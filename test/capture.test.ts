import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { cleanup, createPending, importCapture } from "../src/capture.js";
import { createTempRepo, withPlatform } from "./helpers.js";

const { join } = path;

const teardown: (() => void)[] = [];

afterEach(() => {
  for (const close of teardown.splice(0).toReversed()) {
    close();
  }
});

const prepare = (watchdogSeconds = 15) => {
  const directory = createTempRepo(teardown);

  const pending = createPending(
    "scope",
    "session",
    "build",
    0,
    directory,
    watchdogSeconds
  );

  teardown.push(() => {
    cleanup(pending);
  });

  return pending;
};

const runCapture = function runCapture(command: string, workdir: string) {
  return Bun.spawnSync(
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", command]
      : ["bash", "-c", command],
    { cwd: workdir }
  );
};

describe("private context capture", () => {
  test("captures raw NUL-delimited history with portable framing", () => {
    const pending = prepare();
    const message = "core: Preserve history\n\nA literal body.";

    expect(
      Bun.spawnSync([
        "git",
        "-C",
        pending.workdir,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        message,
      ]).exitCode
    ).toBe(0);
    const result = runCapture(pending.command, pending.workdir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("RECEIPT_OK\n");
    const baseline = importCapture(pending);

    expect(baseline.messages).toEqual([`${message}\n`]);
    expect(baseline.directory).toBe(pending.workdir);
    expect(baseline.head).toMatch(/^[0-9a-f]{40}$/u);
  });

  test.skipIf(process.platform === "win32")(
    "does not require GNU base64 or timeout",
    () => {
      const pending = prepare();

      expect(pending.command).not.toContain("base64 -w");
      expect(pending.command).not.toContain("timeout 15");
      expect(runCapture(pending.command, pending.workdir).exitCode).toBe(0);
      expect(importCapture(pending).head).toBeNull();
    }
  );

  test.skipIf(process.platform === "win32")(
    "kills the capture process group at the watchdog deadline",
    () => {
      const pending = prepare(1.5);
      const bin = join(pending.workdir, "git");

      writeFileSync(bin, "#!/bin/sh\nsleep 30\n", { mode: 0o700 });

      const started = Date.now();

      const result = Bun.spawnSync(["bash", "-c", pending.command], {
        cwd: pending.workdir,
        env: { ...process.env, PATH: `${pending.workdir}:${process.env.PATH}` },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).not.toContain("RECEIPT_OK");
      expect(Date.now() - started).toBeLessThan(5000);
      expect(() => importCapture(pending)).toThrow();
    },
    6000
  );

  test.skipIf(process.platform === "win32")(
    "rejects non-private modes on POSIX but not Windows",
    () => {
      const pending = prepare();

      expect(runCapture(pending.command, pending.workdir).exitCode).toBe(0);

      const [entry] = readdirSync(pending.directory);

      if (entry === undefined) {
        throw new Error("Missing capture artifact");
      }

      const artifact = join(pending.directory, entry);

      chmodSync(artifact, 0o644);
      expect(() => importCapture(pending)).toThrow(
        "Invalid private capture artifact"
      );
      withPlatform("win32", () => {
        expect(importCapture(pending).directory).toBe(pending.workdir);
      });
    }
  );

  test("generates a shell-neutral Windows command with a private encoded path", () => {
    withPlatform("win32", () => {
      const pending = prepare();

      expect(pending.command).toStartWith(
        "powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand "
      );
      expect(pending.command).toMatch(/-EncodedCommand [A-Za-z0-9+/=]+$/u);
      expect(pending.command.length).toBeLessThan(8191);
    });
  });

  test.skipIf(process.platform !== "win32")(
    "runs the Windows capture under each supported shell",
    () => {
      for (const executable of ["cmd.exe", "powershell", "pwsh", "bash"]) {
        const pending = prepare();

        const argsByShell = new Map([
          ["cmd.exe", ["/d", "/s", "/c"]],
          ["bash", ["-c"]],
        ]);

        const args = argsByShell.get(executable) ?? [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
        ];

        const result = Bun.spawnSync([executable, ...args, pending.command], {
          cwd: pending.workdir,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe("RECEIPT_OK\n");
        expect(importCapture(pending).directory).toBe(pending.workdir);
      }
    }
  );

  test("rejects oversized or incomplete artifacts", () => {
    const pending = prepare();

    expect(runCapture(pending.command, pending.workdir).exitCode).toBe(0);
    expect(readFileSync(pending.fd).toString()).toEndWith("END\n");
    writeFileSync(pending.fd, "x".repeat(262_145));
    expect(() => importCapture(pending)).toThrow(
      "Invalid private capture artifact"
    );
  });
});
