# Changelog

All notable changes to `opencode-commit-guard` are documented in this file.

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
