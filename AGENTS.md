# Agent instructions

## Tooling

Use Bun for all repository operations.
Do not use `npm`, `npx`, or `bunx`.

- `bun test`: Run unit tests and real-host E2E tests.
- `bun run typecheck`: Run TypeScript type checking.
- `bun run lint`: Run `oxlint --type-aware .` with Ultracite core, anti-slop, and landmines.
- `bun run format`: Apply Oxfmt formatting.
- `bun run check`: Check lint, formatting, types, and the full test suite.
- `bun run build`: Build the ESM bundle to `dist/`.

Keep the Ultracite core, anti-slop, and landmines lint rules unrelaxed (with `landmines-testing/no-flake-masking` allowlisting only the exact real-subprocess timeout counts in `src/capture.test.ts` and `test/plugin.test.ts`).
Keep `ultracite`, `oxlint`, `oxlint-tsgolint`, and `oxfmt` devDependencies on `latest`, and keep the temporary `"@interfere/landmines": "0.1.1"` pin until Ultracite supports `@interfere/landmines >= 0.2.0`.
Keep Oxfmt `proseWrap: "preserve"`.

## OpenCode target

Target OpenCode `v2.4.1` or newer through the V2 plugin API.
Keep `@opencode/core`, `@opencode/plugin`, `ultracite`, `oxlint`, `oxlint-tsgolint`, and `oxfmt` devDependencies on `latest`.
`^2.4.1` is the minimum `@opencode/plugin` peer floor.
Keep `@opencode/plugin` and `effect` as runtime peers and external build imports.
Never import `@opencode/core` from `src/` or `index.ts`; it is a test-only dependency.

## Capture invariants

- Target PowerShell 7 (`pwsh`) exclusively on `win32` for Windows context capture; do not add `powershell.exe`, `cmd.exe`, `gzip`, `Invoke-Expression`, or `taskkill.exe` fallbacks.
- Publish a Git baseline only if shell result metadata proves `status: "completed"`, `exit: 0`, and `truncated: false`, with no `timeout: true`, `shellID`, `pid`, `killed`, or other unexpected keys; name any unexpected keys in the rejection reason.
- Also require the artifact `END` sentinel before publishing.
- Match claimed captures in `execute.after` by call ID, message ID, session, and agent before checking the tool name. Never require `codemode` equality.
- Fail publication if a later hook changed the claimed command or renamed the call away from `shell`.
- Keep `execute.after` infallible; release the artifact and invalidate the counter on every failure.
- Keep `commit_context` Code Mode-eligible and unpinned. Do not ask for a `background` argument; ask for foreground execution in plain words.
- Read time through Effect `Clock.Clock` captured in `plugin.effect`; do not call `Date.now()` in `src/`.
- Pass `platform` explicitly to capture helpers instead of mutating `process.platform`.

## Code standards

- Import relative files with `.js` extensions (NodeNext resolution).
- Omit explicit function return-type annotations (except type predicates) and use `satisfies` or typed variables when pinning contracts (`landmines-types/no-explicit-return-types`).
- Do not write prose comments in source or test files (`landmines-style/no-comments`); keep only functional directives, `// SAFETY:` annotations, and TSDoc on exported public API symbols, and record design rationale and invariants in `CONTEXT.md`.
- Encapsulate POSIX and PowerShell 7 (`pwsh`) shell tokenization, nested `pwsh`/`bash` unwrapping, and Git invocation parsing in `src/shell.ts`.
- Encapsulate commit message validation and error formatting in `src/validator.ts`.
- Validate plugin options in `parseConfig` (`src/config.ts`) with clear, specific errors: `Invalid plugin options; expected an object.` for non-objects, `Invalid plugin option <name>; expected <description>.` for invalid values, an allowed-scope error when a scope cannot match the scope pattern, a removal notice for `requireSignoff`, and a list of valid options for unknown keys.
- Do not use runtime `typeof` checks; use the type guards in `src/types.ts` and `Object.prototype.toString.call`.
- Do not use the substring "shape" in any symbol name.
- Annotate every TypeScript type assertion with a preceding `// SAFETY:` justification comment.
- Reject invalid tool invocations through `Effect.fail(new Tool.Error(...))` from the `execute.before` hook.
- Return actionable errors that list each rule violation and show a conforming `git commit` example.

## Test contracts

- Load `index.ts` through the latest `@opencode/core` in-process host (`test/host.test-utils.ts`) with the built-in `shell` tool.
- Do not imitate `Plugin.Context`, `Tool.Context`, sessions, or hook registries.
  Replace host layers only to isolate state (paths, database, Git config, location) or to control permissions, flags, storage failures, shell selection, and output limits.
- `test/plugin.test.ts` holds host E2E contracts: normal mode and `full_codemode` capture, `pwsh` host E2E, real shell failure paths, downstream hook changes, option overrides, signoff policy, repository flows, capture expiry and diagnostics, and plugin reload.
- `src/shell.test.ts`, `src/validator.test.ts`, and `src/capture.test.ts` hold colocated pure unit tests for `extractGitCommits`, `validateGitCommits`, and the capture artifact.
- Keep shared test utilities in `test/helpers.test-utils.ts` and `test/host.test-utils.ts`.
- Assert shell tokenization across POSIX and `pwsh` quotes, backtick escapes, line continuations, comments, here-strings, command chains, subshells, subexpressions, nested `pwsh`/`bash` wrappers, and redirections.
- Assert that `git log`, `git status`, `git commit-tree`, and `echo` are not treated as commits.
- Assert scope, allowed scope, line length, signoff, `-F`/`--file`, and `--amend` rules.
- Tests run concurrently (`bunfig.toml`). Give every host and repository its own temporary directory, and provide a plugin-scoped Effect `TestClock` (`testClock: true`) instead of patching globals or using `test.serial`.
- Use `test.each` instead of `Promise.all` loops inside one test.
- Do not import `./dist/index.js` from `bun test`.
