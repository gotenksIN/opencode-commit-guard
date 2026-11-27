import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { createTempRepo } from "../test/helpers.test-utils.js";
import { cleanup, createPending, importCapture } from "./capture.js";

const { delimiter, join } = path;

const hasPwsh = process.platform === "win32" || Bun.which("pwsh") !== null;

const teardown: (() => void)[] = [];

afterEach(() => {
  for (const close of teardown.splice(0).toReversed()) {
    close();
  }
});

const prepare = (
  watchdogSeconds = 15,
  platform: NodeJS.Platform = process.platform
) => {
  const directory = createTempRepo(teardown);

  const pending = createPending(
    "scope",
    "session",
    "build",
    0,
    directory,
    watchdogSeconds,
    platform
  );

  teardown.push(() => {
    cleanup(pending);
  });

  return pending;
};

const runCapture = (
  command: string,
  workdir: string,
  platform: NodeJS.Platform = process.platform
) =>
  Bun.spawnSync(
    platform === "win32"
      ? [
          "pwsh",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          command,
        ]
      : ["bash", "-c", command],
    { cwd: workdir }
  );

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
      expect(importCapture(pending, "win32").directory).toBe(pending.workdir);
    }
  );

  test("generates an uncompressed pwsh Windows command with a private encoded path", () => {
    const pending = prepare(15, "win32");

    expect(pending.command).toStartWith(
      "pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand "
    );
    expect(pending.command).toMatch(/-EncodedCommand [A-Za-z0-9+/=]+$/u);
    expect(pending.command.length).toBeLessThan(32_767);

    const encoded = /-EncodedCommand (?<payload>[A-Za-z0-9+/=]+)$/u.exec(
      pending.command
    )?.groups?.payload;

    const decoded = Buffer.from(encoded ?? "", "base64").toString("utf16le");

    expect(decoded).not.toContain("Invoke-Expression");
    expect(decoded).not.toContain("taskkill.exe");
    expect(decoded).toContain("$p.Kill($true)");
  });

  test.skipIf(!hasPwsh)(
    "runs the pwsh capture command and imports the artifact",
    () => {
      const pending = prepare(15, "win32");
      const message = "core: Pwsh capture\n\nCaptured via pwsh.";

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

      const result = runCapture(pending.command, pending.workdir, "win32");

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("RECEIPT_OK\n");
      const baseline = importCapture(pending, "win32");

      expect(baseline.directory).toBe(pending.workdir);
      expect(baseline.messages).toEqual([`${message}\n`]);
    },
    10_000
  );

  test.skipIf(!hasPwsh)(
    "enforces watchdogSeconds in the pwsh capture command",
    () => {
      const pending = prepare(1.5, "win32");
      const startedMarker = join(pending.workdir, "started.marker");

      if (process.platform === "win32") {
        const stubScript = join(pending.workdir, "slow-git.ts");

        writeFileSync(
          stubScript,
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(startedMarker)}, "1"); await Bun.sleep(30_000);`
        );
        expect(
          Bun.spawnSync([
            process.execPath,
            "build",
            "--compile",
            stubScript,
            "--outfile",
            join(pending.workdir, "git.exe"),
          ]).exitCode
        ).toBe(0);
      } else {
        writeFileSync(
          join(pending.workdir, "git"),
          "#!/bin/sh\ntouch started.marker\nsleep 30\n",
          { mode: 0o700 }
        );
      }

      const started = Date.now();

      const result = Bun.spawnSync(
        [
          "pwsh",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          pending.command,
        ],
        {
          cwd: pending.workdir,
          env: {
            ...process.env,
            PATH: `${pending.workdir}${delimiter}${process.env.PATH}`,
          },
        }
      );

      expect(existsSync(startedMarker)).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).not.toContain("RECEIPT_OK");
      expect(Date.now() - started).toBeLessThan(6000);
      expect(() => importCapture(pending, "win32")).toThrow();
    },
    10_000
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
