import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const createTempRepo = (
  teardown: (() => void)[],
  signing?: string,
  parent = tmpdir()
) => {
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

export const expectThrows = (run: () => void, expected?: string | RegExp) => {
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
) => {
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
