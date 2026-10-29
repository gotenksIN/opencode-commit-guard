import type { GitCommitInvocation, ShellToken } from "./types.js"

const gitGlobalOptionsWithArg = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
])

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
])

const targetMutators = new Set([
  "cd", "pushd", "popd", "chdir", "export", "typeset", "declare", "source", ".", "eval",
  "set", "unset", "readonly", "local", "setenv",
])

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
])

interface CommandSubstitution {
  readonly content: string
  readonly end: number
}

interface ANSIEscape extends CommandSubstitution {
  readonly byte?: number
}

function isWordSeparator(character: string): boolean {
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
  )
}

function consumeCommandSubstitution(command: string, start: number, nesting = 0): CommandSubstitution {
  if (nesting > 12) throw new Error("Shell parsing limit exceeded. Run git commit directly.")
  let depth = 1
  let quote: "'" | '"' | "$'" | undefined
  let i = start + 2
  let atWordStart = true
  let atCommandStart = true
  let timeOption = false

  while (i < command.length) {
    const character = command[i]

    if (character === undefined) break

    if (quote === "$'") {
      if (character === "'") quote = undefined
      else if (character === "\\") {
        i = ansiEscape(command, i).end
        continue
      }

      i++
      continue
    }

    if (quote === "'") {
      if (character === "'") quote = undefined
      i++
      continue
    }

    if (quote === '"') {
      if (character === "\\") {
        i += i + 1 < command.length ? 2 : 1
      } else if (character === '"') {
        quote = undefined
        i++
      } else if (character === "$" && command[i + 1] === "(") {
        i = consumeCommandSubstitution(command, i, nesting + 1).end
      } else if (character === "$" && command[i + 1] === "{") {
        i = consumeQuotedParameter(command, i)
      } else {
        i++
      }

      continue
    }

    if (character === "\\") {
      if (command[i + 1] !== "\n") {
        atWordStart = false
        atCommandStart = false
      }

      i += i + 1 < command.length ? 2 : 1
      continue
    }

    if (atCommandStart && atWordStart && !isWordSeparator(character) && character !== "#") {
      let word = ""

      for (let end = i; end < command.length; end++) {
        const next = command[end]!

        if (next === "\\" && command[end + 1] === "\n") {
          end++
          continue
        }

        if (isWordSeparator(next)) break
        word += next
      }

      if (word === "case") {
        throw new Error("Cannot parse case patterns inside a command substitution. Run the case command separately or run git commit directly.")
      }

      if (word === "function" || word === "coproc") {
        throw new Error("Cannot parse function or coproc declarations inside a command substitution. Run the declaration separately or run git commit directly.")
      }

      atCommandStart = timeOption && (word === "-p" || word === "--") || commandPrefixes.has(word) || word === "{"
      timeOption = word === "time" || timeOption && word === "-p"
    }

    if (character === "$" && command[i + 1] === "'") {
      quote = "$'"
      atWordStart = false
      i += 2
      continue
    }

    if (character === "'") {
      quote = "'"
      atWordStart = false
      i++
      continue
    }

    if (character === '"') {
      quote = '"'
      atWordStart = false
      i++
      continue
    }

    if (character === "#" && atWordStart) {
      while (i < command.length && command[i] !== "\n") i++
      continue
    }

    if (character === "$" && command[i + 1] === "(") {
      i = consumeCommandSubstitution(command, i, nesting + 1).end
      atWordStart = false
      continue
    }

    if (character === "(") {
      depth++
      i++
      atWordStart = true
      atCommandStart = true
      continue
    }

    if (character === ")") {
      depth--

      if (depth === 0) {
        return { content: command.slice(start + 2, i), end: i + 1 }
      }

      atWordStart = true
    }

    if ([";", "&", "|", "\n", ")"].includes(character)) {
      atCommandStart = true
      timeOption = false
    }

    if (isWordSeparator(character)) atWordStart = true
    else atWordStart = false
    i++
  }

  throw new Error("Cannot parse shell substitution reliably. Run git commit directly.")
}

function consumeBackticks(command: string, start: number, doubleQuoted = false): CommandSubstitution {
  let content = ""

  for (let i = start + 1; i < command.length; i++) {
    if (command[i] === "`") return { content, end: i + 1 }

    if (command[i] === "\\" && (["$", "`", "\\"].includes(command[i + 1] ?? "") || doubleQuoted && command[i + 1] === '"')) i++
    content += command[i]
  }

  throw new Error("Cannot parse backtick substitution reliably. Run git commit directly.")
}

function consumeQuotedParameter(command: string, start: number): number {
  for (let i = start + 2; i < command.length; i++) {
    const character = command[i]!

    if (character === "}") return i + 1

    if (["'", '"', "\\", "`", "$", "{"].includes(character)) break
  }

  throw new Error("Cannot parse nested quoting or expansions in a double-quoted parameter expansion. Use a simple parameter such as \"${HOME}\" or run git commit directly.")
}

function ansiEscape(command: string, start: number): ANSIEscape {
  const escaped = command[start + 1] ?? ""
  const simple = new Map(Object.entries({ a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" }))
  const literal = simple.get(escaped)

  if (literal !== undefined) return { content: literal, end: start + 2 }

  if (escaped === "c" && command[start + 2] !== undefined && command[start + 2] !== "'") {
    const character = command[start + 2]!
    const end = start + (character === "\\" && command[start + 3] === "\\" ? 4 : 3)

    return { content: String.fromCharCode(character === "?" ? 127 : character.toUpperCase().charCodeAt(0) & 31), end }
  }

  const count = escaped === "x" ? 2 : escaped === "u" ? 4 : escaped === "U" ? 8 : 0

  const digits = count > 0 ? command.slice(start + 2).match(new RegExp(`^[0-9a-fA-F]{1,${count}}`))?.[0] :
    command.slice(start + 1).match(/^[0-7]{1,3}/)?.[0]

  if (digits !== undefined) {
    const code = Number.parseInt(digits, count > 0 ? 16 : 8)

    if (code > 0x10ffff) throw new Error("Cannot validate this ANSI-C escape. Supply the message literally.")

    const end = start + (count > 0 ? 2 : 1) + digits.length

    if (count === 0 || escaped === "x") return { content: "", byte: code & 255, end }

    return { content: String.fromCodePoint(code), end }
  }

  return { content: `\\${escaped}`, end: start + 2 }
}

function pushWord(
  tokens: ShellToken[],
  value: string,
  substitutions: readonly string[],
  expansion: boolean,
): void {
  const token: ShellToken = substitutions.length > 0 ? { type: "word", value, substitutions } : { type: "word", value }

  tokens.push(expansion ? { ...token, expansion: true } : token)
}

function heredocSubstitutions(body: string): string[] {
  const substitutions: string[] = []

  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && (body[i + 1] === "$" || body[i + 1] === "`")) {
      i++
    } else if (body[i] === "`") {
      throw new Error("Cannot validate command substitutions in an unquoted heredoc. Quote the delimiter, for example: <<'EOF'.")
    } else if (body[i] === "$" && body[i + 1] === "(") {
      const substitution = consumeCommandSubstitution(body, i)

      substitutions.push(substitution.content)
      i = substitution.end - 1
    }
  }

  return substitutions
}

export function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  const pendingHeredocs: { index: number; delimiter: string; quoted: boolean; stripTabs: boolean }[] = []
  let pendingDelimiter: number | undefined
  let i = 0

  while (i < command.length) {
    const character = command[i]

    if (character === undefined) break

    if (character === " " || character === "\t" || character === "\r") {
      i++
      continue
    }

    if (character === "\\" && command[i + 1] === "\n") {
      i += 2
      continue
    }

    if (character === "#") {
      while (i < command.length && command[i] !== "\n") i++
      continue
    }

    const twoCharacters = command.slice(i, i + 2)
    let standaloneBrace = false

    if (character === "{" || character === "}") {
      let commandPosition = true

      for (let index = tokens.length - 1; index >= 0; index--) {
        const token = tokens[index]!

        if (token.type === "operator") break

        if (token.type === "word") {
          const precedingWord = tokens[index - 1]?.type === "word" ? tokens[index - 1]?.value : undefined

          if (index === tokens.length - 1 && token.value === "coproc") continue

          if (token.value === "--" && (precedingWord === "time" || precedingWord === "-p" &&
            tokens[index - 2]?.type === "word" && tokens[index - 2]?.value === "time")) continue

          if (index === tokens.length - 1 && (precedingWord === "function" || precedingWord === "coproc") ||
            precedingWord === "time" && token.value === "-p") {
            index--
            continue
          }
        }

        if (token.type !== "word" || !commandPrefixes.has(token.value)) {
          commandPosition = false
          break
        }
      }

      let braceEnd = i + 1

      while (command[braceEnd] === "\\" && command[braceEnd + 1] === "\n") braceEnd += 2

      standaloneBrace = commandPosition &&
        (command[braceEnd] === undefined || isWordSeparator(command[braceEnd]!) || command[braceEnd] === "<" || command[braceEnd] === ">")
    }

    if (
      twoCharacters === "&&" ||
      twoCharacters === "||" ||
      twoCharacters === "|&" ||
      twoCharacters === ";;"
    ) {
      tokens.push({ type: "operator", value: twoCharacters })
      i += 2
      continue
    }

    if (
      character === "|" ||
      character === ";" ||
      character === "&" && command[i + 1] !== ">" ||
      character === "\n" ||
      character === "(" ||
      character === ")" ||
      standaloneBrace
    ) {
      tokens.push({ type: "operator", value: character })
      i++

      if (character === "\n" && pendingHeredocs.length > 0) {
        for (const heredoc of pendingHeredocs) {
          const bodyStart = i
          let complete = false

          while (i < command.length) {
            const lineEnd = command.indexOf("\n", i)
            const end = lineEnd < 0 ? command.length : lineEnd
            const line = command.slice(i, end)
            i = lineEnd < 0 ? end : end + 1

            if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) {
              complete = true
              const rawBody = command.slice(bodyStart, i - (line.length + (lineEnd < 0 ? 0 : 1)))
              const body = heredoc.stripTabs ? rawBody.replace(/^\t+/gm, "") : rawBody

              tokens[heredoc.index] = {
                ...tokens[heredoc.index]!,
                heredoc: { body, quoted: heredoc.quoted },
                substitutions: heredoc.quoted
                  ? undefined
                  : heredocSubstitutions(body),
              }
              break
            }
          }

          if (!complete) {
            throw new Error("Cannot validate an incomplete heredoc. Close its delimiter on a separate line before running the command.")
          }
        }

        pendingHeredocs.length = 0
      }

      continue
    }

    const redirectMatch = command.slice(i).match(/^(?:\d+)?(?:<<<|<<-|>>|<<|>&|<&|<>|>\||>|<)|^&>>?/)

    if (redirectMatch !== null && redirectMatch[0] !== undefined) {
      tokens.push({ type: "redirect", value: redirectMatch[0] })

      if (/^\d*<<-?$/.test(redirectMatch[0])) pendingDelimiter = tokens.length - 1
      i += redirectMatch[0].length
      continue
    }

    let value = ""
    const wordBytes: number[] = []
    let quoted = false
    let unsupportedDelimiter = false
    let expansion = false
    const substitutions: string[] = []

    while (i < command.length) {
      const current = command[i]

      if (current === undefined || isWordSeparator(current)) break

      if (current === "\\" && command[i + 1] === "\n") {
        i += 2
        continue
      }

      if (current === "\\") {
        quoted = true

        if (i + 1 < command.length) {
          value += command[i + 1]
          i += 2
        } else {
          value += "\\"
          i++
        }

        continue
      }

      if (current === "$" && command[i + 1] === "'") {
        const quoteStart = i

        wordBytes.push(...Buffer.from(value))
        value = ""
        quoted = true
        unsupportedDelimiter = true
        i += 2
        const bytes: number[] = []
        let complete = false

        while (i < command.length) {
          const ansiCharacter = command[i]

          if (ansiCharacter === undefined) break

          if (ansiCharacter === "'") {
            i++
            complete = true
            break
          }

          if (ansiCharacter === "\\" && i + 1 < command.length) {
            const escaped = ansiEscape(command, i)

            bytes.push(...(escaped.byte === undefined ? Buffer.from(escaped.content) : [escaped.byte]))
            i = escaped.end
          } else {
            const literal = String.fromCodePoint(command.codePointAt(i)!)

            bytes.push(...Buffer.from(literal))
            i += literal.length
          }
        }

        if (!complete) throw new Error(
          `Unterminated ANSI-C quote starting at character ${quoteStart + 1}. Close the quote before running the command.`,
        )

        const nul = bytes.indexOf(0)

        wordBytes.push(...(nul < 0 ? bytes : bytes.slice(0, nul)))

        continue
      }

      if (current === "'") {
        const quoteStart = i

        quoted = true
        i++

        while (i < command.length && command[i] !== "'") {
          value += command[i]
          i++
        }

        if (command[i] !== "'") throw new Error(
          `Unterminated single quote starting at character ${quoteStart + 1}. Close the quote before running the command.`,
        )

        i++
        continue
      }

      if (current === '"') {
        const quoteStart = i

        quoted = true
        i++

        while (i < command.length && command[i] !== '"') {
          const quotedCharacter = command[i]

          if (quotedCharacter === undefined) break

          if (quotedCharacter === "\\" && i + 1 < command.length) {
            const escaped = command[i + 1]

            if (escaped === "\n") {
              i += 2
            } else if (escaped === '"' || escaped === "\\" || escaped === "$" || escaped === "`") {
              value += escaped
              i += 2
            } else {
              value += `\\${escaped}`
              i += 2
            }
          } else if (quotedCharacter === "$" && command[i + 1] === "(") {
            const substitution = consumeCommandSubstitution(command, i)
            value += command.slice(i, substitution.end)
            substitutions.push(substitution.content)
            expansion = true
            i = substitution.end
          } else if (quotedCharacter === "$" && command[i + 1] === "{") {
            const end = consumeQuotedParameter(command, i)

            value += command.slice(i, end)
            expansion = true
            i = end
          } else if (quotedCharacter === "`") {
            const substitution = consumeBackticks(command, i, true)

            value += command.slice(i, substitution.end)
            substitutions.push(substitution.content)
            expansion = true
            i = substitution.end
          } else {
            if (quotedCharacter === "$" && /[a-zA-Z0-9_{[*#?@!$-]/.test(command[i + 1] ?? "")) expansion = true
            value += quotedCharacter
            i++
          }
        }

        if (command[i] !== '"') throw new Error(
          `Unterminated double quote starting at character ${quoteStart + 1}. Close the quote before running the command.`,
        )

        i++
        continue
      }

      if (current === "$" && command[i + 1] === "(") {
        const substitution = consumeCommandSubstitution(command, i)
        value += command.slice(i, substitution.end)
        substitutions.push(substitution.content)
        expansion = true
        i = substitution.end
        continue
      }

      if (current === "`") {
        const substitution = consumeBackticks(command, i)

        value += command.slice(i, substitution.end)
        substitutions.push(substitution.content)
        expansion = true
        i = substitution.end
        continue
      }

      if (current === "$" && /[a-zA-Z0-9_{[*#?@!$-]/.test(command[i + 1] ?? "")) expansion = true

      const nextRedirect = command.slice(i).match(/^(?:<<<|<<-|>>|<<|>&|<&|<>|>\||>|<)/)

      if (nextRedirect !== null) break

      value += current
      i++
    }

    if (wordBytes.length > 0) value = Buffer.from([...wordBytes, ...Buffer.from(value)]).toString("utf8")
    pushWord(tokens, value, substitutions, expansion)

    if (pendingDelimiter !== undefined) {
      if (unsupportedDelimiter) {
        throw new Error("Cannot validate an ANSI-C quoted heredoc delimiter. Use a plain quoted delimiter such as <<'EOF'.")
      }

      pendingHeredocs.push({ index: pendingDelimiter, delimiter: value, quoted, stripTabs: tokens[pendingDelimiter]?.value.endsWith("-") === true })
      pendingDelimiter = undefined
    }
  }

  return tokens
}

function splitSimpleCommands(tokens: readonly ShellToken[]): { tokens: ShellToken[]; pipeline: boolean }[] {
  const commands: { tokens: ShellToken[]; pipeline: boolean }[] = []
  let current: ShellToken[] = []
  let precedingPipeline = false

  for (const token of tokens) {
    if (token.type === "operator") {
      const isPipeline = token.value === "|" || token.value === "|&"

      const hasCommand = current.length > 0

      if (hasCommand) commands.push({ tokens: current, pipeline: precedingPipeline || isPipeline })
      current = []

      if (hasCommand || token.value !== "\n") precedingPipeline = isPipeline
    } else {
      current.push(token)
    }
  }

  if (current.length > 0) commands.push({ tokens: current, pipeline: precedingPipeline })

  return commands
}

function extractCommandWords(tokens: readonly ShellToken[]): ShellToken[] {
  const words: ShellToken[] = []
  let i = 0

  while (i < tokens.length) {
    const token = tokens[i]

    if (token === undefined) break

    if (token.type === "redirect") {
      if (tokens[i + 1]?.type === "word") i += 2
      else i++
      continue
    }

    if (token.type === "word") {
      words.push(token)
    }

    i++
  }

  return words
}

function isAssignment(word: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(word)
}

function skipAssignments(words: readonly string[], start: number): number {
  let index = start

  while (words[index] !== undefined && isAssignment(words[index])) index++

  return index
}

function findCommandStart(words: readonly string[]): number {
  let index = skipAssignments(words, 0)

  while (index < words.length) {
    const word = words[index]

    if (word !== undefined && commandPrefixes.has(word)) {
      index = skipAssignments(words, index + 1)
      continue
    }

    if (word === "env") {
      index++

      while (index < words.length) {
        const argument = words[index]

        if (argument === undefined) break

        if (argument === "--") {
          index++
          break
        }

        if (argument === "-u" || argument === "--unset") {
          index += 2
        } else if (argument === "-C" || argument === "--chdir") {
          index += 2
        } else if (argument.startsWith("--chdir=") || /^-C.+/.test(argument)) {
          index++
        } else if (argument.startsWith("--unset=") || /^-u.+/.test(argument)) {
          index++
        } else if (argument.startsWith("-")) {
          index++
        } else if (isAssignment(argument)) {
          index++
        } else {
          break
        }
      }

      index = skipAssignments(words, index)
      continue
    }

    if (word === "exec") {
      index++

      while (index < words.length) {
        const argument = words[index]

        if (argument === "--") {
          index++
          break
        }

        if (argument === "-a") index += 2
        else if (argument !== undefined && argument.startsWith("-")) index++
        else break
      }

      index = skipAssignments(words, index)
      continue
    }

    if (word === "command" || word === "nohup" || word === "builtin") {
      index++

      while (words[index]?.startsWith("-")) index++
      index = skipAssignments(words, index)
      continue
    }

    break
  }

  return index
}

function extractInvocation(
  words: readonly string[],
  commandStart: number,
  wordTokens: readonly ShellToken[],
): GitCommitInvocation | undefined {
  let wordIndex = commandStart
  const executable = words[wordIndex]

  if (executable === undefined || (executable !== "git" && !executable.endsWith("/git"))) return undefined
  wordIndex++
  let subcommand: string | undefined

  let targetError = words.slice(0, commandStart).some((word) => word === "env" || isAssignment(word) || word === "export")
    ? "Environment or wrapper changes can redirect a Git commit target. Use a direct git commit in the captured workdir."
    : undefined

  while (wordIndex < words.length) {
    const argument = words[wordIndex]

    if (argument === undefined) break

    if (argument === "--") {
      subcommand = words[wordIndex + 1]
      wordIndex += 2
      break
    }

    if (gitGlobalOptionsWithArg.has(argument)) {
      if (argument === "-C" || argument === "--git-dir" || argument === "--work-tree" || argument === "-c" || argument === "--config-env") {
        targetError = "Git global directory or configuration flags can change the commit target or signing policy. Use a direct git commit in the captured workdir."
      }

      wordIndex += 2
      continue
    }

    if (
      argument.startsWith("--git-dir=") ||
      argument.startsWith("--work-tree=") ||
      argument.startsWith("--namespace=") ||
      argument.startsWith("--exec-path=") ||
      argument.startsWith("--super-prefix=") ||
      argument.startsWith("--config-env=") ||
      argument.startsWith("-c")
    ) {
      if (argument.startsWith("--git-dir=") || argument.startsWith("--work-tree=") || argument.startsWith("--config-env=") || argument.startsWith("-c")) {
        targetError = "Git global directory or configuration flags can change the commit target or signing policy. Use a direct git commit in the captured workdir."
      }

      wordIndex++
      continue
    }

    if (argument.startsWith("-C")) {
      targetError = "git -C can change the commit target. Run git commit directly in the captured workdir."
      wordIndex++
      continue
    }

    if (argument.startsWith("-")) {
      wordIndex++
      continue
    }

    subcommand = argument
    wordIndex++
    break
  }

  if (subcommand !== "commit") return undefined

  const messages: string[] = []
  const filePaths: string[] = []
  let hasSignoffFlag = false
  let isAmend = false
  let hasNoEdit = false
  let isFixup = false
  let isHelp = false
  let messageExpansion = false
  let hasTrailer = false

  const collectMessage = (word: string | undefined): void => {
    if (word === undefined) return
    messages.push(word)
  }

  const collectFile = (word: string | undefined): void => {
    if (word === undefined) return
    filePaths.push(word)
  }

  for (let index = wordIndex; index < words.length; index++) {
    const argument = words[index]

    if (argument === undefined) break

    const equalsIndex = argument.indexOf("=")
    const longOptionName = equalsIndex > 0 ? argument.slice(0, equalsIndex) : argument

    if (argument === "--") break

    if (argument === "-h" || argument === "--help") {
      isHelp = true
    } else if (argument === "--amend") {
      isAmend = true
    } else if (argument === "--no-edit") {
      hasNoEdit = true
    } else if (argument === "--edit") {
      hasNoEdit = false
    } else if (argument === "-s" || argument === "--signoff") {
      hasSignoffFlag = true
    } else if (argument === "--no-signoff") {
      hasSignoffFlag = false
    } else if (argument === "-m" || argument === "--message") {
      index++
      messageExpansion ||= wordTokens[index]?.expansion === true
      collectMessage(words[index])
    } else if (argument.startsWith("--message=")) {
      messageExpansion ||= wordTokens[index]?.expansion === true
      collectMessage(argument.slice("--message=".length))
    } else if (argument === "-F" || argument === "--file") {
      index++
      collectFile(words[index])
    } else if (argument.startsWith("--file=")) {
      collectFile(argument.slice("--file=".length))
    } else if (argument === "--fixup" || argument.startsWith("--fixup=")) {
      isFixup = true

      if (equalsIndex < 0) index++
    } else if (longOptionName === "--trailer") {
      hasTrailer = true

      if (equalsIndex < 0) index++
    } else if (commitLongOptionsWithArg.has(longOptionName)) {
      if (equalsIndex < 0) index++
    } else if (argument.startsWith("-") && !argument.startsWith("--") && argument.length > 1) {
      for (let characterIndex = 1; characterIndex < argument.length; characterIndex++) {
        const option = argument[characterIndex]

        if (option === "s") {
          hasSignoffFlag = true
        } else if (option === "h") {
          isHelp = true
        } else if (option === "e") {
          hasNoEdit = false
        } else if (option === "m" || option === "F") {
          const attached = argument.slice(characterIndex + 1)

          const input = attached.length > 0
            ? attached
            : words[++index]

          if (option === "m") {
            messageExpansion ||= wordTokens[index]?.expansion === true
            collectMessage(input)
          }
          else collectFile(input)
          break
        } else if (option === "S") {
          break
        } else if (option === "u") {
          break
        } else if (option === "c" || option === "C" || option === "t") {
          if (argument.slice(characterIndex + 1).length === 0) index++
          break
        }
      }
    }
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
  }
}

export function extractGitCommits(command: string, inheritedDirectoryChange = false, depth = 0): GitCommitInvocation[] {
  if (depth > 12 || command.length > 262144) throw new Error("Shell parsing limit exceeded. Run git commit directly.")
  const tokens = tokenizeShell(command)
  const invocations: GitCommitInvocation[] = []
  let changedDirectory = inheritedDirectoryChange

  for (const simple of splitSimpleCommands(tokens)) {
    const commandTokens = simple.tokens
    const wordTokens = extractCommandWords(commandTokens)
    const words = wordTokens.map((token) => token.value)
    const commandStart = findCommandStart(words)
    const invocation = extractInvocation(words, commandStart, wordTokens)

    if (/^(?:.*\/)?(?:bash|sh|zsh)$/.test(words[commandStart] ?? "")) {
      let bodyIndex = commandStart + 1
      let executeString = false

      while (bodyIndex < words.length) {
        const option = words[bodyIndex]!

        if (option === "--") {
          bodyIndex++
          break
        }

        if (!option.startsWith("-") && !option.startsWith("+")) break

        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(option)) executeString = true
        const shortOptions = /^[+-][a-zA-Z]+$/.test(option)

        if (shortOptions && /[oO]/.test(option) && !/[oO]$/.test(option)) {
          throw new Error("Cannot parse shell options reliably. Run git commit directly.")
        }

        const next = words[bodyIndex + 1]
        const optionName = next !== undefined && !/^[+-]/.test(next)

        bodyIndex += shortOptions && /[oO]$/.test(option) && optionName || ["--rcfile", "--init-file"].includes(option) ? 2 : 1
      }

      if (executeString) {
        const body = wordTokens[bodyIndex]

        if (body === undefined || body.expansion) throw new Error("Cannot parse shell -c body reliably. Run git commit directly.")

        if (/^(?:.*\/)?sh$/.test(words[commandStart] ?? "") && body.value.includes("$'")) {
          throw new Error("Cannot parse $' quoting portably in sh -c. Use a literal bash -c or zsh -c body, or run git commit directly.")
        }

        const wrapperChange = words.slice(0, commandStart).some((word) => word === "env" || isAssignment(word))

        invocations.push(...extractGitCommits(body.value, changedDirectory || wrapperChange, depth + 1))
      }
    }

    if (targetMutators.has(words[commandStart] ?? "") || words.length > 0 && words.every(isAssignment)) changedDirectory = true

    if (invocation !== undefined) {
      const target = changedDirectory
        ? { ...invocation, targetError: "A preceding directory or environment change makes the commit target ambiguous. Run git commit in a separate shell call with the captured workdir." }
        : invocation

      if (!invocation.filePaths.includes("-")) {
        invocations.push(target)
        continue
      }

      const heredocs = commandTokens.filter((token) => token.type === "redirect" && /^\d*<<$/.test(token.value))

      const stdinRedirects = commandTokens.filter((token) => {
        if (token.type !== "redirect") return false

        const match = token.value.match(/^(\d*)([<>])/)

        return match !== null && (match[1] === "" ? match[2] === "<" : Number(match[1]) === 0)
      })

      const heredoc = heredocs[0]
      let stdinError: string | undefined

      if (simple.pipeline) stdinError = "Pipelines cannot supply a validated commit message."
      else if (heredocs.length !== 1 || stdinRedirects.length !== 1 || heredoc?.value !== "<<" && heredoc?.value !== "0<<") {
        stdinError = "Use exactly one quoted stdin heredoc on git commit -F -, with no other stdin redirects."
      } else if (heredoc.heredoc?.quoted !== true) {
        stdinError = "Use a complete quoted heredoc delimiter, for example: git commit -s -F - <<'EOF'."
      }

      invocations.push({
        ...target,
        stdinMessage: stdinError === undefined ? heredoc?.heredoc?.body : undefined,
        stdinError,
      })
    }
  }

  for (const token of tokens) {
    for (const substitution of token.substitutions ?? []) {
      invocations.push(...extractGitCommits(substitution, changedDirectory, depth + 1))
    }
  }

  return invocations
}
