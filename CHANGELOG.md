# Changelog

All notable changes to `opencode-commit-guard` are documented in this file.

## 1.0.4 (2026-09-23)

- Add `commit_context` to cache authorized Git commit baselines and signing settings in plugin storage.
- Derive signoff from captured effective `commit.gpgsign` and remove the `requireSignoff` option.
- Block commits without a valid baseline and give capture instructions.
- Reject ambiguous commit targets, including `git -C`, environment mutations, and directory-changing wrappers, instead of reusing another checkout's baseline.
- Require verified foreground shell metadata and a complete private artifact; reject background, timed-out, truncated, or unverified captures.
- Keep `git commit --amend --no-edit` without re-validating the committed message; allow generated `--fixup` commits and validate explicit `fixup!` and `squash!` subjects alongside normal commit messages.

## 1.0.3 (2026-09-23)

- Update compatible OpenCode V2, schema, Effect, and Bun development dependencies.
- Stop reading repository history in pre-execution validation; require an explicit message for no-edit amendments.
- Validate Git subcommands with quoted shell fragments.
- Accept one complete quoted stdin heredoc for `git commit -F -` and reject ambiguous input before execution.
- Continue rejecting disk-backed `-F <path>` commit messages.

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
