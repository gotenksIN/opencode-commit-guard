import { closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs"
import { resolve } from "node:path"
import type {
  CommitGuardConfig,
  GitCommitInvocation,
  OverlongLine,
} from "./types.js"

const scopePattern = /^([a-zA-Z0-9_\-./]+(?:\([a-zA-Z0-9_\-./]+\))?):\s+(.+)$/

const signoffPattern = /^\s*Signed-off-by:\s+[^<>\r\n]+\s+<[^<>\r\n@]+@[^<>\r\n@]+>\s*$/i

const maxMessageFileSize = 64 * 1024

function hasSignoffTrailer(lines: readonly string[]): boolean {
  const subjectIndex = lines.findIndex((line) => line.trim().length > 0)

  return subjectIndex >= 0 && lines.slice(subjectIndex + 1).some((line) => signoffPattern.test(line))
}

function validateAllowedScope(
  rawScope: string,
  allowedScopes: readonly string[],
): string | undefined {
  const parenthesizedScope = rawScope.match(/^([^(]+)\(([^)]+)\)$/)
  const conventionalType = parenthesizedScope?.[1]
  const innerScope = parenthesizedScope?.[2]

  const isAllowed =
    allowedScopes.includes(rawScope) ||
    (innerScope !== undefined && allowedScopes.includes(innerScope)) ||
    (conventionalType !== undefined && allowedScopes.includes(conventionalType))

  if (isAllowed) return undefined

  return `Scope "${rawScope}" is not in the allowed scopes list. Allowed scopes: ${allowedScopes.join(", ")}.`
}

export function createCommitGuardError(
  violations: readonly string[],
  originalCommand: string,
): Error {
  const header = "[commit-guard] Git commit rejected: commit message format rules violated."
  const violationText = violations.map((v, i) => `${i + 1}. ${v}`).join("\n\n")

  const examples = [
    "Example of a correctly formatted git commit:",
    '  git commit -s -m "kernel: add support for foo"',
    '  git commit -s -m "releasetools: fix ota generation" -m "Detailed explanation of why this fix is needed."',
    '  git commit -m "feat(parser): add subshell support" -m "Signed-off-by: Developer <dev@example.com>"',
  ].join("\n")

  return new Error(
    `${header}\n\nViolations:\n${violationText}\n\n${examples}\n\nCommand attempted:\n  ${originalCommand}`,
  )
}

export function validateGitCommits(
  invocations: readonly GitCommitInvocation[],
  config: CommitGuardConfig,
  originalCommand: string,
  workingDirectory?: string,
): void {
  const allViolations: string[] = []

  for (const invocation of invocations) {
    if (invocation.isHelp) {
      continue
    }

    if (invocation.isAmend && invocation.hasNoEdit === true && invocation.messages.length === 0 && invocation.filePaths.length === 0) {
      continue
    }

    const collectedMessages: string[] = [...invocation.messages]
    let messageDirectory = workingDirectory ?? process.cwd()

    for (const directoryChange of invocation.directoryChanges ?? []) {
      messageDirectory = resolve(messageDirectory, directoryChange)
    }

    const filePath = invocation.filePaths.at(-1)

    if (filePath !== undefined) {
      if (filePath === "-") {
        allViolations.push("Cannot validate a commit message read from standard input. Use -m or a regular message file.")
        continue
      }

      const fullPath = resolve(messageDirectory, filePath)

      if (!existsSync(fullPath)) {
        allViolations.push(`Commit message file "${filePath}" does not exist.`)
        continue
      }

      try {
        const fileInfo = statSync(fullPath)

        if (!fileInfo.isFile()) {
          allViolations.push(`Commit message path "${filePath}" is not a regular file.`)
          continue
        }

        if (fileInfo.size > maxMessageFileSize) {
          allViolations.push(`Commit message file "${filePath}" exceeds the 64 KB size limit.`)
          continue
        }

        const descriptor = openSync(fullPath, constants.O_RDONLY | constants.O_NONBLOCK)

        try {
          const openedFileInfo = fstatSync(descriptor)

          if (!openedFileInfo.isFile()) {
            allViolations.push(`Commit message path "${filePath}" is not a regular file.`)
            continue
          }

          const fileContent = Buffer.alloc(maxMessageFileSize + 1)
          const bytesRead = readSync(descriptor, fileContent, 0, fileContent.length, 0)

          if (bytesRead > maxMessageFileSize) {
            allViolations.push(`Commit message file "${filePath}" exceeds the 64 KB size limit.`)
            continue
          }

          collectedMessages.push(fileContent.toString("utf-8", 0, bytesRead))
        } finally {
          closeSync(descriptor)
        }
      } catch (readError) {
        const errorDetail = readError instanceof Error ? readError.message : "Cannot read file"
        allViolations.push(`Failed to read commit message file "${filePath}": ${errorDetail}`)
      }
    }

    if (collectedMessages.length === 0) {
      if (invocation.filePaths.length === 0) {
        allViolations.push(
          'No commit message provided. Commits in OpenCode must provide a commit message via -m "<scope>: <subject>" or -F <file>.',
        )
      }

      continue
    }

    const fullMessage = collectedMessages.join("\n\n")
    const lines = fullMessage.split(/\r?\n/)
    const firstLine = lines[0] ?? ""
    const subjectLine = firstLine.trim()
    const scopeMatch = subjectLine.match(scopePattern)

    if (
      scopeMatch?.[1] !== undefined &&
      config.allowedScopes !== undefined &&
      config.allowedScopes.length > 0
    ) {
      const scopeViolation = validateAllowedScope(scopeMatch[1], config.allowedScopes)

      if (scopeViolation !== undefined) allViolations.push(scopeViolation)
    }

    if (config.requireScope) {
      if (subjectLine.length === 0) {
        allViolations.push('Subject line is empty. The commit message must begin with "<scope>: <subject>".')
      } else if (scopeMatch === null) {
        if (/^:\s*/.test(subjectLine)) {
          allViolations.push(
            `Missing scope before colon in subject line "${subjectLine}". Expected format: "<scope>: <subject>".`,
          )
        } else if (/^[^:]+:\S/.test(subjectLine)) {
          allViolations.push(
            `Missing space after colon in subject line "${subjectLine}". Expected format: "<scope>: <subject>".`,
          )
        } else if (/^[^:]+:\s*$/.test(subjectLine)) {
          allViolations.push(
            `Subject text after colon is empty in "${subjectLine}". Expected format: "<scope>: <subject>".`,
          )
        } else {
          allViolations.push(
            `Missing scope in subject line "${subjectLine}". First line must follow "<scope>: <subject>" format (e.g., "kernel: add support for foo" or "feat(parser): add subshell support").`,
          )
        }
      }
    }

    if (config.maxLineLength > 0) {
      const overlongLines: OverlongLine[] = []

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]

        if (line !== undefined && line.length > config.maxLineLength) {
          overlongLines.push({ lineNumber: i + 1, length: line.length, text: line })
        }
      }

      if (overlongLines.length > 0) {
        const details = overlongLines
          .map((l) => `  - Line ${l.lineNumber} (${l.length} chars, max ${config.maxLineLength}): "${l.text}"`)
          .join("\n")

        allViolations.push(
          `Commit message exceeds maximum line length of ${config.maxLineLength} characters:\n${details}`,
        )
      }
    }

    if (config.requireSignoff) {
      const hasSignoff = invocation.hasSignoffFlag || hasSignoffTrailer(lines)

      if (!hasSignoff) {
        allViolations.push(
          "Missing commit signoff. Commit must either include the '-s' or '--signoff' flag, or contain a valid 'Signed-off-by: Name <email>' trailer in the message body.",
        )
      }
    }
  }

  if (allViolations.length > 0) {
    throw createCommitGuardError(allViolations, originalCommand)
  }
}
