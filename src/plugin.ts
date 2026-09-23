import { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { randomUUID } from "node:crypto"
import { cleanup, createPending, importCapture, invalidate, publish, scopeFor, counter } from "./capture.js"
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
        const scope = scopeFor(ctx, toolContext.sessionID, config)
        const previous = pending.get(scope)

        if (previous !== undefined) {
          if (Date.now() < previous.expires) return { content: `Run this shell command with workdir ${ctx.location.directory} and background:false, then call commit_context again:\n${previous.command}` }
          pending.delete(scope)
          cleanup(previous)
          yield* invalidate(ctx, scope)
        }

        // SAFETY: The tool input schema permits only a refresh boolean.
        const request = input as { refresh?: boolean }

        if (request.refresh === true) yield* invalidate(ctx, scope)
        const count = yield* counter(ctx, scope)
        const attempt = yield* Effect.sync(() => createPending(scope, toolContext.sessionID, toolContext.agent, count))
        pending.set(scope, attempt)

        return { content: `Run this shell command with workdir ${ctx.location.directory} and background:false, then call commit_context again:\n${attempt.command}` }
      }),
    }))

    yield* ctx.tool.hook("execute.before", (event) => Effect.try({
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
            (rawInput["workdir"] !== undefined && rawInput["workdir"] !== ctx.location.directory ||
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

        validateGitCommits(invocations, config, command)
      },
      catch: (error) => new Tool.Error({
        message: error instanceof Error
          ? error.message
          : "[commit-guard] Git commit validation failed.",
      }),
    }))

    yield* ctx.tool.hook("execute.after", (event) => Effect.gen(function*() {
      if (event.tool !== "shell") return

      const attempt = [...pending.values()].find((item) => item.claimed?.id === event.id &&
        item.claimed?.messageID === event.messageID && item.sessionID === event.sessionID && item.agent === event.agent)

      if (attempt === undefined) return
      pending.delete(attempt.scope)

      try {
        if (event.status !== "completed" || Date.now() >= attempt.expires ||
          (yield* counter(ctx, attempt.scope)) !== attempt.counter) return
        // SAFETY: Tool result metadata is untrusted JSON; checked fields below are optional.
        const metadata = event.result.metadata as JsonValue | undefined

        if (isRecord(metadata)) {
          const info = isRecord(metadata["shell"]) ? metadata["shell"] : metadata

          if (info["status"] !== undefined && (info["status"] !== "exited" || info["exit"] !== 0)) return
          const output = isRecord(metadata["output"]) ? metadata["output"] : metadata

          if (output["truncated"] === true) return
        }

        const baseline = importCapture(attempt)

        if (baseline.directory !== ctx.location.directory || ctx.location.workspaceID !== undefined) return
        yield* publish(ctx, attempt, generation, baseline)
      } catch {
        // Capture errors contain no Git output. A failed capture cannot publish a snapshot.
      } finally {
        cleanup(attempt)
      }
    }))
  }),
})

export default plugin
