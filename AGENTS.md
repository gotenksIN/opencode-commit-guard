# Agent instructions

## Tooling

Use Bun for all repository operations.
Do not use `npm`, `npx`, or `bunx`.

- `bun test`: Run unit tests and real-host E2E tests.
- `bun run typecheck`: Run TypeScript type checking.
- `bun run lint`: Run `oxlint --type-aware .` with Ultracite core and anti-slop.
- `bun run format`: Apply Oxfmt formatting.
- `bun run check`: Check lint and formatting.
- `bun run build`: Build the ESM bundle to `dist/`.

Keep the Ultracite core and anti-slop lint rules unrelaxed.
Keep Oxfmt `proseWrap: "preserve"`.

## OpenCode target

Target OpenCode `v2.4.1` or newer through the V2 plugin API.
Keep `@opencode/core`, `@opencode/plugin`, `ultracite`, `oxlint`, `oxlint-tsgolint`, and `oxfmt` devDependencies on `latest`.
`^2.4.1` is the minimum `@opencode/plugin` peer floor.
Keep `@opencode/plugin` and `effect` as runtime peers and external build imports.
Never import `@opencode/core` from `src/` or `index.ts`; it is a test-only dependency.

## Capture invariants

- Publish a Git baseline only if shell result metadata proves `status: "completed"`, `exit: 0`, and `truncated: false`, with no `timeout: true`, `shellID`, `pid`, or `killed` key.
- Also require the artifact `END` sentinel before publishing.
- Match claimed captures in `execute.after` by call ID, message ID, session, and agent before checking the tool name. Never require `codemode` equality.
- Fail publication if a later hook changed the claimed command or renamed the call away from `shell`.
- Keep `execute.after` infallible; release the artifact and invalidate the counter on every failure.
- Keep `commit_context` Code Mode-eligible and unpinned. Do not ask for a `background` argument; ask for foreground execution in plain words.

## Code standards

- Import relative files with `.js` extensions.
- Encapsulate shell tokenization and Git invocation parsing in `src/shell.ts`.
- Encapsulate commit message validation and error formatting in `src/validator.ts`.
- Validate plugin options in `parseConfig` (`src/config.ts`) with clear, specific errors: `Invalid plugin options; expected an object.` for non-objects, `Invalid plugin option <name>; expected <description>.` for invalid values, an allowed-scope error when a scope cannot match the scope pattern, a removal notice for `requireSignoff`, and a list of valid options for unknown keys.
- Do not use runtime `typeof` checks; use the type guards in `src/types.ts` and `Object.prototype.toString.call`.
- Do not use the substring "shape" in any symbol name.
- Annotate every TypeScript type assertion with a preceding `// SAFETY:` justification comment.
- Reject invalid tool invocations through `Effect.fail(new Tool.Error(...))` from the `execute.before` hook.
- Return actionable errors that list each rule violation and show a conforming `git commit` example.

## Test contracts

- Load `index.ts` through the latest `@opencode/core` in-process host (`test/host.ts`) with the built-in `shell` tool.
- Do not imitate `Plugin.Context`, `Tool.Context`, sessions, or hook registries.
  Replace host layers only to isolate state (paths, database, Git config, location) or to control permissions, flags, storage failures, and output limits.
- `test/plugin.test.ts` holds host E2E contracts: normal mode and `full_codemode` capture, real shell failure paths, downstream hook changes, option overrides, signoff policy, repository flows, and plugin reload.
- `test/shell.test.ts`, `test/validator.test.ts`, and `test/capture.test.ts` hold pure unit tests for `extractGitCommits`, `validateGitCommits`, and the capture artifact.
- Assert shell tokenization across quotes, line continuations, command chains, subshells, and redirections.
- Assert that `git log`, `git status`, `git commit-tree`, and `echo` are not treated as commits.
- Assert scope, allowed scope, line length, signoff, `-F`/`--file`, and `--amend` rules.
- Tests run concurrently (`bunfig.toml`). Give every host and repository its own temporary directory, and run tests that patch globals such as `Date.now` with `test.serial`.
- Use `test.each` instead of `Promise.all` loops inside one test.
- Do not import `./dist/index.js` from `bun test`.
