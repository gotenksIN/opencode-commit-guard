# opencode-commit-guard

This OpenCode V2 plugin checks Git commit messages before an agent runs `git commit`.
It requires `@opencode/plugin` 2.4.1 or newer.

## Overview

The plugin inspects every `shell` and `bash` tool call before it runs, across POSIX shells and PowerShell 7 (`pwsh`).
If a `git commit` breaks a formatting rule, the plugin rejects the tool call with an error.
The error lists each violation and shows a conforming example, so the agent can fix the message and retry.

Before the first commit in each session and checkout, the agent captures a Git baseline with the `commit_context` tool.
The baseline records the effective `commit.gpgsign` setting, which determines whether a commit needs a signoff.
On Windows, context capture and command inspection target PowerShell 7 (`pwsh`).

The plugin does not change Git hooks or repository configuration.

## Installation

Add the package to your `opencode.json` or `opencode.jsonc` file:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-commit-guard",
    },
  ],
}
```

Set options on the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-commit-guard",
      "options": {
        "requireScope": true,
        "allowedScopes": ["kernel", "build", "ui"],
        "maxLineLength": 72,
      },
    },
  ],
}
```

| Option          | Default | Allowed values                                                                     |
| --------------- | ------- | ---------------------------------------------------------------------------------- |
| `requireScope`  | `true`  | Boolean. Requires a `<scope>: <subject>` first line.                               |
| `allowedScopes` | none    | Array of non-empty scope names. An empty array allows any scope.                   |
| `maxLineLength` | `72`    | Integer of 0 or more. Limits each subject and body line. Set `0` to remove limits. |

The plugin rejects unknown options, including `requireSignoff`.

## Quick start

1. Call `commit_context` before your first commit in a session and checkout.
   Set `workdir` if the repository is not the session directory, for example `commit_context({ workdir: "my-repo" })`.
2. Run the returned command immediately and unchanged through the `shell` tool, in the foreground, with that workdir.
   Do not run it in the background, wrap it, or chain another command onto it.
3. Commit only after the shell result reports `Frozen commit baseline`.
   That report also lists the commit rules for the checkout.
   If the report is missing, call `commit_context` again with the same workdir for status and next steps.

`RECEIPT_OK` in the shell output confirms only that the capture file was written.
It does not authorize a commit.

Call `commit_context` with `refresh: true` after you switch branches, change signing settings, or change commit instructions.

In `full_codemode`, call both tools from one `execute` script:

```js
const text = await tools.commit_context({ workdir: "my-repo" });
if (!text.includes("Run this shell command")) return text;
const command = text.split("\n").slice(1).join("\n");
const result = await tools.shell({ command, workdir: "my-repo" });
return result.output;
```

If `commit_context` returns status or baseline guidance without a command, the script returns that text.
Otherwise, the returned `result.output` text includes the `Frozen commit baseline` report.

## Formatting rules

- **Scope**: The first line uses `<scope>: <subject>`, for example `kernel: fix race` or `feat(parser): add subshells`.
- **Allowed scopes**: If `allowedScopes` has entries, the scope must match one of them.
- **Line length**: No subject or body line exceeds `maxLineLength`.
- **Signoff**: If the captured `commit.gpgsign` is `true`, add `-s` or a `Signed-off-by:` trailer.
  Signoff is not a cryptographic signature.
- **Literal messages**: Supply messages with `-m`, `--message`, one quoted heredoc on POSIX standard input, or a single literal here-string pipeline in PowerShell 7.
  The plugin rejects message files, shell expansion in messages, and `--trailer`.
- **Direct target**: Run `git commit` directly in the captured checkout.
  The plugin rejects `git -C`, Git directory flags, Git environment overrides, and directory-changing wrappers.

In POSIX shells, use real newlines inside `$'...'` for a message body:

```bash
git commit -s -m $'kernel: Fix race in thermal driver\n\nHold the lock while the sensor list changes.'
```

In PowerShell 7 (`pwsh`), use single quotes or pipe a literal here-string to `git commit -F -`:

```powershell
@'
kernel: Fix race in thermal driver

Hold the lock while the sensor list changes.
'@ | git commit -s -F -
```

`git commit --help` and `git commit -h` do not need a baseline.

## Development

Use Bun 1.4 or newer; the test suite runs tests concurrently.

```sh
bun install
bun run check       # lint, format check, typecheck, and tests
bun test            # unit tests and real OpenCode host tests
bun run typecheck   # TypeScript type checking
bun run build       # build dist/
```

Other scripts: `bun run lint` and `bun run format`.
