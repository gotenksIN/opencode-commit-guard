import { describe, expect, test } from "bun:test"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.js"
import { scopeFor } from "../src/capture.js"
import { parseConfig } from "../src/config.js"
import type { JsonValue } from "../src/types.js"

interface HookEvent {
  tool: string
  input: JsonValue
}

type ToolHookCallback = (event: HookEvent) => Effect.Effect<void, Tool.Error>

async function setupTestPlugin(options: JsonValue = {}, signing: "true" | "false" | "missing" = "true", directory = import.meta.dir) {
  const hooks = new Map<string, ToolHookCallback>()
  const shellHooks = new Map<string, (event: { command: string; cwd: string }) => Effect.Effect<void>>()
  const tools = new Map<string, Tool.Info>()
  const stored = new Map<string, JsonValue>()

  const ctx = {
    options,
    location: {
      directory,
      project: { id: "test-project" },
    },
    session: {
      get: () => Effect.succeed({ location: { directory } }),
    },
    shell: {
      hook: (name: string, callback: (event: { command: string; cwd: string }) => Effect.Effect<void>) => Effect.sync(() => {
        shellHooks.set(name, callback)

        return { dispose: Effect.void }
      }),
    },
    tool: {
      transform: (callback: (editor: { add: (definition: Tool.Info) => void }) => void) => Effect.sync(() => {
        callback({ add: (definition) => { tools.set(definition.name, definition) } })

        return { dispose: Effect.void }
      }),
      hook: (name: string, callback: ToolHookCallback) => Effect.sync(() => {
        hooks.set(name, callback)

        return { dispose: Effect.void }
      }),
    },
    storage: {
      get: (key: string) => Effect.succeed(stored.get(key)),
      set: (key: string, value: JsonValue) => Effect.sync(() => { stored.set(key, value) }),
      remove: (key: string) => Effect.sync(() => { stored.delete(key) }),
      scan: ({ prefix }: { prefix: string }) => {
        if (signing === "missing" || !prefix.startsWith("snap/")) {
          return Effect.succeed({ entries: [...stored].flatMap(([key, value]) => key.startsWith(prefix) ? [{ key, value }] : []) })
        }

        // SAFETY: The harness provides the location fields used by scopeFor.
        const scope = scopeFor(ctx as never, "test-session", parseConfig(options))

        const baseline = { directory, workdir: directory, gitDir: `${directory}/.git`, commonDir: `${directory}/.git`,
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
    prepareCapture: async (onPrepared?: () => void) => {
      const definition = tools.get("commit_context")

      if (definition === undefined) throw new Error("Commit context tool is unavailable")

      // SAFETY: The stub supplies the tool-call identity fields expected by the tool.
      const result = await Effect.runPromise(definition.execute({}, {
        sessionID: "test-session", agent: "build", messageID: "message", id: "capture",
      } as never))

      const text = result.content

      if (Object.prototype.toString.call(text) !== "[object String]") throw new Error("Capture instructions are not text")

      // SAFETY: The object tag verifies the result content is a string.
      const command = (text as string).split("\n").slice(1).join("\n")

      onPrepared?.()

      const hook = hooks.get("execute.before")

      if (hook === undefined) throw new Error("Capture admission hook is unavailable")

      // SAFETY: The stub supplies the shell input and identity fields expected by the hook.
      await Effect.runPromise(hook({
        tool: "shell", input: { command, workdir: directory },
        sessionID: "test-session", agent: "build", messageID: "message", id: "capture",
      } as never))

      return command
    },
    completeCapture: async (command: string, metadata?: JsonValue) => {
      const hook = hooks.get("execute.after")

      if (hook === undefined) throw new Error("Capture completion hook is unavailable")

      // SAFETY: The stub supplies the shell result and tool-call identity fields expected by the hook.
      await Effect.runPromise(hook({
        tool: "shell", input: { command, workdir: directory },
        sessionID: "test-session", agent: "build", messageID: "message", id: "capture",
        status: "completed", result: { metadata },
      } as never))
    },
    startCapture: async (command: string) => {
      const hook = shellHooks.get("create.before")

      if (hook === undefined) throw new Error("Shell creation hook is unavailable")

      await Effect.runPromise(hook({ command, cwd: directory }))
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

  test("publishes a capture only after a verified foreground exit", async () => {
    const accepted = { status: "completed", exit: 0, truncated: false }

    for (const metadata of [undefined, {},
      { status: "running", shellID: "sh_background", truncated: false },
      { status: "completed", exit: 7, truncated: false },
      { status: "completed", truncated: true, exit: 0 },
      { status: "completed", truncated: false, timeout: true },
      { status: "exited", exit: 0, truncated: false },
      { status: "completed", exit: 0, truncated: false, unexpected: true }, accepted]) {
      const harness = await setupTestPlugin({}, "missing")
      const command = await harness.prepareCapture()
      const shell = Bun.spawnSync(["bash", "-c", command], { cwd: import.meta.dir })

      expect(shell.exitCode).toBe(0)
      expect(shell.stdout.toString()).toBe("RECEIPT_OK\n")
      await harness.completeCapture(command, metadata)

      const commit = harness.executeBefore("shell", { command: 'git commit -s -m "kernel: valid capture"' })

      if (metadata === accepted) {
        await expect(commit).resolves.toBeUndefined()
      } else {
        await expect(commit).rejects.toThrow("Call commit_context")
      }
    }
  })

  test("keeps the capture alive when permission approval is slow", async () => {
    const harness = await setupTestPlugin({}, "missing")
    const actualNow = Date.now
    let clock = actualNow()

    Date.now = () => clock

    try {
      const command = await harness.prepareCapture(() => { clock += 15000 })
      clock += 30000
      await harness.startCapture(command)
      const shell = Bun.spawnSync(["bash", "-c", command], { cwd: import.meta.dir })

      expect(shell.exitCode).toBe(0)
      clock += 6000
      await harness.completeCapture(command, { status: "completed", exit: 0, truncated: false })
      await expect(harness.executeBefore("shell", {
        command: 'git commit -s -m "kernel: approved capture"',
      })).resolves.toBeUndefined()
    } finally {
      Date.now = actualNow
    }
  })

  test("rejects a corrupt reference instead of capturing an unborn HEAD", async () => {
    const directory = mkdtempSync(join(tmpdir(), "commit-guard-corrupt-"))

    try {
      const initialized = Bun.spawnSync(["git", "init", "-q", directory])

      expect(initialized.exitCode).toBe(0)
      const unborn = await setupTestPlugin({}, "missing", directory)
      const unbornCommand = await unborn.prepareCapture()
      const unbornShell = Bun.spawnSync(["bash", "-c", unbornCommand], { cwd: directory })

      expect(unbornShell.exitCode).toBe(0)
      await unborn.completeCapture(unbornCommand, { status: "completed", exit: 0, truncated: false })
      await expect(unborn.executeBefore("shell", {
        command: 'git commit -s -m "kernel: valid unborn checkout"',
      })).resolves.toBeUndefined()

      const branch = Bun.spawnSync(["git", "-C", directory, "symbolic-ref", "--short", "HEAD"])

      expect(branch.exitCode).toBe(0)
      writeFileSync(join(directory, ".git", "refs", "heads", branch.stdout.toString().trim()), `${"f".repeat(40)}\n`)
      const harness = await setupTestPlugin({}, "missing", directory)
      const command = await harness.prepareCapture()
      const shell = Bun.spawnSync(["bash", "-c", command], { cwd: directory })

      expect(shell.exitCode).not.toBe(0)
      expect(shell.stdout.toString()).not.toContain("RECEIPT_OK")
      await harness.completeCapture(command, { status: "completed", truncated: false, exit: shell.exitCode })
      await expect(harness.executeBefore("shell", {
        command: 'git commit -s -m "kernel: reject corrupt HEAD"',
      })).rejects.toThrow("Call commit_context")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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

    await expect(harness.executeBefore("shell", {
      command: "export GIT_DIR=/other/.git; git commit -m 'kernel: wrong target'",
    })).rejects.toThrow("Commit target is ambiguous")
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
