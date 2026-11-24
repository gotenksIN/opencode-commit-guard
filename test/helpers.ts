import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const createTempRepo = (
  teardown: (() => void)[],
  signing?: string,
  parent = tmpdir()
): string => {
  const directory = mkdtempSync(path.join(parent, "commit-guard-fixture-"));

  teardown.push(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  expect(
    Bun.spawnSync(["git", "init", "-q", "--template=", directory]).exitCode
  ).toBe(0);

  if (signing !== undefined) {
    expect(
      Bun.spawnSync([
        "git",
        "-C",
        directory,
        "config",
        "commit.gpgsign",
        signing,
      ]).exitCode
    ).toBe(0);
  }

  return directory;
};

export const withPlatform = <T>(platform: string, run: () => T): T => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");

  if (descriptor === undefined) {
    throw new Error("Missing platform descriptor");
  }

  try {
    Object.defineProperty(process, "platform", { value: platform });

    return run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
};

export const expectThrows = (
  run: () => void,
  expected?: string | RegExp
): Error => {
  let caught: Error | undefined;

  try {
    run();
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);

  if (caught === undefined) {
    throw new Error("Expected rejection");
  }

  if (expected !== undefined) {
    expect(caught.message).toMatch(expected);
  }

  return caught;
};

export const expectRejects = async <T>(
  promise: Promise<T>,
  expected: string | RegExp
): Promise<Error> => {
  let caught: Error | undefined;

  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    caught = error;
  }

  return expectThrows(() => {
    if (caught !== undefined) {
      throw caught;
    }
  }, expected);
};

/** Patches the global `Date.now`; run callers with `test.serial`. */
export const withFakeNow = async (
  run: (advance: (milliseconds: number) => void) => Promise<void>
): Promise<void> => {
  const original = Date.now;
  let clock = original();
  Date.now = () => clock;

  try {
    await run((milliseconds) => {
      clock += milliseconds;
    });
  } finally {
    Date.now = original;
  }
};
