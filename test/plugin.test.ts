import { afterEach, describe, expect, test } from "bun:test"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, Scope } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../index.js"
import { findGitRoot, scopeFor } from "../src/capture.js"
import { parseConfig } from "../src/config.js"
import type { JsonValue } from "../src/types.js"
import { isRecord } from "../src/types.js"

interface HookEvent {
  tool: string
  input: JsonValue
}

type ToolHookCallback = (event: HookEvent) => Effect.Effect<void, Tool.Error>

const teardown: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of teardown.splice(0).reverse()) await close()
})

async function setupTestPlugin(options: JsonValue = {}, signing: "true" | "false" | "unset" | "error" | "missing" = "true", directory = import.meta.dir, stored = new Map<string, JsonValue>()) {
  const hooks = new Map<string, ToolHookCallback>()
  const shellHooks = new Map<string, (event: { command: string; cwd: string }) => Effect.Effect<void>>()
  const tools = new Map<string, Tool.Info>()
  let failPublication = false

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
      set: (key: string, value: JsonValue) => Effect.sync(() => {
        if (failPublication && key.startsWith("snap/")) throw new Error("Storage unavailable")
        stored.set(key, value)
      }),
      remove: (key: string) => Effect.sync(() => { stored.delete(key) }),
      scan: ({ prefix }: { prefix: string }) => {
        if (signing === "missing" || !prefix.startsWith("snap/")) {
          return Effect.succeed({ entries: [...stored].flatMap(([key, value]) => key.startsWith(prefix) ? [{ key, value }] : []) })
        }

        // SAFETY: The harness provides the location fields used by scopeFor.
        const scope = scopeFor(ctx as never, "test-session", parseConfig(options))

        const root = findGitRoot(directory) ?? directory

        const baseline = { directory: root, workdir: directory, gitDir: `${root}/.git`, commonDir: `${root}/.git`,
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

  const scope = await Effect.runPromise(Scope.make())
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void))

  teardown.push(close)
  // SAFETY: ctx stubs the options and tool domain required by the plugin effect.
  await Effect.runPromise(plugin.effect(ctx as never).pipe(Scope.provide(scope)))

  const context = async (request: JsonValue = {}) => {
    const definition = tools.get("commit_context")

    if (definition === undefined) throw new Error("Commit context tool is unavailable")

    // SAFETY: The stub supplies the tool-call identity fields expected by the tool.
    const result = await Effect.runPromise(definition.execute(request, {
      sessionID: "test-session", agent: "build", messageID: "message", id: "capture",
    } as never))

    if (Object.prototype.toString.call(result.content) !== "[object String]") throw new Error("Expected text")

    // SAFETY: The object tag verifies the tool content is text.
    return result.content as string
  }

  return {
    context,
    close,
    stored,
    failPublication: () => { failPublication = true },
    executeBefore: async (tool: string, input: JsonValue) => {
      const hook = hooks.get("execute.before")

      if (hook !== undefined) {
        // SAFETY: The stub supplies the tool-call identity fields expected by the hook.
        await Effect.runPromise(hook({ tool, input, sessionID: "test-session", agent: "build", messageID: "message", id: "call" } as never))
      }
    },
    prepareCapture: async (onPrepared?: () => void, request: JsonValue = {}, workdir = directory) => {
      const definition = tools.get("commit_context")

      if (definition === undefined) throw new Error("Commit context tool is unavailable")

      // SAFETY: The stub supplies the tool-call identity fields expected by the tool.
      const result = await Effect.runPromise(definition.execute(request, {
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
        tool: "shell", input: { command, workdir },
        sessionID: "test-session", agent: "build", messageID: "message", id: "capture",
      } as never))

      return command
    },
    completeCapture: async (command: string, metadata?: JsonValue, result: Tool.Result = {
      content: [{ type: "text", text: "RECEIPT_OK\n" }],
      metadata: isRecord(metadata) ? metadata : undefined,
    }, id = "capture") => {
      const hook = hooks.get("execute.after")

      if (hook === undefined) throw new Error("Capture completion hook is unavailable")

      const event = {
        tool: "shell", input: { command, workdir: directory },
        sessionID: "test-session", agent: "build", messageID: "message", id,
        status: "completed", result,
      }

      // SAFETY: The stub supplies the shell result and tool-call identity fields expected by the hook.
      await Effect.runPromise(hook(event as never))

      return event.result
    },
    failCapture: async (command: string, error: Tool.Error) => {
      const hook = hooks.get("execute.after")

      if (hook === undefined) throw new Error("Capture completion hook is unavailable")

      const event = {
        tool: "shell", input: { command, workdir: directory },
        sessionID: "test-session", agent: "build", messageID: "message", id: "capture",
        status: "error", error,
      }

      // SAFETY: The stub supplies a failed shell result and the claimed tool-call identity.
      await Effect.runPromise(hook(event as never))

      return event.error
    },
    startCapture: async (command: string) => {
      const hook = shellHooks.get("create.before")

      if (hook !== undefined) await Effect.runPromise(hook({ command, cwd: directory }))
    },
  }
}

describe("opencode-commit-guard plugin", () => {
  test("appends frozen guidance to copied capture content and structured output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "commit-guard-inline-"))

    teardown.push(async () => { rmSync(directory, { recursive: true, force: true }) })
    expect(Bun.spawnSync(["git", "init", "-q", directory]).exitCode).toBe(0)
    expect(Bun.spawnSync(["git", "-C", directory, "config", "commit.gpgsign", "true"]).exitCode).toBe(0)
    const harness = await setupTestPlugin({ allowedScopes: ["core"] }, "missing", directory)
    const command = await harness.prepareCapture()
    const metadata = Object.freeze({ status: "completed", exit: 0, truncated: false })

    const parts: readonly Tool.Content[] = Object.freeze([
      { type: "text", text: "RECEIPT_OK\n" },
      { type: "file", uri: "file:///receipt", mime: "text/plain" },
    ])

    const output = Object.freeze({ output: "RECEIPT_OK\n", exit: 0, status: "completed" })
    const original = Object.freeze({ content: parts, output, metadata })

    expect(Bun.spawnSync(["bash", "-c", command], { cwd: directory }).exitCode).toBe(0)
    const result = await harness.completeCapture(command, metadata, original)

    await expect(harness.executeBefore("shell", { command: "git commit -s -m 'core: Inline capture'" })).resolves.toBeUndefined()
    const guidance = await harness.context()

    expect(guidance).toContain(`[commit-guard] Frozen commit baseline for ${directory}.`)
    expect(guidance).toContain("Configured scope allowlist: core.")
    expect(guidance).toContain("Add -s or --signoff.")
    expect(guidance).toContain("A second commit_context call is optional.")
    expect(result).not.toBe(original)
    expect(result.content).toEqual([...parts, { type: "text", text: guidance }])
    expect(result.output).toEqual({ ...output, output: `${output.output}\n\n${guidance}` })
    expect(result.metadata).toBe(metadata)
    expect(original.content).toBe(parts)
    expect(original.output).toBe(output)
    expect(await harness.context()).toBe(guidance)
  })

  test("appends the recorded capture failure reason without changing metadata", async () => {
    const harness = await setupTestPlugin({}, "missing")
    const command = await harness.prepareCapture()
    const metadata = { status: "completed", exit: 0, truncated: true }
    const result = await harness.completeCapture(command, metadata)

    const note = "[commit-guard] This capture did not publish a usable baseline: shell result lacks verified foreground completion metadata.\n" +
      "RECEIPT_OK alone does not authorize a commit.\nCall commit_context with the same workdir for status and next steps."

    expect(result.content).toEqual([{ type: "text", text: "RECEIPT_OK\n" }, { type: "text", text: note }])
    expect(result.metadata).toBe(metadata)
    expect(await harness.context()).toContain("previous capture failed: shell result lacks verified foreground completion metadata")
  })

  test("appends capture failure guidance to the original shell error message", async () => {
    const harness = await setupTestPlugin({}, "missing")
    const command = await harness.prepareCapture()
    const original = new Tool.Error({ message: "Permission denied by user" })
    const error = await harness.failCapture(command, original)

    expect(error).toBeInstanceOf(Tool.Error)
    expect(error).not.toBe(original)
    expect(error.message).toStartWith("Permission denied by user\n\n[commit-guard] This capture did not publish a usable baseline: shell result did not complete successfully.")
    expect(error.message).toContain("RECEIPT_OK alone does not authorize a commit.")
    expect(await harness.context()).toContain("previous capture failed: shell result did not complete successfully")
  })

  test("leaves unrelated shell results untouched while a capture is claimed", async () => {
    const harness = await setupTestPlugin({}, "missing")

    await harness.prepareCapture()
    const original: Tool.Result = { content: "git status output", output: { output: "git status output" }, metadata: { exit: 0 } }

    expect(await harness.completeCapture("git status", undefined, original, "other-call")).toBe(original)
  })

  test("renders signoff guidance from the frozen effective policy", async () => {
    for (const required of [true, false]) {
      const harness = await setupTestPlugin({}, required ? "true" : "false")
      const guidance = await harness.context()

      expect(guidance).toContain(required ? "Add -s or --signoff." : "Signoff is not required; add it only if repository instructions require it.")
      expect(guidance).toContain("Signoff is not a cryptographic signature.")
    }

    const unset = await setupTestPlugin({}, "unset")

    expect(await unset.context()).toContain("Effective commit.gpgsign: unset. Signoff is not required; add it only if repository instructions require it.")
  })
  test("reports a missing baseline before message format and permits help", async () => {
    const harness = await setupTestPlugin({}, "missing")

    await expect(harness.executeBefore("shell", { command: "git commit -m bad" })).rejects.toThrow("No published baseline")

    for (const flag of ["--help", "-h"]) {
      await expect(harness.executeBefore("shell", { command: `git commit ${flag}` })).resolves.toBeUndefined()
    }
  })

  test("reports unclaimed, claimed, failed, and reloaded capture status", async () => {
    const harness = await setupTestPlugin({}, "missing")
    const instructions = await harness.context()
    const command = instructions.split("\n").slice(1).join("\n")

    await harness.executeBefore("shell", { command: `${command} `, workdir: import.meta.dir })
    expect(await harness.context()).toContain("still pending and unclaimed")
    expect(await harness.context()).toContain("RECEIPT_OK confirms only that the artifact was written")
    const claimed = await harness.prepareCapture()

    expect(await harness.context()).toContain("Capture claimed")
    await harness.completeCapture(claimed, { status: "completed", exit: 0, truncated: true })
    const reloaded = await setupTestPlugin({}, "missing", import.meta.dir, harness.stored)

    expect(await reloaded.context()).toContain("previous capture failed: shell result lacks verified foreground completion metadata")
  })

  test("reports an incomplete artifact only after successful metadata proof", async () => {
    const harness = await setupTestPlugin({}, "missing")
    const command = await harness.prepareCapture()

    await harness.completeCapture(command, { status: "completed", exit: 0, truncated: false })
    expect(await harness.context()).toContain("private artifact is invalid or incomplete (END required)")
  })

  test("reports failed baseline storage on the next context call", async () => {
    const harness = await setupTestPlugin({}, "missing")
    const command = await harness.prepareCapture()

    expect(Bun.spawnSync(["bash", "-c", command], { cwd: import.meta.dir }).exitCode).toBe(0)
    harness.failPublication()
    await harness.completeCapture(command, { status: "completed", exit: 0, truncated: false })
    expect(await harness.context()).toContain("capture storage failed or its counter changed")
  })

  test("sweeps abandoned unclaimed artifacts and keeps claimed artifacts", async () => {
    const harness = await setupTestPlugin({}, "missing")
    const actualNow = Date.now
    let clock = actualNow()

    Date.now = () => clock

    try {
      const instructions = await harness.context()
      const artifact = instructions.match(/bash '([^']+)' 2>\/dev\/null$/)?.[1]

      expect(artifact).toBeDefined()
      expect(existsSync(artifact!)).toBe(true)
      clock += 21000
      await harness.executeBefore("shell", { command: "git status" })
      expect(existsSync(artifact!)).toBe(false)
      expect(await harness.context()).toContain("previous capture expired before its command was claimed")
      const claimed = await harness.prepareCapture()
      const claimedArtifact = claimed.match(/bash '([^']+)' 2>\/dev\/null$/)?.[1]

      clock += 60000
      await harness.executeBefore("shell", { command: "git status" })
      expect(existsSync(claimedArtifact!)).toBe(true)
    } finally {
      Date.now = actualNow
    }
  })

  test("stale completion and unload do not invalidate a later baseline", async () => {
    for (const finish of ["complete", "unload", "reload"]) {
      const stale = await setupTestPlugin({}, "missing")
      const oldCommand = await stale.prepareCapture()
      const current = await setupTestPlugin({}, "missing", import.meta.dir, stale.stored)
      const command = await current.prepareCapture(undefined, { refresh: finish !== "reload" })
      const shell = Bun.spawnSync(["bash", "-c", command], { cwd: import.meta.dir })

      expect(shell.exitCode).toBe(0)
      await current.completeCapture(command, { status: "completed", exit: 0, truncated: false })

      if (finish !== "unload") await stale.completeCapture(oldCommand, {})
      else await stale.close()
      expect(await current.context()).toContain("Frozen commit baseline")
    }
  })

  test("explains invalid signing config without issuing capture commands repeatedly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "commit-guard-config-"))

    teardown.push(async () => { rmSync(directory, { recursive: true, force: true }) })
    expect(Bun.spawnSync(["git", "init", "-q", directory]).exitCode).toBe(0)
    expect(Bun.spawnSync(["git", "-C", directory, "config", "commit.gpgsign", "invalid_bool"]).exitCode).toBe(0)
    const harness = await setupTestPlugin({}, "missing", directory)
    const command = await harness.prepareCapture()

    expect(Bun.spawnSync(["bash", "-c", command], { cwd: directory }).exitCode).toBe(0)
    const result = await harness.completeCapture(command, { status: "completed", exit: 0, truncated: false })
    const message = await harness.context()

    expect(message).toContain("Git could not read commit.gpgsign as valid")
    expect(message).toContain("git config --show-origin --get-all commit.gpgsign")
    expect(message).toContain("without changing the intended signing policy")
    expect(message).not.toContain("timeout 15s")
    expect(message).not.toContain("Frozen commit baseline")
    expect(result.content).toEqual([{ type: "text", text: "RECEIPT_OK\n" }, { type: "text", text: message }])
    await expect(harness.executeBefore("shell", { command: "git commit -m bad" })).rejects.toThrow("Repeating the capture will not fix it")
  })

  test("shares the baseline and refresh across root and subdirectory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "commit-guard-root-"))
    const subdirectory = join(directory, "sub")

    teardown.push(async () => { rmSync(directory, { recursive: true, force: true }) })
    mkdirSync(subdirectory)
    expect(Bun.spawnSync(["git", "init", "-q", directory]).exitCode).toBe(0)
    const harness = await setupTestPlugin({}, "missing", directory)
    const command = await harness.prepareCapture(undefined, { workdir: "sub" }, subdirectory)

    expect(Bun.spawnSync(["bash", "-c", command], { cwd: subdirectory }).exitCode).toBe(0)
    await harness.completeCapture(command, { status: "completed", exit: 0, truncated: false })
    await expect(harness.executeBefore("shell", { command: "git commit -s -m 'core: Root'", workdir: directory })).resolves.toBeUndefined()
    expect(await harness.context({ workdir: "sub" })).toContain("Frozen commit baseline")
    await harness.context({ refresh: true, workdir: directory })
    await expect(harness.executeBefore("shell", { command: "git commit -s -m 'core: Sub'", workdir: subdirectory })).rejects.toThrow("No published baseline")
    const rootCommand = await harness.prepareCapture()

    expect(Bun.spawnSync(["bash", "-c", rootCommand], { cwd: directory }).exitCode).toBe(0)
    await harness.completeCapture(rootCommand, { status: "completed", exit: 0, truncated: false })
    await expect(harness.executeBefore("shell", { command: "git commit -s -m 'core: Sub'", workdir: subdirectory })).resolves.toBeUndefined()
    await harness.context({ refresh: true, workdir: "sub" })
    await expect(harness.executeBefore("shell", { command: "git commit -s -m 'core: Root'", workdir: directory })).rejects.toThrow("No published baseline")
  })

  test("rejects impossible allowed scopes during configuration", () => {
    for (const scope of ["bad scope", "foo@bar", "core:", "core: Subject", "feat()", "(core)"]) {
      expect(() => parseConfig({ allowedScopes: [scope] })).toThrow(`scope ${JSON.stringify(scope)} cannot match`)
    }

    expect(parseConfig({ allowedScopes: ["core", "feat(core)", "foo/bar", "build-tools"] }).allowedScopes).toEqual(["core", "feat(core)", "foo/bar", "build-tools"])
  })
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
      await harness.startCapture(command)
      clock += 30000
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
