import type { GitCommitInvocation, ShellToken } from "./types.js";

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
]);

interface CommandSubstitution {
  readonly content: string;
  readonly end: number;
}

interface ANSIEscape extends CommandSubstitution {
  readonly byte?: number;
}

interface HeredocDelimiter {
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
}

interface Tokenization {
  readonly tokens: ShellToken[];
  readonly end: number;
  readonly delimiter?: HeredocDelimiter;
}

const isWordSeparator = function isWordSeparator(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\r" ||
    character === "\n" ||
    character === ";" ||
    character === "&" ||
    character === "|" ||
    character === "(" ||
    character === ")"
  );
};

const consumeCommandSubstitution = function consumeCommandSubstitution(
  command: string,
  start: number,
  nesting = 0
): CommandSubstitution {
  if (nesting > 12) {
    throw inspectionError(
      "Shell parsing limit exceeded. Simplify the unsupported syntax."
    );
  }

  let depth = 1;
  let quote: "'" | '"' | "$'" | undefined;
  let i = start + 2;
  let atWordStart = true;
  let atCommandStart = true;
  let timeOption = false;

  let arithmeticDepth: number | undefined =
    command[start + 2] === "(" ? 1 : undefined;

  const pendingHeredocs: HeredocDelimiter[] = [];

  const cases: {
    depth: number;
    phase: "word" | "in" | "pattern" | "body";
    patternStart: boolean;
  }[] = [];

  while (i < command.length) {
    const character = command[i];

    if (character === undefined) {
      break;
    }

    const activeCase = cases.at(-1);

    const consumedQuote = (() => {
      if (quote === "$'") {
        if (character === "'") {
          quote = undefined;
        } else if (character === "\\") {
          i = ansiEscape(command, i).end;

          return true;
        }

        i += 1;

        return true;
      }

      if (quote === "'") {
        if (character === "'") {
          quote = undefined;
        }

        i += 1;

        return true;
      }

      if (quote === '"') {
        if (character === "\\") {
          i += i + 1 < command.length ? 2 : 1;
        } else if (character === '"') {
          quote = undefined;
          i += 1;
        } else if (character === "$" && command[i + 1] === "(") {
          i = consumeCommandSubstitution(command, i, nesting + 1).end;
        } else if (character === "$" && command[i + 1] === "{") {
          i = consumeQuotedParameter(command, i);
        } else if (character === "`") {
          i = consumeBackticks(command, i, true).end;
        } else {
          i += 1;
        }

        return true;
      }

      return false;
    })();

    if (consumedQuote) {
      continue;
    }

    const consumedEscapeOrHeredoc = (() => {
      if (character === "\\") {
        if (command[i + 1] !== "\n") {
          if (activeCase?.depth === depth && activeCase.phase === "pattern") {
            activeCase.patternStart = false;
          }

          atWordStart = false;
          atCommandStart = false;
        }

        i += i + 1 < command.length ? 2 : 1;

        return true;
      }

      if (
        arithmeticDepth === undefined &&
        character === "<" &&
        command[i + 1] === "<"
      ) {
        if (command[i + 2] === "<") {
          i += 3;
        } else {
          const parsed = tokenizeShellInput(command, i, true, nesting + 1);

          if (parsed.delimiter === undefined) {
            throw incompleteHeredoc();
          }

          pendingHeredocs.push(parsed.delimiter);
          i = parsed.end;
        }

        atWordStart = true;

        return true;
      }

      if (character === "\n" && pendingHeredocs.length > 0) {
        i += 1;

        for (const heredoc of pendingHeredocs) {
          i = consumeHeredoc(command, i, heredoc).end;
        }

        pendingHeredocs.length = 0;
        atWordStart = true;
        atCommandStart = true;
        timeOption = false;

        return true;
      }

      return false;
    })();

    if (consumedEscapeOrHeredoc) {
      continue;
    }

    const consumedCaseTerminator = (() => {
      if (
        activeCase?.depth === depth &&
        activeCase.phase === "body" &&
        character === ";" &&
        (command[i + 1] === ";" || command[i + 1] === "&")
      ) {
        i += command.slice(i, i + 3) === ";;&" ? 3 : 2;
        activeCase.phase = "pattern";
        activeCase.patternStart = true;
        atWordStart = true;
        atCommandStart = true;

        return true;
      }

      return false;
    })();

    if (consumedCaseTerminator) {
      continue;
    }

    (() => {
      if (
        (atCommandStart ||
          activeCase?.phase === "word" ||
          activeCase?.phase === "in" ||
          activeCase?.phase === "pattern") &&
        atWordStart &&
        !isWordSeparator(character) &&
        character !== "#"
      ) {
        const word = (() => {
          let headerWord = "";

          for (let end = i; end < command.length; end += 1) {
            const next = command[end];

            if (next === "\\" && command[end + 1] === "\n") {
              end += 1;
              continue;
            }

            if (isWordSeparator(next)) {
              break;
            }

            headerWord += next;
          }

          return headerWord;
        })();

        const patternWord = activeCase?.phase === "pattern";

        (() => {
          if (activeCase?.depth === depth && activeCase.phase === "word") {
            activeCase.phase = "in";
          } else if (activeCase?.depth === depth && activeCase.phase === "in") {
            if (word !== "in") {
              throw inspectionError(
                "Cannot parse case header. Simplify the unsupported syntax."
              );
            }

            activeCase.phase = "pattern";
          } else if (
            word === "esac" &&
            activeCase?.depth === depth &&
            (activeCase.phase !== "pattern" || activeCase.patternStart)
          ) {
            cases.pop();
          } else if (word === "case" && activeCase?.phase !== "pattern") {
            cases.push({ depth, phase: "word", patternStart: true });
          }
        })();

        if (activeCase !== undefined && patternWord) {
          activeCase.patternStart = false;
        }

        if (!patternWord && (word === "function" || word === "coproc")) {
          throw inspectionError(
            "Cannot parse function or coproc declarations inside a command substitution. Run the declaration separately."
          );
        }

        (() => {
          atCommandStart =
            (timeOption && (word === "-p" || word === "--")) ||
            commandPrefixes.has(word) ||
            word === "{";
          timeOption = word === "time" || (timeOption && word === "-p");
        })();
      }
    })();

    const consumedQuotedStartOrSubstitution = (() => {
      if (character === "$" && command[i + 1] === "'") {
        quote = "$'";
        atWordStart = false;
        i += 2;

        return true;
      }

      if (character === "'") {
        quote = "'";
        atWordStart = false;
        i += 1;

        return true;
      }

      if (character === '"') {
        quote = '"';
        atWordStart = false;
        i += 1;

        return true;
      }

      if (character === "#" && atWordStart) {
        while (i < command.length && command[i] !== "\n") {
          i += 1;
        }

        return true;
      }

      if (character === "$" && command[i + 1] === "(") {
        i = consumeCommandSubstitution(command, i, nesting + 1).end;
        atWordStart = false;

        return true;
      }

      if (character === "`") {
        i = consumeBackticks(command, i).end;
        atWordStart = false;

        return true;
      }

      return false;
    })();

    if (consumedQuotedStartOrSubstitution) {
      continue;
    }

    let completed: CommandSubstitution | undefined;

    const consumedParenthesis = (() => {
      if (character === "(") {
        if (activeCase?.depth === depth && activeCase.phase === "pattern") {
          activeCase.patternStart = false;
          i += 1;
          atWordStart = true;

          return true;
        }

        if (
          arithmeticDepth === undefined &&
          atCommandStart &&
          command[i + 1] === "("
        ) {
          arithmeticDepth = depth;
        }

        depth += 1;
        i += 1;
        atWordStart = true;
        atCommandStart = true;

        return true;
      }

      if (character === ")") {
        if (activeCase?.depth === depth && activeCase.phase === "pattern") {
          activeCase.phase = "body";
          atCommandStart = true;
          atWordStart = true;
          i += 1;

          return true;
        }

        depth -= 1;

        if (depth === arithmeticDepth) {
          arithmeticDepth = undefined;
        }

        if (depth === 0) {
          if (pendingHeredocs.length > 0) {
            throw incompleteHeredoc();
          }

          completed = { content: command.slice(start + 2, i), end: i + 1 };

          return true;
        }

        atWordStart = true;
      }

      return false;
    })();

    if (completed !== undefined) {
      return completed;
    }

    if (consumedParenthesis) {
      continue;
    }

    if ([";", "&", "|", "\n", ")"].includes(character)) {
      atCommandStart = true;
      timeOption = false;
    }

    atWordStart = isWordSeparator(character);

    i += 1;
  }

  if (pendingHeredocs.length > 0) {
    throw incompleteHeredoc();
  }

  throw inspectionError(
    `Unterminated $( substitution starting at character ${start + 1}. Close it with ) or use single quotes for literal text.`
  );
};

const consumeBackticks = function consumeBackticks(
  command: string,
  start: number,
  doubleQuoted = false
): CommandSubstitution {
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

const consumeQuotedParameter = function consumeQuotedParameter(
  command: string,
  start: number,
  nesting = 0
): number {
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

const inspectionError = function inspectionError(message: string): Error {
  return new Error(
    `[commit-guard] Pre-execution shell inspection failed: ${message}`
  );
};

const ansiEscape = function ansiEscape(
  command: string,
  start: number
): ANSIEscape {
  const escaped = command[start + 1] ?? "";

  const simple = new Map(
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

  const literal = simple.get(escaped);

  if (literal !== undefined) {
    return { content: literal, end: start + 2 };
  }

  if (
    escaped === "c" &&
    command[start + 2] !== undefined &&
    command[start + 2] !== "'"
  ) {
    const character = command[start + 2];

    const end =
      start + (character === "\\" && command[start + 3] === "\\" ? 4 : 3);

    return {
      content: String.fromCodePoint(
        character === "?"
          ? 127
          : (character.toUpperCase().codePointAt(0) ?? 0) & 31
      ),
      end,
    };
  }

  const count =
    new Map([
      ["x", 2],
      ["u", 4],
      ["U", 8],
    ]).get(escaped) ?? 0;

  const digits =
    count > 0
      ? new RegExp(`^[0-9a-fA-F]{1,${count}}`, "u").exec(
          command.slice(start + 2)
        )?.[0]
      : /^[0-7]{1,3}/u.exec(command.slice(start + 1))?.[0];

  if (digits !== undefined) {
    const radix = count > 0 ? 16 : 8;
    const code = Number.parseInt(digits, radix);

    if (code > 0x10_ff_ff) {
      throw inspectionError(
        "Cannot validate this ANSI-C escape. Supply literal text."
      );
    }

    const end = start + (count > 0 ? 2 : 1) + digits.length;

    if (count === 0 || escaped === "x") {
      return { content: "", byte: code & 255, end };
    }

    return { content: String.fromCodePoint(code), end };
  }

  return { content: `\\${escaped}`, end: start + 2 };
};

const pushWord = function pushWord(
  tokens: ShellToken[],
  value: string,
  substitutions: readonly string[],
  expansion: boolean
): void {
  const token: ShellToken =
    substitutions.length > 0
      ? { type: "word", value, substitutions }
      : { type: "word", value };

  tokens.push(expansion ? { ...token, expansion: true } : token);
};

const heredocSubstitutions = function heredocSubstitutions(
  body: string
): string[] {
  const substitutions: string[] = [];

  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "\\" && ["\\", "$", "`"].includes(body[i + 1] ?? "")) {
      i += 1;
    } else if (body[i] === "`") {
      throw inspectionError(
        "Cannot validate command substitutions in an unquoted heredoc. Quote the delimiter, for example: <<'EOF'."
      );
    } else if (body[i] === "$" && body[i + 1] === "(") {
      const substitution = consumeCommandSubstitution(body, i);

      substitutions.push(substitution.content);
      i = substitution.end - 1;
    }
  }

  return substitutions;
};

const incompleteHeredoc = function incompleteHeredoc(): Error {
  return inspectionError(
    "Cannot validate an incomplete heredoc. Close its delimiter on a separate line before running the command."
  );
};

const consumeHeredoc = function consumeHeredoc(
  command: string,
  start: number,
  heredoc: HeredocDelimiter
): CommandSubstitution {
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

const tokenizeShell = function tokenizeShell(command: string): ShellToken[] {
  return tokenizeShellInput(command).tokens;
};

const tokenizeShellInput = function tokenizeShellInput(
  command: string,
  start = 0,
  delimiterOnly = false,
  nesting = 0
): Tokenization {
  const tokens: ShellToken[] = [];
  const pendingHeredocs: (HeredocDelimiter & { index: number })[] = [];
  let pendingDelimiter: number | undefined;
  let i = start;

  while (i < command.length) {
    const character = command[i];

    if (character === undefined) {
      break;
    }

    const skippedTrivia = (() => {
      if (character === " " || character === "\t" || character === "\r") {
        i += 1;

        return true;
      }

      if (character === "\\" && command[i + 1] === "\n") {
        i += 2;

        return true;
      }

      if (character === "#") {
        while (i < command.length && command[i] !== "\n") {
          i += 1;
        }

        return true;
      }

      return false;
    })();

    if (skippedTrivia) {
      continue;
    }

    const twoCharacters = command.slice(i, i + 2);
    let standaloneBrace = false;

    (() => {
      if (
        delimiterOnly &&
        pendingDelimiter !== undefined &&
        (isWordSeparator(character) || character === "<" || character === ">")
      ) {
        throw incompleteHeredoc();
      }
    })();

    if (character === "{" || character === "}") {
      const braceCommandPosition = (() => {
        let commandPosition = true;

        for (let index = tokens.length - 1; index >= 0; index -= 1) {
          const token = tokens[index];

          if (token.type === "operator") {
            break;
          }

          if (token.type === "word") {
            const precedingWord =
              tokens[index - 1]?.type === "word"
                ? tokens[index - 1]?.value
                : undefined;

            if (index === tokens.length - 1 && token.value === "coproc") {
              continue;
            }

            const followsTime = () =>
              precedingWord === "time" ||
              (precedingWord === "-p" &&
                tokens[index - 2]?.type === "word" &&
                tokens[index - 2]?.value === "time");

            if (token.value === "--" && followsTime()) {
              continue;
            }

            if (
              (index === tokens.length - 1 &&
                (precedingWord === "function" || precedingWord === "coproc")) ||
              (precedingWord === "time" && token.value === "-p")
            ) {
              index -= 1;
              continue;
            }
          }

          if (token.type !== "word" || !commandPrefixes.has(token.value)) {
            commandPosition = false;
            break;
          }
        }

        return commandPosition;
      })();

      let braceEnd = i + 1;

      while (command[braceEnd] === "\\" && command[braceEnd + 1] === "\n") {
        braceEnd += 2;
      }

      standaloneBrace =
        braceCommandPosition &&
        (command[braceEnd] === undefined ||
          isWordSeparator(command[braceEnd]) ||
          command[braceEnd] === "<" ||
          command[braceEnd] === ">");
    }

    const consumedOperator = (() => {
      if (
        twoCharacters === "&&" ||
        twoCharacters === "||" ||
        twoCharacters === "|&" ||
        twoCharacters === ";;"
      ) {
        tokens.push({ type: "operator", value: twoCharacters });
        i += 2;

        return true;
      }

      if (
        character === "|" ||
        character === ";" ||
        (character === "&" && command[i + 1] !== ">") ||
        character === "\n" ||
        character === "(" ||
        character === ")" ||
        standaloneBrace
      ) {
        tokens.push({ type: "operator", value: character });
        i += 1;

        if (character === "\n" && pendingHeredocs.length > 0) {
          for (const heredoc of pendingHeredocs) {
            const body = consumeHeredoc(command, i, heredoc);

            i = body.end;
            tokens[heredoc.index] = {
              ...tokens[heredoc.index],
              heredoc: { body: body.content, quoted: heredoc.quoted },
              substitutions: heredoc.quoted
                ? undefined
                : heredocSubstitutions(body.content),
            };
          }

          pendingHeredocs.length = 0;
        }

        return true;
      }

      return false;
    })();

    if (consumedOperator) {
      continue;
    }

    const redirectMatch =
      /^(?:\d+)?(?:<<<|<<-|>>|<<|>&|<&|<>|>\||>|<)|^&>>?/u.exec(
        command.slice(i)
      );

    if (redirectMatch !== null && redirectMatch[0] !== undefined) {
      tokens.push({ type: "redirect", value: redirectMatch[0] });

      if (/^\d*<<-?$/u.test(redirectMatch[0])) {
        pendingDelimiter = tokens.length - 1;
      }

      i += redirectMatch[0].length;
      continue;
    }

    const result = (() => {
      let value = "";
      const wordBytes: number[] = [];
      let quoted = false;
      let unsupportedDelimiter: "ANSI-C quoted" | "locale-quoted" | undefined;
      let expansion = false;
      const substitutions: string[] = [];

      while (i < command.length) {
        const current = command[i];

        if (current === undefined || isWordSeparator(current)) {
          break;
        }

        if (current === "\\" && command[i + 1] === "\n") {
          i += 2;
          continue;
        }

        if (current === "\\") {
          quoted = true;

          if (i + 1 < command.length) {
            value += command[i + 1];
            i += 2;
          } else {
            value += "\\";
            i += 1;
          }

          continue;
        }

        (() => {
          if (current === "$") {
            let quoteStart = i + 1;

            while (
              command[quoteStart] === "\\" &&
              command[quoteStart + 1] === "\n"
            ) {
              quoteStart += 2;
            }

            if (command[quoteStart] === '"') {
              unsupportedDelimiter = "locale-quoted";
            } else if (command[quoteStart] === "'") {
              unsupportedDelimiter = "ANSI-C quoted";
            }
          }
        })();

        if (current === "$" && command[i + 1] === "'") {
          (() => {
            const quoteStart = i;

            wordBytes.push(...Buffer.from(value));
            value = "";
            quoted = true;
            unsupportedDelimiter = "ANSI-C quoted";
            i += 2;
            const bytes: number[] = [];
            let complete = false;

            while (i < command.length) {
              const ansiCharacter = command[i];

              if (ansiCharacter === undefined) {
                break;
              }

              if (ansiCharacter === "'") {
                i += 1;
                complete = true;
                break;
              }

              if (ansiCharacter === "\\" && i + 1 < command.length) {
                const escaped = ansiEscape(command, i);

                bytes.push(
                  ...(escaped.byte === undefined
                    ? Buffer.from(escaped.content)
                    : [escaped.byte])
                );
                i = escaped.end;
              } else {
                const literal = String.fromCodePoint(
                  command.codePointAt(i) ?? 0
                );

                bytes.push(...Buffer.from(literal));
                i += literal.length;
              }
            }

            if (!complete) {
              throw inspectionError(
                `Unterminated ANSI-C quote starting at character ${quoteStart + 1}. Close the quote before running the command.`
              );
            }

            const nul = bytes.indexOf(0);

            wordBytes.push(...(nul === -1 ? bytes : bytes.slice(0, nul)));
          })();

          continue;
        }

        if (current === "'") {
          (() => {
            const quoteStart = i;

            quoted = true;
            i += 1;

            while (i < command.length && command[i] !== "'") {
              value += command[i];
              i += 1;
            }

            if (command[i] !== "'") {
              throw inspectionError(
                `Unterminated single quote starting at character ${quoteStart + 1}. Close the quote before running the command.`
              );
            }

            i += 1;
          })();

          continue;
        }

        if (current === '"') {
          (() => {
            const quoteStart = i;

            quoted = true;
            i += 1;

            while (i < command.length && command[i] !== '"') {
              const quotedCharacter = command[i];

              if (quotedCharacter === undefined) {
                break;
              }

              if (quotedCharacter === "\\" && i + 1 < command.length) {
                const escaped = command[i + 1];

                if (escaped === "\n") {
                  // A double-quoted line continuation contributes no text.
                } else if (
                  escaped === '"' ||
                  escaped === "\\" ||
                  escaped === "$" ||
                  escaped === "`"
                ) {
                  value += escaped;
                } else {
                  value += `\\${escaped}`;
                }

                i += 2;
              } else if (quotedCharacter === "$" && command[i + 1] === "(") {
                const substitution = consumeCommandSubstitution(
                  command,
                  i,
                  nesting
                );

                value += command.slice(i, substitution.end);
                substitutions.push(substitution.content);
                expansion = true;
                i = substitution.end;
              } else if (quotedCharacter === "$" && command[i + 1] === "{") {
                const end = consumeQuotedParameter(command, i);

                value += command.slice(i, end);
                expansion = true;
                i = end;
              } else if (quotedCharacter === "`") {
                const substitution = consumeBackticks(command, i, true);

                value += command.slice(i, substitution.end);
                substitutions.push(substitution.content);
                expansion = true;
                i = substitution.end;
              } else {
                if (
                  quotedCharacter === "$" &&
                  /[a-zA-Z0-9_{[*#?@!$-]/u.test(command[i + 1] ?? "")
                ) {
                  expansion = true;
                }

                value += quotedCharacter;
                i += 1;
              }
            }

            if (command[i] !== '"') {
              throw inspectionError(
                `Unterminated double quote starting at character ${quoteStart + 1}. Close the quote before running the command.`
              );
            }

            i += 1;
          })();

          continue;
        }

        if (current === "$" && command[i + 1] === "(") {
          const substitution = consumeCommandSubstitution(command, i, nesting);
          value += command.slice(i, substitution.end);
          substitutions.push(substitution.content);
          expansion = true;
          i = substitution.end;
          continue;
        }

        if (current === "`") {
          const substitution = consumeBackticks(command, i);

          value += command.slice(i, substitution.end);
          substitutions.push(substitution.content);
          expansion = true;
          i = substitution.end;
          continue;
        }

        if (
          current === "$" &&
          /[a-zA-Z0-9_{[*#?@!$-]/u.test(command[i + 1] ?? "")
        ) {
          expansion = true;
        }

        const nextRedirect = /^(?:<<<|<<-|>>|<<|>&|<&|<>|>\||>|<)/u.exec(
          command.slice(i)
        );

        if (nextRedirect !== null) {
          break;
        }

        value += current;
        i += 1;
      }

      const finishedWord = (() => {
        if (wordBytes.length > 0) {
          value = Buffer.from([...wordBytes, ...Buffer.from(value)]).toString(
            "utf-8"
          );
        }

        pushWord(tokens, value, substitutions, expansion);

        if (pendingDelimiter !== undefined) {
          if (unsupportedDelimiter !== undefined) {
            throw inspectionError(
              `Cannot validate this ${unsupportedDelimiter} heredoc delimiter. Use a plain quoted delimiter such as <<'EOF'.`
            );
          }

          const delimiter = {
            delimiter: value,
            quoted,
            stripTabs: tokens[pendingDelimiter]?.value.endsWith("-"),
          };

          if (delimiterOnly) {
            return { tokens, end: i, delimiter };
          }

          pendingHeredocs.push({ index: pendingDelimiter, ...delimiter });
          pendingDelimiter = undefined;
        }

        return null;
      })();

      return finishedWord;
    })();

    if (result !== null) {
      return result;
    }
  }

  return { tokens, end: i };
};

const splitSimpleCommands = function splitSimpleCommands(
  tokens: readonly ShellToken[]
): { tokens: ShellToken[]; pipeline: boolean }[] {
  const commands: { tokens: ShellToken[]; pipeline: boolean }[] = [];
  let current: ShellToken[] = [];
  let precedingPipeline = false;

  for (const token of tokens) {
    if (token.type === "operator") {
      const isPipeline = token.value === "|" || token.value === "|&";

      const hasCommand = current.length > 0;

      if (hasCommand) {
        commands.push({
          tokens: current,
          pipeline: precedingPipeline || isPipeline,
        });
      }

      current = [];

      if (hasCommand || token.value !== "\n") {
        precedingPipeline = isPipeline;
      }
    } else {
      current.push(token);
    }
  }

  if (current.length > 0) {
    commands.push({ tokens: current, pipeline: precedingPipeline });
  }

  return commands;
};

const extractCommandWords = function extractCommandWords(
  tokens: readonly ShellToken[]
): ShellToken[] {
  const words: ShellToken[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token === undefined) {
      break;
    }

    if (token.type === "redirect") {
      i += tokens[i + 1]?.type === "word" ? 2 : 1;

      continue;
    }

    if (token.type === "word") {
      words.push(token);
    }

    i += 1;
  }

  return words;
};

const isAssignment = function isAssignment(word: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*=/u.test(word);
};

const skipAssignments = function skipAssignments(
  words: readonly string[],
  start: number
): number {
  let index = start;

  while (words[index] !== undefined && isAssignment(words[index])) {
    index += 1;
  }

  return index;
};

const findCommandStart = function findCommandStart(
  words: readonly string[]
): number {
  let index = skipAssignments(words, 0);

  while (index < words.length) {
    const word = words[index];

    if (word !== undefined && commandPrefixes.has(word)) {
      index = skipAssignments(words, index + 1);
      continue;
    }

    if (word === "env") {
      index += 1;

      (() => {
        while (index < words.length) {
          const argument = words[index];

          if (argument === undefined) {
            break;
          }

          if (argument === "--") {
            index += 1;
            break;
          }

          if (argument === "-u" || argument === "--unset") {
            index += 2;
          } else if (argument === "-C" || argument === "--chdir") {
            index += 2;
          } else if (
            argument.startsWith("--chdir=") ||
            /^-C.+/u.test(argument)
          ) {
            index += 1;
          } else if (
            argument.startsWith("--unset=") ||
            /^-u.+/u.test(argument)
          ) {
            index += 1;
          } else if (argument.startsWith("-")) {
            index += 1;
          } else if (isAssignment(argument)) {
            index += 1;
          } else {
            break;
          }
        }
      })();

      index = skipAssignments(words, index);
      continue;
    }

    if (word === "exec") {
      index += 1;

      while (index < words.length) {
        const argument = words[index];

        if (argument === "--") {
          index += 1;
          break;
        }

        if (argument === "-a") {
          index += 2;
        } else if (argument !== undefined && argument.startsWith("-")) {
          index += 1;
        } else {
          break;
        }
      }

      index = skipAssignments(words, index);
      continue;
    }

    if (word === "command" || word === "nohup" || word === "builtin") {
      index += 1;

      while (words[index]?.startsWith("-")) {
        index += 1;
      }

      index = skipAssignments(words, index);
      continue;
    }

    break;
  }

  return index;
};

const extractInvocation = function extractInvocation(
  words: readonly string[],
  commandStart: number,
  wordTokens: readonly ShellToken[]
): GitCommitInvocation | undefined {
  let wordIndex = commandStart;
  const executable = words[wordIndex];

  if (
    executable === undefined ||
    (executable !== "git" && !executable.endsWith("/git"))
  ) {
    return undefined;
  }

  wordIndex += 1;
  let subcommand: string | undefined;

  let targetError = words
    .slice(0, commandStart)
    .some((word) => word === "env" || isAssignment(word) || word === "export")
    ? "Environment or wrapper changes can redirect a Git commit target. Use a direct git commit in the captured workdir."
    : undefined;

  const readSubcommand = () => {
    while (wordIndex < words.length) {
      const argument = words[wordIndex];

      if (argument === undefined) {
        break;
      }

      if (wordTokens[wordIndex]?.expansion === true) {
        throw inspectionError(
          "Cannot inspect dynamic Git options or subcommands. Use literal command words."
        );
      }

      if (argument === "--") {
        if (wordTokens[wordIndex + 1]?.expansion === true) {
          throw inspectionError(
            "Cannot inspect a dynamic Git subcommand. Use literal command words."
          );
        }

        subcommand = words[wordIndex + 1];
        wordIndex += 2;
        break;
      }

      if (gitGlobalOptionsWithArg.has(argument)) {
        if (
          ["-C", "--git-dir", "--work-tree", "-c", "--config-env"].includes(
            argument
          )
        ) {
          targetError =
            "Git global directory or configuration flags can change the commit target or signing policy. Use a direct git commit in the captured workdir.";
        }

        wordIndex += 2;
        continue;
      }

      const consumedAttachedGlobal = (() => {
        if (
          argument.startsWith("--git-dir=") ||
          argument.startsWith("--work-tree=") ||
          argument.startsWith("--namespace=") ||
          argument.startsWith("--exec-path=") ||
          argument.startsWith("--super-prefix=") ||
          argument.startsWith("--config-env=") ||
          argument.startsWith("-c")
        ) {
          if (
            argument.startsWith("--git-dir=") ||
            argument.startsWith("--work-tree=") ||
            argument.startsWith("--config-env=") ||
            argument.startsWith("-c")
          ) {
            targetError =
              "Git global directory or configuration flags can change the commit target or signing policy. Use a direct git commit in the captured workdir.";
          }

          wordIndex += 1;

          return true;
        }

        return false;
      })();

      if (consumedAttachedGlobal) {
        continue;
      }

      if (argument.startsWith("-C")) {
        targetError =
          "git -C can change the commit target. Run git commit directly in the captured workdir.";
        wordIndex += 1;
        continue;
      }

      if (argument.startsWith("-")) {
        wordIndex += 1;
        continue;
      }

      subcommand = argument;
      wordIndex += 1;
      break;
    }
  };

  readSubcommand();

  if (subcommand !== "commit") {
    return undefined;
  }

  const messages: string[] = [];
  const filePaths: string[] = [];
  let hasSignoffFlag = false;
  let isAmend = false;
  let hasNoEdit = false;
  let isFixup = false;
  let isHelp = false;
  let messageExpansion = false;
  let hasTrailer = false;

  const collectMessage = (word: string | undefined): void => {
    if (word === undefined) {
      return;
    }

    messages.push(word);
  };

  const collectFile = (word: string | undefined): void => {
    if (word === undefined) {
      return;
    }

    filePaths.push(word);
  };

  for (let index = wordIndex; index < words.length; index += 1) {
    const argument = words[index];

    if (argument === undefined) {
      break;
    }

    const equalsIndex = argument.indexOf("=");

    const longOptionName =
      equalsIndex > 0 ? argument.slice(0, equalsIndex) : argument;

    if (argument === "--") {
      break;
    }

    const consumedBooleanFlag = (() => {
      if (argument === "-h" || argument === "--help") {
        isHelp = true;
      } else if (argument === "--amend") {
        isAmend = true;
      } else if (argument === "--no-edit") {
        hasNoEdit = true;
      } else if (argument === "--edit") {
        hasNoEdit = false;
      } else if (argument === "-s" || argument === "--signoff") {
        hasSignoffFlag = true;
      } else if (argument === "--no-signoff") {
        hasSignoffFlag = false;
      } else {
        return false;
      }

      return true;
    })();

    if (consumedBooleanFlag) {
      continue;
    }

    const consumedMessageOption = (() => {
      if (argument === "-m" || argument === "--message") {
        index += 1;
        messageExpansion ||= wordTokens[index]?.expansion === true;
        collectMessage(words[index]);
      } else if (argument.startsWith("--message=")) {
        messageExpansion ||= wordTokens[index]?.expansion === true;
        collectMessage(argument.slice("--message=".length));
      } else if (argument === "-F" || argument === "--file") {
        index += 1;
        collectFile(words[index]);
      } else if (argument.startsWith("--file=")) {
        collectFile(argument.slice("--file=".length));
      } else {
        return false;
      }

      return true;
    })();

    if (consumedMessageOption) {
      continue;
    }

    (() => {
      if (argument === "--fixup" || argument.startsWith("--fixup=")) {
        isFixup = true;

        if (equalsIndex === -1) {
          index += 1;
        }
      } else if (longOptionName === "--trailer") {
        hasTrailer = true;

        if (equalsIndex === -1) {
          index += 1;
        }
      } else if (commitLongOptionsWithArg.has(longOptionName)) {
        if (equalsIndex === -1) {
          index += 1;
        }
      } else if (
        argument.startsWith("-") &&
        !argument.startsWith("--") &&
        argument.length > 1
      ) {
        (() => {
          for (
            let characterIndex = 1;
            characterIndex < argument.length;
            characterIndex += 1
          ) {
            const option = argument[characterIndex];

            if (option === "s") {
              hasSignoffFlag = true;
            } else if (option === "h") {
              isHelp = true;
            } else if (option === "e") {
              hasNoEdit = false;
            } else if (option === "m" || option === "F") {
              const attached = argument.slice(characterIndex + 1);

              const input =
                attached.length > 0 ? attached : words[(index += 1)];

              if (option === "m") {
                messageExpansion ||= wordTokens[index]?.expansion === true;
                collectMessage(input);
              } else {
                collectFile(input);
              }

              break;
            } else if (option === "S") {
              break;
            } else if (option === "u") {
              break;
            } else if (option === "c" || option === "C" || option === "t") {
              if (argument.slice(characterIndex + 1).length === 0) {
                index += 1;
              }

              break;
            }
          }
        })();
      }
    })();
  }

  return {
    messages,
    filePaths,
    hasSignoffFlag,
    isAmend,
    hasNoEdit,
    isFixup,
    isHelp,
    targetError,
    messageExpansion,
    hasTrailer,
  };
};

export const extractGitCommits = function extractGitCommits(
  command: string,
  inheritedDirectoryChange = false,
  depth = 0
): GitCommitInvocation[] {
  if (depth > 12 || command.length > 262_144) {
    throw inspectionError(
      "Shell parsing limit exceeded. Simplify the unsupported syntax."
    );
  }

  const tokens = tokenizeShell(command);
  const invocations: GitCommitInvocation[] = [];
  let changedDirectory = inheritedDirectoryChange;

  for (const simple of splitSimpleCommands(tokens)) {
    const commandTokens = simple.tokens;
    const wordTokens = extractCommandWords(commandTokens);
    const words = wordTokens.map((token) => token.value);
    const commandStart = findCommandStart(words);

    if (wordTokens[commandStart]?.expansion === true) {
      throw inspectionError(
        "Cannot inspect a dynamic command name. Use literal command words."
      );
    }

    const invocation = extractInvocation(words, commandStart, wordTokens);
    const directoryChanged = changedDirectory;

    (() => {
      if (/^(?:.*\/)?(?:bash|sh|zsh)$/u.test(words[commandStart] ?? "")) {
        let bodyIndex = commandStart + 1;
        let executeString = false;

        (() => {
          while (bodyIndex < words.length) {
            const option = words[bodyIndex];

            if (option === "--") {
              bodyIndex += 1;
              break;
            }

            if (!option.startsWith("-") && !option.startsWith("+")) {
              break;
            }

            if (/^-[a-zA-Z]*c[a-zA-Z]*$/u.test(option)) {
              executeString = true;
            }

            const shortOptions = /^[+-][a-zA-Z]+$/u.test(option);

            if (
              shortOptions &&
              /[oO]/u.test(option) &&
              !/[oO]$/u.test(option)
            ) {
              throw inspectionError(
                "Cannot parse shell options reliably. Simplify the unsupported syntax."
              );
            }

            const next = words[bodyIndex + 1];
            const optionName = next !== undefined && !/^[+-]/u.test(next);

            bodyIndex +=
              (shortOptions && /[oO]$/u.test(option) && optionName) ||
              ["--rcfile", "--init-file"].includes(option)
                ? 2
                : 1;
          }
        })();

        if (executeString) {
          const body = wordTokens[bodyIndex];

          if (body === undefined || body.expansion === true) {
            throw inspectionError(
              "Cannot parse an expanded or missing shell -c body reliably. Use a literal shell body; if committing, run git commit directly."
            );
          }

          if (
            /^(?:.*\/)?sh$/u.test(words[commandStart] ?? "") &&
            body.value.includes("$'")
          ) {
            throw inspectionError(
              "Cannot parse $' quoting portably in sh -c. Use a literal bash -c or zsh -c body."
            );
          }

          const wrapperChange = words
            .slice(0, commandStart)
            .some((word) => word === "env" || isAssignment(word));

          invocations.push(
            ...extractGitCommits(
              body.value,
              directoryChanged || wrapperChange,
              depth + 1
            )
          );
        }
      }
    })();

    if (
      targetMutators.has(words[commandStart] ?? "") ||
      (words.length > 0 && words.every(isAssignment))
    ) {
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

      if (!invocation.filePaths.includes("-")) {
        invocations.push(target);
        continue;
      }

      const collectStdinMessage = () => {
        const heredocs = commandTokens.filter(
          (token) => token.type === "redirect" && /^\d*<<$/u.test(token.value)
        );

        const stdinRedirects = commandTokens.filter((token) => {
          if (token.type !== "redirect") {
            return false;
          }

          const match = /^(?<descriptor>\d*)(?<direction>[<>])/u.exec(
            token.value
          );

          return (
            match !== null &&
            (match[1] === "" ? match[2] === "<" : Number(match[1]) === 0)
          );
        });

        const [heredoc] = heredocs;
        let stdinError: string | undefined;

        if (simple.pipeline) {
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

        invocations.push({
          ...target,
          stdinMessage:
            stdinError === undefined ? heredoc?.heredoc?.body : undefined,
          stdinError,
        });
      };

      collectStdinMessage();
    }
  }

  for (const token of tokens) {
    for (const substitution of token.substitutions ?? []) {
      invocations.push(
        ...extractGitCommits(substitution, changedDirectory, depth + 1)
      );
    }
  }

  return invocations;
};
