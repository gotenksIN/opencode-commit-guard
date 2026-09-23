import { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { cleanup, createPending, importCapture, invalidate, publish, scopeFor, counter, load } from "./capture.js"
import type { Pending } from "./capture.js"
import { parseConfig } from "./config.js"
import { extractGitCommits } from "./shell.js"
import { isJSONString, isRecord } from "./types.js"
import type { JsonValue } from "./types.js"
import { validateGitCommits } from "./validator.js"

export const plugin = Plugin.define({
  id: "opencode-commit-guard",
  effect: (ctx) => Effect.gen(function*() {
    const config = yield* Effect.sync(() => {
      // SAFETY: OpenCode plugin options are passed through ctx.options as JsonValue or undefined.
      return parseConfig(ctx.options as JsonValue | undefined)
    })

    const generation = randomUUID()
    const pending = new Map<string, Pending>()
    const preparing = new Set<string>()

    yield* Effect.addFinalizer(() => Effect.gen(function*() {
      for (const attempt of pending.values()) {
        cleanup(attempt)
        yield* invalidate(ctx, attempt.scope)
      }

      pending.clear()
    }))

    yield* ctx.tool.transform((editor) => editor.add({
      name: "commit_context",
      description: "Prepare a private, permission-checked Git baseline. Run the returned shell command in the foreground, then call this tool again. Set refresh to replace a frozen baseline.",
      input: { type: "object", properties: { refresh: { type: "boolean" } }, additionalProperties: false },
      execute: (input, toolContext) => Effect.gen(function*() {
        if (ctx.location.workspaceID !== undefined) return { content: "Commit context capture is unavailable for remote workspaces." }

        const session = yield* ctx.session.get({ sessionID: toolContext.sessionID })

        if (session.location.directory !== ctx.location.directory || session.location.workspaceID !== ctx.location.workspaceID) {
          return { content: "The session moved to another worktree. Call commit_context from its new location." }
        }

        const scope = scopeFor(ctx, toolContext.sessionID, config)

        if (preparing.has(scope)) return { content: "A commit context capture is preparing for this session. Call commit_context again." }

        preparing.add(scope)

        return yield* Effect.gen(function*() {
        const previous = pending.get(scope)

        if (previous !== undefined) {
          // SAFETY: The tool input schema permits only a refresh boolean.
          const refreshing = input as { refresh?: boolean }

          if (Date.now() < previous.expires && refreshing.refresh !== true) return { content: `Run this shell command with workdir ${ctx.location.directory} and background:false, then call commit_context again:\n${previous.command}` }
          pending.delete(scope)
          cleanup(previous)
          yield* invalidate(ctx, scope)
        }

        // SAFETY: The tool input schema permits only a refresh boolean.
        const request = input as { refresh?: boolean }

        if (request.refresh !== true) {
          const baseline = yield* load(ctx, scope)

          if (baseline !== undefined && baseline.workdir === ctx.location.directory && baseline.gpgsign !== "error" && baseline.signingkey !== "error") {
            const observed = [...new Set(baseline.messages.map((message) => message.split("\n")[0]?.match(/^([a-zA-Z0-9_./-]{1,40}): /)?.[1]).filter((value) => value !== undefined))].slice(0, 3)
            const examples = observed.length > 0 ? `Observed scope examples (not an allowlist): ${observed.join(", ")}.\n` : ""

            const scopes = config.allowedScopes === undefined ? "No configured scope allowlist." :
              `Configured scope allowlist: ${config.allowedScopes.join(", ").slice(0, 512)}.`

            return { content: `Frozen commit baseline for ${ctx.location.directory}.\n` +
              `Use <scope>: <subject>${config.requireScope ? " (required)" : " (optional)"}; maximum line length: ${config.maxLineLength || "unlimited"}.\n` +
              `${scopes}\n${examples}` +
              `Effective commit.gpgsign: ${baseline.gpgsign}. Signoff ${baseline.gpgsign === "true" ? "required" : "not required"}; ` +
              `signoff is not a cryptographic signature. user.signingkey: ${baseline.signingkey === null ? "unset" : "configured"}.\n` +
              "Set refresh:true after a branch switch, changed signing settings, or changed commit instructions." }
          }
        }

        if (request.refresh === true) yield* invalidate(ctx, scope)
        const count = yield* counter(ctx, scope)
        const attempt = yield* Effect.sync(() => createPending(scope, toolContext.sessionID, toolContext.agent, count, ctx.location.directory))
        pending.set(scope, attempt)

        return { content: `Run this shell command with workdir ${ctx.location.directory} and background:false, then call commit_context again:\n${attempt.command}` }
        }).pipe(Effect.ensuring(Effect.sync(() => { preparing.delete(scope) })))
      }).pipe(Effect.mapError(() => new Tool.Error({
        message: "[commit-guard] Could not access the session or commit context. Call commit_context again from this checkout.",
      }))),
    }))

    yield* ctx.tool.hook("execute.before", (event) => Effect.gen(function*() {
      const parsed = yield* Effect.try({
        try: () => {
        if (event.tool !== "shell" && event.tool !== "bash") {
          return
        }

        // SAFETY: event.input is an unvalidated tool input payload from OpenCode runtime.
        const rawInput = event.input as JsonValue | undefined

        if (!isRecord(rawInput)) {
          return
        }

        const command = rawInput["command"]

        if (!isJSONString(command)) {
          return
        }

        for (const attempt of pending.values()) {
          if (command !== attempt.command) continue

          if (event.tool !== "shell" || event.sessionID !== attempt.sessionID || event.agent !== attempt.agent ||
            (rawInput["workdir"] !== ctx.location.directory ||
            rawInput["background"] === true) || Date.now() >= attempt.expires || attempt.claimed !== undefined) {
            throw new Error("[commit-guard] Capture must use its exact foreground shell command in the original session and workdir. Call commit_context to refresh.")
          }

          attempt.claimed = { messageID: event.messageID, id: event.id }

          return
        }

        const invocations = extractGitCommits(command)

        if (invocations.length === 0) {
          return
        }

        validateGitCommits(invocations, { ...config, enforceSignoff: false }, command)

        return { invocations, command, rawInput }
        },
        catch: (error) => new Tool.Error({
          message: error instanceof Error ? error.message : "[commit-guard] Git commit validation failed.",
        }),
      })

      if (parsed === undefined) return

      if (ctx.location.workspaceID !== undefined) return yield* Effect.fail(new Tool.Error({
        message: "[commit-guard] Remote workspace commits cannot use local commit context. Capture from a verified local checkout.",
      }))

      const session = yield* ctx.session.get({ sessionID: event.sessionID })

      if (session.location.directory !== ctx.location.directory || session.location.workspaceID !== ctx.location.workspaceID ||
        parsed.rawInput["workdir"] !== undefined && parsed.rawInput["workdir"] !== ctx.location.directory ||
        parsed.invocations.some((invocation) => invocation.targetError !== undefined)) {
        return yield* Effect.fail(new Tool.Error({ message: "[commit-guard] Commit target is ambiguous. Use a direct git commit without -C, Git directory/configuration flags, environment overrides, or cd wrappers. Set shell workdir to the captured checkout and call commit_context there." }))
      }

      const baseline = yield* load(ctx, scopeFor(ctx, event.sessionID, config))

      if (baseline === undefined || baseline.workdir !== ctx.location.directory || baseline.gpgsign === "error" || baseline.signingkey === "error") {
        return yield* Effect.fail(new Tool.Error({ message: "[commit-guard] No valid signing baseline for this checkout. Call commit_context, run its authorized foreground shell command, then call commit_context again before committing." }))
      }

      yield* Effect.try({
        try: () => validateGitCommits(parsed.invocations, { ...config, enforceSignoff: baseline.gpgsign === "true" }, parsed.command),
        catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : "[commit-guard] Git commit validation failed." }),
      })
    }).pipe(Effect.mapError((error) => error instanceof Tool.Error ? error : new Tool.Error({
      message: "[commit-guard] Could not verify the commit target or signing baseline. Call commit_context from this checkout.",
    }))))

    yield* ctx.tool.hook("execute.after", (event) => Effect.gen(function*() {
      if (event.tool !== "shell") return

      const attempt = [...pending.values()].find((item) => item.claimed?.id === event.id &&
        item.claimed?.messageID === event.messageID && item.sessionID === event.sessionID && item.agent === event.agent)

      if (attempt === undefined) return

      let published = false

      yield* Effect.gen(function*() {
        if (event.status !== "completed" || Date.now() >= attempt.expires ||
          (yield* counter(ctx, attempt.scope)) !== attempt.counter) return
        // SAFETY: Tool result metadata is untrusted JSON; checked fields below are optional.
        const metadata = event.result.metadata as JsonValue | undefined

        if (isRecord(metadata)) {
          const info = isRecord(metadata["shell"]) ? metadata["shell"] : metadata

          if ((info["status"] !== undefined || info["exit"] !== undefined) && (info["status"] !== "exited" || info["exit"] !== 0)) return

          const output = isRecord(info["output"]) ? info["output"] : isRecord(metadata["output"]) ? metadata["output"] : metadata

          if (output["truncated"] === true || info["truncated"] === true || metadata["truncated"] === true ||
            isRecord(metadata["output"]) && metadata["output"]["truncated"] === true) return
        }

        const session = yield* Effect.orElseSucceed(ctx.session.get({ sessionID: event.sessionID }), () => undefined)

        if (session === undefined || session.location.directory !== ctx.location.directory || session.location.workspaceID !== ctx.location.workspaceID) return

        const baseline = yield* Effect.try({ try: () => importCapture(attempt), catch: () => new Error("Invalid capture") })

        if (baseline.workdir !== ctx.location.directory || ctx.location.workspaceID !== undefined) return
        published = yield* publish(ctx, attempt, generation, baseline)
      }).pipe(Effect.onExit(() => Effect.gen(function*() {
        if (pending.get(attempt.scope) === attempt) pending.delete(attempt.scope)

        if (!published) yield* invalidate(ctx, attempt.scope)

        yield* Effect.sync(() => cleanup(attempt))
      })), Effect.catchCause(() => Effect.void))
    }))
  }),
})

export default plugin
