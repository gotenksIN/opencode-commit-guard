import { describe, expect, test } from "bun:test"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import plugin from "../index.js"
import { scopeFor } from "../src/capture.js"
import { parseConfig } from "../src/config.js"
import type { JsonValue } from "../src/types.js"

interface HookEvent {
  tool: string
  input: JsonValue
}

type ToolHookCallback = (event: HookEvent) => Effect.Effect<void, Tool.Error>

async function setupTestPlugin(options: JsonValue = {}, signing: "true" | "false" | "missing" = "true") {
  const hooks = new Map<string, ToolHookCallback>()

  const ctx = {
    options,
    location: {
      directory: import.meta.dir,
      project: { id: "test-project" },
    },
    session: {
      get: () => Effect.succeed({ location: { directory: import.meta.dir } }),
    },
    tool: {
      transform: () => Effect.succeed({ dispose: Effect.void }),
      hook: (name: string, callback: ToolHookCallback) => Effect.sync(() => {
        hooks.set(name, callback)

        return { dispose: Effect.void }
      }),
    },
    storage: {
      get: () => Effect.succeed(undefined),
      set: () => Effect.void,
      scan: () => {
        if (signing === "missing") return Effect.succeed({ entries: [] })

        // SAFETY: The harness provides the location fields used by scopeFor.
        const scope = scopeFor(ctx as never, "test-session", parseConfig(options))

        const baseline = { directory: import.meta.dir, workdir: import.meta.dir, gitDir: `${import.meta.dir}/.git`, commonDir: `${import.meta.dir}/.git`,
          branch: "main", head: null, messages: [], gpgsign: signing, signingkey: null }

        const generation = "test-generation"
        const sequence = "000000000000001-fixture"
        const checksum = createHash("sha256").update(JSON.stringify([1, scope, 0, generation, sequence, baseline])).digest("hex")

        return Effect.succeed({ entries: [{ key: `snap/${scope}/${sequence}`, value: {
          schema: 1, scope, counter: 0, generation, sequence, baseline, checksum,
        } }] })
      },
    },
  }

  // SAFETY: ctx stubs the options and tool domain required by the plugin effect.
  await Effect.runPromise(Effect.scoped(plugin.effect(ctx as never)))

  return {
    executeBefore: async (tool: string, input: JsonValue) => {
      const hook = hooks.get("execute.before")

      if (hook !== undefined) {
        // SAFETY: The stub supplies the tool-call identity fields expected by the hook.
        await Effect.runPromise(hook({ tool, input, sessionID: "test-session", agent: "build", messageID: "message", id: "call" } as never))
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

  test("allows generated fixup commits without an explicit message", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: "git commit --fixup=HEAD" }),
    ).resolves.toBeUndefined()
  })

  test("allows explicit fixup and squash subjects with valid scopes", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: 'git commit -s -m "fixup! kernel: fix race"' }),
    ).resolves.toBeUndefined()
    await expect(
      harness.executeBefore("shell", { command: 'git commit -s -m "squash! feat(parser): add token"' }),
    ).resolves.toBeUndefined()
  })

  test("rejects explicit fixup subjects with invalid scopes", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: 'git commit -s -m "fixup! invalid subject"' }),
    ).rejects.toThrow('Missing scope in subject line "fixup! invalid subject"')
  })

  test("allows a no-edit amendment without an explicit message", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: "git commit --amend --no-edit" }),
    ).resolves.toBeUndefined()
  })

  test("validates an amendment when an explicit message is provided", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: 'git commit --amend -s -m "kernel: valid message"' }),
    ).resolves.toBeUndefined()
    await expect(
      harness.executeBefore("shell", { command: 'git commit --amend -s -m "invalid message"' }),
    ).rejects.toThrow("Missing scope in subject line")
  })

  test("rejects git commit commands with invalid format before execution", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: 'git commit -m "Missing scope entirely" -s' }),
    ).rejects.toThrow("Missing scope in subject line")
    await expect(
      harness.executeBefore("shell", { command: 'git com""mit -m "Missing scope entirely" -s' }),
    ).rejects.toThrow("Missing scope in subject line")
  })

  test("settles parallel validation failures as independent tool errors", async () => {
    const harness = await setupTestPlugin()

    const settled = await Promise.allSettled([
      harness.executeBefore("shell", { command: 'git commit -s -m "invalid scope"' }),
      harness.executeBefore("shell", { command: 'git commit -m "kernel: missing signoff"' }),
    ])

    const scopeFailure = settled[0]
    const signoffFailure = settled[1]

    expect(scopeFailure?.status).toBe("rejected")
    expect(signoffFailure?.status).toBe("rejected")

    if (scopeFailure?.status === "rejected" && signoffFailure?.status === "rejected") {
      expect(scopeFailure.reason).toBeInstanceOf(Tool.Error)
      expect(signoffFailure.reason).toBeInstanceOf(Tool.Error)
      expect(scopeFailure.reason.message).toContain("Missing scope in subject line")
      expect(signoffFailure.reason.message).toContain("Missing commit signoff")
    }
  })

  test("rejects git commit commands missing signoff flag or trailer", async () => {
    const harness = await setupTestPlugin()
    await expect(
      harness.executeBefore("shell", { command: 'git commit -m "kernel: fix race condition"' }),
    ).rejects.toThrow("Missing commit signoff")

    const withoutBaseline = await setupTestPlugin({}, "missing")

    await expect(
      withoutBaseline.executeBefore("shell", { command: 'git commit -s -m "kernel: fix race condition"' }),
    ).rejects.toThrow("Call commit_context")
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

  test("does not require signoff when effective commit.gpgsign is false", async () => {
    const harness = await setupTestPlugin({}, "false")

    await expect(
      harness.executeBefore("shell", { command: 'git commit -m "kernel: add foo without signoff"' }),
    ).resolves.toBeUndefined()

    await expect(
      harness.executeBefore("shell", { command: 'git -C elsewhere commit -m "kernel: wrong target"' }),
    ).rejects.toThrow("Commit target is ambiguous")
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
    await expect(setupTestPlugin({ requireSignoff: true })).rejects.toThrow(
      "Plugin option requireSignoff has been removed",
    )
  })
})
