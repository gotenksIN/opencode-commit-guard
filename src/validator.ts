import { scopePattern } from "./scope.js";
import type { CommitGuardConfig, GitCommitInvocation } from "./types.js";

const signoffPattern =
  /^\s*[sS][iI][gG][nN][eE][dD]-[oO][fF][fF]-[bB][yY]:\s+[^<>\r\n]+\s+<[^<>\r\n@]+@[^<>\r\n@]+>\s*$/u;

const subjectScopeViolation = (
  subject: string,
  effective: string
): string | undefined => {
  if (subject.length === 0) {
    return 'Subject line is empty. The commit message must begin with "<scope>: <subject>".';
  }

  if (scopePattern.test(effective)) {
    return undefined;
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
  violations: string[]
): readonly string[] | undefined => {
  if (invocation.messageExpansion === true) {
    violations.push(
      "Cannot validate a message containing shell expansion. Supply the final message literally."
    );

    return undefined;
  }

  if (invocation.hasTrailer === true) {
    violations.push(
      "Cannot validate --trailer. Put the trailer in the literal message body or use -s."
    );

    return undefined;
  }

  const filePath = invocation.filePaths.at(-1);

  if (filePath === undefined) {
    return invocation.messages;
  }

  if (filePath !== "-" || invocation.filePaths.length !== 1) {
    violations.push(
      "Cannot validate a commit message from -F/--file before permission approval. Use an inline $'...' message or one quoted stdin heredoc."
    );

    return undefined;
  }

  if (
    invocation.stdinError !== undefined ||
    invocation.stdinMessage === undefined ||
    invocation.messages.length > 0
  ) {
    violations.push(
      `${invocation.stdinError ?? "Cannot combine -F - with -m or unsupported stdin input."} Use one quoted stdin heredoc or an inline $'...' message.`
    );

    return undefined;
  }

  return [invocation.stdinMessage];
};

const checkAllowedScope = (
  subject: string,
  effective: string,
  allowed: readonly string[]
): string | undefined => {
  const rawScope = scopePattern.exec(effective)?.[1];

  if (rawScope === undefined || allowed.length === 0) {
    return undefined;
  }

  const conventional = /^(?<type>[^(]+)\((?<scope>[^)]+)\)$/u.exec(rawScope);

  if (
    [rawScope, conventional?.[1], conventional?.[2]].some(
      (scope) => scope !== undefined && allowed.includes(scope)
    )
  ) {
    return undefined;
  }

  const detail = effective === subject ? "" : ` Subject line: "${subject}".`;

  return `Scope "${rawScope}" is not in the allowed scopes list. Allowed scopes: ${allowed.join(", ")}.${detail}`;
};

const checkLineLength = (
  lines: readonly string[],
  max: number
): string | undefined => {
  if (max <= 0) {
    return undefined;
  }

  const overlong = lines.flatMap((line, index) =>
    line.length > max
      ? [`  - Line ${index + 1} (${line.length} chars, max ${max}): "${line}"`]
      : []
  );

  return overlong.length === 0
    ? undefined
    : `Commit message exceeds maximum line length of ${max} characters:\n${overlong.join("\n")}\nEach -m becomes one paragraph line. Wrap with real newlines inside $'...'; "\\n" inside double quotes stays literal.`;
};

const validateInvocation = (
  invocation: GitCommitInvocation,
  config: CommitGuardConfig
): string[] => {
  const violations: string[] = [];

  if (invocation.isHelp) {
    return violations;
  }

  const messages = resolveMessages(invocation, violations);

  if (messages === undefined) {
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
    config.requireScope ? subjectScopeViolation(subject, effective) : undefined,
    checkLineLength(lines, config.maxLineLength),
  ];

  violations.push(...checks.filter((violation) => violation !== undefined));
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
  _originalCommand?: string
): void => {
  const violations = invocations.flatMap((invocation) =>
    validateInvocation(invocation, config)
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

  throw new Error(
    `[commit-guard] Git commit rejected: commit message format rules violated.\n\nViolations:\n${details}\n\nSignoff ${policy}\nExample:\n  git commit${config.enforceSignoff ? " -s" : ""} -m $'${scope}: Subject\\n\\nBody line one.\\nBody line two.'`
  );
};
