# opencode-commit-guard

OpenCode V2 plugin that enforces git commit message format rules during agent sessions.
Capture Git context before your first commit in each session and checkout.

## Overview

`opencode-commit-guard` intercepts `shell` and `bash` tool execution before it runs.
When an agent attempts a `git commit`, the plugin inspects the command line and inline message content.
If the commit violates configured formatting standards, the plugin rejects the tool call through OpenCode's typed tool-error channel.
The plugin requires a valid Git signing baseline for the exact checkout before it allows a commit.

### Why this approach fits

- Operates strictly inside OpenCode agent sessions.
- Leaves system git hooks, Gerrit Change-Id hooks, and repository configuration untouched.
- Gives the agent an immediate error explaining the rule violation and providing a conforming example.
- Allows the agent to correct the message and retry without corrupting repository state.

## Installation

Add the plugin to your `opencode.json` configuration file:

```json
{
  "plugins": [
    {
      "package": "opencode-commit-guard"
    }
  ]
}
```

You can also specify custom configuration options:

```json
{
  "plugins": [
    {
      "package": "opencode-commit-guard",
      "options": {
        "requireScope": true,
        "allowedScopes": ["kernel", "releasetools", "build", "ui"],
        "maxLineLength": 72
      }
    }
  ]
}
```

## Configuration options

| Option | Type | Default | Description |
|---|---|---|---|
| `requireScope` | `boolean` | `true` | Requires the first line to match `<scope>: <subject>`. |
| `allowedScopes` | `string[]` | `undefined` | Restricts allowed scope identifiers to a specified list. |
| `maxLineLength` | `number` | `72` | Limits every line in the subject and body to this length. Set to `0` to disable. |

## Capture commit context

Call `commit_context` before your first commit in each session and worktree.
If the Git repository is in a subdirectory or differs from the project root, specify `workdir` (e.g., `commit_context({ workdir: "my-repo" })`).
If `workdir` is omitted and the project root is not a Git repository, the plugin automatically selects the repository if exactly one exists, or lists available repositories if multiple are present.
Run the returned command immediately, unchanged, through the foreground `shell` tool with the indicated workdir and `background:false`.
Do not wrap it or chain another command onto it.
Commit after the shell result reports `Frozen commit baseline` and follow its commit rules.
If the result lacks that report, call `commit_context` again with the same workdir for status and next steps.
A second call is optional after inline success.
Repeat an explicit `workdir` when you check that checkout.
An argument-free call selects the session directory when it is inside a Git repository, even after an explicit selection.
If the shell result lacks a verified successful process exit, capture again instead of using a partial baseline.
The command writes full historical messages to a private file and prints a fixed receipt.
The plugin appends the capture outcome and commit rules to the shell result.
`RECEIPT_OK` confirms only that the artifact was written, not that the baseline was published.
The next context call reports whether a capture is unclaimed, awaiting permission or execution, expired, or failed.
Run an unclaimed command within 20 seconds; a claimed capture does not expire during permission approval.
Expired unclaimed captures release their private files on later context or tool calls.
The plugin does not put complete historical messages into tool results or model context.
Set `refresh: true` after a branch switch, a signing setting change, or a change to commit instructions.
A failed refresh does not restore the previous baseline.
Calls from the checkout root and its subdirectories share one baseline and refresh state.
Run each capture from its exact indicated workdir.
An external Git configuration change or checkout replacement at the same path is not detected until you refresh.
Remote workspaces are unsupported.
Historical scopes are observations, not allowed scopes or policy.
The guard enforces configured scope syntax, allowed scopes, line length, inline message input, and conditional signoff.
It does not enforce every writing convention in `AGENTS.md` or verify a cryptographic signature.

## Formatting rules

### 1. Scope prefix (`requireScope`)

The first line of the commit message must follow the `<scope>: <subject>` pattern.
Both standard lowercase scopes and conventional commit formats are valid:

- `kernel: add support for new thermal sensor`
- `releasetools: fix ota package generation`
- `feat(parser): add subshell tokenization`
- `fix(ui): resolve button alignment issue`

The plugin rejects subject lines that omit the colon, leave the scope empty, or omit the space after the colon:

- Invalid: `Add support for new thermal sensor`
- Invalid: `: add support for new thermal sensor`
- Invalid: `kernel:add support for new thermal sensor`

### 2. Allowed scopes (`allowedScopes`)

When `allowedScopes` contains values, the extracted scope must match an entry in the list.
For conventional commits such as `feat(parser): ...`, the plugin accepts either the inner scope (`parser`), the full scope token (`feat(parser)`), or the type prefix (`feat`).
Each configured entry must match the scope syntax; spaces and characters such as `@` are invalid.

### 3. Maximum line length (`maxLineLength`)

No line in the commit subject or body may exceed the configured character limit (default 72 characters).
When a line exceeds this limit, the error identifies the exact line number, current character length, and offending text.
Each `-m` supplies a paragraph, not automatic line wrapping.
Wrap with real newlines inside `$'...'`; `"\n"` inside double quotes remains literal.

### 4. Signoff

When the captured effective `commit.gpgsign` is `true`, every commit with a supplied message must include a signoff indicator.
When it is `false` or unset, signoff is not required.
A missing signing snapshot blocks the commit until you capture context.
An invalid signing setting requires a configuration repair, not repeated capture.
Inspect it with `git config --show-origin --get-all commit.gpgsign` (or `user.signingkey`).
Fix the value without changing the intended signing policy, then call `commit_context({ refresh: true })`.
You can provide this either via flags or directly in the message body:

- Pass `-s` or `--signoff` in the git command.
- Or include a trailer matching `Signed-off-by: Full Name <email@example.com>` in the message body.

Signoff identifies the author of a contribution.
It does not cryptographically sign the commit.
Git signing settings and your signing key remain separate from signoff.

### 5. Amend commits (`--amend`)

Use `git commit --amend --no-edit` to keep the existing message unchanged.
The plugin does not read or revalidate that message, so a message created outside this guard may not meet its format rules.
Provide `-m` when you change the message; the plugin validates the supplied text in the captured checkout.
Use a direct Git command in that checkout.
The guard rejects `git -C`, Git directory and worktree flags, Git environment overrides, and directory-changing wrappers because they can select another target.
The guard also rejects earlier shell environment mutations such as `export`, `typeset`, `declare`, `source`, `.`, `eval`, `set`, and assignment-only commands before a commit.

### Message input

Provide commit messages inline with `-m` or `--message`, or use one quoted heredoc directly on standard input:

```bash
git commit -s -F - <<'EOF'
kernel: fix race
EOF
```

The plugin rejects file-backed `-F` or `--file` messages without reading the files.
It also rejects unquoted or ambiguous standard-input sources.
Supply the final message literally; message words containing shell expansion are rejected without evaluation.
Single quotes and ANSI-C quotes (`$'...'`) supply literal text.
The parser inspects commits inside command substitutions, backticks, and literal `bash`, `sh`, or `zsh` `-c` bodies.
Run Git directly if a shell body is dynamic or cannot be parsed reliably.
Put trailers in the literal message body or use `-s`; `--trailer` is rejected.
The guard resolves the signing baseline before reporting message-format violations.
`git commit --help` and `git commit -h` do not require a baseline.

## Development

Use Bun for all repository operations.

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run build
```
