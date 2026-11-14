import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanup, createPending, importCapture } from "../src/capture.js"

const teardown: (() => void)[] = []

afterEach(() => {
  for (const close of teardown.splice(0).reverse()) close()
})

function prepare() {
  const directory = mkdtempSync(join(tmpdir(), "commit-guard-capture-"))

  teardown.push(() => rmSync(directory, { recursive: true, force: true }))
  expect(Bun.spawnSync(["git", "init", "-q", directory]).exitCode).toBe(0)
  const pending = createPending("scope", "session", "build", 0, directory)

  teardown.push(() => cleanup(pending))

  return pending
}

function runCapture(command: string, workdir: string) {
  return Bun.spawnSync(process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["bash", "-c", command], { cwd: workdir })
}

describe("private context capture", () => {
  test("captures raw NUL-delimited history with portable framing", () => {
    const pending = prepare()
    const message = "core: Preserve history\n\nA literal body."

    expect(Bun.spawnSync(["git", "-C", pending.workdir, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message]).exitCode).toBe(0)
    const result = runCapture(pending.command, pending.workdir)

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe("RECEIPT_OK\n")
    const baseline = importCapture(pending)

    expect(baseline.messages).toEqual([`${message}\n`])
    expect(baseline.directory).toBe(pending.workdir)
    expect(baseline.head).toMatch(/^[0-9a-f]{40}$/)
  })

  test.skipIf(process.platform === "win32")("does not require GNU base64 or timeout", () => {
    const pending = prepare()

    expect(pending.command).not.toContain("base64 -w")
    expect(pending.command).not.toContain("timeout 15")
    expect(runCapture(pending.command, pending.workdir).exitCode).toBe(0)
    expect(importCapture(pending).head).toBeNull()
  })

  test.skipIf(process.platform === "win32")("kills the capture process group after 15 seconds", () => {
    const pending = prepare()
    const bin = join(pending.workdir, "git")

    writeFileSync(bin, "#!/bin/sh\nsleep 30\n", { mode: 0o700 })

    const started = Date.now()

    const result = Bun.spawnSync(["bash", "-c", pending.command], {
      cwd: pending.workdir, env: { ...process.env, PATH: `${pending.workdir}:${process.env["PATH"]}` },
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stdout.toString()).not.toContain("RECEIPT_OK")
    expect(Date.now() - started).toBeLessThan(19000)
    expect(() => importCapture(pending)).toThrow()
  }, 20000)

  test.skipIf(process.platform === "win32")("rejects non-private modes on POSIX but not Windows", () => {
    const pending = prepare()

    expect(runCapture(pending.command, pending.workdir).exitCode).toBe(0)
    const artifact = join(pending.directory, readdirSync(pending.directory)[0]!)

    chmodSync(artifact, 0o644)
    expect(() => importCapture(pending)).toThrow("Invalid private capture artifact")
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!

    try {
      Object.defineProperty(process, "platform", { value: "win32" })
      expect(importCapture(pending).directory).toBe(pending.workdir)
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })

  test("generates a shell-neutral Windows command with a private encoded path", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!

    try {
      Object.defineProperty(process, "platform", { value: "win32" })
      const pending = prepare()

      expect(pending.command).toStartWith("powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ")
      expect(pending.command).toMatch(/-EncodedCommand [A-Za-z0-9+/=]+$/)
      expect(pending.command.length).toBeLessThan(8191)
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })

  test.skipIf(process.platform !== "win32")("runs the Windows capture under each supported shell", () => {
    for (const executable of ["cmd.exe", "powershell", "pwsh", "bash"]) {
      const pending = prepare()

      const args = executable === "cmd.exe" ? ["/d", "/s", "/c"] :
        executable === "bash" ? ["-c"] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]

      const result = Bun.spawnSync([executable, ...args, pending.command], { cwd: pending.workdir })

      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe("RECEIPT_OK\n")
      expect(importCapture(pending).directory).toBe(pending.workdir)
    }
  })

  test("rejects oversized or incomplete artifacts", () => {
    const pending = prepare()

    expect(runCapture(pending.command, pending.workdir).exitCode).toBe(0)
    expect(readFileSync(pending.fd).toString()).toEndWith("END\n")
    writeFileSync(pending.fd, "x".repeat(262145))
    expect(() => importCapture(pending)).toThrow("Invalid private capture artifact")
  })
})
