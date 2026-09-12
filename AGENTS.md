# Agent instructions

## Tooling

Use Bun for all repository operations.
Do not use `npm`, `npx`, or `bunx`.

- `bun test`: Run the test suite.
- `bun run typecheck`: Run TypeScript type checking.
- `bun run build`: Build the ESM distribution bundle.
- `bun run lint`: Run code linter checks.

Always maintain compatibility with the OpenCode V2 plugin API.

## Code standards

- Write source code in TypeScript with ECMAScript Modules (ESM).
- Encapsulate shell tokenization and git invocation parsing in `src/shell.ts`.
- Encapsulate commit message validation and error formatting in `src/validator.ts`.
- Validate configuration options in `parseConfig` (`src/config.ts`) with clear error messages.
- Do not use `typeof` checks in source or test code; use explicit type guards and `Object.prototype.toString.call`.
- Do not use the substring "shape" in any symbol name.
- Annotate every TypeScript type assertion with a preceding `// SAFETY:` justification comment.
- Reject invalid tool invocations before execution by throwing an Error from the `execute.before` hook.
- Return structured, actionable error messages detailing the exact rule violations and examples of conforming git commit commands.

## Test contracts

- Test public interfaces of `extractGitCommits`, `tokenizeShell`, `validateGitCommits`, `parseConfig`, and the OpenCode plugin hooks.
- Assert shell tokenization across single commands, quotes, line continuations, command chains, subshells, and redirections.
- Assert commit detection ignoring non-commit commands (`git log`, `git status`, `git commit-tree`, `echo`).
- Assert validation rules for scopes, allowed scopes, line length limits, and signoffs.
- Assert handling for file inputs (`-F`, `--file`) and amend commits (`--amend`).
- Assert option overrides for `requireScope`, `allowedScopes`, `maxLineLength`, and `requireSignoff`.
- Do not write tests that only verify the presence of symbol names, command registrations, or type definitions.
- Let the TypeScript compiler enforce static type relationships.
