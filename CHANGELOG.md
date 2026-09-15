# Changelog

All notable changes to `opencode-commit-guard` are documented in this file.

## 1.0.2 (2026-09-15)

- Update OpenCode V2 and Oxlint dependencies.
- Reject file-based commit messages before execution to prevent unauthorized host file reads.
- Resolve relative, home, and Windows shell working directories consistently with OpenCode.
- Reject unsafe repository selectors and ambiguous home directory changes for no-edit amendments.
- Reject local repository reads for no-edit amendments in workspace-backed sessions.
- Return validation failures through OpenCode's typed tool-error channel.

## 1.0.1 (2026-09-12)

- Accept `git commit --fixup=<commit>` without requiring `-m` or `-F`.
- Allow `fixup!` and `squash!` prefixes on commit subjects while checking the underlying scope.
- Support `git commit --amend --no-edit` by validating the existing `HEAD` commit message.

## 1.0.0 (2026-09-12)

- Initial release of `opencode-commit-guard` for OpenCode V2.
- Intercepts `shell` and `bash` tool execution via `ctx.tool.hook("execute.before")`.
- Enforces `<scope>: <subject>` prefix formatting in commit subject lines.
- Enforces 72-character maximum line length across subject and body lines.
- Enforces commit sign-offs (`-s`, `--signoff`, or `Signed-off-by:` body trailers).
- Robust shell tokenizer supporting command chaining, subshells, quotes, and shell comment stripping.
- Safe `-F` / `--file` relative path resolution against working directories with bounded reads.
- Configurable plugin options: `requireScope`, `allowedScopes`, `maxLineLength`, and `requireSignoff`.
- Vendored anti-slop Oxlint rules and complete Bun test suite.
