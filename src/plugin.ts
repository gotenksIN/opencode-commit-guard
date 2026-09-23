import { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
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
  }),
})

export default plugin
