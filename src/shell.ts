import type { GitCommitInvocation, ShellToken } from "./types.js"

const gitGlobalOptionsWithArg = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
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

interface CommandWord {
  readonly value: string
  readonly hasExpansion: boolean
}

interface CommandSubstitution {
  readonly content: string
  readonly end: number
}

interface CommandStart {
  readonly index: number
  readonly directoryChanges: readonly string[]
  readonly splitCommands: readonly CommandWord[]
  readonly hasExpansion: boolean
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
  hasExpansion: boolean,
  substitutions: readonly string[],
): void {
  if (hasExpansion && substitutions.length > 0) {
    tokens.push({ type: "word", value, hasExpansion: true, substitutions })
  } else if (hasExpansion) {
    tokens.push({ type: "word", value, hasExpansion: true })
  } else if (substitutions.length > 0) {
    tokens.push({ type: "word", value, substitutions })
  } else {
    tokens.push({ type: "word", value })
  }
}

export function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
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
      continue
    }

    const redirectMatch = command.slice(i).match(/^(\d+)?(<<<|>>|<<|>&|<&|>\||>|<)(?:-|\d+)?/)

    if (redirectMatch !== null && redirectMatch[0] !== undefined) {
      tokens.push({ type: "redirect", value: redirectMatch[0] })
      i += redirectMatch[0].length
      continue
    }

    let value = ""
    let hasExpansion = false
    const substitutions: string[] = []

    while (i < command.length) {
      const current = command[i]

      if (current === undefined || isWordSeparator(current)) break

      if (current === "\\" && command[i + 1] === "\n") {
        i += 2
        continue
      }

      if (current === "\\") {
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
        i++

        while (i < command.length && command[i] !== "'") {
          value += command[i]
          i++
        }

        if (command[i] === "'") i++
        continue
      }

      if (current === '"') {
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
            hasExpansion = true
            i = substitution.end
          } else {
            if (quotedCharacter === "$" || quotedCharacter === "`") hasExpansion = true
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
        hasExpansion = true
        i = substitution.end
        continue
      }

      const nextRedirect = command.slice(i).match(/^(\d+)?(<<<|>>|<<|>&|<&|>\||>|<)(?:-|\d+)?/)

      if (nextRedirect !== null) break

      if (current === "$" || current === "`") hasExpansion = true
      value += current
      i++
    }

    pushWord(tokens, value, hasExpansion, substitutions)
  }

  return tokens
}

function splitSimpleCommands(tokens: readonly ShellToken[]): ShellToken[][] {
  const commands: ShellToken[][] = []
  let current: ShellToken[] = []

  for (const token of tokens) {
    if (token.type === "operator") {
      if (current.length > 0) commands.push(current)
      current = []
    } else {
      current.push(token)
    }
  }

  if (current.length > 0) commands.push(current)

  return commands
}

function extractCommandWords(tokens: readonly ShellToken[]): CommandWord[] {
  const words: CommandWord[] = []
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
      words.push({ value: token.value, hasExpansion: token.hasExpansion === true })
    }

    i++
  }

  return words
}

function isAssignment(word: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(word)
}

function skipAssignments(words: readonly CommandWord[], start: number): number {
  let index = start

  while (words[index] !== undefined && isAssignment(words[index].value)) index++

  return index
}

function findCommandStart(words: readonly CommandWord[]): CommandStart {
  let index = skipAssignments(words, 0)
  const directoryChanges: string[] = []
  const splitCommands: CommandWord[] = []
  let hasExpansion = false

  while (index < words.length) {
    const word = words[index]?.value

    if (word !== undefined && commandPrefixes.has(word)) {
      index = skipAssignments(words, index + 1)
      continue
    }

    if (word === "env") {
      index++

      while (index < words.length) {
        const option = words[index]
        const argument = option?.value

        if (argument === undefined) break

        if (argument === "--") {
          index++
          break
        }

        if (argument === "-u" || argument === "--unset") {
          index += 2
        } else if (argument === "-C" || argument === "--chdir") {
          const directory = words[index + 1]

          if (directory !== undefined) {
            directoryChanges.push(directory.value)

            if (directory.hasExpansion) hasExpansion = true
          }

          index += 2
        } else if (argument.startsWith("--chdir=")) {
          directoryChanges.push(argument.slice("--chdir=".length))

          if (option.hasExpansion) hasExpansion = true
          index++
        } else if (/^-C.+/.test(argument)) {
          directoryChanges.push(argument.slice(2))

          if (option.hasExpansion) hasExpansion = true
          index++
        } else if (argument === "-S" || argument === "--split-string") {
          const splitCommand = words[index + 1]

          if (splitCommand !== undefined) splitCommands.push(splitCommand)
          index += 2
        } else if (argument.startsWith("--split-string=")) {
          splitCommands.push({
            value: argument.slice("--split-string=".length),
            hasExpansion: option.hasExpansion,
          })
          index++
        } else if (/^-S.+/.test(argument)) {
          splitCommands.push({ value: argument.slice(2), hasExpansion: option.hasExpansion })
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
        const argument = words[index]?.value

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

      while (words[index]?.value.startsWith("-")) index++
      index = skipAssignments(words, index)
      continue
    }

    break
  }

  return { index, directoryChanges, splitCommands, hasExpansion }
}

function extractInvocation(
  words: readonly CommandWord[],
  commandStart: CommandStart,
): GitCommitInvocation | undefined {
  let wordIndex = commandStart.index
  const executable = words[wordIndex]?.value

  if (executable === undefined || (executable !== "git" && !executable.endsWith("/git"))) return undefined
  wordIndex++
  const directoryChanges = [...commandStart.directoryChanges]
  let hasUnexpandedArgument = commandStart.hasExpansion

  let subcommand: string | undefined

  while (wordIndex < words.length) {
    const argument = words[wordIndex]?.value

    if (argument === undefined) break

    if (argument === "--") {
      subcommand = words[wordIndex + 1]?.value
      wordIndex += 2
      break
    }

    if (gitGlobalOptionsWithArg.has(argument)) {
      const optionValue = words[wordIndex + 1]

      if (optionValue?.hasExpansion === true) hasUnexpandedArgument = true

      if (argument === "-C" && optionValue !== undefined) {
        directoryChanges.push(optionValue.value)
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
      argument.startsWith("-c")
    ) {
      if (words[wordIndex]?.hasExpansion === true) hasUnexpandedArgument = true
      wordIndex++
      continue
    }

    if (argument.startsWith("-C")) {
      directoryChanges.push(argument.slice(2))

      if (words[wordIndex]?.hasExpansion === true) hasUnexpandedArgument = true
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
  const unverifiableInputs: string[] = []
  let hasSignoffFlag = false
  let isAmend = false
  let hasNoEdit = false
  let isHelp = false

  for (let index = wordIndex; index < words.length; index++) {
    if (words[index]?.hasExpansion === true) hasUnexpandedArgument = true
  }

  if (hasUnexpandedArgument) {
    unverifiableInputs.push("A git commit argument contains an unexpanded shell variable or command substitution.")
  }

  const collectMessage = (word: CommandWord | undefined): void => {
    if (word === undefined) return
    messages.push(word.value)
  }

  const collectFile = (word: CommandWord | undefined): void => {
    if (word === undefined) return
    filePaths.push(word.value)
  }

  for (let index = wordIndex; index < words.length; index++) {
    const word = words[index]
    const argument = word?.value

    if (argument === undefined) break

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
      collectMessage({ value: argument.slice("--message=".length), hasExpansion: word.hasExpansion })
    } else if (argument === "-F" || argument === "--file") {
      index++
      collectFile(words[index])
    } else if (argument.startsWith("--file=")) {
      collectFile({ value: argument.slice("--file=".length), hasExpansion: word.hasExpansion })
    } else if (commitLongOptionsWithArg.has(argument)) {
      index++
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
            ? { value: attached, hasExpansion: word.hasExpansion }
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
    isHelp,
    unverifiableInputs,
    directoryChanges,
  }
}

export function extractGitCommits(command: string): GitCommitInvocation[] {
  const tokens = tokenizeShell(command)
  const invocations: GitCommitInvocation[] = []

  for (const commandTokens of splitSimpleCommands(tokens)) {
    const words = extractCommandWords(commandTokens)
    const commandStart = findCommandStart(words)
    const invocation = extractInvocation(words, commandStart)

    if (invocation !== undefined) invocations.push(invocation)

    for (const splitCommand of commandStart.splitCommands) {
      for (const nestedInvocation of extractGitCommits(splitCommand.value)) {
        const unverifiableInputs = [...(nestedInvocation.unverifiableInputs ?? [])]

        if (splitCommand.hasExpansion || commandStart.hasExpansion) {
          unverifiableInputs.push(
            "An env split-string command contains an unexpanded shell variable or command substitution.",
          )
        }

        invocations.push({
          ...nestedInvocation,
          unverifiableInputs,
          directoryChanges: [
            ...commandStart.directoryChanges,
            ...(nestedInvocation.directoryChanges ?? []),
          ],
        })
      }
    }
  }

  for (const token of tokens) {
    for (const substitution of token.substitutions ?? []) {
      invocations.push(...extractGitCommits(substitution))
    }
  }

  return invocations
}
