import type { GitCommitInvocation, ShellMode, ShellToken } from "./types.js";

const gitGlobalOptionsWithArg = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

const targetGlobalOptions = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--config-env",
]);

const commandPrefixes = new Set([
  "!",
  "do",
  "elif",
  "else",
  "if",
  "then",
  "time",
  "until",
  "while",
]);

const targetMutators = new Set([
  "cd",
  "pushd",
  "popd",
  "chdir",
  "export",
  "typeset",
  "declare",
  "source",
  ".",
  "eval",
  "set",
  "unset",
  "readonly",
  "local",
  "setenv",
]);

const commitLongOptionsWithArg = new Set([
  "--author",
  "--cleanup",
  "--date",
  "--fixup",
  "--pathspec-from-file",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "--template",
  "--trailer",
]);

const simpleAnsiEscapes = new Map(
  Object.entries({
    a: "\u0007",
    b: "\b",
    e: "\u001B",
    E: "\u001B",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
    "?": "?",
  })
);

const hexEscapeWidths = new Map([
  ["x", 2],
  ["u", 4],
  ["U", 8],
]);

const twoCharacterOperators = new Set(["&&", "||", "|&", ";;"]);

const wrapperArgsWithValue = new Map([
  ["env", new Set(["-u", "--unset", "-C", "--chdir"])],
  ["exec", new Set(["-a"])],
  ["command", new Set<string>()],
  ["nohup", new Set<string>()],
  ["builtin", new Set<string>()],
]);

const booleanCommitFlags = new Map<string, [string, boolean]>([
  ["-h", ["isHelp", true]],
  ["--help", ["isHelp", true]],
  ["--amend", ["isAmend", true]],
  ["--no-edit", ["hasNoEdit", true]],
  ["--edit", ["hasNoEdit", false]],
  ["-s", ["hasSignoffFlag", true]],
  ["--signoff", ["hasSignoffFlag", true]],
  ["--no-signoff", ["hasSignoffFlag", false]],
]);

interface ScanResult {
  content: string;
  end: number;
  byte?: number;
  bytes?: number[];
  substitutions?: string[];
  expansion?: boolean;
}

interface HeredocDelimiter {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

interface CaseState {
  depth: number;
  phase: "word" | "in" | "pattern" | "body";
  patternStart: boolean;
}

interface SubstitutionState {
  i: number;
  depth: number;
  arithmeticDepth?: number;
  atWordStart: boolean;
  atCommandStart: boolean;
  timeOption: boolean;
  cases: CaseState[];
  heredocs: HeredocDelimiter[];
}

const inspectionError = (message: string): Error =>
  new Error(`[commit-guard] Pre-execution shell inspection failed: ${message}`);

const incompleteHeredoc = (): Error =>
  inspectionError(
    "Cannot validate an incomplete heredoc. Close its delimiter on a separate line before running the command."
  );

const isWordSeparator = (character: string): boolean =>
  /[ \t\r\n;&|()]/u.test(character);

const isExpansion = (command: string, i: number): boolean =>
  command[i] === "$" && /[a-zA-Z0-9_{[*#?@!$-]/u.test(command[i + 1] ?? "");

const ansiEscape = (command: string, start: number): ScanResult => {
  const escaped = command[start + 1] ?? "";
  const literal = simpleAnsiEscapes.get(escaped);

  if (literal !== undefined) {
    return { content: literal, end: start + 2 };
  }

  const character = command[start + 2];

  if (escaped === "c" && character !== undefined && character !== "'") {
    return {
      content: String.fromCodePoint(
        character === "?"
          ? 127
          : (character.toUpperCase().codePointAt(0) ?? 0) & 31
      ),
      end: start + (character === "\\" && command[start + 3] === "\\" ? 4 : 3),
    };
  }

  const count = hexEscapeWidths.get(escaped) ?? 0;

  const digits =
    count > 0
      ? new RegExp(`^[0-9a-fA-F]{1,${count}}`, "u").exec(
          command.slice(start + 2)
        )?.[0]
      : /^[0-7]{1,3}/u.exec(command.slice(start + 1))?.[0];

  if (digits === undefined) {
    return { content: `\\${escaped}`, end: start + 2 };
  }

  const radix = count > 0 ? 16 : 8;
  const code = Number.parseInt(digits, radix);

  if (code > 0x10_ff_ff) {
    throw inspectionError(
      "Cannot validate this ANSI-C escape. Supply literal text."
    );
  }

  const end = start + (count > 0 ? 2 : 1) + digits.length;

  return count === 0 || escaped === "x"
    ? { content: "", byte: code & 255, end }
    : { content: String.fromCodePoint(code), end };
};

const scanSingleQuote = (command: string, start: number): ScanResult => {
  const end = command.indexOf("'", start + 1);

  if (end === -1) {
    throw inspectionError(
      `Unterminated single quote starting at character ${start + 1}. Close the quote before running the command.`
    );
  }

  return { content: command.slice(start + 1, end), end: end + 1 };
};

const scanAnsiQuote = (command: string, start: number): ScanResult => {
  const bytes: number[] = [];
  let i = start + 2;

  while (i < command.length && command[i] !== "'") {
    if (command[i] === "\\" && i + 1 < command.length) {
      const escaped = ansiEscape(command, i);
      bytes.push(
        ...(escaped.byte === undefined
          ? Buffer.from(escaped.content)
          : [escaped.byte])
      );
      i = escaped.end;
    } else {
      const literal = String.fromCodePoint(command.codePointAt(i) ?? 0);
      bytes.push(...Buffer.from(literal));
      i += literal.length;
    }
  }

  if (command[i] !== "'") {
    throw inspectionError(
      `Unterminated ANSI-C quote starting at character ${start + 1}. Close the quote before running the command.`
    );
  }

  const nul = bytes.indexOf(0);

  // Keep bytes separate until the whole word is assembled: adjacent quotes can split UTF-8.
  return {
    content: "",
    end: i + 1,
    bytes: nul === -1 ? bytes : bytes.slice(0, nul),
  };
};

const consumeBackticks = (
  command: string,
  start: number,
  doubleQuoted = false
): ScanResult => {
  let content = "";

  for (let i = start + 1; i < command.length; i += 1) {
    if (command[i] === "`") {
      return { content, end: i + 1 };
    }

    if (
      command[i] === "\\" &&
      (["$", "`", "\\"].includes(command[i + 1] ?? "") ||
        (doubleQuoted && command[i + 1] === '"'))
    ) {
      i += 1;
    }

    content += command[i];
  }

  throw inspectionError(
    `Unterminated backtick substitution starting at character ${start + 1}. Close it, escape a literal backtick as \\\`, or use single quotes.`
  );
};

const consumeQuotedParameter = (
  command: string,
  start: number,
  nesting = 0
): number => {
  if (nesting > 12) {
    throw inspectionError(
      "Shell parsing limit exceeded. Simplify the unsupported syntax."
    );
  }

  let quote = false;

  for (let i = start + 2; i < command.length; i += 1) {
    const character = command[i];

    if (character === "`" || (character === "$" && command[i + 1] === "(")) {
      throw inspectionError(
        "Cannot inspect command substitutions inside a double-quoted parameter expansion. Run substitutions separately or quote literal text."
      );
    }

    if (character === "\\") {
      i += 1;
    } else if (character === '"') {
      quote = !quote;
    } else if (character === "$" && command[i + 1] === "{") {
      i = consumeQuotedParameter(command, i, nesting + 1) - 1;
    } else if (character === "}" && !quote) {
      return i + 1;
    }
  }

  throw inspectionError(
    "Cannot parse an incomplete double-quoted parameter expansion. Close its quotes and braces or quote literal text."
  );
};

const scanDoubleQuote = (
  command: string,
  start: number,
  nesting: number
): ScanResult => {
  let content = "";
  let expansion = false;
  const substitutions: string[] = [];
  let i = start + 1;

  while (i < command.length && command[i] !== '"') {
    const character = command[i];

    if (character === "\\" && i + 1 < command.length) {
      const escaped = command[i + 1] ?? "";

      if (escaped !== "\n") {
        content += ['"', "\\", "$", "`"].includes(escaped)
          ? escaped
          : `\\${escaped}`;
      }

      i += 2;
    } else if (
      (character === "$" && command[i + 1] === "(") ||
      character === "`"
    ) {
      const result =
        character === "`"
          ? consumeBackticks(command, i, true)
          : consumeCommandSubstitution(command, i, nesting);

      content += command.slice(i, result.end);
      substitutions.push(result.content);
      expansion = true;
      i = result.end;
    } else if (character === "$" && command[i + 1] === "{") {
      const end = consumeQuotedParameter(command, i);
      content += command.slice(i, end);
      expansion = true;
      i = end;
    } else {
      expansion ||= isExpansion(command, i);
      content += character;
      i += 1;
    }
  }

  if (command[i] !== '"') {
    throw inspectionError(
      `Unterminated double quote starting at character ${start + 1}. Close the quote before running the command.`
    );
  }

  return { content, end: i + 1, expansion, substitutions };
};

const consumeHeredoc = (
  command: string,
  start: number,
  heredoc: HeredocDelimiter
): ScanResult => {
  let i = start;
  let body = "";

  while (i < command.length) {
    let line = "";
    let newline = false;

    while (i < command.length) {
      const lineEnd = command.indexOf("\n", i);
      const end = lineEnd === -1 ? command.length : lineEnd;
      const physicalLine = command.slice(i, end);
      const backslashes = /\\+$/u.exec(physicalLine)?.[0].length ?? 0;
      newline = lineEnd !== -1;
      i = newline ? end + 1 : end;

      if (!heredoc.quoted && newline && backslashes % 2 === 1) {
        line += physicalLine.slice(0, -1);
        continue;
      }

      line += physicalLine;
      break;
    }

    if (heredoc.stripTabs) {
      line = line.replace(/^\t+/u, "");
    }

    if (line === heredoc.delimiter) {
      return { content: body, end: i };
    }

    body += line + (newline ? "\n" : "");
  }

  throw incompleteHeredoc();
};

const advanceCaseState = (
  cases: CaseState[],
  depth: number,
  word: string
): void => {
  const active = cases.at(-1);
  const patternWord = active?.phase === "pattern";

  if (active?.depth === depth && active.phase === "word") {
    active.phase = "in";
  } else if (active?.depth === depth && active.phase === "in") {
    if (word !== "in") {
      throw inspectionError(
        "Cannot parse case header. Simplify the unsupported syntax."
      );
    }

    active.phase = "pattern";
  } else if (
    word === "esac" &&
    active?.depth === depth &&
    (!patternWord || active.patternStart)
  ) {
    cases.pop();
  } else if (word === "case" && !patternWord) {
    cases.push({ depth, phase: "word", patternStart: true });
  }

  if (active !== undefined && patternWord) {
    active.patternStart = false;
  }
};

const trackSubstitutionWord = (
  command: string,
  state: SubstitutionState
): void => {
  const phase = state.cases.at(-1)?.phase;

  if (
    !state.atWordStart ||
    !(state.atCommandStart || ["word", "in", "pattern"].includes(phase ?? ""))
  ) {
    return;
  }

  let word = "";

  for (let end = state.i; end < command.length; end += 1) {
    const ch = command[end] ?? "";

    if (ch === "\\" && command[end + 1] === "\n") {
      end += 1;
    } else if (isWordSeparator(ch)) {
      break;
    } else {
      word += ch;
    }
  }

  advanceCaseState(state.cases, state.depth, word);

  if (phase !== "pattern" && ["function", "coproc"].includes(word)) {
    throw inspectionError(
      "Cannot parse function or coproc declarations inside a command substitution. Run the declaration separately."
    );
  }

  state.atCommandStart =
    (state.timeOption && (word === "-p" || word === "--")) ||
    commandPrefixes.has(word) ||
    word === "for" ||
    word === "{";
  state.timeOption = word === "time" || (state.timeOption && word === "-p");
};

const stepSubstitutionSyntax = (
  command: string,
  state: SubstitutionState,
  nesting: number
): boolean => {
  const { i } = state;
  const character = command[i];
  const active = state.cases.at(-1);

  if (character === "\\") {
    if (command[i + 1] !== "\n") {
      if (active?.depth === state.depth && active.phase === "pattern") {
        active.patternStart = false;
      }

      state.atWordStart = false;
      state.atCommandStart = false;
    }

    state.i += i + 1 < command.length ? 2 : 1;

    return true;
  }

  if (state.arithmeticDepth === undefined && command.slice(i, i + 2) === "<<") {
    if (command[i + 2] === "<") {
      state.i += 3;
    } else {
      const result = readHeredocDelimiter(command, i, nesting + 1);
      state.heredocs.push(result.delimiter);
      state.i = result.end;
    }

    state.atWordStart = true;

    return true;
  }

  if (character === "\n" && state.heredocs.length > 0) {
    state.i += 1;

    for (const heredoc of state.heredocs) {
      state.i = consumeHeredoc(command, state.i, heredoc).end;
    }

    state.heredocs.length = 0;
    state.atWordStart = true;
    state.atCommandStart = true;
    state.timeOption = false;

    return true;
  }

  if (
    active?.depth === state.depth &&
    active.phase === "body" &&
    /^;(?:;|&)/u.test(command.slice(i, i + 2))
  ) {
    state.i += command.slice(i, i + 3) === ";;&" ? 3 : 2;
    active.phase = "pattern";
    active.patternStart = true;
    state.atWordStart = true;
    state.atCommandStart = true;

    return true;
  }

  return false;
};

const stepSubstitutionWord = (
  command: string,
  state: SubstitutionState,
  nesting: number
): boolean => {
  const { i } = state;
  const character = command[i] ?? "";

  if (character === "#" && state.atWordStart) {
    const end = command.indexOf("\n", i);
    state.i = end === -1 ? command.length : end;

    return true;
  }

  if (!isWordSeparator(character) && character !== "#") {
    trackSubstitutionWord(command, state);
  }

  const result = scanWordFragment(command, i, nesting + 1);

  if (result === undefined) {
    return false;
  }

  state.i = result.end;
  state.atWordStart = false;

  return true;
};

const stepSubstitutionParenthesis = (
  command: string,
  state: SubstitutionState
): boolean => {
  const character = command[state.i];
  const active = state.cases.at(-1);

  if (character !== "(" && character !== ")") {
    return false;
  }

  if (active?.depth === state.depth && active.phase === "pattern") {
    if (character === "(") {
      active.patternStart = false;
    } else {
      active.phase = "body";
      state.atCommandStart = true;
    }

    state.i += 1;
    state.atWordStart = true;

    return true;
  }

  if (character === "(") {
    if (
      state.arithmeticDepth === undefined &&
      state.atCommandStart &&
      command[state.i + 1] === "("
    ) {
      state.arithmeticDepth = state.depth;
    }

    state.depth += 1;
    state.atCommandStart = true;
  } else {
    state.depth -= 1;

    if (state.depth === state.arithmeticDepth) {
      state.arithmeticDepth = undefined;
    }
  }

  state.atWordStart = true;

  return false;
};

const consumeCommandSubstitution = (
  command: string,
  start: number,
  nesting = 0
): ScanResult => {
  if (nesting > 12) {
    throw inspectionError(
      "Shell parsing limit exceeded. Simplify the unsupported syntax."
    );
  }

  const state: SubstitutionState = {
    i: start + 2,
    depth: 1,
    atWordStart: true,
    atCommandStart: true,
    timeOption: false,
    arithmeticDepth: command[start + 2] === "(" ? 1 : undefined,
    cases: [],
    heredocs: [],
  };

  while (state.i < command.length) {
    if (
      stepSubstitutionSyntax(command, state, nesting) ||
      stepSubstitutionWord(command, state, nesting)
    ) {
      continue;
    }

    const character = command[state.i] ?? "";

    if (stepSubstitutionParenthesis(command, state)) {
      continue;
    }

    if (state.depth === 0) {
      if (state.heredocs.length > 0) {
        throw incompleteHeredoc();
      }

      const content =
        command[start + 2] === "("
          ? command.slice(start + 1, state.i + 1)
          : command.slice(start + 2, state.i);

      return { content, end: state.i + 1 };
    }

    if ([";", "&", "|", "\n", ")"].includes(character)) {
      state.atCommandStart = true;
      state.timeOption = false;
    }

    state.atWordStart = isWordSeparator(character);
    state.i += 1;
  }

  if (state.heredocs.length > 0) {
    throw incompleteHeredoc();
  }

  throw inspectionError(
    `Unterminated $( substitution starting at character ${start + 1}. Close it with ) or use single quotes for literal text.`
  );
};

const heredocSubstitutions = (body: string): string[] => {
  const substitutions: string[] = [];

  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "\\" && ["\\", "$", "`"].includes(body[i + 1] ?? "")) {
      i += 1;
    } else if (body[i] === "`") {
      throw inspectionError(
        "Cannot validate command substitutions in an unquoted heredoc. Quote the delimiter, for example: <<'EOF'."
      );
    } else if (body.slice(i, i + 2) === "$(") {
      const result = consumeCommandSubstitution(body, i);
      substitutions.push(result.content);
      i = result.end - 1;
    }
  }

  return substitutions;
};

const isBraceCommandPosition = (tokens: readonly ShellToken[]): boolean => {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];

    if (token === undefined) {
      continue;
    }

    if (token.type === "operator") {
      break;
    }

    const preceding = tokens[index - 1]?.value;

    if (token.type === "word") {
      if (index === tokens.length - 1 && token.value === "coproc") {
        continue;
      }

      const followsTime =
        preceding === "time" ||
        (preceding === "-p" && tokens[index - 2]?.value === "time");

      if (token.value === "--" && followsTime) {
        continue;
      }

      if (
        (index === tokens.length - 1 &&
          ["function", "coproc"].includes(preceding ?? "")) ||
        (preceding === "time" && token.value === "-p")
      ) {
        index -= 1;
        continue;
      }
    }

    if (token.type !== "word" || !commandPrefixes.has(token.value)) {
      return false;
    }
  }

  return true;
};

const isArithmeticCommandPosition = (tokens: readonly ShellToken[]): boolean =>
  isBraceCommandPosition(tokens) ||
  (tokens.at(-1)?.type === "word" &&
    tokens.at(-1)?.value === "for" &&
    isBraceCommandPosition(tokens.slice(0, -1)));

interface WordResult extends ScanResult {
  bytes?: number[];
  quoted?: boolean;
  unsupportedDelimiter?: string;
}

const scanWord = (
  command: string,
  start: number,
  nesting: number
): WordResult => {
  let content = "";
  const bytes: number[] = [];
  const substitutions: string[] = [];
  let quoted = false;
  let expansion = false;
  let unsupportedDelimiter: string | undefined;
  let i = start;

  while (i < command.length) {
    const character = command[i] ?? "";

    if (isWordSeparator(character)) {
      break;
    }

    if (character === "\\" && command[i + 1] === "\n") {
      i += 2;
      continue;
    }

    if (character === "\\") {
      quoted = true;
      content += command[i + 1] ?? "\\";
      i += i + 1 < command.length ? 2 : 1;
      continue;
    }

    const dollarQuote = /^\$(?:\\\n)*(?<quote>['"])/u.exec(
      command.slice(i)
    )?.[1];

    if (dollarQuote !== undefined) {
      unsupportedDelimiter =
        dollarQuote === "'" ? "ANSI-C quoted" : "locale-quoted";
    }

    const result = scanWordFragment(command, i, nesting);

    if (result !== undefined) {
      quoted ||= result.quoted === true;

      if (result.bytes === undefined) {
        content += result.content;
      } else {
        bytes.push(...Buffer.from(content), ...result.bytes);
        content = "";
      }

      substitutions.push(...(result.substitutions ?? []));
      expansion ||= result.expansion === true;
      i = result.end;
      continue;
    }

    if (/^[<>]/u.test(character)) {
      break;
    }

    expansion ||= isExpansion(command, i);
    content += character;
    i += 1;
  }

  return {
    content:
      bytes.length > 0
        ? Buffer.from([...bytes, ...Buffer.from(content)]).toString("utf-8")
        : content,
    end: i,
    quoted,
    expansion,
    substitutions,
    unsupportedDelimiter,
  };
};

const scanWordFragment = (
  command: string,
  i: number,
  nesting: number
): WordResult | undefined => {
  const pair = command.slice(i, i + 2);

  if (pair === "$'") {
    return { ...scanAnsiQuote(command, i), quoted: true };
  }

  if (command[i] === "'") {
    return { ...scanSingleQuote(command, i), quoted: true };
  }

  if (command[i] === '"') {
    return { ...scanDoubleQuote(command, i, nesting), quoted: true };
  }

  if (pair === "$(" || command[i] === "`") {
    const result =
      pair === "$("
        ? consumeCommandSubstitution(command, i, nesting)
        : consumeBackticks(command, i);

    return {
      content: command.slice(i, result.end),
      end: result.end,
      expansion: true,
      substitutions: [result.content],
    };
  }

  return undefined;
};

const skipTrivia = (command: string, start: number): number => {
  let i = start;

  while (i < command.length) {
    const ch = command[i] ?? "";

    if (/[ \t\r]/u.test(ch)) {
      i += 1;
    } else if (ch === "\\" && command[i + 1] === "\n") {
      i += 2;
    } else if (ch === "#") {
      const end = command.indexOf("\n", i);
      i = end === -1 ? command.length : end;
    } else {
      break;
    }
  }

  return i;
};

interface DelimiterResult {
  delimiter: HeredocDelimiter;
  end: number;
}

const readHeredocDelimiter = (
  command: string,
  start: number,
  nesting: number
): DelimiterResult => {
  const stripTabs = command[start + 2] === "-";
  const i = skipTrivia(command, start + (stripTabs ? 3 : 2));

  const next = command[i];

  if (next === undefined || isWordSeparator(next) || /[<>]/u.test(next)) {
    throw incompleteHeredoc();
  }

  const word = scanWord(command, i, nesting);

  if (word.unsupportedDelimiter !== undefined) {
    throw inspectionError(
      `Cannot validate this ${word.unsupportedDelimiter} heredoc delimiter. Use a plain quoted delimiter such as <<'EOF'.`
    );
  }

  return {
    delimiter: {
      delimiter: word.content,
      quoted: word.quoted === true,
      stripTabs,
    },
    end: word.end,
  };
};

const readOperator = (
  command: string,
  i: number,
  tokens: readonly ShellToken[]
): string | undefined => {
  const pair = command.slice(i, i + 2);

  if (twoCharacterOperators.has(pair)) {
    return pair;
  }

  const character = command[i];

  if (character === undefined) {
    return undefined;
  }

  if (
    "|;\n()".includes(character) ||
    (character === "&" && command[i + 1] !== ">")
  ) {
    return character;
  }

  if (
    (character === "{" || character === "}") &&
    isBraceCommandPosition(tokens)
  ) {
    let end = i + 1;

    while (command[end] === "\\" && command[end + 1] === "\n") {
      end += 2;
    }

    const following = command[end];

    if (
      following === undefined ||
      isWordSeparator(following) ||
      /[<>]/u.test(following)
    ) {
      return character;
    }
  }

  return undefined;
};

const tokenizeShell = (command: string): ShellToken[] => {
  const tokens: ShellToken[] = [];
  const heredocs: (HeredocDelimiter & { index: number })[] = [];
  let depth = 0;
  let arithmeticDepth: number | undefined;
  let i = 0;

  while ((i = skipTrivia(command, i)) < command.length) {
    const operator = readOperator(command, i, tokens);

    if (operator !== undefined) {
      if (operator === "(") {
        if (
          arithmeticDepth === undefined &&
          command[i + 1] === "(" &&
          isArithmeticCommandPosition(tokens)
        ) {
          arithmeticDepth = depth;
        }

        depth += 1;
      } else if (operator === ")") {
        depth -= 1;

        if (depth === arithmeticDepth) {
          arithmeticDepth = undefined;
        }
      }

      tokens.push({ type: "operator", value: operator });
      i += operator.length;

      if (operator === "\n") {
        for (const heredoc of heredocs) {
          const body = consumeHeredoc(command, i, heredoc);
          i = body.end;
          const target = tokens[heredoc.index];

          if (target !== undefined) {
            tokens[heredoc.index] = {
              ...target,
              heredoc: { body: body.content, quoted: heredoc.quoted },
              substitutions: heredoc.quoted
                ? undefined
                : heredocSubstitutions(body.content),
            };
          }
        }

        heredocs.length = 0;
      }

      continue;
    }

    const redirect = /^(?:\d+)?(?:<<<|<<-|>>|<<|>&|<&|<>|>\||>|<)|^&>>?/u.exec(
      command.slice(i)
    )?.[0];

    if (redirect !== undefined) {
      // Arithmetic shifts are ordinary expression text, not stdin redirections.
      tokens.push({ type: "redirect", value: redirect });

      if (arithmeticDepth === undefined && /^\d*<<-?$/u.test(redirect)) {
        const result = readHeredocDelimiter(
          command,
          i + redirect.search(/</u),
          0
        );

        heredocs.push({ ...result.delimiter, index: tokens.length - 1 });
        tokens.push({ type: "word", value: result.delimiter.delimiter });
        i = result.end;
      } else {
        i += redirect.length;
      }

      continue;
    }

    const word = scanWord(command, i, 0);
    tokens.push({
      type: "word",
      value: word.content,
      substitutions: word.substitutions,
      expansion: word.expansion,
    });
    i = word.end;
  }

  if (heredocs.length > 0) {
    throw incompleteHeredoc();
  }

  return tokens;
};

const extractCommandWords = (tokens: readonly ShellToken[]): ShellToken[] => {
  const words: ShellToken[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token === undefined) {
      continue;
    }

    if (token.type === "redirect") {
      i += tokens[i + 1]?.type === "word" ? 1 : 0;
    } else if (token.type === "word") {
      words.push(token);
    }
  }

  return words;
};

const isAssignment = (word: string): boolean =>
  /^[a-zA-Z_][a-zA-Z0-9_]*=/u.test(word);

const skipWrapperOptions = (
  words: readonly string[],
  start: number,
  valued: ReadonlySet<string>
): number => {
  let index = start;

  while (index < words.length) {
    const argument = words[index];

    if (argument === undefined) {
      break;
    }

    if (argument === "--") {
      return index + 1;
    }

    if (!argument.startsWith("-") && !isAssignment(argument)) {
      break;
    }

    index += valued.has(argument) ? 2 : 1;
  }

  return index;
};

const findCommandStart = (words: readonly string[]): number => {
  let index = 0;

  while (index < words.length) {
    const word = words[index];

    if (word === undefined) {
      break;
    }

    if (isAssignment(word) || commandPrefixes.has(word)) {
      index += 1;
    } else {
      const valued = wrapperArgsWithValue.get(word);

      if (valued === undefined) {
        break;
      }

      index = skipWrapperOptions(words, index + 1, valued);
    }
  }

  return index;
};

interface GlobalOptions {
  index: number;
  targetError?: string;
}

const consumeGitGlobalOptions = (
  words: readonly ShellToken[],
  start: number
): GlobalOptions => {
  let index = start;
  let targetError: string | undefined;

  while (index < words.length) {
    const token = words[index];

    if (token === undefined) {
      break;
    }

    const argument = token.value;

    if (token.expansion === true) {
      throw inspectionError(
        "Cannot inspect dynamic Git options or subcommands. Use literal command words."
      );
    }

    if (argument === "--") {
      if (words[index + 1]?.expansion === true) {
        throw inspectionError(
          "Cannot inspect a dynamic Git subcommand. Use literal command words."
        );
      }

      return { index: index + 1, targetError };
    }

    if (!argument.startsWith("-")) {
      break;
    }

    const option = /^-[Cc]/u.test(argument)
      ? argument.slice(0, 2)
      : (argument.split("=")[0] ?? "");

    if (targetGlobalOptions.has(option)) {
      targetError =
        "Git global directory or configuration flags can change the commit target or signing policy. Use a direct git commit in the captured workdir.";
    }

    index += gitGlobalOptionsWithArg.has(argument) ? 2 : 1;
  }

  return { index, targetError };
};

interface CommitArguments {
  messages: string[];
  filePaths: string[];
  hasSignoffFlag: boolean;
  isAmend: boolean;
  hasNoEdit: boolean;
  isFixup: boolean;
  isHelp: boolean;
  messageExpansion: boolean;
  hasTrailer: boolean;
}

const consumeShortCommitFlags = (
  words: readonly ShellToken[],
  start: number,
  argument: string,
  result: CommitArguments
): number => {
  let index = start;

  for (let i = 1; i < argument.length; i += 1) {
    const option = argument[i];

    if (option === "s") {
      result.hasSignoffFlag = true;
    } else if (option === "h") {
      result.isHelp = true;
    } else if (option === "e") {
      result.hasNoEdit = false;
    } else if (option === "m" || option === "F") {
      const attached = argument.slice(i + 1);
      const input = attached.length > 0 ? attached : words[(index += 1)]?.value;

      if (option === "m") {
        result.messageExpansion ||= words[index]?.expansion === true;
      }

      if (input !== undefined) {
        (option === "m" ? result.messages : result.filePaths).push(input);
      }

      break;
    } else if (option === "S" || option === "u") {
      break;
    } else if (option === "c" || option === "C" || option === "t") {
      index += argument.slice(i + 1).length === 0 ? 1 : 0;
      break;
    }
  }

  return index;
};

const consumeMessageOrFileFlag = (
  words: readonly ShellToken[],
  index: number,
  argument: string,
  isMessage: boolean,
  result: CommitArguments
): number => {
  const equals = argument.indexOf("=");
  const nextIndex = equals === -1 ? index + 1 : index;

  const input =
    equals === -1 ? words[nextIndex]?.value : argument.slice(equals + 1);

  if (isMessage) {
    result.messageExpansion ||= words[nextIndex]?.expansion === true;
  }

  if (input !== undefined) {
    (isMessage ? result.messages : result.filePaths).push(input);
  }

  return nextIndex;
};

const parseCommitArguments = (
  words: readonly ShellToken[],
  start: number
): CommitArguments => {
  const result: CommitArguments = {
    messages: [],
    filePaths: [],
    hasSignoffFlag: false,
    isAmend: false,
    hasNoEdit: false,
    isFixup: false,
    isHelp: false,
    messageExpansion: false,
    hasTrailer: false,
  };

  for (let index = start; index < words.length; index += 1) {
    const token = words[index];

    if (token === undefined || token.value === "--") {
      break;
    }

    const argument = token.value;
    const boolean = booleanCommitFlags.get(argument);

    if (boolean !== undefined) {
      Object.assign(result, { [boolean[0]]: boolean[1] });
      continue;
    }

    const [option = ""] = argument.split("=");
    const isMessage = option === "--message" || argument === "-m";
    const isFile = option === "--file" || argument === "-F";

    if (isMessage || isFile) {
      index = consumeMessageOrFileFlag(
        words,
        index,
        argument,
        isMessage,
        result
      );
    } else if (commitLongOptionsWithArg.has(option)) {
      result.isFixup ||= option === "--fixup";
      result.hasTrailer ||= option === "--trailer";
      index += argument.includes("=") ? 0 : 1;
    } else if (/^-[^-]/u.test(argument)) {
      index = consumeShortCommitFlags(words, index, argument, result);
    }
  }

  return result;
};

const isGitExecutable = (executable: string, mode: ShellMode): boolean =>
  mode === "pwsh"
    ? /^(?:.*[/\\])?git(?:\.exe)?$/iu.test(executable)
    : executable === "git" || executable.endsWith("/git");

const extractInvocation = (
  words: readonly ShellToken[],
  start: number,
  mode: ShellMode
): GitCommitInvocation | undefined => {
  const executable = words[start]?.value;

  if (executable === undefined || !isGitExecutable(executable, mode)) {
    return undefined;
  }

  const global = consumeGitGlobalOptions(words, start + 1);

  if (words[global.index]?.value !== "commit") {
    return undefined;
  }

  const wrapperChange = words
    .slice(0, start)
    .some((word) => word.value === "env" || isAssignment(word.value));

  return {
    ...parseCommitArguments(words, global.index + 1),
    targetError:
      global.targetError ??
      (wrapperChange
        ? "Environment or wrapper changes can redirect a Git commit target. Use a direct git commit in the captured workdir."
        : undefined),
  };
};

const consumeShellOptions = (words: readonly ShellToken[], start: number) => {
  let index = start + 1;
  let executeString = false;

  while (index < words.length) {
    const option = words[index]?.value ?? "";

    if (option === "--") {
      index += 1;
      break;
    }

    if (!/^[+-]/u.test(option)) {
      break;
    }

    executeString ||= /^-[a-zA-Z]*c[a-zA-Z]*$/u.test(option);
    const shortOptions = /^[+-][a-zA-Z]+$/u.test(option);

    if (shortOptions && /[oO]/u.test(option) && !/[oO]$/u.test(option)) {
      throw inspectionError(
        "Cannot parse shell options reliably. Simplify the unsupported syntax."
      );
    }

    const next = words[index + 1]?.value;
    const optionName = next !== undefined && !/^[+-]/u.test(next);
    index +=
      (shortOptions && /[oO]$/u.test(option) && optionName) ||
      ["--rcfile", "--init-file"].includes(option)
        ? 2
        : 1;
  }

  return { index, executeString };
};

const extractShellCBody = (
  words: readonly ShellToken[],
  start: number
): string | undefined => {
  if (!/^(?:.*\/)?(?:bash|sh|zsh)$/u.test(words[start]?.value ?? "")) {
    return undefined;
  }

  const { index, executeString } = consumeShellOptions(words, start);

  if (!executeString) {
    return undefined;
  }

  const body = words[index];

  if (body === undefined || body.expansion === true) {
    throw inspectionError(
      "Cannot parse an expanded or missing shell -c body reliably. Use a literal shell body; if committing, run git commit directly."
    );
  }

  if (
    /^(?:.*\/)?sh$/u.test(words[start]?.value ?? "") &&
    body.value.includes("$'")
  ) {
    throw inspectionError(
      "Cannot parse $' quoting portably in sh -c. Use a literal bash -c or zsh -c body."
    );
  }

  return body.value;
};

const attachStdinHeredoc = (
  invocation: GitCommitInvocation,
  tokens: readonly ShellToken[],
  pipeline: boolean
): GitCommitInvocation => {
  if (!invocation.filePaths.includes("-")) {
    return invocation;
  }

  const heredocs = tokens.filter(
    (token) => token.type === "redirect" && /^\d*<<$/u.test(token.value)
  );

  const stdinRedirects = tokens.filter((token) => {
    if (token.type !== "redirect") {
      return false;
    }

    const match = /^(?<descriptor>\d*)(?<direction>[<>])/u.exec(token.value);

    return (
      match !== null &&
      (match[1] === "" ? match[2] === "<" : Number(match[1]) === 0)
    );
  });

  const [heredoc] = heredocs;
  let stdinError: string | undefined;

  if (pipeline) {
    stdinError = "Pipelines cannot supply a validated commit message.";
  } else if (
    heredocs.length !== 1 ||
    stdinRedirects.length !== 1 ||
    (heredoc?.value !== "<<" && heredoc?.value !== "0<<")
  ) {
    stdinError =
      "Use exactly one quoted stdin heredoc on git commit -F -, with no other stdin redirects.";
  } else if (heredoc.heredoc?.quoted !== true) {
    stdinError =
      "Use a complete quoted heredoc delimiter, for example: git commit -s -F - <<'EOF'.";
  }

  return {
    ...invocation,
    stdinError,
    stdinMessage: stdinError === undefined ? heredoc?.heredoc?.body : undefined,
  };
};

const pwshBacktickEscapes = new Map(
  Object.entries({
    "0": "\0",
    a: "\u0007",
    b: "\b",
    e: "\u001B",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
  })
);

const pwshTargetMutators = new Set([
  "cd",
  "sl",
  "set-location",
  "push-location",
  "pushd",
  "pop-location",
  "popd",
  "set-variable",
  "sv",
  "iex",
  "invoke-expression",
  ".",
]);

const isPwshSingleQuote = (character: string): boolean =>
  character === "'" || (character >= "\u2018" && character <= "\u201B");

const isPwshDoubleQuote = (character: string): boolean =>
  character === '"' || (character >= "\u201C" && character <= "\u201E");

const isPwshWordSeparator = (character: string): boolean =>
  /[ \t\r\n;&|(){}]/u.test(character);

const isPwshVariableStart = (command: string, index: number): boolean =>
  command[index] === "$" && /[a-zA-Z0-9_?^$:]/u.test(command[index + 1] ?? "");

const decodePwshBacktick = (command: string, start: number): ScanResult => {
  const next = command[start + 1];

  if (next === undefined) {
    return { content: "`", end: start + 1 };
  }

  if (next === "\r" && command[start + 2] === "\n") {
    return { content: "\n", end: start + 3 };
  }

  if (next === "u" && command[start + 2] === "{") {
    const close = command.indexOf("}", start + 3);
    const hex = close === -1 ? "" : command.slice(start + 3, close);

    if (close === -1 || !/^[0-9a-fA-F]{1,6}$/u.test(hex)) {
      throw inspectionError(
        "Invalid PowerShell Unicode escape sequence. Use valid `u{hex} syntax."
      );
    }

    const code = Number.parseInt(hex, 16);

    if (code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) {
      throw inspectionError(
        "Invalid PowerShell Unicode scalar value in `u{hex} escape."
      );
    }

    return { content: String.fromCodePoint(code), end: close + 1 };
  }

  const mapped = pwshBacktickEscapes.get(next);

  return { content: mapped ?? next, end: start + 2 };
};

const scanPwshSingleQuote = (command: string, start: number): ScanResult => {
  let content = "";
  let i = start + 1;

  while (i < command.length) {
    const ch = command[i] ?? "";

    if (isPwshSingleQuote(ch)) {
      if (isPwshSingleQuote(command[i + 1] ?? "")) {
        content += "'";
        i += 2;
        continue;
      }

      return { content, end: i + 1 };
    }

    content += ch;
    i += 1;
  }

  throw inspectionError(
    `Unterminated PowerShell single quote starting at character ${start + 1}. Close the quote before running the command.`
  );
};

const scanPwshBracedVar = (command: string, start: number): number => {
  for (let i = start + 2; i < command.length; i += 1) {
    if (command[i] === "`") {
      i += 1;
    } else if (command[i] === "}") {
      return i + 1;
    }
  }

  throw inspectionError(
    `Unterminated PowerShell braced variable starting at character ${start + 1}.`
  );
};

const skipPwshBlockComment = (command: string, start: number): number => {
  const end = command.indexOf("#>", start + 2);

  if (end === -1) {
    throw inspectionError(
      `Unterminated PowerShell block comment starting at character ${start + 1}. Close it with #>.`
    );
  }

  return end + 2;
};

const scanPwshExpandableText = (text: string, nesting: number) => {
  let content = "";
  let expansion = false;
  const substitutions: string[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i] ?? "";

    if (ch === "`") {
      const escaped = decodePwshBacktick(text, i);
      content += escaped.content;
      i = escaped.end;
    } else if (ch === "$" && text[i + 1] === "(") {
      const sub = consumePwshSubexpression(text, i, nesting);
      content += text.slice(i, sub.end);
      substitutions.push(sub.content);
      expansion = true;
      i = sub.end;
    } else if (ch === "$" && text[i + 1] === "{") {
      const end = scanPwshBracedVar(text, i);
      content += text.slice(i, end);
      expansion = true;
      i = end;
    } else {
      expansion ||= isPwshVariableStart(text, i);
      content += ch;
      i += 1;
    }
  }

  return { content, expansion, substitutions };
};

interface PwshWordResult extends ScanResult {
  hereString?: { readonly body: string; readonly quoted: boolean };
}

const scanPwshHereString = (
  command: string,
  start: number,
  nesting: number
): PwshWordResult => {
  const quote = command[start + 1] ?? "";
  const isSingle = isPwshSingleQuote(quote);
  let i = start + 2;

  while (i < command.length && (command[i] === " " || command[i] === "\t")) {
    i += 1;
  }

  if (command[i] === "\r" && command[i + 1] === "\n") {
    i += 2;
  } else if (command[i] === "\n") {
    i += 1;
  } else {
    throw inspectionError(
      `Invalid PowerShell here-string header at character ${start + 1}. Put a newline immediately after @${quote}.`
    );
  }

  const lines: string[] = [];

  while (i < command.length) {
    const lineEnd = command.indexOf("\n", i);
    const rawEnd = lineEnd === -1 ? command.length : lineEnd;
    const rawLine = command.slice(i, rawEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const first = line[0] ?? "";

    if (
      (isSingle ? isPwshSingleQuote(first) : isPwshDoubleQuote(first)) &&
      line[1] === "@"
    ) {
      const footerEnd = i + 2;
      const body = lines.join("\n");

      if (isSingle) {
        return {
          content: body,
          end: footerEnd,
          hereString: { body, quoted: true },
        };
      }

      const expanded = scanPwshExpandableText(body, nesting);

      return {
        content: expanded.content,
        end: footerEnd,
        expansion: expanded.expansion,
        substitutions: expanded.substitutions,
        hereString: { body: expanded.content, quoted: false },
      };
    }

    lines.push(line);

    if (lineEnd === -1) {
      break;
    }

    i = lineEnd + 1;
  }

  throw inspectionError(
    `Unterminated PowerShell here-string starting at character ${start + 1}. Close it with ${isSingle ? "'@" : '"@'} at column 0.`
  );
};

const scanPwshDoubleQuote = (
  command: string,
  start: number,
  nesting: number
): ScanResult => {
  let content = "";
  let expansion = false;
  const substitutions: string[] = [];
  let i = start + 1;

  while (i < command.length) {
    const ch = command[i] ?? "";

    if (isPwshDoubleQuote(ch)) {
      if (isPwshDoubleQuote(command[i + 1] ?? "")) {
        content += '"';
        i += 2;
        continue;
      }

      return { content, end: i + 1, expansion, substitutions };
    }

    if (ch === "`") {
      const escaped = decodePwshBacktick(command, i);
      content += escaped.content;
      i = escaped.end;
    } else if (ch === "$" && command[i + 1] === "(") {
      const sub = consumePwshSubexpression(command, i, nesting);
      content += command.slice(i, sub.end);
      substitutions.push(sub.content);
      expansion = true;
      i = sub.end;
    } else if (ch === "$" && command[i + 1] === "{") {
      const end = scanPwshBracedVar(command, i);
      content += command.slice(i, end);
      expansion = true;
      i = end;
    } else {
      expansion ||= isPwshVariableStart(command, i);
      content += ch;
      i += 1;
    }
  }

  throw inspectionError(
    `Unterminated PowerShell double quote starting at character ${start + 1}. Close the quote before running the command.`
  );
};

const stepPwshSubexpression = (
  command: string,
  i: number,
  atWordStart: boolean,
  nesting: number
): number | undefined => {
  const ch = command[i] ?? "";

  if (ch === "<" && command[i + 1] === "#") {
    return skipPwshBlockComment(command, i);
  }

  if (ch === "#" && atWordStart) {
    const end = command.indexOf("\n", i);

    return end === -1 ? command.length : end;
  }

  if (
    ch === "@" &&
    (isPwshSingleQuote(command[i + 1] ?? "") ||
      isPwshDoubleQuote(command[i + 1] ?? ""))
  ) {
    return scanPwshHereString(command, i, nesting + 1).end;
  }

  if (isPwshSingleQuote(ch)) {
    return scanPwshSingleQuote(command, i).end;
  }

  if (isPwshDoubleQuote(ch)) {
    return scanPwshDoubleQuote(command, i, nesting + 1).end;
  }

  if (ch === "`") {
    return decodePwshBacktick(command, i).end;
  }

  return undefined;
};

const consumePwshSubexpression = (
  command: string,
  start: number,
  nesting = 0
): ScanResult => {
  if (nesting > 12) {
    throw inspectionError(
      "Shell parsing limit exceeded. Simplify the unsupported syntax."
    );
  }

  let depth = 1;
  let i = start + 2;
  let atWordStart = true;

  while (i < command.length) {
    const stepped = stepPwshSubexpression(command, i, atWordStart, nesting);

    if (stepped !== undefined) {
      i = stepped;
      atWordStart = false;
      continue;
    }

    const ch = command[i] ?? "";

    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;

      if (depth === 0) {
        return { content: command.slice(start + 2, i), end: i + 1 };
      }
    }

    atWordStart = isPwshWordSeparator(ch);
    i += 1;
  }

  throw inspectionError(
    `Unterminated PowerShell subexpression starting at character ${start + 1}. Close it with ).`
  );
};

const skipPwshTrivia = (command: string, start: number): number => {
  let i = start;

  while (i < command.length) {
    const ch = command[i] ?? "";

    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
    } else if (ch === "`" && command[i + 1] === "\n") {
      i += 2;
    } else if (
      ch === "`" &&
      command[i + 1] === "\r" &&
      command[i + 2] === "\n"
    ) {
      i += 3;
    } else if (ch === "<" && command[i + 1] === "#") {
      i = skipPwshBlockComment(command, i);
    } else if (ch === "#") {
      const end = command.indexOf("\n", i);
      i = end === -1 ? command.length : end;
    } else {
      break;
    }
  }

  return i;
};

const scanPwshStopParsing = (command: string, start: number) => {
  const lineEnd = command.indexOf("\n", start);
  const end = lineEnd === -1 ? command.length : lineEnd;
  const raw = command.slice(start, end).replace(/\r$/u, "");

  if (/%[^%\r\n]+%/u.test(raw)) {
    throw inspectionError(
      "Cannot inspect PowerShell stop-parsing (--%) with %VAR% expansion. Supply literal arguments."
    );
  }

  const tokens: ShellToken[] = [];
  let i = 0;

  while (i < raw.length) {
    while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) {
      i += 1;
    }

    if (i >= raw.length) {
      break;
    }

    let word = "";
    let inQuote = false;

    while (i < raw.length) {
      const ch = raw[i] ?? "";

      if (ch === '"') {
        inQuote = !inQuote;
        i += 1;
      } else if (!inQuote && (ch === " " || ch === "\t")) {
        break;
      } else {
        word += ch;
        i += 1;
      }
    }

    if (inQuote) {
      throw inspectionError(
        "Unterminated double quote after PowerShell stop-parsing (--%)."
      );
    }

    tokens.push({ type: "word", value: word });
  }

  return { tokens, end };
};

const scanPwshWordFragment = (
  command: string,
  i: number,
  nesting: number
): ScanResult | undefined => {
  const ch = command[i] ?? "";

  if (isPwshSingleQuote(ch)) {
    return scanPwshSingleQuote(command, i);
  }

  if (isPwshDoubleQuote(ch)) {
    return scanPwshDoubleQuote(command, i, nesting);
  }

  if ((ch === "$" || ch === "@") && command[i + 1] === "(") {
    const sub = consumePwshSubexpression(command, i, nesting);

    return {
      content: command.slice(i, sub.end),
      end: sub.end,
      expansion: true,
      substitutions: [sub.content],
    };
  }

  if (ch === "$" && command[i + 1] === "{") {
    const end = scanPwshBracedVar(command, i);

    return { content: command.slice(i, end), end, expansion: true };
  }

  if (ch === "`") {
    return decodePwshBacktick(command, i);
  }

  return undefined;
};

const scanPwshWord = (
  command: string,
  start: number,
  nesting: number
): PwshWordResult => {
  const first = command[start] ?? "";
  const second = command[start + 1] ?? "";

  if (
    first === "@" &&
    (isPwshSingleQuote(second) || isPwshDoubleQuote(second))
  ) {
    return scanPwshHereString(command, start, nesting);
  }

  if (first === "@" && /^[a-zA-Z0-9_]/u.test(second)) {
    throw inspectionError(
      "Cannot inspect PowerShell splatting (@var) reliably. Supply literal arguments."
    );
  }

  let content = "";
  let expansion = false;
  const substitutions: string[] = [];
  let i = start;

  while (i < command.length) {
    const ch = command[i] ?? "";

    if (
      isPwshWordSeparator(ch) ||
      ch === ">" ||
      (ch === "<" && command[i + 1] === "#")
    ) {
      break;
    }

    const fragment = scanPwshWordFragment(command, i, nesting);

    if (fragment !== undefined) {
      content += fragment.content;
      expansion ||= fragment.expansion === true;
      substitutions.push(...(fragment.substitutions ?? []));
      i = fragment.end;
      continue;
    }

    expansion ||= isPwshVariableStart(command, i);
    content += ch;
    i += 1;
  }

  return { content, end: i, expansion, substitutions };
};

const tokenizePwsh = (command: string): ShellToken[] => {
  const tokens: ShellToken[] = [];
  let i = 0;

  while ((i = skipPwshTrivia(command, i)) < command.length) {
    const pair = command.slice(i, i + 2);

    if (pair === "&&" || pair === "||") {
      tokens.push({ type: "operator", value: pair });
      i += 2;
      continue;
    }

    const ch = command[i] ?? "";

    if ("|;\n(){}".includes(ch)) {
      tokens.push({ type: "operator", value: ch });
      i += 1;
      continue;
    }

    if (ch === "&") {
      const atStart = tokens.length === 0 || tokens.at(-1)?.type === "operator";

      tokens.push({ type: atStart ? "word" : "operator", value: "&" });
      i += 1;
      continue;
    }

    const redirect = /^(?:[1-6*])?(?:>>|>&1|>)/u.exec(command.slice(i))?.[0];

    if (redirect !== undefined) {
      tokens.push({ type: "redirect", value: redirect });
      i += redirect.length;
      continue;
    }

    if (
      command.slice(i, i + 3) === "--%" &&
      (i + 3 >= command.length || isPwshWordSeparator(command[i + 3] ?? ""))
    ) {
      const stopped = scanPwshStopParsing(command, i + 3);
      tokens.push(...stopped.tokens);
      i = stopped.end;
      continue;
    }

    const word = scanPwshWord(command, i, 0);
    tokens.push({
      type: "word",
      value: word.content,
      substitutions: word.substitutions,
      expansion: word.expansion,
      hereString: word.hereString,
    });
    i = word.end;
  }

  return tokens;
};

const decodePwshEncodedCommand = (encoded: string): string => {
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded
    )
  ) {
    throw inspectionError(
      "Cannot decode invalid pwsh -EncodedCommand base64 payload."
    );
  }

  const bytes = Buffer.from(encoded, "base64");

  if (bytes.length % 2 !== 0) {
    throw inspectionError(
      "Cannot decode pwsh -EncodedCommand payload with odd UTF-16LE byte length."
    );
  }

  return bytes.toString("utf16le");
};

type PwshSwitchKind =
  | "boolean"
  | "value"
  | "workingDirectory"
  | "command"
  | "commandWithArgs"
  | "encodedCommand"
  | "unsupported";

const pwshSwitchTable: readonly (readonly [string, PwshSwitchKind, string])[] =
  [
    ["command", "command", "c"],
    ["commandwithargs", "commandWithArgs", "cwa"],
    ["encodedcommand", "encodedCommand", "e"],
    ["encodedarguments", "unsupported", "ea"],
    ["file", "unsupported", "f"],
    ["workingdirectory", "workingDirectory", "wd"],
    ["nologo", "boolean", "nol"],
    ["noprofile", "boolean", "nop"],
    ["noninteractive", "boolean", "noni"],
    ["noexit", "boolean", "noe"],
    ["noprofileloadtime", "boolean", "noprofilel"],
    ["login", "boolean", "l"],
    ["mta", "boolean", "m"],
    ["sta", "boolean", "st"],
    ["interactive", "boolean", "int"],
    ["version", "boolean", "v"],
    ["help", "boolean", "h"],
    ["sshservermode", "boolean", "sshs"],
    ["inputformat", "value", "if"],
    ["outputformat", "value", "of"],
    ["executionpolicy", "value", "ep"],
    ["windowstyle", "value", "w"],
    ["configurationname", "value", "configurationn"],
    ["configurationfile", "value", "configurationf"],
    ["custompipename", "value", "cu"],
    ["settingsfile", "value", "set"],
  ];

const pwshSwitchAliases = new Map<string, PwshSwitchKind>([
  ["?", "boolean"],
  ["ec", "encodedCommand"],
  ["cwa", "commandWithArgs"],
  ["wd", "workingDirectory"],
  ["ea", "unsupported"],
  ["if", "value"],
  ["of", "value"],
  ["ep", "value"],
]);

const classifyPwshSwitch = (raw: string): PwshSwitchKind | undefined => {
  const normalized = raw.replace(/^[/\-–-―]+/u, "").toLowerCase();

  if (normalized.length === 0) {
    return undefined;
  }

  const alias = pwshSwitchAliases.get(normalized);

  if (alias !== undefined) {
    return alias;
  }

  const matches = pwshSwitchTable.filter(
    ([full, , minPrefix]) =>
      full.startsWith(normalized) && normalized.length >= minPrefix.length
  );

  return matches.length === 1 ? matches[0]?.[1] : undefined;
};

const isPwshSwitchToken = (raw: string): boolean =>
  raw.length > 1 && /^[/\-–-―]/u.test(raw);

const readPwshCommandArgs = (
  words: readonly ShellToken[],
  index: number,
  kind: "command" | "commandWithArgs" | "encodedCommand"
): string => {
  const target = words[index];

  if (target === undefined || target.expansion === true) {
    throw inspectionError(
      "Cannot parse an expanded or missing pwsh command body reliably. Use a literal command."
    );
  }

  if (kind === "encodedCommand") {
    return decodePwshEncodedCommand(target.value);
  }

  if (kind === "commandWithArgs") {
    return target.value;
  }

  if (target.value === "-") {
    throw inspectionError(
      "Cannot inspect pwsh -Command - reading from standard input. Supply a literal command."
    );
  }

  const remaining = words.slice(index);

  if (remaining.some((word) => word.expansion === true)) {
    throw inspectionError(
      "Cannot parse an expanded pwsh -Command body reliably. Use a literal command."
    );
  }

  return remaining.map((word) => word.value).join(" ");
};

const extractPwshBody = (
  words: readonly ShellToken[],
  start: number
): { body: string; workingDirectoryChanged: boolean } | undefined => {
  if (!/^(?:.*[/\\])?pwsh(?:\.exe)?$/iu.test(words[start]?.value ?? "")) {
    return undefined;
  }

  let index = start + 1;
  let workingDirectoryChanged = false;

  while (index < words.length) {
    const token = words[index];

    if (token === undefined) {
      break;
    }

    if (token.expansion === true) {
      throw inspectionError(
        "Cannot inspect dynamic pwsh arguments reliably. Use literal arguments."
      );
    }

    if (!isPwshSwitchToken(token.value)) {
      throw inspectionError(
        "Cannot inspect positional pwsh script files reliably. Pass a literal -Command or run git commit directly."
      );
    }

    const kind = classifyPwshSwitch(token.value);

    if (kind === undefined || kind === "unsupported") {
      throw inspectionError(
        `Cannot inspect unsupported pwsh switch "${token.value}" reliably. Use literal -Command or run git commit directly.`
      );
    }

    if (kind === "boolean") {
      index += 1;
    } else if (kind === "value" || kind === "workingDirectory") {
      workingDirectoryChanged ||= kind === "workingDirectory";
      index += 2;
    } else {
      return {
        body: readPwshCommandArgs(words, index + 1, kind),
        workingDirectoryChanged,
      };
    }
  }

  return undefined;
};

interface PipelineStage {
  tokens: ShellToken[];
  pipeline: boolean;
  pipedHereString?: string;
}

const splitPipelines = (
  tokens: readonly ShellToken[],
  mode: ShellMode
): PipelineStage[] => {
  const result: PipelineStage[] = [];
  let stages: ShellToken[][] = [];
  let current: ShellToken[] = [];

  const flush = (): void => {
    if (current.length > 0) {
      stages.push(current);
      current = [];
    }

    if (stages.length === 0) {
      return;
    }

    const isPipeline = stages.length > 1;
    const [firstStage] = stages;

    const pipedHereString =
      mode === "pwsh" &&
      stages.length === 2 &&
      firstStage?.length === 1 &&
      firstStage[0]?.type === "word" &&
      firstStage[0].hereString?.quoted === true
        ? firstStage[0].hereString.body
        : undefined;

    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      const stageTokens = stages[stageIndex];

      if (stageTokens !== undefined) {
        result.push({
          tokens: stageTokens,
          pipeline: isPipeline,
          pipedHereString: stageIndex === 1 ? pipedHereString : undefined,
        });
      }
    }

    stages = [];
  };

  for (const token of tokens) {
    if (token.type === "operator") {
      if (token.value === "|" || token.value === "|&") {
        if (current.length > 0) {
          stages.push(current);
          current = [];
        }
      } else if (
        token.value !== "\n" ||
        current.length > 0 ||
        stages.length === 0
      ) {
        flush();
      }
    } else {
      current.push(token);
    }
  }

  flush();

  return result;
};

const attachPwshStdin = (
  invocation: GitCommitInvocation,
  stage: PipelineStage
): GitCommitInvocation => {
  if (!invocation.filePaths.includes("-")) {
    return invocation;
  }

  if (stage.pipedHereString !== undefined) {
    return {
      ...invocation,
      stdinMessage: stage.pipedHereString,
    };
  }

  return {
    ...invocation,
    stdinError:
      "In PowerShell, pipe a single literal here-string (@'...'@ | git commit -F -) or pass -m directly.",
  };
};

const resolveCommandStart = (
  words: readonly ShellToken[],
  values: readonly string[],
  mode: ShellMode
): number => {
  if (mode === "posix") {
    return findCommandStart(values);
  }

  if (words[0]?.value === "&") {
    if (words[1] === undefined || words[1].expansion === true) {
      throw inspectionError(
        "Cannot inspect a dynamic PowerShell call operator (& $cmd). Use literal command words."
      );
    }

    return 1;
  }

  return 0;
};

const isTargetMutatorCommand = (
  values: readonly string[],
  start: number,
  mode: ShellMode
): boolean => {
  const commandName = values[start] ?? "";

  if (mode === "pwsh") {
    return (
      pwshTargetMutators.has(commandName.toLowerCase()) ||
      /^\$\{?env:/iu.test(values[0] ?? "")
    );
  }

  return (
    targetMutators.has(commandName) ||
    (values.length > 0 && values.every(isAssignment))
  );
};

export interface ExtractOptions {
  readonly shell?: ShellMode;
}

const extractGitCommitsInternal = (
  command: string,
  mode: ShellMode,
  inheritedDirectoryChange: boolean,
  depth: number
): GitCommitInvocation[] => {
  if (depth > 12 || command.length > 262_144) {
    throw inspectionError(
      "Shell parsing limit exceeded. Simplify the unsupported syntax."
    );
  }

  const tokens =
    mode === "pwsh" ? tokenizePwsh(command) : tokenizeShell(command);

  const invocations: GitCommitInvocation[] = [];
  let changedDirectory = inheritedDirectoryChange;

  for (const stage of splitPipelines(tokens, mode)) {
    const words = extractCommandWords(stage.tokens);
    const values = words.map((token) => token.value);
    const start = resolveCommandStart(words, values, mode);

    if (words[start]?.expansion === true) {
      throw inspectionError(
        "Cannot inspect a dynamic command name. Use literal command words."
      );
    }

    const invocation = extractInvocation(words, start, mode);
    const posixBody = extractShellCBody(words, start);
    const pwshBody = extractPwshBody(words, start);

    const wrapperChange =
      mode === "posix" &&
      values
        .slice(0, start)
        .some((word) => word === "env" || isAssignment(word));

    if (posixBody !== undefined) {
      invocations.push(
        ...extractGitCommitsInternal(
          posixBody,
          "posix",
          changedDirectory || wrapperChange,
          depth + 1
        )
      );
    }

    if (pwshBody !== undefined) {
      invocations.push(
        ...extractGitCommitsInternal(
          pwshBody.body,
          "pwsh",
          changedDirectory || wrapperChange || pwshBody.workingDirectoryChanged,
          depth + 1
        )
      );
    }

    if (isTargetMutatorCommand(values, start, mode)) {
      changedDirectory = true;
    }

    if (invocation !== undefined) {
      const target = changedDirectory
        ? {
            ...invocation,
            targetError:
              "A preceding directory or environment change makes the commit target ambiguous. Run git commit in a separate shell call with the captured workdir.",
          }
        : invocation;

      invocations.push(
        mode === "pwsh"
          ? attachPwshStdin(target, stage)
          : attachStdinHeredoc(target, stage.tokens, stage.pipeline)
      );
    }
  }

  for (const token of tokens) {
    for (const substitution of token.substitutions ?? []) {
      invocations.push(
        ...extractGitCommitsInternal(
          substitution,
          mode,
          changedDirectory,
          depth + 1
        )
      );
    }
  }

  return invocations;
};

export const extractGitCommits = (
  command: string,
  options?: ExtractOptions
): GitCommitInvocation[] =>
  extractGitCommitsInternal(command, options?.shell ?? "posix", false, 0);
