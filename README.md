# opencode-commit-guard

OpenCode V2 plugin that enforces git commit message format rules during agent sessions.

## Overview

`opencode-commit-guard` intercepts `shell` and `bash` tool execution before it runs.
When an agent attempts a `git commit`, the plugin inspects the command line and inline message content.
If the commit violates configured formatting standards, the plugin rejects the tool call immediately by throwing a descriptive error.

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
        "maxLineLength": 72,
        "requireSignoff": true
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
| `requireSignoff` | `boolean` | `true` | Requires `-s`/`--signoff` or a `Signed-off-by:` trailer. |

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

### 3. Maximum line length (`maxLineLength`)

No line in the commit subject or body may exceed the configured character limit (default 72 characters).
When a line exceeds this limit, the error identifies the exact line number, current character length, and offending text.

### 4. Signoff (`requireSignoff`)

Every commit must include a signoff indicator.
You can provide this either via flags or directly in the message body:

- Pass `-s` or `--signoff` in the git command.
- Or include a trailer matching `Signed-off-by: Full Name <email@example.com>` in the message body.

### 5. Amend commits (`--amend`)

If an agent runs `git commit --amend --no-edit` without supplying a new message, the plugin permits execution.
If the agent provides a new message with `-m`, the plugin validates the new message.
No-edit amendments that use `--git-dir` or `--work-tree` must provide a new inline message because the plugin cannot inspect repositories selected outside OpenCode's shell permissions.

### Message input

Provide commit messages inline with `-m` or `--message`.
The plugin rejects `-F`, `--file`, and standard-input message sources because the pre-execution hook cannot read them through OpenCode's file permissions.

## Development

Use Bun for all repository operations.

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run build
```
