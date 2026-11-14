import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { Plugin, Tool } from "@opencode/plugin/effect";
import { Effect, Schema } from "effect";

import {
  captureStatus,
  cleanup,
  counter,
  createPending,
  findGitRoot,
  importCapture,
  invalidate,
  invalidateOwned,
  load,
  publish,
  recordState,
  resolveTargetWorkdir,
  scopeFor,
} from "./capture.js";
import type { Baseline, Pending } from "./capture.js";
import { parseConfig } from "./config.js";
import { extractGitCommits } from "./shell.js";
import { isJSONString, isRecord } from "./types.js";
import type { CommitGuardConfig, JsonValue } from "./types.js";
import { validateGitCommits } from "./validator.js";

const { relative, resolve } = path;

export const plugin = Plugin.define({
  id: "opencode-commit-guard",
  effect: (ctx) =>
    Effect.gen(function* setupGuard() {
      const config = yield* Effect.sync(() =>
        // SAFETY: OpenCode plugin options are passed through ctx.options as JsonValue or undefined.
        parseConfig(ctx.options as JsonValue | undefined)
      );

      const generation = randomUUID();
      const pending = new Map<string, Pending>();
      const preparing = new Set<string>();
      const lastSessionWorkdir = new Map<string, string>();
      const failures = new Map<string, string>();

      const rememberFailure = (scope: string, reason: string) => {
        failures.delete(scope);
        failures.set(
          scope,
          `The previous capture failed: ${reason.slice(0, 256)}. `
        );

        if (failures.size > 128) {
          const oldest = failures.keys().next().value;

          if (oldest !== undefined) {
            failures.delete(oldest);
          }
        }
      };

      const sweep = () =>
        Effect.gen(function* sweepPending() {
          for (const attempt of [...pending.values()].slice(0, 32)) {
            pending.delete(attempt.scope);

            if (
              attempt.claimed === undefined &&
              Date.now() >= attempt.expires
            ) {
              cleanup(attempt);
              yield* recordState(ctx, attempt, "expired");
              yield* invalidateOwned(ctx, attempt);
            } else {
              pending.set(attempt.scope, attempt);
            }
          }
        });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* unloadGuard() {
          for (const attempt of pending.values()) {
            cleanup(attempt);
            yield* recordState(
              ctx,
              attempt,
              "failed",
              "plugin unloaded before publication"
            );
            yield* invalidateOwned(ctx, attempt);
          }

          pending.clear();
        })
      );

      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: "commit_context",
          description: String.raw`Prepare a Git baseline. Run the returned command unchanged in the foreground; require "Frozen commit baseline".
Call before your first commit in each session and checkout.
Set workdir when targeting another repository.
Run the returned command immediately, unchanged, with the indicated workdir and background:false.
Do not wrap it or chain another command onto it.
Commit only after the shell result or this tool reports "Frozen commit baseline".
RECEIPT_OK alone is insufficient.
The shell result includes commit rules; a second call is optional.
Repeat an explicit workdir when checking that checkout.
Set refresh:true after switching branches, changing signing settings, or changing commit instructions.
Use literal message text and real body newlines.
Example: git commit -m $'scope: Subject\n\nBody line one.\nBody line two.'
Replace scope and follow the returned line-length and signoff rules.
Add -s only when the returned policy or repository instructions require it.`,
          input: {
            type: "object",
            properties: {
              refresh: { type: "boolean" },
              workdir: {
                type: "string",
                description:
                  "Working directory of the Git repository relative to the session directory or absolute.",
              },
              directory: {
                type: "string",
                description:
                  "Path to the Git repository checkout (alias for workdir).",
              },
            },
            additionalProperties: false,
          },
          execute: (input, toolContext) =>
            Effect.gen(function* execute() {
              yield* sweep();

              if (ctx.location.workspaceID !== undefined) {
                return {
                  content:
                    "Commit context capture is unavailable for remote workspaces.",
                };
              }

              const session = yield* ctx.session.get({
                sessionID: toolContext.sessionID,
              });

              if (session.location.workspaceID !== ctx.location.workspaceID) {
                return {
                  content:
                    "Commit context capture is unavailable for remote workspaces.",
                };
              }

              // SAFETY: The tool input schema permits refresh, workdir, and directory.
              const request =
                Schema.is(Schema.Json)(input) && isRecord(input) ? input : {};

              let requestedDir: string | undefined;

              if (isJSONString(request.workdir)) {
                requestedDir = request.workdir;
              } else if (isJSONString(request.directory)) {
                requestedDir = request.directory;
              }

              const sessionDirectory =
                session.location.directory ?? ctx.location.directory;

              let target = resolveTargetWorkdir(sessionDirectory, requestedDir);

              if (target.workdir === undefined && requestedDir === undefined) {
                const remembered = lastSessionWorkdir.get(
                  toolContext.sessionID
                );

                if (
                  remembered !== undefined &&
                  existsSync(remembered) &&
                  findGitRoot(remembered) !== undefined
                ) {
                  target = { workdir: remembered };
                }
              }

              if (target.error !== undefined || target.workdir === undefined) {
                return {
                  content:
                    target.error ??
                    "Could not determine target Git repository.",
                };
              }

              const targetWorkdir = target.workdir;

              lastSessionWorkdir.set(toolContext.sessionID, targetWorkdir);

              const scope = scopeFor(
                ctx,
                toolContext.sessionID,
                config,
                targetWorkdir
              );

              if (preparing.has(scope)) {
                return {
                  content:
                    "A commit context capture is preparing for this session and checkout. Wait for its command, then follow its instructions.",
                };
              }

              preparing.add(scope);

              return yield* Effect.gen(function* prepareCapture() {
                const previous = pending.get(scope);

                if (previous !== undefined) {
                  if (
                    previous.claimed !== undefined &&
                    request.refresh !== true
                  ) {
                    return {
                      content:
                        'Capture claimed; permission approval or execution is pending. Wait for its foreground shell result. Commit after it reports "Frozen commit baseline"; otherwise call commit_context again with the same workdir before committing. RECEIPT_OK confirms only that the artifact was written, not that the baseline was published.',
                    };
                  }

                  if (request.refresh !== true) {
                    return {
                      content: captureInstructions(
                        previous,
                        "Capture still pending and unclaimed. "
                      ),
                    };
                  }

                  pending.delete(scope);
                  cleanup(previous);
                  yield* recordState(
                    ctx,
                    previous,
                    "failed",
                    "capture replaced by refresh"
                  );
                  yield* invalidateOwned(ctx, previous);
                }

                if (request.refresh !== true) {
                  const baseline = yield* load(ctx, scope);

                  if (
                    baseline !== undefined &&
                    baseline.directory === findGitRoot(targetWorkdir)
                  ) {
                    return { content: baselineGuidance(baseline, config) };
                  }
                }

                const count = yield* invalidate(ctx, scope);

                const attempt = yield* Effect.sync(() =>
                  createPending(
                    scope,
                    toolContext.sessionID,
                    toolContext.agent,
                    count,
                    targetWorkdir
                  )
                );

                pending.set(scope, attempt);

                const status =
                  failures.get(scope) ?? (yield* captureStatus(ctx, scope));

                yield* recordState(ctx, attempt, "prepared");

                return { content: captureInstructions(attempt, status) };
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    preparing.delete(scope);
                  })
                )
              );
            }).pipe(
              Effect.mapError(
                () =>
                  new Tool.Error({
                    message:
                      "[commit-guard] Could not access the session or commit context. Call commit_context again from this checkout.",
                  })
              )
            ),
        });
      });

      yield* ctx.tool.hook("execute.before", (event) =>
        Effect.gen(function* beforeExecution() {
          yield* sweep();

          // SAFETY: Tool input is untrusted JSON and is checked before reading its fields.
          const rawInput = Schema.is(Schema.Json)(event.input)
            ? event.input
            : undefined;

          if (
            (event.tool === "shell" || event.tool === "bash") &&
            rawInput === undefined
          ) {
            yield* Effect.fail(
              new Tool.Error({
                message:
                  "[commit-guard] Cannot inspect non-JSON shell input. Supply literal command and workdir fields.",
              })
            );
          }

          // Only capture commands need session identity before invocation extraction.
          const captureSession =
            (event.tool === "shell" || event.tool === "bash") &&
            [...pending.values()].some(
              (attempt) =>
                isRecord(rawInput) && rawInput.command === attempt.command
            )
              ? yield* ctx.session.get({ sessionID: event.sessionID })
              : undefined;

          const captureSessionDirectory =
            captureSession?.location.directory ?? ctx.location.directory;

          const parsed = yield* Effect.try({
            try: () => {
              if (event.tool !== "shell" && event.tool !== "bash") {
                return null;
              }

              if (!isRecord(rawInput)) {
                return null;
              }

              const { command } = rawInput;

              if (!isJSONString(command)) {
                return null;
              }

              const rawWorkdir = rawInput.workdir;

              for (const attempt of pending.values()) {
                if (command !== attempt.command) {
                  continue;
                }

                const matchesWorkdir =
                  rawWorkdir === attempt.workdir ||
                  (isJSONString(rawWorkdir) &&
                    resolve(captureSessionDirectory, rawWorkdir) ===
                      attempt.workdir) ||
                  (rawWorkdir === undefined &&
                    captureSessionDirectory === attempt.workdir);

                if (
                  event.tool !== "shell" ||
                  event.sessionID !== attempt.sessionID ||
                  event.agent !== attempt.agent ||
                  !matchesWorkdir ||
                  rawInput.background === true ||
                  Date.now() >= attempt.expires ||
                  attempt.claimed !== undefined
                ) {
                  throw new Error(
                    "[commit-guard] Capture must use its exact foreground shell command in the original session and workdir. Call commit_context to refresh."
                  );
                }

                attempt.claimed = { messageID: event.messageID, id: event.id };

                return null;
              }

              const invocations = extractGitCommits(command);

              if (invocations.length === 0) {
                return null;
              }

              return { invocations, command, rawInput };
            },
            catch: (error) =>
              new Tool.Error({
                message:
                  error instanceof Error
                    ? error.message
                    : "[commit-guard] Git commit validation failed.",
              }),
          });

          for (const attempt of pending.values()) {
            if (
              attempt.claimed?.messageID === event.messageID &&
              attempt.claimed.id === event.id &&
              attempt.sessionID === event.sessionID &&
              attempt.agent === event.agent
            ) {
              yield* recordState(ctx, attempt, "claimed");
            }
          }

          if (
            parsed === null ||
            parsed.invocations.every((invocation) => invocation.isHelp)
          ) {
            return;
          }

          yield* Effect.gen(function* validateTarget() {
            if (ctx.location.workspaceID !== undefined) {
              return yield* Effect.fail(
                new Tool.Error({
                  message:
                    "[commit-guard] Remote workspace commits cannot use local commit context. Capture from a verified local checkout.",
                })
              );
            }

            const session =
              captureSession ??
              (yield* ctx.session.get({ sessionID: event.sessionID }));

            if (
              session.location.workspaceID !== ctx.location.workspaceID ||
              parsed.invocations.some(
                (invocation) => invocation.targetError !== undefined
              )
            ) {
              return yield* Effect.fail(
                new Tool.Error({
                  message:
                    "[commit-guard] Commit target is ambiguous. Use a direct git commit without -C, Git directory/configuration flags, environment overrides, or cd wrappers. Set shell workdir to the captured checkout and call commit_context there.",
                })
              );
            }

            const sessionDirectory =
              session.location.directory ?? ctx.location.directory;

            const rawWorkdir = parsed.rawInput.workdir;

            const effectiveWorkdir = yield* Effect.try(() =>
              realpathSync(
                isJSONString(rawWorkdir)
                  ? resolve(sessionDirectory, rawWorkdir)
                  : sessionDirectory
              )
            );

            const targetGitRoot = findGitRoot(effectiveWorkdir);

            const scope = scopeFor(
              ctx,
              event.sessionID,
              config,
              effectiveWorkdir
            );

            const baseline = yield* load(ctx, scope);

            const expectedDir = targetGitRoot ?? effectiveWorkdir;

            const baselineValid =
              baseline !== undefined &&
              targetGitRoot !== undefined &&
              baseline.directory === targetGitRoot &&
              baseline.directory === expectedDir;

            if (!baselineValid || baseline === undefined) {
              const relWorkdir = relative(sessionDirectory, expectedDir);

              const workdirHint = JSON.stringify(
                relWorkdir.length > 0 ? relWorkdir : "."
              );

              return yield* Effect.fail(
                new Tool.Error({
                  message: `[commit-guard] No published baseline for ${expectedDir}. Call commit_context({ workdir: ${workdirHint} }), then run the returned command immediately, unchanged, in the foreground with that workdir and background:false. Do not wrap it or chain another command onto it. Commit after the shell result reports "Frozen commit baseline"; otherwise call commit_context again with the same workdir before committing. RECEIPT_OK alone is insufficient.`,
                })
              );
            }

            if (
              baseline.gpgsign === "error" ||
              baseline.signingkey === "error"
            ) {
              return yield* Effect.fail(
                new Tool.Error({
                  message: signingError(
                    baseline.gpgsign === "error"
                      ? "commit.gpgsign"
                      : "user.signingkey"
                  ),
                })
              );
            }

            yield* Effect.try({
              try: () => {
                validateGitCommits(
                  parsed.invocations,
                  { ...config, enforceSignoff: baseline.gpgsign === "true" },
                  parsed.command
                );
              },
              catch: (error) =>
                new Tool.Error({
                  message:
                    error instanceof Error
                      ? error.message
                      : "[commit-guard] Git commit validation failed.",
                }),
            });

            return yield* Effect.void;
          });
        }).pipe(
          Effect.mapError((error) =>
            error instanceof Tool.Error
              ? error
              : new Tool.Error({
                  message:
                    error instanceof Error
                      ? error.message
                      : "[commit-guard] Git commit validation failed.",
                })
          )
        )
      );

      yield* ctx.tool.hook("execute.after", (event) =>
        Effect.gen(function* afterExecution() {
          if (event.tool !== "shell") {
            return;
          }

          const attempt = [...pending.values()].find(
            (item) =>
              item.claimed?.id === event.id &&
              item.claimed?.messageID === event.messageID &&
              item.sessionID === event.sessionID &&
              item.agent === event.agent
          );

          if (attempt === undefined) {
            return;
          }

          let published = false;
          let captured: Baseline | undefined;
          let reason = "capture import or storage failed";

          yield* Effect.gen(function* publishCapture() {
            reason = "shell result did not complete successfully";

            if (event.status !== "completed") {
              return;
            }

            reason = "capture was superseded by a refresh";

            if ((yield* counter(ctx, attempt.scope)) !== attempt.counter) {
              return;
            }

            // SAFETY: Tool result metadata is untrusted JSON; verify every required field before import.
            const metadata = event.result.metadata as JsonValue | undefined;

            reason =
              "shell result lacks verified foreground completion metadata";

            if (!isRecord(metadata)) {
              return;
            }

            // OpenCode's shell tool reports completed/exit:0 after a foreground process exits.
            // Continued jobs report running/shellID; timeouts report timeout:true without an exit.
            if (
              metadata.status !== "completed" ||
              metadata.exit !== 0 ||
              metadata.truncated !== false ||
              (metadata.timeout !== undefined && metadata.timeout !== false) ||
              metadata.shellID !== undefined ||
              Object.keys(metadata).some(
                (key) =>
                  !["status", "exit", "truncated", "timeout"].includes(key)
              )
            ) {
              return;
            }

            const session = yield* Effect.orElseSucceed(
              ctx.session.get({ sessionID: event.sessionID }),
              () => {
                /* empty */
              }
            );

            reason = "capture session or workspace no longer matches";

            if (
              session === undefined ||
              session.location.workspaceID !== ctx.location.workspaceID
            ) {
              return;
            }

            reason = "private artifact is invalid or incomplete (END required)";

            const baseline = yield* Effect.try({
              try: () => importCapture(attempt),
              catch: () => new Error("Invalid capture"),
            });

            if (
              baseline.workdir !== attempt.workdir ||
              ctx.location.workspaceID !== undefined
            ) {
              return;
            }

            reason = "capture storage failed or its counter changed";
            published = yield* publish(ctx, attempt, generation, baseline);

            if (published) {
              captured = baseline;
              failures.delete(attempt.scope);
              yield* recordState(ctx, attempt, "published");
            }
          }).pipe(
            Effect.onExit(() =>
              Effect.gen(function* finalizeCapture() {
                if (pending.get(attempt.scope) === attempt) {
                  pending.delete(attempt.scope);
                }

                if (!published) {
                  rememberFailure(attempt.scope, reason);
                  yield* recordState(ctx, attempt, "failed", reason).pipe(
                    Effect.catchCause(() => Effect.void)
                  );
                  yield* invalidateOwned(ctx, attempt);
                }
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    cleanup(attempt);
                  })
                )
              )
            ),
            Effect.catchCause(() => Effect.void)
          );

          const note =
            published && captured !== undefined
              ? baselineGuidance(captured, config)
              : `[commit-guard] This capture did not publish a usable baseline: ${reason.slice(0, 256)}.\n` +
                "RECEIPT_OK alone does not authorize a commit.\n" +
                "Call commit_context with the same workdir for status and next steps.";

          if (event.status === "error") {
            event.error = new Tool.Error({
              error: event.error.error,
              metadata: event.error.metadata,
              message: `${event.error.message}\n\n${note}`,
            });
          } else {
            event.result = appendCaptureNote(event.result, note);
          }
        })
      );
    }),
});

export default plugin;

const captureInstructions = function captureInstructions(
  attempt: Pending,
  status: string
): string {
  return (
    `${status}Run this shell command immediately, unchanged, in the foreground with workdir ${attempt.workdir} and background:false. ` +
    'Do not wrap it or chain another command onto it. Commit after the shell result reports "Frozen commit baseline"; ' +
    "otherwise call commit_context again with the same workdir before committing. " +
    `RECEIPT_OK confirms only that the artifact was written, not that the baseline was published:\n${attempt.command}`
  );
};

const baselineGuidance = function baselineGuidance(
  baseline: Baseline,
  config: CommitGuardConfig
): string {
  if (baseline.gpgsign === "error" || baseline.signingkey === "error") {
    return signingError(
      baseline.gpgsign === "error" ? "commit.gpgsign" : "user.signingkey"
    );
  }

  const observed = [
    ...new Set(
      baseline.messages
        .map(
          (message) =>
            /^(?<scope>[a-zA-Z0-9_./-]{1,40}): /u.exec(
              message.split("\n")[0]
            )?.[1]
        )
        .filter((value) => value !== undefined)
    ),
  ].slice(0, 3);

  const examples =
    observed.length > 0
      ? `Observed scope examples (not an allowlist): ${observed.join(", ")}.\n`
      : "";

  const scopes =
    config.allowedScopes === undefined
      ? "No configured scope allowlist."
      : `Configured scope allowlist: ${config.allowedScopes.join(", ").slice(0, 512)}.`;

  const signoff =
    baseline.gpgsign === "true"
      ? "Add -s or --signoff."
      : "Signoff is not required; add it only if repository instructions require it.";

  return (
    `[commit-guard] Frozen commit baseline for ${baseline.directory.slice(0, 4096)}.\n` +
    `Use <scope>: <subject>${config.requireScope ? " (required)" : " (optional)"}; maximum line length: ${config.maxLineLength || "unlimited"}.\n` +
    `${scopes}\n${examples}Effective commit.gpgsign: ${baseline.gpgsign}. ${signoff}\n` +
    `user.signingkey: ${baseline.signingkey === null ? "unset" : "configured"}. Signoff is not a cryptographic signature.\n` +
    "A second commit_context call is optional.\n" +
    "Set refresh:true after a branch switch, changed signing settings, or changed commit instructions."
  );
};

const appendCaptureNote = function appendCaptureNote(
  result: Tool.Result,
  note: string
): Tool.Result {
  const content: readonly Tool.Content[] = isJSONString(result.content)
    ? [{ type: "text", text: result.content }]
    : (result.content ?? []);

  // SAFETY: Structured tool output is untrusted JSON; check the record and output field before copying it.
  const rawOutput: unknown = result.output;
  const output = Schema.is(Schema.Json)(rawOutput) ? rawOutput : undefined;

  const annotated: Tool.Result = {
    ...result,
    content: [...content, { type: "text", text: note }],
  };

  if (isRecord(output) && isJSONString(output.output)) {
    return {
      ...annotated,
      output: {
        ...Object.fromEntries(Object.entries(output)),
        output: `${output.output}\n\n${note}`,
      },
    };
  }

  return annotated;
};

const signingError = function signingError(setting: string): string {
  return `[commit-guard] Git could not read ${setting} as valid. Repeating the capture will not fix it. Inspect with git config --show-origin --get-all ${setting}; fix the value without changing the intended signing policy, then call commit_context with refresh:true.`;
};
