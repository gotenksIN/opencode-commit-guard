import { Plugin } from "@opencode/plugin"
import { parseConfig } from "./config.js"
import { extractGitCommits } from "./shell.js"
import { isJSONString, isRecord } from "./types.js"
import type { JsonValue } from "./types.js"
import { validateGitCommits } from "./validator.js"

export const plugin = Plugin.define({
  id: "opencode-commit-guard",
  setup: async (ctx) => {
    // SAFETY: OpenCode plugin options are passed through ctx.options as JsonValue or undefined.
    const config = parseConfig(ctx.options as JsonValue | undefined)
    const sessionDirectory = ctx.location.directory

    await ctx.tool.hook("execute.before", async (event) => {
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

      const workdir = rawInput["workdir"]
      validateGitCommits(
        invocations,
        config,
        command,
        isJSONString(workdir) ? workdir : sessionDirectory,
      )
    })
  },
})

export default plugin
