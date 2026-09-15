import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type {
  CommitGuardConfig,
  GitCommitInvocation,
  OverlongLine,
} from "./types.js"

const scopePattern = /^([a-zA-Z0-9_\-./]+(?:\([a-zA-Z0-9_\-./]+\))?):\s+(.+)$/

const signoffPattern = /^\s*Signed-off-by:\s+[^<>\r\n]+\s+<[^<>\r\n@]+@[^<>\r\n@]+>\s*$/i

function normalizeWindowsShellPath(inputPath: string): string {
  if (process.platform !== "win32") return inputPath

  const patterns = [
    /^\/([a-zA-Z]):(?:[\\/]|$)/,
    /^\/([a-zA-Z])(?:\/|$)/,
    /^\/cygdrive\/([a-zA-Z])(?:\/|$)/,
    /^\/mnt\/([a-zA-Z])(?:\/|$)/,
  ]

  for (const pattern of patterns) {
    const match = inputPath.match(pattern)
    const drive = match?.[1]

    if (match?.[0] !== undefined && drive !== undefined) {
      return `${drive.toUpperCase()}:/${inputPath.slice(match[0].length)}`
    }
  }

  return inputPath
}

export function resolveLocationPath(baseDirectory: string, inputPath: string): string {
  const homeDirectory = process.env.OPENCODE_TEST_HOME ?? homedir()
  const normalizedInput = normalizeWindowsShellPath(inputPath)

  if (normalizedInput === "~") return homeDirectory

  if (
    normalizedInput.startsWith("~/") ||
    (process.platform === "win32" && normalizedInput.startsWith("~\\"))
  ) {
    return join(homeDirectory, normalizedInput.slice(2))
  }

  return resolve(baseDirectory, normalizedInput)
}

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
  canReadLocalRepository = true,
): void {
  const allViolations: string[] = []

  for (const invocation of invocations) {
    if (invocation.isHelp) {
      continue
    }

    const collectedMessages: string[] = [...invocation.messages]
    let messageDirectory = workingDirectory ?? process.cwd()

    for (const directoryChange of invocation.directoryChanges ?? []) {
      messageDirectory = resolve(messageDirectory, directoryChange)
    }

    if (
      invocation.isAmend &&
      invocation.hasNoEdit === true &&
      invocation.messages.length === 0 &&
      invocation.filePaths.length === 0
    ) {
      const hasAmbiguousHomeChange = invocation.directoryChanges?.some((directoryChange) =>
        directoryChange === "~" ||
        directoryChange.startsWith("~/") ||
        (process.platform === "win32" && directoryChange.startsWith("~\\"))
      ) === true

      if (hasAmbiguousHomeChange) {
        allViolations.push(
          'Cannot validate an existing commit through a shell directory change that starts with "~". Provide an explicit inline message, for example: git commit --amend -s -m "kernel: fix race".',
        )
        continue
      }

      if (!canReadLocalRepository) {
        allViolations.push(
          'Cannot validate the existing commit in a workspace-backed location. Provide an explicit inline message, for example: git commit --amend -s -m "kernel: fix race".',
        )
        continue
      }

      if (invocation.gitDir !== undefined || invocation.workTree !== undefined) {
        allViolations.push(
          'Cannot validate an existing commit through --git-dir or --work-tree before shell permissions run. Provide an explicit inline message, for example: git commit --amend -s -m "kernel: fix race".',
        )
        continue
      }

      const result = spawnSync("git", ["log", "-1", "--format=%B", "HEAD"], {
        cwd: messageDirectory,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      })

      if (result.error !== undefined) {
        allViolations.push(`Failed to read the existing HEAD commit message: ${result.error.message}`)
        continue
      }

      if (result.status !== 0) {
        const detail = result.stderr.trim()
        const suffix = detail.length > 0 ? `: ${detail}` : "."
        allViolations.push(`Failed to read the existing HEAD commit message${suffix}`)
        continue
      }

      const existingMessage = result.stdout.replace(/[\r\n]+$/, "")

      if (existingMessage.trim().length === 0) {
        allViolations.push("The existing HEAD commit message is empty.")
        continue
      }

      collectedMessages.push(existingMessage)
    }

    const filePath = invocation.filePaths.at(-1)

    if (filePath !== undefined) {
      allViolations.push(
        `Cannot validate a commit message from ${filePath === "-" ? "standard input" : `file "${filePath}"`} before shell permissions run. Use an inline message, for example: git commit -s -m "kernel: add support for foo".`,
      )
      continue
    }

    if (collectedMessages.length === 0) {
      if (invocation.isFixup === true) {
        continue
      }

      if (invocation.filePaths.length === 0) {
        allViolations.push(
          'No commit message provided. Commits in OpenCode must provide an inline message via -m "<scope>: <subject>".',
        )
      }

      continue
    }

    const fullMessage = collectedMessages.join("\n\n")
    const lines = fullMessage.split(/\r?\n/)
    const firstLine = lines[0] ?? ""
    const subjectLine = firstLine.trim()
    const effectiveSubject = subjectLine.replace(/^(?:(?:fixup|squash)!\s+)+/, "")
    const scopeMatch = effectiveSubject.match(scopePattern)

    if (
      scopeMatch?.[1] !== undefined &&
      config.allowedScopes !== undefined &&
      config.allowedScopes.length > 0
    ) {
      const scopeViolation = validateAllowedScope(scopeMatch[1], config.allowedScopes)

      if (scopeViolation !== undefined) {
        const fullSubjectDetail = effectiveSubject === subjectLine
          ? ""
          : ` Subject line: "${subjectLine}".`

        allViolations.push(`${scopeViolation}${fullSubjectDetail}`)
      }
    }

    if (config.requireScope) {
      if (subjectLine.length === 0) {
        allViolations.push('Subject line is empty. The commit message must begin with "<scope>: <subject>".')
      } else if (scopeMatch === null) {
        if (/^:\s*/.test(effectiveSubject)) {
          allViolations.push(
            `Missing scope before colon in subject line "${subjectLine}". Expected format: "<scope>: <subject>".`,
          )
        } else if (/^[^:]+:\S/.test(effectiveSubject)) {
          allViolations.push(
            `Missing space after colon in subject line "${subjectLine}". Expected format: "<scope>: <subject>".`,
          )
        } else if (/^[^:]+:\s*$/.test(effectiveSubject)) {
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
