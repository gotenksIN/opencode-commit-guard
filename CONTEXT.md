# Architecture specification

This document provides the architectural specification for `opencode-commit-guard`.
Use this specification to recreate or maintain the plugin from first principles.

## Domain model

The domain model represents git commit invocations, formatting rules, configuration, and violation diagnostics.

### Configuration

```ts
export interface CommitGuardConfig {
  readonly requireScope: boolean
  readonly allowedScopes?: readonly string[]
  readonly maxLineLength: number
}
```

- `requireScope`: Enforces that the commit subject begins with `<scope>: <subject>`. Defaults to `true`.
- `allowedScopes`: Optional list of valid scope names. When defined, the extracted scope must match an item in this list. Defaults to `undefined`.
- `maxLineLength`: Maximum allowed line length across subject and body lines. Defaults to `72`. Setting this to `0` disables length checks.
- Signoff applies only when a verified baseline records effective `commit.gpgsign=true`.
  A missing, failed, or stale baseline blocks the commit.

### Commit invocation

```ts
export interface GitCommitInvocation {
  readonly messages: readonly string[]
  readonly filePaths: readonly string[]
  readonly stdinMessage?: string
  readonly stdinError?: string
  readonly hasSignoffFlag: boolean
  readonly isAmend: boolean
  readonly isHelp: boolean
  readonly targetError?: string
}
```

- `messages`: Commit message fragments supplied via `-m` or `--message`.
- `filePaths`: Message files referenced via `-F` or `--file`.
- `hasSignoffFlag`: `true` when `-s` or `--signoff` was passed; `false` when omitted or explicitly overridden by `--no-signoff`.
- `isAmend`: `true` when `--amend` was passed.
- `isHelp`: `true` when `-h` or `--help` was passed.
- `targetError`: Describes a directory or Git configuration override that prevents reliable target matching.
- `stdinMessage` and `stdinError`: Hold a validated quoted heredoc body or an actionable stdin-input rejection.

### Diagnostics

```ts
export interface OverlongLine {
  readonly lineNumber: number
  readonly length: number
  readonly text: string
}
```

- `OverlongLine`: Records a specific line that exceeded `maxLineLength`, along with its line number and character count.

## Shell command decomposition

The shell parser (`src/shell.ts`) inspects shell command strings without spawning child processes.

### 1. Tokenization (`tokenizeShell`)

The tokenizer divides the raw command into words, control operators, and redirections:

- Operators: `&&`, `||`, `|&`, `;;`, `;`, `&`, `|`, `\n`, `(`, `)`.
- Quotes:
  - Single quotes (`'...'`) preserve all characters literally.
  - Double quotes (`"..."`) interpret escape characters (`\"`, `\\`, `\$`, `` \` ``, `\n`).
  - ANSI-C quotes (`$'...'`) resolve standard escape codes (`\n`, `\t`, `\r`, etc.).
- Concatenation: Adjacent quoted and unquoted fragments (such as `--message="value"`) combine into a single word token.
- Line continuation: Backslash newline sequences (`\` + `\n`) are discarded.
- Redirections: File descriptors and redirect operators (`> /dev/null`, `2>&1`, `< file`) are identified and separated from arguments.

### 2. Invocation extraction (`extractGitCommits`)

The extraction pipeline identifies git commit commands:

1. Splits tokens into simple commands separated by control operators (`&&`, `;`, `||`, `|`, subshells).
2. Filters out redirect operators and their target paths.
3. Skips leading environment variable assignments (`VAR=val`).
4. Skips command execution wrappers (`env`, `exec`, `command`, `builtin`, `nohup`).
5. Verifies that the command executable is `git`.
6. Consumes git global options (`-C`, `-c`, `--git-dir`, `--work-tree`, `--no-pager`, etc.).
7. Confirms that the git subcommand is `"commit"`.
8. Parses commit flags:
   - `-m`, `--message`, `--message=` extract message values.
   - `-F`, `--file`, `--file=` extract message file references.
   - `-s`, `--signoff`, `--no-signoff` update the signoff flag.
   - Combined short flags (such as `-sm "..."`, `-sam "..."`, `-m"..."`) are correctly unpacked.
   - Positional separator `--` terminates flag processing.

## Validation engine

The validation engine (`src/validator.ts`) enforces commit format invariants.

### 1. Message assembly

- If multiple `-m` options are given, their values are joined with double newlines (`\n\n`) as separate paragraphs.
- File-backed references (`-F <file>`, `--file=<file>`) are rejected before shell execution.
- One complete, quoted heredoc attached directly to descriptor 0 of `git commit -F -` supplies a literal message.
- Pipelines, multiple heredocs, inherited compound-command input, nonzero descriptors, competing stdin redirects, and unquoted delimiters are rejected for `-F -`.
- The plugin never reads `-F` or `--file` message files because the pre-execution hook has no permission-checked file access boundary.
- If no message is provided, the invocation is rejected unless it uses `--amend --no-edit` or a generated fixup message.
- `git commit --amend --no-edit` without a new message retains the existing message without reading or revalidating repository history.
- Explicit amendment messages are validated without reading repository history.

### 2. Rule evaluation

1. **Scope format (`requireScope`)**:
   - The first line is evaluated against `/^([a-zA-Z0-9_\-./]+(?:\([a-zA-Z0-9_\-./]+\))?):\s+(.+)$/`.
   - Rejects empty subjects, missing colons, empty scopes, and missing spaces after colons.
2. **Allowed scopes (`allowedScopes`)**:
   - Matches the extracted scope against the configured list.
   - For conventional commits (`type(scope)`), checks the inner scope, the full scope token, and the type prefix.
3. **Line length (`maxLineLength`)**:
   - Evaluates every line in the assembled commit text against the maximum line length (default 72).
   - Records each overlong line with its 1-based index and character count.
4. **Signoff (captured `commit.gpgsign`)**:
   - Satisfied if `hasSignoffFlag` is true or if any line in the message body matches `/^\s*Signed-off-by:\s+[^<>\r\n]+\s+<[^<>\r\n@]+@[^<>\r\n@]+>\s*$/i`.

### 3. Error construction

When violations occur, the engine throws an Error with:
- A clear rejection header.
- A numbered list of specific violations with offending text.
- Concrete examples of conforming git commit commands.
- The attempted command string.

## OpenCode hook integration

The plugin (`src/plugin.ts`) wires the validation engine to OpenCode's tool execution lifecycle:

- Entrypoint: `Plugin.define` from `@opencode/plugin/effect`.
- Hook: `ctx.tool.hook("execute.before")` with an Effect callback.
- Checks if `event.tool` is `"shell"` or `"bash"`.
- Extracts `command` from `event.input`.
- Does not read repository history or message files before the shell permission check.
- Runs `extractGitCommits(command)` and validates all found invocations.
- Loads a checksum-validated, session-and-worktree-scoped signing baseline from plugin storage.
- Rejects missing or invalid baselines, remote workspaces, and commits whose target differs from the captured checkout.
- Requires signoff only when the baseline records effective `commit.gpgsign=true`.
- Validation failures use the typed `Tool.Error` failure channel so parallel calls settle independently without becoming Effect defects.

## Authorized context capture

The on-demand `commit_context` tool returns a Git capture command for the foreground `shell` tool.
The plugin creates a private owner-only artifact and retains its file descriptor before returning the command.
It claims the exact command against the shell tool-call identity before execution.
The installed V2 shell tool's result metadata uses `status: "completed"`, `exit: 0`, and `truncated: false` for a successful foreground process.
This is the tool-result status, not `Shell.Info.status`, which uses `exited`.
A continued background call reports `status: "running"` and `shellID`; a timeout reports `timeout: true` with no exit; a killed call reports an `execute.after` error without result metadata.
The importer requires the observed successful metadata combination, rejects unrecognized or absent fields, and separately requires the artifact end sentinel.
It also validates bounded artifact framing, ownership, size, and a final end sentinel through that descriptor.
The plugin extends the attempt's deadline when `execute.before` claims the exact command and again when the shell process is created after permission approval.
The shell-creation hook only updates the deadline; it does not read Git.
Git reference failures cannot be inferred to mean detached or unborn HEAD; an unborn HEAD requires a readable symbolic reference and a successful status check.
Only then does it store a checksum-protected snapshot under a unique key.
The snapshot contains the checkout identity, branch, HEAD, up to ten full messages, and effective signing settings.
Storage scopes include schema, project, session, location, and policy revision.
A persisted invalidation counter prevents a late snapshot from replacing a refreshed or cancelled baseline.
The tool returns only bounded guidance and observed scope examples, never complete historical messages.
Refresh the frozen baseline after a branch switch, signing setting change, or changed commit instructions.
The plugin does not detect configuration changes or repository replacement at the same path without another authorized capture.
The guard does not verify cryptographic signatures or enforce all writing conventions in `AGENTS.md`.

## Packaging and runtime invariants

- Package uses ECMAScript Modules (`"type": "module"`).
- Dependencies on `@opencode/plugin`, `@opencode/schema`, and `effect` are declared under `dependencies`.
- The ESM distribution bundle keeps OpenCode and Effect runtime packages external so it uses the host's typed failure classes and Effect runtime.
- Oxlint enforces custom anti-slop rules including `require-safety-comment-for-type-assertion` and `no-runtime-typeof`.
