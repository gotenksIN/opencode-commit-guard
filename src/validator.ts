import type {
  CommitGuardConfig,
  GitCommitInvocation,
  OverlongLine,
} from "./types.js"

import { scopePattern } from "./scope.js"

const signoffPattern = /^\s*Signed-off-by:\s+[^<>\r\n]+\s+<[^<>\r\n@]+@[^<>\r\n@]+>\s*$/i

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
  config: CommitGuardConfig,
): Error {
  const header = "[commit-guard] Git commit rejected: commit message format rules violated."
  const violationText = violations.map((v, i) => `${i + 1}. ${v}`).join("\n\n")

  const scope = config.allowedScopes?.[0] ?? "scope"

  const examples = `Signoff ${config.enforceSignoff ? "required: captured commit.gpgsign=true. Keep -s." : "not required: captured commit.gpgsign=false|unset."}\n` +
    `Example:\n  git commit${config.enforceSignoff ? " -s" : ""} -m $'${scope}: Subject\\n\\nBody line one.\\nBody line two.'`

  return new Error(
    `${header}\n\nViolations:\n${violationText}\n\n${examples}`,
  )
}

export function validateGitCommits(
  invocations: readonly GitCommitInvocation[],
  config: CommitGuardConfig,
  _originalCommand: string,
): void {
  const allViolations: string[] = []

  for (const invocation of invocations) {
    if (invocation.isHelp) {
      continue
    }

    if (invocation.messageExpansion) {
      allViolations.push("Cannot validate a message containing shell expansion. Supply the final message literally.")
      continue
    }

    if (invocation.hasTrailer) {
      allViolations.push("Cannot validate --trailer. Put the trailer in the literal message body or use -s.")
      continue
    }

    const collectedMessages: string[] = [...invocation.messages]

    const filePath = invocation.filePaths.at(-1)

    if (filePath !== undefined) {
      if (filePath !== "-" || invocation.filePaths.length !== 1) {
        allViolations.push(
          "Cannot validate a commit message from -F/--file before permission approval. Use an inline $'...' message or one quoted stdin heredoc.",
        )
        continue
      }

      if (invocation.stdinError !== undefined || invocation.stdinMessage === undefined || collectedMessages.length > 0) {
        allViolations.push(
          `${invocation.stdinError ?? "Cannot combine -F - with -m or unsupported stdin input."} Use one quoted stdin heredoc or an inline $'...' message.`,
        )
        continue
      }

      collectedMessages.push(invocation.stdinMessage)
    }

    if (collectedMessages.length === 0) {
      if (invocation.isAmend && invocation.hasNoEdit === true) {
        continue
      }

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
            `Missing scope in subject line "${subjectLine}". First line must follow "<scope>: <subject>" format.`,
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
          `Commit message exceeds maximum line length of ${config.maxLineLength} characters:\n${details}\nEach -m becomes one paragraph line. Wrap with real newlines inside $'...'; "\\n" inside double quotes stays literal.`,
        )
      }
    }

    if (config.enforceSignoff) {
      const hasSignoff = invocation.hasSignoffFlag || hasSignoffTrailer(lines)

      if (!hasSignoff) {
        allViolations.push(
          "Missing commit signoff. Commit must either include the '-s' or '--signoff' flag, or contain a valid 'Signed-off-by: Name <email>' trailer in the message body.",
        )
      }
    }
  }

  if (allViolations.length > 0) {
    throw createCommitGuardError(allViolations.slice(0, 10).map((text) => text.slice(0, 2048)), config)
  }
}
