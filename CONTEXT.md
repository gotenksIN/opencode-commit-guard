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

The capture writes a private owner-only artifact and prints only `RECEIPT_OK`.
Tool results and model context receive bounded guidance, not complete historical messages.
The plugin stores a checksum-protected baseline in plugin storage.
Storage scopes include the project, session, canonical checkout root, workspace, and policy.
A persisted counter stops a late or stale capture from replacing a refreshed baseline.

Signoff policy derives from the captured effective `commit.gpgsign` value.
`true` requires a signoff; `false` or unset does not.
A missing baseline blocks commits, and an unreadable signing setting requires a configuration repair, not another capture.
The plugin rejects the removed `requireSignoff` option, because signoff follows the captured policy.

## Fail closed on parsing and metadata

The shell parser inspects commands without running them.
If it cannot prove the command words and message text, it rejects the command.
Shell expansion in messages, message files, and commit target overrides fail closed.

Publication requires shell result metadata of exactly `status: "completed"`, `exit: 0`, and `truncated: false`.
The plugin rejects other metadata, such as `timeout: true`, `shellID`, `pid`, or `killed`.
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

Plugin tests load the plugin into an in-process `@opencode/core` host.
The host uses real `Tool`, `PluginHooks`, `Shell`, `ShellTool`, `Session`, and `KV` services and runs real shell commands.
Hand-rolled plugin contexts drift from upstream contracts, so the suite does not use them.
Host layers change only to isolate state and to control permissions, flags, storage failures, and output limits.

Pure unit tests cover the shell parser, the validator, and the capture artifact format.
Tests run concurrently through `bunfig.toml`; tests that patch the clock run serially.

## Keep tooling on the latest release

Development dependencies on `@opencode/core`, `@opencode/plugin`, `ultracite`, `oxlint`, `oxlint-tsgolint`, and `oxfmt` use `latest`.
`bun.lock` records the resolved versions.
Type-aware Oxlint with the Ultracite core and anti-slop presets, and Oxfmt, gate every change.
