import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { Plugin, Tool } from "@opencode/plugin/effect";
import { Cause, Effect } from "effect";

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
import { scopePattern } from "./scope.js";
import { extractGitCommits } from "./shell.js";
import { isJSONBoolean, isJSONString, isRecord } from "./types.js";
import type {
  CommitGuardConfig,
  GitCommitInvocation,
  JsonValue,
} from "./types.js";
import { validateGitCommits } from "./validator.js";

const { relative, resolve } = path;

type HookEvent = Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0];

type BeforeEvent = Exclude<HookEvent, { status: string }>;

type AfterEvent = Extract<HookEvent, { status: string }>;

interface GuardState {
  ctx: Plugin.Context;
  config: CommitGuardConfig;
  generation: string;
  pending: Map<string, Pending>;
  preparing: Set<string>;
  lastSessionWorkdir: Map<string, string>;
  failures: Map<string, string>;
}

const publicationGuidance =
  'Commit after the shell result reports "Frozen commit baseline"; otherwise call commit_context again with the same workdir before committing.';

const receiptGuidance =
  "RECEIPT_OK confirms only that the artifact was written, not that the baseline was published.";

const toToolError = (cause: unknown): Tool.Error => {
  if (Cause.isUnknownError(cause)) {
    return toToolError(cause.cause);
  }

  return cause instanceof Tool.Error
    ? cause
    : new Tool.Error({
        message:
          cause instanceof Error
            ? cause.message
            : "[commit-guard] Git commit validation failed.",
        error: cause,
      });
};

const signingError = (setting: string): string =>
  `[commit-guard] Git could not read ${setting} as valid. Repeating the capture will not fix it. Inspect with git config --show-origin --get-all ${setting}; fix the value without changing the intended signing policy, then call commit_context with refresh:true.`;

const baselineGuidance = (
  baseline: Baseline,
  config: CommitGuardConfig
): string => {
  if (baseline.gpgsign === "error" || baseline.signingkey === "error") {
    return signingError(
      baseline.gpgsign === "error" ? "commit.gpgsign" : "user.signingkey"
    );
  }

  const observed = [
    ...new Set(
      baseline.messages
        .map((message) => scopePattern.exec(message.split("\n")[0])?.[1])
        .filter((scope) => scope !== undefined && scope.length <= 40)
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
    "A second commit_context call is optional.\nSet refresh:true after a branch switch, changed signing settings, or changed commit instructions."
  );
};

const captureInstructions = (attempt: Pending, status: string): string =>
  `${status}Run this shell command immediately, unchanged, in the foreground with workdir ${attempt.workdir} (do not run it in the background). ` +
  `Do not wrap it or chain another command onto it. ${publicationGuidance} ${receiptGuidance}\n${attempt.command}`;

const sweep = (state: GuardState) =>
  Effect.gen(function* sweepPending() {
    for (const attempt of [...state.pending.values()].slice(0, 32)) {
      state.pending.delete(attempt.scope);

      if (attempt.claimed === undefined && Date.now() >= attempt.expires) {
        cleanup(attempt);
        yield* recordState(state.ctx, attempt, "expired");
        yield* invalidateOwned(state.ctx, attempt);
      } else {
        state.pending.set(attempt.scope, attempt);
      }
    }
  });

const resolveCanonicalWorkdir = (
  sessionDirectory: string,
  workdir: JsonValue | undefined
): string => {
  try {
    return realpathSync(
      isJSONString(workdir)
        ? resolve(sessionDirectory, workdir)
        : sessionDirectory
    );
  } catch {
    throw new Error(
      "[commit-guard] Cannot access the shell workdir. Supply an existing checkout directory and call commit_context there."
    );
  }
};

const validateFields = (
  input: BeforeEvent["input"],
  fields: readonly string[],
  booleans: readonly string[]
): Record<string, JsonValue | undefined> => {
  if (!isRecord(input)) {
    throw new Error(
      "[commit-guard] Cannot inspect non-object tool input. Supply literal command and workdir fields."
    );
  }

  for (const field of fields) {
    if (input[field] !== undefined && !isJSONString(input[field])) {
      throw new Error(`[commit-guard] Invalid ${field}; expected a string.`);
    }
  }

  for (const field of booleans) {
    if (input[field] !== undefined && !isJSONBoolean(input[field])) {
      throw new Error(`[commit-guard] Invalid ${field}; expected a boolean.`);
    }
  }

  return input;
};

const prepareCapture = (
  state: GuardState,
  toolContext: Tool.Context,
  request: Record<string, JsonValue | undefined>,
  workdir: string,
  scope: string
) =>
  Effect.gen(function* prepare() {
    const { ctx, pending, config } = state;
    const previous = pending.get(scope);

    if (previous !== undefined) {
      if (request.refresh !== true) {
        return {
          content:
            previous.claimed === undefined
              ? captureInstructions(
                  previous,
                  "Capture still pending and unclaimed. "
                )
              : `Capture claimed; permission approval or execution is pending. Wait for its foreground shell result. ${publicationGuidance} ${receiptGuidance}`,
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
        baseline.directory === findGitRoot(workdir)
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
        workdir
      )
    );

    pending.set(scope, attempt);

    const status =
      state.failures.get(scope) ?? (yield* captureStatus(ctx, scope));

    yield* recordState(ctx, attempt, "prepared");

    return { content: captureInstructions(attempt, status) };
  });

const runCommitContext = (
  state: GuardState,
  input: BeforeEvent["input"],
  toolContext: Tool.Context
) =>
  Effect.gen(function* context() {
    yield* sweep(state);
    const { ctx } = state;

    if (ctx.location.workspaceID !== undefined) {
      return {
        content: "Commit context capture is unavailable for remote workspaces.",
      };
    }

    const request = yield* Effect.try(() =>
      validateFields(input, ["workdir", "directory"], ["refresh"])
    );

    const session = yield* ctx.session.get({
      sessionID: toolContext.sessionID,
    });

    if (session.location.workspaceID !== ctx.location.workspaceID) {
      return {
        content: "Commit context capture is unavailable for remote workspaces.",
      };
    }

    const requestedDir = isJSONString(request.workdir)
      ? request.workdir
      : request.directory;

    const explicitDir = isJSONString(requestedDir) ? requestedDir : undefined;

    const sessionDirectory =
      session.location.directory ?? ctx.location.directory;

    let target = resolveTargetWorkdir(sessionDirectory, explicitDir);

    if (target.workdir === undefined && explicitDir === undefined) {
      const remembered = state.lastSessionWorkdir.get(toolContext.sessionID);

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
        content: target.error ?? "Could not determine target Git repository.",
      };
    }

    const { workdir } = target;
    state.lastSessionWorkdir.set(toolContext.sessionID, workdir);
    const scope = scopeFor(ctx, toolContext.sessionID, state.config, workdir);

    if (state.preparing.has(scope)) {
      return {
        content:
          "A commit context capture is preparing for this session and checkout. Wait for its command, then follow its instructions.",
      };
    }

    state.preparing.add(scope);

    return yield* prepareCapture(
      state,
      toolContext,
      request,
      workdir,
      scope
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.preparing.delete(scope);
        })
      )
    );
  }).pipe(Effect.mapError(toToolError));

const claimCapture = (
  state: GuardState,
  event: BeforeEvent,
  input: Record<string, JsonValue | undefined>,
  attempt: Pending
) =>
  Effect.gen(function* claim() {
    const session = yield* state.ctx.session.get({
      sessionID: event.sessionID,
    });

    yield* Effect.try(() => {
      let matchesWorkdir = false;

      try {
        matchesWorkdir =
          resolveCanonicalWorkdir(
            session.location.directory ?? state.ctx.location.directory,
            input.workdir
          ) === attempt.workdir;
      } catch {
        // A missing or inaccessible path cannot claim a capture.
      }

      if (
        event.tool !== "shell" ||
        event.sessionID !== attempt.sessionID ||
        event.agent !== attempt.agent ||
        !matchesWorkdir ||
        input.background === true ||
        Date.now() >= attempt.expires ||
        attempt.claimed !== undefined
      ) {
        throw new Error(
          "[commit-guard] Capture must use its exact foreground shell command in the original session and workdir. Call commit_context to refresh."
        );
      }

      attempt.claimed = { messageID: event.messageID, id: event.id };
    });
    yield* recordState(state.ctx, attempt, "claimed");
  });

const verifyBaselineAndValidate = (
  state: GuardState,
  event: BeforeEvent,
  input: Record<string, JsonValue | undefined>,
  command: string,
  invocations: readonly GitCommitInvocation[]
) =>
  Effect.gen(function* validate() {
    const { ctx, config } = state;

    if (ctx.location.workspaceID !== undefined) {
      return yield* Effect.fail(
        new Error(
          "[commit-guard] Remote workspace commits cannot use local commit context. Capture from a verified local checkout."
        )
      );
    }

    const session = yield* ctx.session.get({ sessionID: event.sessionID });

    if (
      session.location.workspaceID !== ctx.location.workspaceID ||
      invocations.some((invocation) => invocation.targetError !== undefined)
    ) {
      return yield* Effect.fail(
        new Error(
          "[commit-guard] Commit target is ambiguous. Use a direct git commit without -C, Git directory/configuration flags, environment overrides, or cd wrappers. Set shell workdir to the captured checkout and call commit_context there."
        )
      );
    }

    const sessionDirectory =
      session.location.directory ?? ctx.location.directory;

    const workdir = yield* Effect.try(() =>
      resolveCanonicalWorkdir(sessionDirectory, input.workdir)
    );

    const root = findGitRoot(workdir);

    const baseline = yield* load(
      ctx,
      scopeFor(ctx, event.sessionID, config, workdir)
    );

    if (
      baseline === undefined ||
      root === undefined ||
      baseline.directory !== root
    ) {
      const expected = root ?? workdir;
      const hint = JSON.stringify(relative(sessionDirectory, expected) || ".");

      return yield* Effect.fail(
        new Error(
          `[commit-guard] No published baseline for ${expected}. Call commit_context({ workdir: ${hint} }), then run the returned command immediately, unchanged, in the foreground with that workdir (do not run it in the background). Do not wrap it or chain another command onto it. ${publicationGuidance} RECEIPT_OK alone is insufficient.`
        )
      );
    }

    if (baseline.gpgsign === "error" || baseline.signingkey === "error") {
      return yield* Effect.fail(
        new Error(
          signingError(
            baseline.gpgsign === "error" ? "commit.gpgsign" : "user.signingkey"
          )
        )
      );
    }

    yield* Effect.try(() => {
      validateGitCommits(
        invocations,
        { ...config, enforceSignoff: baseline.gpgsign === "true" },
        command
      );
    });

    return yield* Effect.void;
  });

const handleBeforeExecute = (state: GuardState, event: BeforeEvent) =>
  Effect.gen(function* before() {
    yield* sweep(state);

    if (event.tool !== "shell" && event.tool !== "bash") {
      return;
    }

    const input = yield* Effect.try(() =>
      validateFields(event.input, ["workdir"], ["background"])
    );

    if (!isJSONString(input.command)) {
      yield* Effect.fail(
        new Error(
          "[commit-guard] Invalid command; expected a literal command string."
        )
      );

      return;
    }

    const { command } = input;

    const attempt = [...state.pending.values()].find(
      (item) => item.command === command
    );

    if (attempt !== undefined) {
      yield* claimCapture(state, event, input, attempt);

      return;
    }

    const invocations = yield* Effect.try(() => extractGitCommits(command));

    if (
      invocations.length > 0 &&
      !invocations.every((invocation) => invocation.isHelp)
    ) {
      yield* verifyBaselineAndValidate(
        state,
        event,
        input,
        command,
        invocations
      );
    }
  }).pipe(Effect.mapError(toToolError));

const isVerifiedShellMetadata = (
  metadata: unknown
): metadata is {
  status: "completed";
  exit: 0;
  truncated: false;
  timeout?: false;
} =>
  isRecord(metadata) &&
  metadata.status === "completed" &&
  metadata.exit === 0 &&
  metadata.truncated === false &&
  (metadata.timeout === undefined || metadata.timeout === false) &&
  Object.keys(metadata).every((key) =>
    ["status", "exit", "truncated", "timeout"].includes(key)
  );

const publishCapturedAttempt = (
  state: GuardState,
  event: AfterEvent,
  attempt: Pending
) =>
  Effect.gen(function* publishAttempt() {
    const { ctx } = state;

    if (!isRecord(event.input) || event.input.command !== attempt.command) {
      return "claimed capture command was modified before execution";
    }

    if (event.status !== "completed") {
      return "shell result did not complete successfully";
    }

    if ((yield* counter(ctx, attempt.scope)) !== attempt.counter) {
      return "capture was superseded by a refresh";
    }

    if (!isVerifiedShellMetadata(event.result.metadata)) {
      return "shell result lacks verified foreground completion metadata";
    }

    const session = yield* Effect.orElseSucceed(
      ctx.session.get({ sessionID: event.sessionID }),
      () => null
    );

    if (
      session === null ||
      session.location.workspaceID !== ctx.location.workspaceID
    ) {
      return "capture session or workspace no longer matches";
    }

    const baseline = yield* Effect.try(() => importCapture(attempt)).pipe(
      Effect.orElseSucceed(() => null)
    );

    if (
      baseline === null ||
      baseline.workdir !== attempt.workdir ||
      ctx.location.workspaceID !== undefined
    ) {
      return "private artifact is invalid or incomplete (END required)";
    }

    if (
      !(yield* publish(ctx, attempt, state.generation, baseline).pipe(
        Effect.catchCause(() => Effect.succeed(false))
      ))
    ) {
      return "capture storage failed or its counter changed";
    }

    state.failures.delete(attempt.scope);

    return baseline;
  });

const appendCaptureNote = (result: Tool.Result, note: string): Tool.Result => {
  const content: readonly Tool.Content[] = isJSONString(result.content)
    ? [{ type: "text", text: result.content }]
    : (result.content ?? []);

  const annotated: Tool.Result = {
    ...result,
    content: [...content, { type: "text", text: note }],
  };

  return isRecord(result.output) && isJSONString(result.output.output)
    ? {
        ...annotated,
        output: {
          ...result.output,
          output: `${result.output.output}\n\n${note}`,
        },
      }
    : annotated;
};

const rememberFailure = (
  state: GuardState,
  scope: string,
  reason: string
): void => {
  state.failures.delete(scope);
  state.failures.set(
    scope,
    `The previous capture failed: ${reason.slice(0, 256)}. `
  );

  if (state.failures.size > 128) {
    const oldest = state.failures.keys().next().value;

    if (oldest !== undefined) {
      state.failures.delete(oldest);
    }
  }
};

const finalizeAttempt = (
  state: GuardState,
  attempt: Pending,
  outcome: Baseline | string
) =>
  Effect.gen(function* finalize() {
    if (state.pending.get(attempt.scope) === attempt) {
      state.pending.delete(attempt.scope);
    }

    if (isJSONString(outcome)) {
      rememberFailure(state, attempt.scope, outcome);
      yield* recordState(state.ctx, attempt, "failed", outcome).pipe(
        Effect.catchCause(() => Effect.void)
      );
      yield* invalidateOwned(state.ctx, attempt);
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        cleanup(attempt);
      })
    ),
    Effect.catchCause(() => Effect.void)
  );

const handleAfterExecute = (state: GuardState, event: AfterEvent) =>
  Effect.gen(function* after() {
    const attempt = [...state.pending.values()].find(
      (item) =>
        item.claimed?.id === event.id &&
        item.claimed?.messageID === event.messageID &&
        item.sessionID === event.sessionID &&
        item.agent === event.agent
    );

    if (attempt === undefined) {
      return;
    }

    if (event.tool !== "shell") {
      yield* finalizeAttempt(
        state,
        attempt,
        "claimed capture tool was renamed away from shell"
      );

      return;
    }

    let outcome: Baseline | string = "capture import or storage failed";

    yield* Effect.gen(function* publishing() {
      outcome = yield* publishCapturedAttempt(state, event, attempt);

      if (!isJSONString(outcome)) {
        yield* recordState(state.ctx, attempt, "published");
      }
    }).pipe(
      Effect.onExit(() => finalizeAttempt(state, attempt, outcome)),
      Effect.catchCause(() => Effect.void)
    );

    const note = isJSONString(outcome)
      ? `[commit-guard] This capture did not publish a usable baseline: ${outcome.slice(0, 256)}.\nRECEIPT_OK alone does not authorize a commit.\nCall commit_context with the same workdir for status and next steps.`
      : baselineGuidance(outcome, state.config);

    if (event.status === "error") {
      event.error = new Tool.Error({
        error: event.error.error,
        metadata: event.error.metadata,
        message: `${event.error.message}\n\n${note}`,
      });
    } else {
      event.result = appendCaptureNote(event.result, note);
    }
  });

export const plugin = Plugin.define({
  id: "opencode-commit-guard",
  effect: (ctx) =>
    Effect.gen(function* setup() {
      const config = yield* Effect.sync(() => parseConfig(ctx.options));

      const state: GuardState = {
        ctx,
        config,
        generation: randomUUID(),
        pending: new Map(),
        preparing: new Set(),
        lastSessionWorkdir: new Map(),
        failures: new Map(),
      };

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* unload() {
          for (const attempt of state.pending.values()) {
            cleanup(attempt);
            yield* recordState(
              ctx,
              attempt,
              "failed",
              "plugin unloaded before publication"
            );
            yield* invalidateOwned(ctx, attempt);
          }

          state.pending.clear();
        })
      );
      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: "commit_context",
          description: String.raw`Prepare a Git baseline. Run the returned command unchanged in the foreground; require "Frozen commit baseline".
Call before your first commit in each session and checkout.
Set workdir when targeting another repository.
Run the returned command immediately, unchanged, in the foreground with the indicated workdir (do not run it in the background).
Do not wrap it or chain another command onto it.
${publicationGuidance} ${receiptGuidance}
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
            runCommitContext(state, input, toolContext),
        });
      });
      yield* ctx.tool.hook("execute.before", (event) =>
        handleBeforeExecute(state, event)
      );
      yield* ctx.tool.hook("execute.after", (event) =>
        handleAfterExecute(state, event)
      );
    }),
});

export default plugin;
