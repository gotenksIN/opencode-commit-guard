import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { Tool } from "@opencode/plugin/effect";
import { Effect } from "effect";

import { resolveTargetWorkdir } from "../src/capture.js";
import { parseConfig } from "../src/config.js";
import type { JsonValue } from "../src/types.js";
import { isJSONString, isRecord } from "../src/types.js";
import { createTempRepo, expectRejects, withFakeNow } from "./helpers.js";
import { createHost } from "./host.js";
import type { Host, HostOptions } from "./host.js";

const { join } = path;

const timeout = 30_000;

const frozen = "Frozen commit baseline";

const publicationGuidance =
  'Commit after the shell result reports "Frozen commit baseline"; otherwise call commit_context again';

const unverified = "shell result lacks verified foreground completion metadata";

interface Fixture {
  readonly repo: (signing?: string, parent?: string) => string;
  readonly temp: (prefix: string) => string;
  readonly host: (options: HostOptions) => Promise<Host>;
}

const withFixture = async (
  run: (fixture: Fixture) => Promise<void>
): Promise<void> => {
  const teardown: (() => void)[] = [];
  const hosts: Host[] = [];

  try {
    await run({
      repo: (signing, parent) => createTempRepo(teardown, signing, parent),
      temp: (prefix) => {
        const directory = mkdtempSync(join(tmpdir(), prefix));

        teardown.push(() => {
          rmSync(directory, { recursive: true, force: true });
        });

        return directory;
      },
      host: async (options) => {
        const host = await createHost(options);

        hosts.push(host);

        return host;
      },
    });
  } finally {
    await Promise.allSettled(
      hosts.map(async (host) => {
        await host.close();
      })
    );

    for (const close of teardown.toReversed()) {
      close();
    }
  }
};

const scenario =
  (run: (fixture: Fixture) => Promise<void>) => async (): Promise<void> => {
    await withFixture(run);
  };

type Result = Awaited<ReturnType<Host["execute"]>>;

const text = (result: Result): string =>
  result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

const context = async (
  host: Host,
  input: Record<string, JsonValue> = {}
): Promise<string> => text(await host.execute("commit_context", input));

const commandOf = (instructions: string): string =>
  instructions.split("\n").slice(1).join("\n");

/** Extracts the private artifact path from a POSIX or Windows capture command. */
const artifactOf = (command: string): string => {
  const posix = / '(?<artifact>[^']+)' 2>\/dev\/null$/u.exec(command)?.groups
    ?.artifact;

  if (posix !== undefined) {
    return posix;
  }

  const encoded = /-EncodedCommand (?<encoded>[A-Za-z0-9+/=]+)$/u.exec(command)
    ?.groups?.encoded;

  const compressed = /FromBase64String\('(?<compressed>[^']+)'\)\)/u.exec(
    Buffer.from(encoded ?? "", "base64").toString("utf16le")
  )?.groups?.compressed;

  const encodedPath = /\$path = .*FromBase64String\('(?<path>[^']+)'\)/u.exec(
    gunzipSync(Buffer.from(compressed ?? "", "base64")).toString()
  )?.groups?.path;

  if (encodedPath === undefined) {
    throw new Error("Missing capture artifact path");
  }

  return Buffer.from(encodedPath, "base64").toString();
};

const shell = async (
  host: Host,
  command: string,
  workdir?: string,
  extra: Record<string, JsonValue> = {}
): Promise<Result> =>
  await host.execute(
    "shell",
    workdir === undefined
      ? { ...extra, command }
      : { ...extra, command, workdir }
  );

const capture = async (
  host: Host,
  workdir: string,
  input: Record<string, JsonValue> = {},
  extra: Record<string, JsonValue> = {}
): Promise<Result> =>
  await shell(host, commandOf(await context(host, input)), workdir, extra);

const rejects = async (
  promise: Promise<unknown>,
  expected: string | RegExp
): Promise<Error> => {
  const error = await expectRejects(promise, expected);

  expect(error).toBeInstanceOf(Tool.Error);

  return error;
};

const toolError = (outcome: PromiseSettledResult<Result>): Tool.Error => {
  if (
    outcome.status === "fulfilled" ||
    !(outcome.reason instanceof Tool.Error)
  ) {
    throw new Error("Expected an independent tool error");
  }

  return outcome.reason;
};

const invalidContextInputs: JsonValue[] = [
  null,
  [],
  { workdir: 1 },
  { directory: false },
  { refresh: "true" },
];

const invalidShellInputs: JsonValue[] = [
  null,
  [],
  "git status",
  { command: 1 },
  { command: "git status", workdir: 1 },
  { command: "git status", background: "false" },
];

const failureNote = (reason: string): string =>
  `[commit-guard] This capture did not publish a usable baseline: ${reason}.\n` +
  "RECEIPT_OK alone does not authorize a commit.\nCall commit_context with the same workdir for status and next steps.";

/** Holds a matching shell call after the guard claims it, until released. */
const holdShell = async (host: Host, command: string) => {
  const reached = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();

  await host.hook("execute.before", (event) =>
    isRecord(event.input) && event.input.command === command
      ? Effect.promise(async () => {
          reached.resolve(undefined);
          await released.promise;
        })
      : Effect.void
  );

  return {
    reached: reached.promise,
    release: () => {
      released.resolve(undefined);
    },
  };
};

/** Returns the JSON text of an execute script's return value. */
const scriptOutput = (result: Result): string => {
  const output: unknown = result.output;

  if (!isRecord(output) || !isJSONString(output.output)) {
    throw new Error("Expected Code Mode output");
  }

  return output.output;
};

describe("normal mode capture", () => {
  test(
    "publishes a frozen baseline from a verified real shell result",
    scenario(async ({ repo, host: start }) => {
      const directory = repo("true");

      const host = await start({
        directory,
        options: { allowedScopes: ["core"] },
      });

      const result = await capture(host, directory);
      const guidance = await context(host);

      expect(result.metadata).toEqual({
        status: "completed",
        truncated: false,
        exit: 0,
      });
      expect(isRecord(result.output) && Object.keys(result.output)).toEqual([
        "exitCode",
        "wallTimeSeconds",
        "output",
      ]);
      expect(guidance).toStartWith(
        `[commit-guard] ${frozen} for ${directory}.`
      );
      expect(guidance).toContain("Configured scope allowlist: core.");
      expect(guidance).toContain("Add -s or --signoff.");
      expect(guidance).toContain("A second commit_context call is optional.");
      expect(result.content).toEqual([
        { type: "text", text: "RECEIPT_OK\n" },
        { type: "text", text: guidance },
      ]);
      expect(isRecord(result.output) && result.output.output).toBe(
        `RECEIPT_OK\n\n\n${guidance}`
      );

      const [valid, scope, signoff] = await Promise.allSettled([
        shell(host, "git commit -s -m 'core: Inline capture'", directory),
        shell(host, 'git commit -s -m "invalid scope"', directory),
        shell(host, 'git commit -m "core: missing signoff"', directory),
      ]);

      expect(valid.status).toBe("fulfilled");
      expect(toolError(scope).message).toContain(
        "Missing scope in subject line"
      );
      expect(toolError(signoff).message).toContain("Missing commit signoff");
      expect(toolError(signoff).message).not.toContain("Missing scope");
    }),
    timeout
  );

  test.each([
    ["true", "Add -s or --signoff."],
    [
      "false",
      "Signoff is not required; add it only if repository instructions require it.",
    ],
    [
      undefined,
      "Effective commit.gpgsign: unset. Signoff is not required; add it only if repository instructions require it.",
    ],
  ])(
    "derives signoff policy from commit.gpgsign %p",
    async (signing, expected) => {
      await withFixture(async ({ repo, host: start }) => {
        const directory = repo(signing);
        const host = await start({ directory });

        await capture(host, directory);
        const guidance = await context(host);

        expect(guidance).toContain(expected);
        expect(guidance).toContain("Signoff is not a cryptographic signature.");

        const unsigned = shell(
          host,
          'git commit --allow-empty -m "kernel: add foo without signoff"',
          directory
        );

        if (signing === "true") {
          await rejects(unsigned, "Missing commit signoff");
          // Without a signing key, Git itself cannot finish a signed commit.
          await shell(host, 'git commit -s -m "kernel: add foo"', directory);

          return;
        }

        const committed = await unsigned;

        expect(committed.metadata?.exit).toBe(0);
        expect(
          Bun.spawnSync(["git", "-C", directory, "log", "-1", "--format=%s"])
            .stdout.toString()
            .trim()
        ).toBe("kernel: add foo without signoff");
      });
    },
    timeout
  );

  test(
    "reports a missing baseline before message format and permits help",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });
      const commit = shell(host, "git commit -m bad", directory);

      const error = await rejects(
        commit,
        `No published baseline for ${directory}`
      );

      expect(error.message).toContain(publicationGuidance);
      expect(error.message).toContain(
        "in the foreground with that workdir (do not run it in the background)"
      );
      expect(error.message).not.toContain("background:false");
      await shell(host, "git commit -h", directory);
      await shell(host, "git commit --help >/dev/null 2>&1 || true", directory);
    }),
    timeout
  );

  test(
    "reports unclaimed, claimed, failed, and reloaded capture status",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });
      const instructions = await context(host);
      const command = commandOf(instructions);

      expect(instructions).toContain(
        `immediately, unchanged, in the foreground with workdir ${directory} (do not run it in the background).`
      );
      expect(instructions).not.toContain("background:false");
      expect(instructions).toContain(
        "Do not wrap it or chain another command onto it."
      );
      expect(instructions).toContain(publicationGuidance);
      await rejects(
        shell(host, `${command} `, directory),
        "Pre-execution shell inspection failed"
      );
      expect(await context(host)).toContain("still pending and unclaimed");
      expect(await context(host)).toContain(
        "RECEIPT_OK confirms only that the artifact was written"
      );

      const held = await holdShell(host, command);
      const running = shell(host, command, directory, { timeout: 1 });

      await held.reached;
      expect(await context(host)).toContain("Capture claimed");

      const unrelated = await shell(host, "git status --short", directory);

      expect(text(unrelated)).not.toContain("[commit-guard]");
      held.release();
      expect(text(await running)).toContain(failureNote(unverified));
      await host.unload();
      await host.reload();
      expect(await context(host)).toStartWith(
        `The previous capture failed: ${unverified}. Run this shell command`
      );
    }),
    timeout
  );

  test(
    "rejects a corrupt reference instead of capturing an unborn HEAD",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });

      await capture(host, directory);
      expect(await context(host)).toContain(frozen);
      await shell(
        host,
        'git commit -s -m "kernel: valid unborn checkout"',
        directory
      );

      const branch = Bun.spawnSync([
        "git",
        "-C",
        directory,
        "symbolic-ref",
        "--short",
        "HEAD",
      ]);

      writeFileSync(
        join(
          directory,
          ".git",
          "refs",
          "heads",
          branch.stdout.toString().trim()
        ),
        `${"f".repeat(40)}\n`
      );

      const result = await capture(host, directory, { refresh: true });

      expect(result.metadata?.status).toBe("completed");
      expect(result.metadata?.exit).not.toBe(0);
      expect(text(result)).not.toContain("RECEIPT_OK\n");
      expect(text(result)).toContain(failureNote(unverified));
      await rejects(
        shell(
          host,
          'git commit -s -m "kernel: reject corrupt HEAD"',
          directory
        ),
        "Call commit_context"
      );
    }),
    timeout
  );
});

describe("capture failure paths", () => {
  test(
    "rejects a foreground timeout that moved to the background",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });
      const result = await capture(host, directory, {}, { timeout: 1 });

      expect(result.metadata?.status).toBe("running");
      expect(result.metadata?.shellID).toBeString();
      expect(text(result)).toContain(failureNote(unverified));
      expect(await context(host)).toContain(
        `previous capture failed: ${unverified}`
      );
      await rejects(
        shell(host, "git commit -s -m 'core: Subject'", directory),
        "No published baseline"
      );
    }),
    timeout
  );

  test(
    "rejects truncated shell output",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory, maxOutputBytes: 4 });
      const result = await capture(host, directory);

      expect(result.metadata).toEqual({
        status: "completed",
        truncated: true,
        exit: 0,
      });
      expect(text(result)).toContain(failureNote(unverified));
      await rejects(
        shell(host, "git commit -s -m 'core: Subject'", directory),
        "No published baseline"
      );
    }),
    timeout
  );

  test.each([
    {
      name: "killed metadata without an exit code",
      metadata: { status: "completed", truncated: false, killed: true },
    },
    {
      name: "an unexpected metadata key",
      metadata: { status: "completed", truncated: false, exit: 0, extra: 1 },
    },
  ])(
    "rejects $name",
    async ({ metadata }) => {
      await withFixture(async ({ repo, host: start }) => {
        const directory = repo();

        const host = await start({
          directory,
          // Rewrites the real result, for example into the worker-restart
          // variant, before the guard's execute.after hook observes it.
          setup: (ctx) =>
            ctx.tool.hook("execute.after", (event) =>
              Effect.sync(() => {
                if (event.status === "completed") {
                  event.result = { ...event.result, metadata };
                }
              })
            ),
        });

        const result = await capture(host, directory);

        expect(result.metadata).toEqual(metadata);
        expect(text(result)).toContain(failureNote(unverified));
        await rejects(
          shell(host, "git commit -s -m 'core: Subject'", directory),
          "No published baseline"
        );
      });
    },
    timeout
  );

  test(
    "appends capture failure guidance to a permission denial",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });

      host.deny("shell");

      const error = await rejects(
        capture(host, directory),
        "shell result did not complete successfully"
      );

      expect(error.message).toContain(
        `\n\n${failureNote("shell result did not complete successfully")}`
      );
      expect(error.message).not.toStartWith("[commit-guard]");
      expect(await context(host)).toContain(
        "previous capture failed: shell result did not complete successfully"
      );
    }),
    timeout
  );

  test(
    "requires the END sentinel after verified metadata",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      let issued = "";

      const host = await start({
        directory,
        // A host shell wrapper that skips the capture leaves no artifact.
        setup: (ctx) =>
          ctx.shell.hook("create.before", (event) =>
            Effect.sync(() => {
              if (event.command === issued) {
                event.command = "echo RECEIPT_OK";
              }
            })
          ),
      });

      issued = commandOf(await context(host));
      const result = await shell(host, issued, directory);

      expect(result.metadata).toEqual({
        status: "completed",
        truncated: false,
        exit: 0,
      });
      expect(text(result)).toContain(
        failureNote("private artifact is invalid or incomplete (END required)")
      );
    }),
    timeout
  );

  test(
    "reports failed baseline storage on the next context call",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });
      const command = commandOf(await context(host));

      host.failStorage();

      const result = await shell(host, command, directory);

      expect(text(result)).toContain(
        failureNote("capture storage failed or its counter changed")
      );
      expect(await context(host)).toContain(
        "previous capture failed: capture storage failed or its counter changed"
      );
    }),
    timeout
  );

  test(
    "explains invalid signing config without repeating capture",
    scenario(async ({ repo, host: start }) => {
      const directory = repo("invalid_bool");
      const host = await start({ directory });
      const result = await capture(host, directory);
      const message = await context(host);

      expect(message).toContain("Git could not read commit.gpgsign as valid");
      expect(message).toContain(
        "git config --show-origin --get-all commit.gpgsign"
      );
      expect(message).toContain("without changing the intended signing policy");
      expect(message).not.toContain("Run this shell command");
      expect(message).not.toContain(frozen);
      expect(result.content).toEqual([
        { type: "text", text: "RECEIPT_OK\n" },
        { type: "text", text: message },
      ]);
      await rejects(
        shell(host, "git commit -m bad", directory),
        "Repeating the capture will not fix it"
      );
    }),
    timeout
  );
});

describe("downstream execute.before hooks", () => {
  test(
    "rejects a claimed capture whose command a later hook modified",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });
      const command = commandOf(await context(host));

      await host.hook("execute.before", (event) =>
        Effect.sync(() => {
          if (isRecord(event.input) && event.input.command === command) {
            event.input = { ...event.input, command: "printf 'RECEIPT_OK\\n'" };
          }
        })
      );

      const reason = "claimed capture command was modified before execution";
      const result = await shell(host, command, directory);

      expect(text(result)).toContain(failureNote(reason));
      expect(existsSync(artifactOf(command))).toBe(false);
      expect(await context(host)).toContain(
        `previous capture failed: ${reason}`
      );
    }),
    timeout
  );

  test(
    "releases a claimed capture that a later hook renamed away from shell",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });
      const command = commandOf(await context(host));

      await host.hook("execute.before", (event) =>
        Effect.sync(() => {
          if (isRecord(event.input) && event.input.command === command) {
            event.tool = "commit_context";
          }
        })
      );

      const result = await shell(host, command, directory);

      expect(text(result)).not.toContain("[commit-guard]");
      expect(existsSync(artifactOf(command))).toBe(false);
      expect(await context(host)).toContain(
        "previous capture failed: claimed capture tool was renamed away from shell"
      );
    }),
    timeout
  );
});

describe("repository flows", () => {
  test(
    "shares the baseline and refresh across root and subdirectory",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const subdirectory = join(directory, "sub");

      mkdirSync(subdirectory);
      const host = await start({ directory });

      await capture(host, subdirectory, { workdir: "sub" });
      await shell(host, "git commit -s -m 'core: Root'", directory);
      expect(await context(host, { workdir: "sub" })).toContain(frozen);
      await context(host, { refresh: true, workdir: directory });
      await rejects(
        shell(host, "git commit -s -m 'core: Sub'", subdirectory),
        "No published baseline"
      );
      await capture(host, directory);
      await shell(host, "git commit -s -m 'core: Sub'", subdirectory);
      await context(host, { refresh: true, workdir: "sub" });
      await rejects(
        shell(host, "git commit -s -m 'core: Root'", directory),
        "No published baseline"
      );
    }),
    timeout
  );

  test(
    "canonicalizes symlink workdirs",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const target = join(directory, "sub");
      const linked = join(directory, "linked");

      mkdirSync(target);
      symlinkSync(target, linked, "junction");
      const host = await start({ directory });

      await capture(host, linked, { directory: "linked" });
      await shell(host, "git commit -s -m 'core: Symlink'", linked);
      expect(await context(host, { workdir: "sub" })).toContain(frozen);
      await rejects(
        shell(
          host,
          "git commit -s -m 'core: Missing'",
          join(directory, "absent")
        ),
        "[commit-guard] Cannot access the shell workdir"
      );
    }),
    timeout
  );

  test.each(invalidContextInputs.map((input) => ({ input })))(
    "rejects invalid commit_context input $input",
    async ({ input }) => {
      await withFixture(async ({ repo, host: start }) => {
        const host = await start({ directory: repo() });

        await rejects(
          host.execute("commit_context", input),
          'Invalid arguments for tool "commit_context"'
        );
      });
    },
    timeout
  );

  test(
    "discovers subrepositories and remembers explicit targets outside a repository",
    scenario(async ({ repo, temp, host: start }) => {
      const base = temp("commit-guard-discovery-");

      expect(resolveTargetWorkdir(base).error).toContain(
        "No Git repository found"
      );
      expect(resolveTargetWorkdir(base, "absent").error).toContain(
        "does not exist"
      );
      writeFileSync(join(base, "file"), "");
      expect(resolveTargetWorkdir(base, "file").error).toContain(
        "not a directory"
      );
      expect(resolveTargetWorkdir(base, ".").error).toContain(
        "not a Git repository"
      );
      const first = repo(undefined, base);

      expect(resolveTargetWorkdir(base).workdir).toBe(first);
      const host = await start({ directory: base });

      await capture(host, first, { directory: first });
      const second = repo(undefined, base);

      expect(resolveTargetWorkdir(base).error).toContain(
        "Multiple Git repositories"
      );
      expect(await context(host)).toContain(`${frozen} for ${first}`);
      await capture(host, second, { workdir: second, refresh: true });
      await host.move(first);
      expect(await context(host)).toContain(`${frozen} for ${first}`);
      await host.move(base);
      expect(await context(host)).toContain(`${frozen} for ${first}`);
    }),
    timeout
  );

  test.each(["remote", "mismatch"])(
    "rejects %s workspace captures and commits",
    async (workspace) => {
      await withFixture(async ({ repo, host: start }) => {
        const directory = repo();

        const host = await start(
          workspace === "remote"
            ? { directory, workspace: "wrk_remote" }
            : { directory, sessionWorkspace: "wrk_remote" }
        );

        expect(await context(host)).toBe(
          "Commit context capture is unavailable for remote workspaces."
        );
        await rejects(
          shell(host, "git commit -s -m 'core: Subject'", directory),
          workspace === "remote"
            ? "Remote workspace commits cannot use local commit context"
            : "Commit target is ambiguous"
        );
      });
    },
    timeout
  );

  test(
    "rejects commands that target another repository",
    scenario(async ({ repo, host: start }) => {
      const directory = repo("false");
      const host = await start({ directory });

      await capture(host, directory);
      await rejects(
        shell(
          host,
          'git -C elsewhere commit -m "kernel: wrong target"',
          directory
        ),
        "Commit target is ambiguous"
      );
      await rejects(
        shell(
          host,
          "export GIT_DIR=/other/.git; git commit -m 'kernel: wrong target'",
          directory
        ),
        "Commit target is ambiguous"
      );
    }),
    timeout
  );
});

describe("plugin lifecycle", () => {
  test(
    "keeps a published baseline across plugin unload and reload",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });

      await capture(host, directory);
      await host.unload();
      await host.reload();
      expect(await context(host)).toContain(frozen);
      await shell(host, "git commit -s -m 'core: Reloaded'", directory);
    }),
    timeout
  );

  test.each([
    ["complete", true],
    ["unload", true],
    ["complete", false],
  ])(
    "a stale %s with refresh %p does not invalidate a later baseline",
    async (finish, refresh) => {
      await withFixture(async ({ repo, temp, host: start }) => {
        const directory = repo();
        const database = join(temp("commit-guard-database-"), "opencode.db");
        const stale = await start({ directory, database });
        const oldCommand = commandOf(await context(stale));
        const held = await holdShell(stale, oldCommand);
        const running = shell(stale, oldCommand, directory);

        await held.reached;

        const current = await start({
          directory,
          database,
          sessionID: stale.session,
        });

        await capture(current, directory, { refresh });

        if (finish === "unload") {
          await stale.unload();
        }

        held.release();
        await running;
        expect(existsSync(artifactOf(oldCommand))).toBe(false);
        expect(await context(current)).toContain(frozen);
        await shell(current, "git commit -s -m 'core: Current'", directory);
      });
    },
    timeout
  );

  test(
    "inspects non-commit shell commands without a session lookup",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });

      await capture(host, directory);
      await host.removeSession();
      await shell(host, "git status --short", directory);
      await shell(host, "git commit --help >/dev/null 2>&1 || true", directory);
      await rejects(
        shell(host, "git commit -s -m 'core: Check lookup'", directory),
        /^/u
      );
    }),
    timeout
  );
});

describe("tool pass-through", () => {
  test(
    "ignores non-shell tools and validates bash tool commits",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });

      await capture(host, directory);
      await rejects(
        host.execute("write", {
          path: "file.txt",
          content: "git commit invalid",
        }),
        'No tool named "write"'
      );
      await rejects(
        host.execute("bash", {
          command: 'git commit -sm "feat(parser): add subshell support"',
        }),
        'No tool named "bash"'
      );
      await rejects(
        host.execute("bash", { command: 'git commit -s -m "invalid"' }),
        "Missing scope in subject line"
      );
    }),
    timeout
  );

  test.each(invalidShellInputs.map((input) => ({ input })))(
    "rejects non-literal shell input $input",
    async ({ input }) => {
      await withFixture(async ({ repo, host: start }) => {
        const host = await start({ directory: repo() });

        await rejects(host.execute("shell", input), "[commit-guard]");
      });
    },
    timeout
  );

  test(
    "rejects invalid commit formats before execution",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });

      await capture(host, directory);
      await rejects(
        shell(host, 'git commit -m "Missing scope entirely" -s', directory),
        "Missing scope in subject line"
      );
      await rejects(
        shell(host, 'git com""mit -m "Missing scope entirely" -s', directory),
        "Missing scope in subject line"
      );
    }),
    timeout
  );
});

describe("full Code Mode", () => {
  test(
    "captures and validates commits inside one execute script",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory, codemode: true });
      const workdir = JSON.stringify(directory);

      const result = scriptOutput(
        await host.execute("execute", {
          code: [
            `const text = await tools.commit_context({ workdir: ${workdir} });`,
            'const command = text.split("\\n").slice(1).join("\\n");',
            `return await tools.shell({ command, workdir: ${workdir} });`,
          ].join("\n"),
        })
      );

      expect(result).toStartWith('{"exitCode":0,');
      expect(result).toContain(
        JSON.stringify(`[commit-guard] ${frozen} for ${directory}.`).slice(
          1,
          -1
        )
      );

      const rejected = await host.execute("execute", {
        code: `return await tools.shell({ command: "git commit -m bad", workdir: ${workdir} });`,
      });

      expect(text(rejected)).toContain("Missing scope in subject line");
      expect(isRecord(rejected.output) && rejected.output.error).toBe(true);

      const accepted = await host.execute("execute", {
        code: `return await tools.shell({ command: 'git commit --allow-empty -m "core: Valid"', workdir: ${workdir} });`,
      });

      expect(scriptOutput(accepted)).toStartWith('{"exitCode":0,');
    }),
    timeout
  );

  test(
    "captures two repositories in parallel calls of one script",
    scenario(async ({ repo, temp, host: start }) => {
      const base = temp("commit-guard-parallel-");
      const first = repo(undefined, base);
      const second = repo(undefined, base);
      const host = await start({ directory: base, codemode: true });

      const result = scriptOutput(
        await host.execute("execute", {
          code: [
            `return await Promise.all(${JSON.stringify([first, second])}.map(async (workdir) => {`,
            "  const text = await tools.commit_context({ workdir });",
            '  const command = text.split("\\n").slice(1).join("\\n");',
            "  return (await tools.shell({ command, workdir })).output;",
            "}));",
          ].join("\n"),
        })
      );

      const firstBaseline = result.indexOf(`${frozen} for ${first}.`);
      const secondBaseline = result.indexOf(`${frozen} for ${second}.`);

      expect(result).toStartWith('["RECEIPT_OK');
      expect(firstBaseline).toBeGreaterThan(0);
      expect(secondBaseline).toBeGreaterThan(firstBaseline);
      await Array.fromAsync([first, second], async (workdir) => {
        await shell(host, "git commit -m 'core: Parallel'", workdir);
        await rejects(
          shell(host, "git commit -m 'Parallel'", workdir),
          "Missing scope in subject line"
        );
      });
    }),
    timeout
  );

  test(
    "publishes a top-level call to the Code Mode shell",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory, codemode: true });
      const result = await capture(host, directory);

      expect(result.metadata).toEqual({
        status: "completed",
        truncated: false,
        exit: 0,
      });
      expect(text(result)).toContain(`[commit-guard] ${frozen}`);
    }),
    timeout
  );
});

describe("fake clock boundaries", () => {
  test.serial(
    "sweeps abandoned unclaimed artifacts and keeps claimed artifacts",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });

      await withFakeNow(async (advance) => {
        const artifact = artifactOf(commandOf(await context(host)));

        expect(existsSync(artifact)).toBe(true);
        advance(21_000);
        await shell(host, "git status --short", directory);
        expect(existsSync(artifact)).toBe(false);
        expect(await context(host)).toContain(
          "previous capture expired before its command was claimed"
        );

        const command = commandOf(await context(host, { refresh: true }));
        const held = await holdShell(host, command);
        const running = shell(host, command, directory);

        await held.reached;
        advance(60_000);
        await shell(host, "git status --short", directory);
        expect(existsSync(artifactOf(command))).toBe(true);
        held.release();
        expect(text(await running)).toContain(frozen);
      });
    }),
    timeout
  );

  test.serial(
    "keeps a claimed capture alive while approval is slow",
    scenario(async ({ repo, host: start }) => {
      const directory = repo();
      const host = await start({ directory });

      await withFakeNow(async (advance) => {
        const command = commandOf(await context(host));

        await host.hook("execute.before", (event) =>
          Effect.sync(() => {
            if (isRecord(event.input) && event.input.command === command) {
              advance(45_000);
            }
          })
        );

        expect(text(await shell(host, command, directory))).toContain(frozen);
        await shell(host, 'git commit -s -m "kernel: approved"', directory);
      });
    }),
    timeout
  );
});

describe("configuration", () => {
  test.each([null, [], false, "options", 1].map((options) => ({ options })))(
    "rejects non-object configuration: %j",
    ({ options }) => {
      expect(() => parseConfig(options)).toThrow("expected an object");
    }
  );

  test("normalizes empty allowlists and rejects unknown keys", () => {
    expect(parseConfig(undefined).allowedScopes).toBeUndefined();
    expect(parseConfig({ allowedScopes: [] }).allowedScopes).toBeUndefined();
    expect(parseConfig({ allowedScopes: [" core "] }).allowedScopes).toEqual([
      "core",
    ]);
    const emptyOptions: Record<string, JsonValue> = {};

    Object.setPrototypeOf(emptyOptions, null);
    expect(parseConfig(emptyOptions).requireScope).toBe(true);

    for (const options of [
      { typo: true },
      { allowedScopes: [""] },
      { allowedScopes: [1] },
      { maxLineLength: 1.5 },
      { maxLineLength: Number.NaN },
    ]) {
      expect(() => parseConfig(options)).toThrow();
    }

    expect(() => parseConfig({ typo: true })).toThrow(
      "Valid options: requireScope, allowedScopes, maxLineLength"
    );
  });

  test("rejects impossible allowed scopes", () => {
    for (const scope of [
      "bad scope",
      "foo@bar",
      "core:",
      "core: Subject",
      "feat()",
      "(core)",
    ]) {
      expect(() => parseConfig({ allowedScopes: [scope] })).toThrow(
        `scope ${JSON.stringify(scope)} cannot match`
      );
    }

    expect(
      parseConfig({
        allowedScopes: ["core", "feat(core)", "foo/bar", "build-tools"],
      }).allowedScopes
    ).toEqual(["core", "feat(core)", "foo/bar", "build-tools"]);
  });

  test.each([
    [
      { requireScope: "invalid" },
      "Invalid plugin option requireScope; expected a boolean.",
    ],
    [
      { allowedScopes: "not-an-array" },
      "Invalid plugin option allowedScopes; expected an array of non-empty strings.",
    ],
    [
      { maxLineLength: -5 },
      "Invalid plugin option maxLineLength; expected an integer greater than or equal to 0.",
    ],
    [{ requireSignoff: true }, "Plugin option requireSignoff has been removed"],
    [
      { typo: true },
      "Valid options: requireScope, allowedScopes, maxLineLength",
    ],
  ])(
    "rejects plugin options %j during host setup",
    async (options, expected) => {
      await withFixture(async ({ repo, host: start }) => {
        await expectRejects(start({ directory: repo(), options }), expected);
      });
    },
    timeout
  );

  test(
    "applies allowedScopes, maxLineLength, and requireScope overrides",
    scenario(async ({ repo, host: start }) => {
      const directory = repo("true");

      const scoped = await start({
        directory,
        options: { allowedScopes: ["kernel", "releasetools"] },
      });

      await capture(scoped, directory);
      await shell(scoped, 'git commit -s -m "kernel: fix race"', directory);
      await rejects(
        shell(scoped, 'git commit -s -m "ui: update colors"', directory),
        'Scope "ui" is not in the allowed scopes list'
      );

      const long = await start({ directory, options: { maxLineLength: 100 } });
      const eighty = `kernel: ${"a".repeat(75)}`;

      await capture(long, directory);
      await shell(long, `git commit -s -m "${eighty}"`, directory);

      const free = await start({ directory, options: { requireScope: false } });

      await capture(free, directory);
      await shell(
        free,
        'git commit -s -m "Freeform commit title without scope"',
        directory
      );
    }),
    timeout
  );
});
