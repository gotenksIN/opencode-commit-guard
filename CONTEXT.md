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
- `parseConfig` rejects allowed-scope entries that cannot match the validator's shared scope pattern.

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
  - Double quotes (`"..."`) decode `\"`, `\\`, `\$`, and `` \` ``, and remove backslash-newline continuations.
    They preserve `\n` literally.
  - ANSI-C quotes (`$'...'`) decode Bash control, hexadecimal, Unicode, and octal escapes, and preserve the backslash on unknown escapes.
    A trailing `\c` preserves the closing quote; `\c\\` consumes the escaped backslash operand.
- Concatenation: Adjacent quoted and unquoted fragments (such as `--message="value"`) combine into a single word token.
- Braces separate commands only as standalone reserved words at command positions; attached braces remain part of their word.
  Function declarations, `time -p`, and `coproc` also introduce brace groups.
  Prefix combinations such as `time -p -- !` retain their command position.
  Brace boundaries ignore backslash-newline continuations.
- Line continuation: Backslash newline sequences (`\` + `\n`) are discarded.
- Redirections: File descriptors and redirect operators (`> /dev/null`, `2>&1`, `< file`) are identified and separated from arguments.
- Tab-stripping heredocs (`<<-`) remove leading tabs from body lines and the closing delimiter.
- Message tokens track unquoted and double-quoted expansions without evaluating them.
- Unterminated quotes fail closed with the quote kind and the position of the opening quote.

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
9. Recursively inspects `$()` and backtick substitutions and literal `bash`, `sh`, and `zsh` `-c` bodies.
   Bounded recursion and incomplete or dynamic shell bodies fail closed with instructions to run Git directly.

## Validation engine

The validation engine (`src/validator.ts`) enforces commit format invariants.

### 1. Message assembly

- If multiple `-m` options are given, their values are joined with double newlines (`\n\n`) as separate paragraphs.
- File-backed references (`-F <file>`, `--file=<file>`) are rejected before shell execution.
- One complete, quoted heredoc attached directly to descriptor 0 of `git commit -F -` supplies a literal message.
- Pipelines, multiple heredocs, inherited compound-command input, nonzero descriptors, competing stdin redirects, and unquoted delimiters are rejected for `-F -`.
- The plugin never reads `-F` or `--file` message files because the pre-execution hook has no permission-checked file access boundary.
- Messages containing shell expansion are rejected; single quotes and ANSI-C quotes supply literal text.
- `--trailer` is rejected; use a literal trailer in the message body or `-s`.
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
- One single-line example with the first allowed scope (or `scope`), literal `\n` escapes inside `$'...'`, and `-s` only when signoff is required.
- The captured signoff policy and bounded violation details, without repeating the attempted command.

## OpenCode hook integration

The plugin (`src/plugin.ts`) wires the validation engine to OpenCode's tool execution lifecycle:

- Entrypoint: `Plugin.define` from `@opencode/plugin/effect`.
- Hook: `ctx.tool.hook("execute.before")` with an Effect callback.
- Checks if `event.tool` is `"shell"` or `"bash"`.
- Extracts `command` from `event.input`.
- Does not read repository history or message files before the shell permission check.
- Runs `extractGitCommits(command)` and validates all found invocations.
- Loads a checksum-validated, session-and-worktree-scoped signing baseline from plugin storage.
- Resolves the baseline before validating message format and signoff once with the captured policy.
  Help-only invocations do not require a baseline.
- Rejects missing or invalid baselines, remote workspaces, and commits whose target differs from the captured checkout.
- Supports Git repositories located at the project root, in subdirectories, or in moved sessions/worktrees.
- Requires signoff only when the baseline records effective `commit.gpgsign=true`.
- Validation failures use the typed `Tool.Error` failure channel so parallel calls settle independently without becoming Effect defects.

## Authorized context capture

The on-demand `commit_context` tool returns a Git capture command for the foreground `shell` tool.
The tool accepts an optional `workdir` (or `directory` alias) parameter to target a repository located in a subdirectory or worktree.
When omitted in a non-repository directory, it automatically targets a single sub-repository or lists available repositories.
Run the returned command immediately, unchanged, with its indicated workdir and `background:false`.
Do not wrap it or chain another command onto it.
Commit after the shell result reports `Frozen commit baseline` and follow its commit rules.
If the result lacks that report, call `commit_context` again for status and next steps.
A second call is optional after inline success.
Repeat an explicit `workdir` when you check that checkout.
An argument-free call prioritizes the session directory's repository over a remembered target.
The plugin creates a private owner-only artifact and retains its file descriptor before returning the command.
It claims the exact command against the shell tool-call identity before execution.
The installed V2 shell tool's result metadata uses `status: "completed"`, `exit: 0`, and `truncated: false` for a successful foreground process.
This is the tool-result status, not `Shell.Info.status`, which uses `exited`.
A continued background call reports `status: "running"` and `shellID`; a timeout reports `timeout: true` with no exit; a killed call reports an `execute.after` error without result metadata.
The importer requires the observed successful metadata combination, rejects unrecognized or absent fields, and separately requires the artifact end sentinel.
It also validates bounded artifact framing, ownership, size, and a final end sentinel through that descriptor.
An unclaimed attempt has a 20-second admission deadline.
Once `execute.before` claims it, permission approval and execution do not expire the attempt.
The host calls `create.before` before permission approval, not after it.
The shell command's process timeout and verified result metadata bound execution.
Each context or pre-execution call sweeps up to 32 pending entries and removes expired unclaimed artifacts and descriptors.
The sweep never removes claimed attempts.
Git reference failures cannot be inferred to mean detached or unborn HEAD; an unborn HEAD requires a readable symbolic reference and a successful status check.
Only then does it store a checksum-protected snapshot under a unique key.
The snapshot contains the checkout identity, branch, HEAD, up to ten full messages, and effective signing settings.
Storage scopes include schema, project, session, canonical checkout root, workspace, and policy revision.
Captures retain their exact authorized workdir for claim matching, while root and subdirectory calls share baseline identity and refresh invalidation.
A persisted invalidation counter prevents a late snapshot from replacing a refreshed or cancelled baseline.
Each prepared attempt reserves a distinct counter under the storage lock, including captures prepared after plugin reload.
Cleanup compares and increments this counter atomically, only while the attempt still owns it.
Each scope retains one persisted capture status: prepared, claimed, published, expired, or failed.
Failure reasons are bounded and explain metadata, artifact, counter, or storage failures on the next context call.
The plugin also retains up to 128 failure diagnostics in memory if storage fails.
`RECEIPT_OK` confirms only that the artifact was written, not that the baseline was published.
The plugin appends one bounded outcome note to claimed capture results, preserving the original content parts and metadata.
It also appends that note to the structured shell output so Code Mode receives it.
A failed tool call retains its original error message with the failure note appended.
The context tool and inline success share identical checkout-root guidance and captured signoff instructions.
An invalid signing setting produces repair guidance instead of another capture command.
Inspect its origin, fix the value without changing the intended signing policy, then request `refresh:true`.
The tool returns only bounded guidance and observed scope examples, never complete historical messages.
Refresh the frozen baseline after a branch switch, signing setting change, or changed commit instructions.
The plugin does not detect configuration changes or repository replacement at the same path without another authorized capture.
The guard does not verify cryptographic signatures or enforce all writing conventions in `AGENTS.md`.

## Packaging and runtime invariants

- Package uses ECMAScript Modules (`"type": "module"`).
- Dependencies on `@opencode/plugin`, `@opencode/schema`, and `effect` are declared under `dependencies`.
- The ESM distribution bundle keeps OpenCode and Effect runtime packages external so it uses the host's typed failure classes and Effect runtime.
- Oxlint enforces custom anti-slop rules including `require-safety-comment-for-type-assertion` and `no-runtime-typeof`.
