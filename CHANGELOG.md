# Changelog

All notable changes to `opencode-commit-guard` are documented in this file.

## 1.1.1 (2026-11-14)

- Track arithmetic `(( ... ))` and `for (( ... ))` expressions in top-level shell tokenization so left-shift operators cannot enter heredoc mode or hide subsequent commits, and fail closed on dangling `<<` redirects.
- Validate tool inputs, `commit_context` requests, and structured shell outputs with explicit property type guards instead of `Schema.Json`, allowing omitted or `undefined` optional fields while rejecting unknown option keys in `parseConfig`.
- Canonicalize shell workdirs with `realpathSync` when claiming pending captures across symlinked paths and frame inaccessible workdir errors with `[commit-guard]`.
- Consolidate shell scanning, validation, capture import helpers, and test harnesses, and reconcile `CONTEXT.md`, `AGENTS.md`, and `README.md`.

## 1.1.0 (2026-11-14)

- Preserve original error causes and metadata when appending capture failure guidance in `execute.after`.
- Prefix pre-execution shell inspection errors with `[commit-guard]` using command-neutral guidance, and support nested quoting in double-quoted `${...}` parameters and `case` patterns inside `$()` substitutions while keeping dynamic `-c` bodies fail-closed.
- Support cross-platform context capture across Linux, macOS, and Windows shells (`pwsh`, `powershell`, `cmd.exe`, and `bash`) with portable timeout and base64 framing and platform-aware path and mode validation.
- Defer `ctx.session.get` lookups in `execute.before` until required and document the deferred Code Mode `shell` boundary.
- Import `Tool` from `@opencode/plugin/effect`, remove `@opencode/schema`, move `@opencode/plugin` and `effect` to `peerDependencies`, and ship only the built `dist` bundle.
- Privatize `tokenizeShell` and `createCommitGuardError`, replace test stubs with a typed `Plugin.Context` harness and real captures, and migrate linting and formatting to type-aware Ultracite and Oxfmt.

## 1.0.7 (2026-11-04)

- Accept heredocs inside command substitutions, so quotes or parentheses in a heredoc body no longer cause a false rejection.
- Report the kind and opening position of unterminated quotes, backticks, and `$(` substitutions, and suggest a fix instead of "Run git commit directly".
- Keep braces attached to shell words and ANSI-C control escapes inside their quotes, so later commit options cannot escape validation.
- Bound substitutions with shell quote rules, decode escaped double quotes in double-quoted backticks, and join unquoted heredoc continuation lines before delimiter matching.
- Reject syntax the parser cannot read reliably: nested quoting in double-quoted parameters, `case` patterns in substitutions, ANSI-C quotes in literal `sh -c` bodies, and locale-quoted or continued dollar-quoted heredoc delimiters.
- Load the anti-slop Oxlint rules from the upstream `oxlint-plugin-anti-slop` package instead of a vendored copy.

## 1.0.6 (2026-10-29)

- Report the capture outcome in the shell result, so agents can commit after "Frozen commit baseline" without a second `commit_context` call.
- Report why a capture failed, expired, or is still pending instead of silently returning another capture command.
- Keep claimed captures alive through shell permission approval, and clean up unused captures.
- Prevent a stale capture from invalidating a newer baseline.
- Explain invalid `commit.gpgsign` or `user.signingkey` settings instead of repeating the capture.
- Scope baselines to the checkout root, so subdirectories and the root share one baseline.
- Check the baseline before message format, and allow `git commit --help` without a baseline.
- Show one policy-aware rejection example with an allowed scope, signoff only when required, and a one-line `$'...'` wrapped body.
- Detect commits after redirections, inside command substitutions, and in `bash -c` style wrappers; parse tab-stripped heredocs and Bash ANSI-C escapes.
- Reject messages that contain shell expansion, and reject `--trailer`.
- Reject `allowedScopes` entries that can never match.
- Describe the full capture procedure in the `commit_context` tool description.
- Update `@opencode/plugin` and `@opencode/schema` to `2.2.1`, `effect` to `4.0.1`, Oxlint dependencies to `1.90.0`, and `@types/bun` to `1.4.4`.

## 1.0.5 (2026-10-02)

- Add support for Git repositories located in subdirectories and moved worktrees without requiring session moves.
- Add `workdir` and `directory` options to the `commit_context` tool.
- Automatically detect a single sub-repository when the project directory is not a Git repository, and list available repositories when multiple are present.
- Resolve canonical physical paths with `realpathSync` to prevent symlink target mismatches.
- Update `@opencode/plugin` and `@opencode/schema` to `2.0.21`, and update Oxlint dependencies to `1.86.0`.

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
