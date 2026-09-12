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
  readonly requireSignoff: boolean
}
```

- `requireScope`: Enforces that the commit subject begins with `<scope>: <subject>`. Defaults to `true`.
- `allowedScopes`: Optional list of valid scope names. When defined, the extracted scope must match an item in this list. Defaults to `undefined`.
- `maxLineLength`: Maximum allowed line length across subject and body lines. Defaults to `72`. Setting this to `0` disables length checks.
- `requireSignoff`: Enforces that the commit includes `-s` / `--signoff` or a `Signed-off-by:` trailer. Defaults to `true`.

### Commit invocation

```ts
export interface GitCommitInvocation {
  readonly messages: readonly string[]
  readonly filePaths: readonly string[]
  readonly hasSignoffFlag: boolean
  readonly isAmend: boolean
  readonly isHelp: boolean
}
```

- `messages`: Commit message fragments supplied via `-m` or `--message`.
- `filePaths`: Message files referenced via `-F` or `--file`.
- `hasSignoffFlag`: `true` when `-s` or `--signoff` was passed; `false` when omitted or explicitly overridden by `--no-signoff`.
- `isAmend`: `true` when `--amend` was passed.
- `isHelp`: `true` when `-h` or `--help` was passed.

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
- File references (`-F <file>`) are resolved against the current working directory and read synchronously.
- If a referenced file does not exist, a violation is added.
- If no message is provided and `--amend` is not present, the invocation is rejected.
- If `--amend` is present with no new message (`git commit --amend --no-edit`), validation passes.

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
4. **Signoff (`requireSignoff`)**:
   - Satisfied if `hasSignoffFlag` is true or if any line in the message body matches `/^\s*Signed-off-by:\s+[^<>\r\n]+\s+<[^<>\r\n@]+@[^<>\r\n@]+>\s*$/i`.

### 3. Error construction

When violations occur, the engine throws an Error with:
- A clear rejection header.
- A numbered list of specific violations with offending text.
- Concrete examples of conforming git commit commands.
- The attempted command string.

## OpenCode hook integration

The plugin (`src/plugin.ts`) wires the validation engine to OpenCode's tool execution lifecycle:

- Hook: `ctx.tool.hook("execute.before")`.
- Checks if `event.tool` is `"shell"` or `"bash"`.
- Extracts `command` from `event.input`.
- Returns immediately if the command does not contain `"commit"`.
- Runs `extractGitCommits(command)` and validates all found invocations.
- Throwing an Error inside `execute.before` aborts tool execution and displays the error prompt to the agent.

## Packaging and runtime invariants

- Package uses ECMAScript Modules (`"type": "module"`).
- Dependency on `@opencode/plugin: 2.0.2` declared under `dependencies`.
- Standalone ESM distribution bundle created with `bun build index.ts --outdir dist --target bun --format esm --external @opencode/plugin`.
- Oxlint enforces custom anti-slop rules including `require-safety-comment-for-type-assertion` and `no-runtime-typeof`.
