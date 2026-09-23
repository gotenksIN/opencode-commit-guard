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
  "--trailer",
])

interface CommandSubstitution {
  readonly content: string
  readonly end: number
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
    character === ")" ||
    character === "{" ||
    character === "}"
  )
}

function consumeCommandSubstitution(command: string, start: number): CommandSubstitution {
  let depth = 1
  let quote: "'" | '"' | undefined
  let i = start + 2
  let atWordStart = true

  while (i < command.length) {
    const character = command[i]

    if (character === undefined) break

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
        i = consumeCommandSubstitution(command, i).end
      } else {
        i++
      }

      continue
    }

    if (character === "\\") {
      if (command[i + 1] !== "\n") atWordStart = false
      i += i + 1 < command.length ? 2 : 1
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
      i = consumeCommandSubstitution(command, i).end
      atWordStart = false
      continue
    }

    if (character === "(") {
      depth++
      i++
      atWordStart = true
      continue
    }

    if (character === ")") {
      depth--

      if (depth === 0) {
        return { content: command.slice(start + 2, i), end: i + 1 }
      }

      atWordStart = true
    }

    if (isWordSeparator(character)) atWordStart = true
    else atWordStart = false
    i++
  }

  return { content: command.slice(start + 2), end: command.length }
}

function pushWord(
  tokens: ShellToken[],
  value: string,
  substitutions: readonly string[],
): void {
  if (substitutions.length > 0) {
    tokens.push({ type: "word", value, substitutions })
  } else {
    tokens.push({ type: "word", value })
  }
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
  const pendingHeredocs: { index: number; delimiter: string; quoted: boolean }[] = []
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
      character === "&" ||
      character === "\n" ||
      character === "(" ||
      character === ")" ||
      character === "{" ||
      character === "}"
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

            if (line === heredoc.delimiter) {
              complete = true
              const body = command.slice(bodyStart, i - (line.length + (lineEnd < 0 ? 0 : 1)))

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

    const redirectMatch = command.slice(i).match(/^(\d+)?(<<<|>>|<<|>&|<&|>\||>|<)(?:-|\d+)?/)

    if (redirectMatch !== null && redirectMatch[0] !== undefined) {
      tokens.push({ type: "redirect", value: redirectMatch[0] })

      if (/^\d*<<$/.test(redirectMatch[0])) pendingDelimiter = tokens.length - 1
      i += redirectMatch[0].length
      continue
    }

    let value = ""
    let quoted = false
    let unsupportedDelimiter = false
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
        quoted = true
        unsupportedDelimiter = true
        i += 2

        while (i < command.length) {
          const ansiCharacter = command[i]

          if (ansiCharacter === undefined) break

          if (ansiCharacter === "'") {
            i++
            break
          }

          if (ansiCharacter === "\\" && i + 1 < command.length) {
            const escaped = command[i + 1]

            if (escaped === "n") value += "\n"
            else if (escaped === "t") value += "\t"
            else if (escaped === "r") value += "\r"
            else if (escaped === "\\") value += "\\"
            else if (escaped === "'") value += "'"
            else if (escaped === '"') value += '"'
            else value += escaped
            i += 2
          } else {
            value += ansiCharacter
            i++
          }
        }

        continue
      }

      if (current === "'") {
        quoted = true
        i++

        while (i < command.length && command[i] !== "'") {
          value += command[i]
          i++
        }

        if (command[i] === "'") i++
        continue
      }

      if (current === '"') {
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
            i = substitution.end
          } else {
            value += quotedCharacter
            i++
          }
        }

        if (command[i] === '"') i++
        continue
      }

      if (current === "$" && command[i + 1] === "(") {
        const substitution = consumeCommandSubstitution(command, i)
        value += command.slice(i, substitution.end)
        substitutions.push(substitution.content)
        i = substitution.end
        continue
      }

      const nextRedirect = command.slice(i).match(/^(\d+)?(<<<|>>|<<|>&|<&|>\||>|<)(?:-|\d+)?/)

      if (nextRedirect !== null) break

      value += current
      i++
    }

    pushWord(tokens, value, substitutions)

    if (pendingDelimiter !== undefined) {
      if (unsupportedDelimiter) {
        throw new Error("Cannot validate an ANSI-C quoted heredoc delimiter. Use a plain quoted delimiter such as <<'EOF'.")
      }

      pendingHeredocs.push({ index: pendingDelimiter, delimiter: value, quoted })
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

function extractCommandWords(tokens: readonly ShellToken[]): string[] {
  const words: string[] = []
  let i = 0

  while (i < tokens.length) {
    const token = tokens[i]

    if (token === undefined) break

    if (token.type === "redirect") {
      if (!token.value.includes("&") && tokens[i + 1]?.type === "word") i += 2
      else i++
      continue
    }

    if (token.type === "word") {
      words.push(token.value)
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
      collectMessage(words[index])
    } else if (argument.startsWith("--message=")) {
      collectMessage(argument.slice("--message=".length))
    } else if (argument === "-F" || argument === "--file") {
      index++
      collectFile(words[index])
    } else if (argument.startsWith("--file=")) {
      collectFile(argument.slice("--file=".length))
    } else if (argument === "--fixup" || argument.startsWith("--fixup=")) {
      isFixup = true

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

          if (option === "m") collectMessage(input)
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
  }
}

export function extractGitCommits(command: string, inheritedDirectoryChange = false): GitCommitInvocation[] {
  const tokens = tokenizeShell(command)
  const invocations: GitCommitInvocation[] = []
  let changedDirectory = inheritedDirectoryChange

  for (const simple of splitSimpleCommands(tokens)) {
    const commandTokens = simple.tokens
    const words = extractCommandWords(commandTokens)
    const commandStart = findCommandStart(words)
    const invocation = extractInvocation(words, commandStart)

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
      invocations.push(...extractGitCommits(substitution, changedDirectory))
    }
  }

  return invocations
}
