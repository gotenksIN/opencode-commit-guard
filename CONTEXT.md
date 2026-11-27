# Project decisions

## Guard before execution instead of Git hooks

The plugin validates `git commit` commands in the OpenCode `execute.before` tool hook.
It rejects a violation through the typed `Tool.Error` channel before the shell runs.
The agent receives each violation and a conforming example, and the repository stays unchanged.
Git hooks, Gerrit Change-Id hooks, and repository configuration stay untouched.
Parallel tool calls settle independently because rejections are typed failures, not Effect defects.

The guard covers only commits that agents start through the `shell` and `bash` tools.
It does not verify cryptographic signatures or enforce every writing convention in `AGENTS.md`.

## Capture Git context on demand

The `commit_context` tool returns a capture command for the foreground `shell` tool.
The agent runs that command, so the normal shell permission flow authorizes every read of repository history and configuration.
The plugin runs no Git commands and reads no repository history or Git configuration on its own.

The capture writes a private owner-only artifact where each line is a base64-encoded Git result, and prints only `RECEIPT_OK`.
No Git output enters the shell result.
Tool results and model context receive bounded guidance, not complete historical messages.
On POSIX, the capture script enables Bash job control so the watchdog kills the worker process group and all Git children at the deadline.
During import, the plugin decodes every base64 config field, even when unset, to enforce strict framing.

The plugin stores a checksum-protected baseline in plugin storage.
Storage scopes include the project, session, canonical checkout root, workspace, and policy.
A persisted counter stops a late or stale capture from replacing a refreshed baseline.
Unclaimed captures expire after 20 seconds so models capture context right before committing.
When a model retries `commit_context` without `refresh: true` for the same workdir, the plugin refreshes the unclaimed capture expiry; when the workdir changes within the same checkout root, the plugin replaces the unclaimed capture.
The plugin records recently expired capture commands and detects modified live capture commands before shell parsing so agents receive direct expiry or unchanged-command guidance.

Signoff policy derives from the captured effective `commit.gpgsign` value.
`true` requires a signoff; `false` or unset does not.
A missing baseline blocks commits, and an unreadable signing setting requires a configuration repair, not another capture.
The plugin rejects the removed `requireSignoff` option, because signoff follows the captured policy.

## Target PowerShell 7 on Windows

Windows context capture targets PowerShell 7 (`pwsh`) exclusively and drops legacy `powershell.exe` and `cmd.exe`.
The Windows capture command passes an uncompressed UTF-16LE `pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand` script, removing `gzip` and `Invoke-Expression` bootstrapping.
It uses PowerShell 7 native `$p.Kill($true)` with start-state guards instead of shelling out to `taskkill.exe`, and parameterizes the watchdog timeout in milliseconds.

In `execute.before`, the plugin selects `pwsh` top-level parsing when the shell tool description matches `using pwsh.` (checking `event.info?.description`, then `ctx.tool.list()`, then `process.platform === "win32"`).
The shell parser in `src/shell.ts` implements PowerShell 7 quoting, Unicode smart quotes and dashes, backtick escapes, line and block comments, here-strings, subexpressions, call operators, target mutators, and fail-closed splatting and stop-parsing checks.
It recursively unwraps nested `pwsh` and `pwsh.exe` invocations (including `-Command`, `-CommandWithArgs`, and strict UTF-16LE `-EncodedCommand`) in both POSIX and `pwsh` modes.
In `pwsh` mode, `git commit -F -` accepts a single-stage literal here-string pipeline (`@'...'@ | git commit -F -`) while rejecting multi-stage pipelines, expandable `@"..."@` here-strings, and disk message files.

## Fail closed on parsing and metadata

The shell parser inspects commands without running them.
If it cannot prove the command words and message text, it rejects the command.
Shell expansion in messages, message files, and commit target overrides fail closed.
In POSIX tokenization, adjacent ANSI-C quotes buffer raw bytes until the whole word is assembled so split UTF-8 sequences decode accurately, and arithmetic `(( ... ))` expressions do not treat left-shift `<<` operators as heredoc redirects.

Publication requires shell result metadata of exactly `status: "completed"`, `exit: 0`, and `truncated: false`, with optional `timeout: false`.
The plugin rejects other metadata and names any unexpected keys, such as `shellID`, `pid`, or `killed`, in the failure reason.
Publication also requires the artifact `END` sentinel.

This rule handles two OpenCode `v2.4.1` behaviors:

- A foreground command that exceeds its timeout moves to the background.
  Its result has `status: "running"` and a `shellID`, so the capture fails and releases its artifact.
- A worker restart or daemon loss reports `killed: true` without an exit code.
  The capture fails instead of trusting a partial artifact.

## Keep `commit_context` in Code Mode and unpinned

`commit_context` stays Code Mode-eligible, and it does not set `pinned: true`.
Each nested Code Mode tool call has its own call ID.
Parallel `tools.shell` captures in one script do not collide.
An unpinned tool keeps non-Git sessions from paying the full catalog token cost.

The `full_codemode` shell schema has no `background` field.
Capture guidance asks for foreground execution in plain words instead of a `background:false` argument.

A top-level call to a Code Mode-only `shell` reaches `execute.before` with `codemode: false` and `execute.after` with `codemode: true`.
The plugin matches a claimed capture by call ID, message ID, session, and agent, not by `codemode`.

## Accept the hook-order boundary

OpenCode V2 hooks have no priority and run in registration order.
A later `execute.before` hook can change or rename a call, including a Code Mode call.
The guard detects the cases that affect a claimed capture:

- If a later hook changes the capture command, publication fails.
- If a later hook renames the capture call away from `shell`, the capture fails and releases its artifact without changing the tool result.
  This cleanup runs in `execute.after`.
  If the new name is not an available tool, OpenCode returns an error without running `execute.after`, and the capture stays claimed.
  In that case, call `commit_context` with `refresh: true` to replace the claimed capture.

A later plugin that renames another tool to `shell` runs after this guard has inspected the call.
The guard cannot inspect that call.

## Package with external runtime peers

`@opencode/plugin` and `effect` are peer dependencies and stay external in the ESM bundle.
The plugin then shares the host's `Tool.Error` class and Effect runtime.
The peer floor is `@opencode/plugin ^2.4.1` and `effect ^4.0.0`.
`@opencode/core` is a development dependency for tests only and never enters `dist/`.

## Test through the real OpenCode host

Plugin tests load the plugin into an in-process `@opencode/core` host (`test/host.test-utils.ts`).
The host uses real `Tool`, `PluginHooks`, `Shell`, `ShellTool`, `ShellSelect`, `Session`, and `KV` services and runs real shell commands.
Hand-rolled plugin contexts drift from upstream contracts, so the suite does not use them.
Host layers change only to isolate state and to control permissions, flags, storage failures, shell selection, and output limits.

Pure unit tests live beside their source modules (`src/shell.test.ts`, `src/validator.test.ts`, and `src/capture.test.ts`).
The plugin reads time through Effect `Clock.Clock` captured in `plugin.effect`.
Time-boundary tests provide a plugin-scoped `TestClock` from `effect/testing` without replacing the host clock or mutating `Date.now`, so the entire suite runs concurrently through `bunfig.toml`.
Real `pwsh` capture, watchdog, and host E2E tests run unconditionally on `win32` and on POSIX hosts whenever `pwsh` is on `PATH`.

## Keep tooling on the latest release

Development dependencies on `@opencode/core`, `@opencode/plugin`, `ultracite`, `oxlint`, `oxlint-tsgolint`, and `oxfmt` use `latest`.
`@interfere/landmines` stays pinned to `0.1.1` until Ultracite updates `ultracite/oxlint/landmines` for `@interfere/landmines >= 0.2.0`.
`bun.lock` records the resolved versions.
Type-aware Oxlint with the Ultracite core, anti-slop, and landmines presets, Oxfmt, TypeScript (`NodeNext` with `noUncheckedIndexedAccess`), and `bun test` gate every change through `bun run check`.
