import { describe, expect, test } from "bun:test"
import plugin from "../index.js"
import type { JsonValue } from "../src/types.js"

interface HookEvent {
  tool: string
  input: JsonValue
}

type ToolHookCallback = (event: HookEvent) => Promise<void>

async function setupTestPlugin(options: JsonValue = {}) {
  const hooks = new Map<string, ToolHookCallback>()

  const ctx = {
    options,
    location: {
      directory: import.meta.dir,
    },
    tool: {
      hook: async (name: string, callback: ToolHookCallback) => {
        hooks.set(name, callback)
      },
    },
  }

  // SAFETY: ctx stubs the options and tool domain required by the plugin setup.
  await plugin.setup(ctx as never)

  return {
    executeBefore: async (tool: string, input: JsonValue) => {
      const hook = hooks.get("execute.before")

      if (hook !== undefined) {
        await hook({ tool, input })
      }
    },
  }
}

describe("opencode-commit-guard plugin", () => {
  test("allows non-shell tools without interception", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("write", { path: "file.txt", content: "git commit invalid" }),
    ).resolves.toBeUndefined()
  })

  test("allows shell commands that do not contain git commit", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: "git status" }),
    ).resolves.toBeUndefined()
    await expect(
      harness.executeBefore("bash", { command: "bun test && git log -5" }),
    ).resolves.toBeUndefined()
  })

  test("allows commands that mention git commit inside strings", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: 'echo "git commit without scope"' }),
    ).resolves.toBeUndefined()
  })

  test("allows conforming git commit commands", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: 'git commit -s -m "kernel: add support for foo"' }),
    ).resolves.toBeUndefined()
    await expect(
      harness.executeBefore("bash", { command: 'git commit -sm "feat(parser): add subshell support"' }),
    ).resolves.toBeUndefined()
  })

  test("rejects git commit commands with invalid format before execution", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: 'git commit -m "Missing scope entirely" -s' }),
    ).rejects.toThrow("Missing scope in subject line")
  })

  test("rejects git commit commands missing signoff flag or trailer", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: 'git commit -m "kernel: fix race condition"' }),
    ).rejects.toThrow("Missing commit signoff")
  })

  test("rejects git commit commands exceeding line length", async () => {
    const harness = await setupTestPlugin()
    const longMsg = "kernel: add support for an excessively long feature description that crosses seventy-two chars"
    await expect(
      harness.executeBefore("shell", { command: `git commit -s -m "${longMsg}"` }),
    ).rejects.toThrow("Commit message exceeds maximum line length of 72 characters")
  })

  test("respects allowedScopes option", async () => {
    const harness = await setupTestPlugin({
      allowedScopes: ["kernel", "releasetools"],
    })

    await expect(
      harness.executeBefore("shell", { command: 'git commit -s -m "kernel: fix race"' }),
    ).resolves.toBeUndefined()

    await expect(
      harness.executeBefore("shell", { command: 'git commit -s -m "ui: update colors"' }),
    ).rejects.toThrow('Scope "ui" is not in the allowed scopes list')
  })

  test("respects maxLineLength option override", async () => {
    const harness = await setupTestPlugin({
      maxLineLength: 100,
    })

    const eightyChars = "kernel: " + "a".repeat(75)
    await expect(
      harness.executeBefore("shell", { command: `git commit -s -m "${eightyChars}"` }),
    ).resolves.toBeUndefined()
  })

  test("respects requireSignoff: false option override", async () => {
    const harness = await setupTestPlugin({
      requireSignoff: false,
    })

    await expect(
      harness.executeBefore("shell", { command: 'git commit -m "kernel: add foo without signoff"' }),
    ).resolves.toBeUndefined()
  })

  test("respects requireScope: false option override", async () => {
    const harness = await setupTestPlugin({
      requireScope: false,
    })

    await expect(
      harness.executeBefore("shell", { command: 'git commit -s -m "Freeform commit title without scope"' }),
    ).resolves.toBeUndefined()
  })

  test("validates configuration options on setup", async () => {
    await expect(setupTestPlugin({ requireScope: "invalid" })).rejects.toThrow(
      "Invalid plugin option requireScope; expected a boolean.",
    )
    await expect(setupTestPlugin({ allowedScopes: "not-an-array" })).rejects.toThrow(
      "Invalid plugin option allowedScopes; expected an array of non-empty strings.",
    )
    await expect(setupTestPlugin({ maxLineLength: -5 })).rejects.toThrow(
      "Invalid plugin option maxLineLength; expected an integer greater than or equal to 0.",
    )
    await expect(setupTestPlugin({ requireSignoff: 123 })).rejects.toThrow(
      "Invalid plugin option requireSignoff; expected a boolean.",
    )
  })
})
