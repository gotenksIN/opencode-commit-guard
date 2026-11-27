import { scopePattern } from "./scope.js";
import type {
  CommitGuardConfig,
  GitCommitInvocation,
  ShellMode,
} from "./types.js";

const signoffPattern =
  /^\s*[sS][iI][gG][nN][eE][dD]-[oO][fF][fF]-[bB][yY]:\s+[^<>\r\n]+\s+<[^<>\r\n@]+@[^<>\r\n@]+>\s*$/u;

const subjectScopeViolation = (subject: string, effective: string) => {
  if (subject.length === 0) {
    return 'Subject line is empty. The commit message must begin with "<scope>: <subject>".';
  }

  if (scopePattern.test(effective)) {
    return null;
  }

  if (/^:\s*/u.test(effective)) {
    return `Missing scope before colon in subject line "${subject}". Expected format: "<scope>: <subject>".`;
  }

  if (/^[^:]+:\S/u.test(effective)) {
    return `Missing space after colon in subject line "${subject}". Expected format: "<scope>: <subject>".`;
  }

  if (/^[^:]+:\s*$/u.test(effective)) {
    return `Subject text after colon is empty in "${subject}". Expected format: "<scope>: <subject>".`;
  }

  return `Missing scope in subject line "${subject}". First line must follow "<scope>: <subject>" format.`;
};

const resolveMessages = (
  invocation: GitCommitInvocation,
  violations: string[],
  shellMode: ShellMode
) => {
  if (invocation.messageExpansion === true) {
    violations.push(
      "Cannot validate a message containing shell expansion. Supply the final message literally."
    );

    return null;
  }

  if (invocation.hasTrailer === true) {
    violations.push(
      "Cannot validate --trailer. Put the trailer in the literal message body or use -s."
    );

    return null;
  }

  const filePath = invocation.filePaths.at(-1);

  if (filePath === undefined) {
    return invocation.messages;
  }

  const inlineHint =
    shellMode === "pwsh"
      ? "Use an inline single-quoted -m message or a single literal here-string pipeline (@'...'@ | git commit -F -)."
      : "Use an inline $'...' message or one quoted stdin heredoc.";

  if (filePath !== "-" || invocation.filePaths.length !== 1) {
    violations.push(
      `Cannot validate a commit message from -F/--file before permission approval. ${inlineHint}`
    );

    return null;
  }

  if (
    invocation.stdinError !== undefined ||
    invocation.stdinMessage === undefined ||
    invocation.messages.length > 0
  ) {
    violations.push(
      `${invocation.stdinError ?? "Cannot combine -F - with -m or unsupported stdin input."} ${inlineHint}`
    );

    return null;
  }

  return [invocation.stdinMessage];
};

const checkAllowedScope = (
  subject: string,
  effective: string,
  allowed: readonly string[]
) => {
  const rawScope = scopePattern.exec(effective)?.[1];

  if (rawScope === undefined || allowed.length === 0) {
    return null;
  }

  const conventional = /^(?<type>[^(]+)\((?<scope>[^)]+)\)$/u.exec(rawScope);

  if (
    [rawScope, conventional?.[1], conventional?.[2]].some(
      (scope) => scope !== undefined && allowed.includes(scope)
    )
  ) {
    return null;
  }

  const detail = effective === subject ? "" : ` Subject line: "${subject}".`;

  return `Scope "${rawScope}" is not in the allowed scopes list. Allowed scopes: ${allowed.join(", ")}.${detail}`;
};

const checkLineLength = (
  lines: readonly string[],
  max: number,
  shellMode: ShellMode
) => {
  if (max <= 0) {
    return null;
  }

  const overlong = lines.flatMap((line, index) =>
    line.length > max
      ? [`  - Line ${index + 1} (${line.length} chars, max ${max}): "${line}"`]
      : []
  );

  const wrapHint =
    shellMode === "pwsh"
      ? "Wrap with real newlines inside a literal @'...'@ here-string or PowerShell `n escapes inside double quotes."
      : `Wrap with real newlines inside $'...'; "\\n" inside double quotes stays literal.`;

  return overlong.length === 0
    ? null
    : `Commit message exceeds maximum line length of ${max} characters:\n${overlong.join("\n")}\nEach -m becomes one paragraph line. ${wrapHint}`;
};

const validateInvocation = (
  invocation: GitCommitInvocation,
  config: CommitGuardConfig,
  shellMode: ShellMode
) => {
  const violations: string[] = [];

  if (invocation.isHelp) {
    return violations;
  }

  const messages = resolveMessages(invocation, violations, shellMode);

  if (messages === null) {
    return violations;
  }

  if (messages.length === 0) {
    if (
      !(invocation.isAmend && invocation.hasNoEdit === true) &&
      invocation.isFixup !== true &&
      invocation.filePaths.length === 0
    ) {
      violations.push(
        'No commit message provided. Commits in OpenCode must provide an inline message via -m "<scope>: <subject>".'
      );
    }

    return violations;
  }

  const lines = messages.join("\n\n").split(/\r?\n/u);
  const subject = (lines[0] ?? "").trim();
  const effective = subject.replace(/^(?:(?:fixup|squash)!\s+)+/u, "");

  const checks = [
    checkAllowedScope(subject, effective, config.allowedScopes ?? []),
    config.requireScope ? subjectScopeViolation(subject, effective) : null,
    checkLineLength(lines, config.maxLineLength, shellMode),
  ];

  violations.push(...checks.filter((violation) => violation !== null));
  const subjectIndex = lines.findIndex((line) => line.trim().length > 0);

  const hasTrailer =
    subjectIndex !== -1 &&
    lines.slice(subjectIndex + 1).some((line) => signoffPattern.test(line));

  if (config.enforceSignoff && !invocation.hasSignoffFlag && !hasTrailer) {
    violations.push(
      "Missing commit signoff. Commit must either include the '-s' or '--signoff' flag, or contain a valid 'Signed-off-by: Name <email>' trailer in the message body."
    );
  }

  return violations;
};

export const validateGitCommits = (
  invocations: readonly GitCommitInvocation[],
  config: CommitGuardConfig,
  _originalCommand?: string,
  shellMode: ShellMode = "posix"
) => {
  const violations = invocations.flatMap((invocation) =>
    validateInvocation(invocation, config, shellMode)
  );

  if (violations.length === 0) {
    return;
  }

  const details = violations
    .slice(0, 10)
    .map((text, index) => `${index + 1}. ${text.slice(0, 2048)}`)
    .join("\n\n");

  const scope = config.allowedScopes?.[0] ?? "scope";

  const policy = config.enforceSignoff
    ? "required: captured commit.gpgsign=true. Keep -s."
    : "not required: captured commit.gpgsign=false|unset.";

  const signoff = config.enforceSignoff ? " -s" : "";

  const example =
    shellMode === "pwsh"
      ? `  @'\n${scope}: Subject\n\nBody line one.\nBody line two.\n'@ | git commit${signoff} -F -`
      : `  git commit${signoff} -m $'${scope}: Subject\\n\\nBody line one.\\nBody line two.'`;

  throw new Error(
    `[commit-guard] Git commit rejected: commit message format rules violated.\n\nViolations:\n${details}\n\nSignoff ${policy}\nExample:\n${example}`
  );
};
