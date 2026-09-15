import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import plugin from "../index.js"
import type { JsonValue } from "../src/types.js"

const testDir = join(import.meta.dir, ".plugin-tmp")

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
  delete process.env.OPENCODE_TEST_HOME
})

interface HookEvent {
  tool: string
  input: JsonValue
}

type ToolHookCallback = (event: HookEvent) => Promise<void>

async function setupTestPlugin(
  options: JsonValue = {},
  directory = import.meta.dir,
  workspaceID?: string,
) {
  const hooks = new Map<string, ToolHookCallback>()

  const ctx = {
    options,
    location: {
      directory,
      workspaceID,
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

function runGit(args: readonly string[], directory = testDir): void {
  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })

  if (result.status !== 0) {
    throw new Error(`Git test setup failed: ${result.stderr}`)
  }
}

function initializeRepository(message: string, directory = testDir): void {
  mkdirSync(directory, { recursive: true })
  runGit(["init", "--quiet"], directory)
  runGit([
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    message,
  ], directory)
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

  test("validates the existing commit for amend with no edit", async () => {
    initializeRepository("kernel: valid existing message\n\nSigned-off-by: Test User <test@example.com>")
    const harness = await setupTestPlugin({}, testDir)
    await expect(
      harness.executeBefore("shell", { command: "git commit --amend --no-edit" }),
    ).resolves.toBeUndefined()
  })

  test("rejects amend with no edit when the existing commit is invalid", async () => {
    initializeRepository("Invalid existing message\n\nSigned-off-by: Test User <test@example.com>")
    const harness = await setupTestPlugin({}, testDir)
    await expect(
      harness.executeBefore("shell", { command: "git commit --amend --no-edit" }),
    ).rejects.toThrow("Missing scope in subject line")
  })

  test("rejects no-edit amendments with explicit repository selectors", async () => {
    const harness = await setupTestPlugin()

    await expect(
      harness.executeBefore("shell", {
        command: "git --git-dir ../outside.git --work-tree ../outside commit --amend --no-edit",
      }),
    ).rejects.toThrow("Cannot validate an existing commit through --git-dir or --work-tree")
  })

  test("avoids local repository reads for workspace-backed locations", async () => {
    initializeRepository("Invalid local host message")
    const harness = await setupTestPlugin({}, testDir, "workspace-1")

    await expect(
      harness.executeBefore("shell", { command: "git commit --amend --no-edit" }),
    ).rejects.toThrow("Cannot validate the existing commit in a workspace-backed location")
    await expect(
      harness.executeBefore("shell", { command: 'git commit --amend -s -m "kernel: valid remote message"' }),
    ).resolves.toBeUndefined()
    await expect(
      harness.executeBefore("shell", { command: 'git commit --amend -s -m "invalid remote message"' }),
    ).rejects.toThrow("Missing scope in subject line")
  })

  test("resolves a relative shell workdir from the session directory", async () => {
    const sessionDirectory = join(testDir, "session")
    const repositoryDirectory = join(sessionDirectory, "nested")
    initializeRepository("kernel: valid existing message\n\nSigned-off-by: Test User <test@example.com>", repositoryDirectory)
    const harness = await setupTestPlugin({}, sessionDirectory)

    await expect(
      harness.executeBefore("shell", {
        command: "git commit --amend --no-edit",
        workdir: "nested",
      }),
    ).resolves.toBeUndefined()
  })

  test("expands a home shell workdir like OpenCode", async () => {
    process.env.OPENCODE_TEST_HOME = testDir
    initializeRepository("kernel: valid existing message\n\nSigned-off-by: Test User <test@example.com>")
    const harness = await setupTestPlugin({}, join(testDir, "session"))

    await expect(
      harness.executeBefore("shell", {
        command: "git commit --amend --no-edit",
        workdir: "~",
      }),
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
