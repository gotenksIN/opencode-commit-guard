# opencode-commit-guard

OpenCode V2 plugin that enforces git commit message format rules during agent sessions.

## Overview

`opencode-commit-guard` intercepts `shell` and `bash` tool execution before it runs.
When an agent attempts a `git commit`, the plugin inspects the command line and inline message content.
If the commit violates configured formatting standards, the plugin rejects the tool call through OpenCode's typed tool-error channel.

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

Every commit with a supplied message must include a signoff indicator.
You can provide this either via flags or directly in the message body:

- Pass `-s` or `--signoff` in the git command.
- Or include a trailer matching `Signed-off-by: Full Name <email@example.com>` in the message body.

### 5. Amend commits (`--amend`)

Use `git commit --amend --no-edit` to keep the existing message unchanged.
The plugin does not read or revalidate that message, so a message created outside this guard may not meet its format rules.
Provide `-m` when you change the message; the plugin validates the supplied text in all repository locations.

### Message input

Provide commit messages inline with `-m` or `--message`, or use one quoted heredoc directly on standard input:

```bash
git commit -s -F - <<'EOF'
kernel: fix race
EOF
```

The plugin rejects file-backed `-F` or `--file` messages without reading the files.
It also rejects unquoted or ambiguous standard-input sources.

## Development

Use Bun for all repository operations.

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run build
```
