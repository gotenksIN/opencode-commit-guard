import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Agent, Location, Tool } from "@opencode/plugin/effect";
import type { Plugin } from "@opencode/plugin/effect";
import { DateTime, Effect, Exit, Schema, Scope, Stream } from "effect";

import plugin from "../index.js";
import { parseConfig } from "../src/config.js";
import type { JsonValue } from "../src/types.js";
import { isJSONString, isRecord } from "../src/types.js";

const { join } = path;

type HookEvent = Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0];

interface HookEvents {
  "execute.before": Exclude<HookEvent, { status: string }>;
  "execute.after": Extract<HookEvent, { status: string }>;
}

interface HookFailures {
  "execute.before": Tool.Error;
  "execute.after": never;
}

const unused = (method: string) => () => Effect.die(`unused ${method}`);

const unusedDomains = {
  app: { name: "test", version: "test", channel: "test" },
  agent: {
    get: unused("agent.get"),
    list: unused("agent.list"),
    transform: unused("agent.transform"),
    reload: unused("agent.reload"),
  },
  aisdk: { hook: unused("aisdk.hook") },
  command: {
    list: unused("command.list"),
    transform: unused("command.transform"),
    reload: unused("command.reload"),
  },
  credential: { activate: unused("credential.activate") },
  event: {
    subscribe: () => Stream.fromEffect(Effect.die("unused event.subscribe")),
  },
  experimental: {
    terminal: { read: unused("experimental.terminal.read") },
    generate: {
      text: unused("experimental.generate.text"),
      image: unused("experimental.generate.image"),
      decisions: unused("experimental.generate.decisions"),
    },
    artifact: {
      transform: unused("experimental.artifact.transform"),
      reload: unused("experimental.artifact.reload"),
    },
  },
  generate: { text: unused("generate.text") },
  integration: {
    list: unused("integration.list"),
    get: unused("integration.get"),
    transform: unused("integration.transform"),
    reload: unused("integration.reload"),
    connect: {
      key: unused("integration.connect.key"),
      external: unused("integration.connect.external"),
    },
    oauth: {
      connect: unused("integration.oauth.connect"),
      status: unused("integration.oauth.status"),
      complete: unused("integration.oauth.complete"),
      cancel: unused("integration.oauth.cancel"),
    },
    command: {
      connect: unused("integration.command.connect"),
      status: unused("integration.command.status"),
      cancel: unused("integration.command.cancel"),
    },
    connection: {
      active: unused("integration.connection.active"),
      resolve: unused("integration.connection.resolve"),
      status: unused("integration.connection.status"),
    },
  },
  mcp: {
    list: unused("mcp.list"),
    transform: unused("mcp.transform"),
    reload: unused("mcp.reload"),
  },
  model: {
    list: unused("model.list"),
    default: unused("model.default"),
    transform: unused("model.transform"),
    reload: unused("model.reload"),
  },
  permission: {
    list: unused("permission.list"),
    get: unused("permission.get"),
    reply: unused("permission.reply"),
    hook: unused("permission.hook"),
    assert: unused("permission.assert"),
  },
  plugin: { list: unused("plugin.list") },
  provider: {
    list: unused("provider.list"),
    get: unused("provider.get"),
    transform: unused("provider.transform"),
    reload: unused("provider.reload"),
  },
  reference: {
    list: unused("reference.list"),
    transform: unused("reference.transform"),
    reload: unused("reference.reload"),
  },
  rpc: Object.assign(() => Effect.runSync(Effect.die("unused rpc.call")), {
    register: unused("rpc.register"),
  }),
  shell: { hook: unused("shell.hook") },
  skill: {
    list: unused("skill.list"),
    transform: unused("skill.transform"),
    reload: unused("skill.reload"),
  },
  vcs: {
    get: unused("vcs.get"),
    base: unused("vcs.base"),
    status: unused("vcs.status"),
    diff: unused("vcs.diff"),
    branch: { list: unused("vcs.branch.list") },
    transform: unused("vcs.transform"),
    reload: unused("vcs.reload"),
  },
  websearch: {
    providers: unused("websearch.providers"),
    query: unused("websearch.query"),
    transform: unused("websearch.transform"),
    reload: unused("websearch.reload"),
  },
  worktree: {
    list: unused("worktree.list"),
    create: unused("worktree.create"),
    remove: unused("worktree.remove"),
    refresh: unused("worktree.refresh"),
    transform: unused("worktree.transform"),
    reload: unused("worktree.reload"),
  },
};

const unusedSession = {
  list: unused("session.list"),
  create: unused("session.create"),
  remove: unused("session.remove"),
  switchAgent: unused("session.switchAgent"),
  switchModel: unused("session.switchModel"),
  prompt: unused("session.prompt"),
  generate: unused("session.generate"),
  command: unused("session.command"),
  compact: unused("session.compact"),
  synthetic: unused("session.synthetic"),
  interrupt: unused("session.interrupt"),
  update: unused("session.update"),
  move: unused("session.move"),
  context: unused("session.context"),
  wait: unused("session.wait"),
  instructions: {
    entry: {
      list: unused("session.instructions.entry.list"),
      put: unused("session.instructions.entry.put"),
      remove: unused("session.instructions.entry.remove"),
    },
  },
  hook: unused("session.hook"),
};

const teardown: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  await Effect.runPromise(
    Effect.forEach(
      teardown.splice(0).toReversed(),
      (close) =>
        Effect.promise(async () => {
          await close();
        }),
      { discard: true }
    )
  );
});

const setupTestPlugin = async function setupTestPlugin(
  options: Record<string, JsonValue> = {},
  signing: "true" | "false" | "unset" | "error" | "missing" = "true",
  sessionDirectory = import.meta.dir,
  stored = new Map<string, JsonValue>()
) {
  const directory =
    signing === "missing"
      ? sessionDirectory
      : mkdtempSync(join(tmpdir(), "commit-guard-fixture-"));

  if (signing !== "missing") {
    teardown.push(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    expect(Bun.spawnSync(["git", "init", "-q", directory]).exitCode).toBe(0);

    if (signing !== "unset") {
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
  }

  const hooks = new Map<string, () => Effect.Effect<void, Tool.Error>>();
  const tools = new Map<string, Tool.Info>();
  let failPublication = false;
  let sessionLookups = 0;

  const absolute = Schema.String.pipe(Schema.brand("AbsolutePath")).make(
    directory
  );

  const location = Location.Info.make({
    directory: absolute,
    project: {
      id: Schema.String.pipe(Schema.brand("Project.ID")).make("test-project"),
      directory: absolute,
      canonical: absolute,
    },
  });

  const toolContext: Tool.Context = {
    sessionID: Schema.String.pipe(Schema.brand("SessionID")).make(
      "test-session"
    ),
    agent: Agent.ID.make("build"),
    messageID: Schema.String.pipe(Schema.brand("Session.Message.ID")).make(
      "message"
    ),
    id: Tool.CallID.make("capture"),
    progress: unused("toolContext.progress"),
  };

  const events: HookEvents = {
    "execute.before": { ...toolContext, tool: "shell", input: {} },
    "execute.after": {
      ...toolContext,
      tool: "shell",
      input: {},
      status: "completed",
      result: {},
    },
  };

  const ctx: Plugin.Context = {
    ...unusedDomains,
    options,
    location,
    session: {
      ...unusedSession,
      get: () =>
        Effect.sync(() => {
          sessionLookups += 1;

          return {
            id: toolContext.sessionID,
            projectID: location.project.id,
            location: { directory: location.directory },
            cost: Schema.Number.pipe(Schema.brand("Money.USD")).make(0),
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            time: {
              created: DateTime.makeUnsafe(0),
              updated: DateTime.makeUnsafe(0),
            },
          };
        }),
    },
    tool: {
      reload: unused("tool.reload"),
      list: unused("tool.list"),
      transform: (editTools) =>
        Effect.sync(() => {
          editTools({
            list: () => {
              throw new Error("unused editor.list");
            },
            get: () => {
              throw new Error("unused editor.get");
            },
            namespace: () => {
              throw new Error("unused editor.namespace");
            },
            update: () => {
              throw new Error("unused editor.update");
            },
            remove: () => {
              throw new Error("unused editor.remove");
            },
            add: (definition) => {
              tools.set(definition.name, definition);
            },
          });

          return { dispose: Effect.void };
        }),
      hook: <Name extends keyof HookEvents>(
        name: Name,
        runHook: (
          event: HookEvents[Name]
        ) => Effect.Effect<void, HookFailures[Name]>
      ) =>
        Effect.sync(() => {
          hooks.set(name, () => runHook(events[name]));

          return { dispose: Effect.void };
        }),
    },
    storage: {
      get: (key: string) => Effect.succeed(stored.get(key)),
      set: (key, value) =>
        Effect.sync(() => {
          if (failPublication && key.startsWith("snap/")) {
            throw new Error("Storage unavailable");
          }

          stored.set(key, value);
        }),
      remove: (key: string) =>
        Effect.sync(() => {
          stored.delete(key);
        }),
      scan: ({ prefix }) =>
        Effect.succeed({
          entries: [...stored].flatMap(([key, value]) =>
            key.startsWith(prefix) ? [{ key, value }] : []
          ),
        }),
    },
  };

  const scope = await Effect.runPromise(Scope.make());

  const close = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  };

  teardown.push(close);
  await Effect.runPromise(plugin.effect(ctx).pipe(Scope.provide(scope)));

  const context = async (request: JsonValue = {}) => {
    const definition = tools.get("commit_context");

    if (definition === undefined) {
      throw new Error("Commit context tool is unavailable");
    }

    const result = await Effect.runPromise(
      definition.execute(request, toolContext)
    );

    if (!isJSONString(result.content)) {
      throw new Error("Expected text");
    }

    return result.content;
  };

  const harness = {
    context,
    close,
    stored,
    sessionLookups: () => sessionLookups,
    failPublication: () => {
      failPublication = true;
    },
    executeBefore: async (
      tool: string,
      input: HookEvents["execute.before"]["input"]
    ) => {
      const hook = hooks.get("execute.before");

      if (hook !== undefined) {
        events["execute.before"] = {
          ...toolContext,
          tool,
          input,
          id: Tool.CallID.make("call"),
        };
        await Effect.runPromise(hook());
      }
    },
    prepareCapture: async (
      onPrepared?: () => void,
      request: JsonValue = {},
      workdir = directory
    ) => {
      const text = await context(request);
      const command = text.split("\n").slice(1).join("\n");

      onPrepared?.();

      const hook = hooks.get("execute.before");

      if (hook === undefined) {
        throw new Error("Capture admission hook is unavailable");
      }

      events["execute.before"] = {
        ...toolContext,
        tool: "shell",
        input: { command, workdir },
      };
      await Effect.runPromise(hook());

      return command;
    },
    completeCapture: async (
      command: string,
      metadata?: JsonValue,
      result?: Tool.Result,
      id = "capture"
    ) => {
      const hook = hooks.get("execute.after");

      if (hook === undefined) {
        throw new Error("Capture completion hook is unavailable");
      }

      const event: HookEvent = {
        ...toolContext,
        tool: "shell",
        input: { command, workdir: directory },
        id: Tool.CallID.make(id),
        status: "completed",
        result: result ?? {
          content: [{ type: "text", text: "RECEIPT_OK\n" }],
          metadata: isRecord(metadata) ? metadata : undefined,
        },
      };

      events["execute.after"] = event;
      await Effect.runPromise(hook());

      return event.result;
    },
    failCapture: async (command: string, error: Tool.Error) => {
      const hook = hooks.get("execute.after");

      if (hook === undefined) {
        throw new Error("Capture completion hook is unavailable");
      }

      const event: HookEvent = {
        ...toolContext,
        tool: "shell",
        input: { command, workdir: directory },
        status: "error",
        error,
      };

      events["execute.after"] = event;
      await Effect.runPromise(hook());

      return event.error;
    },
  };

  if (signing !== "missing") {
    const command = await harness.prepareCapture();

    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(directory, "global-config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
    };

    const captured = Bun.spawnSync(["bash", "-c", command], {
      cwd: directory,
      env,
    });

    expect(captured.exitCode).toBe(0);
    await harness.completeCapture(command, {
      status: "completed",
      exit: 0,
      truncated: false,
    });
    sessionLookups = 0;
  }

  return harness;
};

describe("opencode-commit-guard plugin", () => {
  test("appends frozen guidance to copied capture content and structured output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "commit-guard-inline-"));

    teardown.push(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    expect(Bun.spawnSync(["git", "init", "-q", directory]).exitCode).toBe(0);
    expect(
      Bun.spawnSync([
        "git",
        "-C",
        directory,
        "config",
        "commit.gpgsign",
        "true",
      ]).exitCode
    ).toBe(0);

    const harness = await setupTestPlugin(
      { allowedScopes: ["core"] },
      "missing",
      directory
    );

    const command = await harness.prepareCapture();

    const metadata = Object.freeze({
      status: "completed",
      exit: 0,
      truncated: false,
    });

    const parts: readonly Tool.Content[] = Object.freeze([
      { type: "text", text: "RECEIPT_OK\n" },
      { type: "file", uri: "file:///receipt", mime: "text/plain" },
    ]);

    const output = Object.freeze({
      output: "RECEIPT_OK\n",
      exitCode: 0,
      wallTimeSeconds: 0.1,
    });

    const original = Object.freeze({ content: parts, output, metadata });

    expect(
      Bun.spawnSync(["bash", "-c", command], { cwd: directory }).exitCode
    ).toBe(0);
    const result = await harness.completeCapture(command, metadata, original);

    expect(
      harness.executeBefore("shell", {
        command: "git commit -s -m 'core: Inline capture'",
      })
    ).resolves.toBeUndefined();
    const guidance = await harness.context();

    expect(guidance).toContain(
      `[commit-guard] Frozen commit baseline for ${directory}.`
    );
    expect(guidance).toContain("Configured scope allowlist: core.");
    expect(guidance).toContain("Add -s or --signoff.");
    expect(guidance).toContain("A second commit_context call is optional.");
    expect(result).not.toBe(original);
    expect(result.content).toEqual([
      ...parts,
      { type: "text", text: guidance },
    ]);
    expect(result.output).toEqual({
      ...output,
      output: `${output.output}\n\n${guidance}`,
    });
    expect(result.metadata).toBe(metadata);
    expect(original.content).toBe(parts);
    expect(original.output).toBe(output);
    expect(await harness.context()).toBe(guidance);
  });

  test("appends the recorded capture failure reason without changing metadata", async () => {
    const harness = await setupTestPlugin({}, "missing");
    const command = await harness.prepareCapture();
    const metadata = { status: "completed", exit: 0, truncated: true };
    const result = await harness.completeCapture(command, metadata);

    const note =
      "[commit-guard] This capture did not publish a usable baseline: shell result lacks verified foreground completion metadata.\n" +
      "RECEIPT_OK alone does not authorize a commit.\nCall commit_context with the same workdir for status and next steps.";

    expect(result.content).toEqual([
      { type: "text", text: "RECEIPT_OK\n" },
      { type: "text", text: note },
    ]);
    expect(result.metadata).toBe(metadata);
    expect(await harness.context()).toContain(
      "previous capture failed: shell result lacks verified foreground completion metadata"
    );
  });

  test("appends capture failure guidance to the original shell error message", async () => {
    const harness = await setupTestPlugin({}, "missing");
    const command = await harness.prepareCapture();
    const cause = new Error("Underlying shell failure");
    const metadata = { status: "killed", private: "preserved" };

    const original = new Tool.Error({
      message: "Permission denied by user",
      error: cause,
      metadata,
    });

    const error = await harness.failCapture(command, original);

    expect(error).toBeInstanceOf(Tool.Error);
    expect(error).not.toBe(original);
    expect(error.error).toBe(cause);
    expect(error.metadata).toEqual(original.metadata);
    expect(error.message).toStartWith(
      "Permission denied by user\n\n[commit-guard] This capture did not publish a usable baseline: shell result did not complete successfully."
    );
    expect(error.message).toContain(
      "RECEIPT_OK alone does not authorize a commit."
    );
    expect(await harness.context()).toContain(
      "previous capture failed: shell result did not complete successfully"
    );
  });

  test("leaves unrelated shell results untouched while a capture is claimed", async () => {
    const harness = await setupTestPlugin({}, "missing");

    await harness.prepareCapture();

    const original: Tool.Result = {
      content: "git status output",
      output: { output: "git status output" },
      metadata: { exit: 0 },
    };

    expect(
      await harness.completeCapture(
        "git status",
        undefined,
        original,
        "other-call"
      )
    ).toBe(original);
  });

  test("renders signoff guidance from the frozen effective policy", async () => {
    await Promise.all(
      [true, false].map(async (required) => {
        const harness = await setupTestPlugin({}, required ? "true" : "false");
        const guidance = await harness.context();

        expect(guidance).toContain(
          required
            ? "Add -s or --signoff."
            : "Signoff is not required; add it only if repository instructions require it."
        );
        expect(guidance).toContain("Signoff is not a cryptographic signature.");
      })
    );

    const unset = await setupTestPlugin({}, "unset");

    expect(await unset.context()).toContain(
      "Effective commit.gpgsign: unset. Signoff is not required; add it only if repository instructions require it."
    );
  });
  test("reports a missing baseline before message format and permits help", async () => {
    const harness = await setupTestPlugin({}, "missing");

    expect(
      harness.executeBefore("shell", { command: "git commit -m bad" })
    ).rejects.toThrow("No published baseline");
    expect(
      harness.executeBefore("shell", { command: "git commit -m bad" })
    ).rejects.toThrow(
      'Commit after the shell result reports "Frozen commit baseline"; otherwise call commit_context again'
    );

    for (const flag of ["--help", "-h"]) {
      expect(
        harness.executeBefore("shell", { command: `git commit ${flag}` })
      ).resolves.toBeUndefined();
    }
  });

  test("reports unclaimed, claimed, failed, and reloaded capture status", async () => {
    const harness = await setupTestPlugin({}, "missing");
    const instructions = await harness.context();
    const command = instructions.split("\n").slice(1).join("\n");

    expect(instructions).toContain("immediately, unchanged, in the foreground");
    expect(instructions).toContain(
      "Do not wrap it or chain another command onto it."
    );
    expect(instructions).toContain(
      'Commit after the shell result reports "Frozen commit baseline"; otherwise call commit_context again'
    );
    expect(
      harness.executeBefore("shell", {
        command: `${command} `,
        workdir: import.meta.dir,
      })
    ).rejects.toThrow("Pre-execution shell inspection failed");
    expect(await harness.context()).toContain("still pending and unclaimed");
    expect(await harness.context()).toContain(
      'Commit after the shell result reports "Frozen commit baseline"; otherwise call commit_context again'
    );
    expect(await harness.context()).toContain(
      "RECEIPT_OK confirms only that the artifact was written"
    );
    const claimed = await harness.prepareCapture();

    expect(await harness.context()).toContain("Capture claimed");
    expect(await harness.context()).toContain(
      'Commit after it reports "Frozen commit baseline"; otherwise call commit_context again'
    );
    await harness.completeCapture(claimed, {
      status: "completed",
      exit: 0,
      truncated: true,
    });

    const reloaded = await setupTestPlugin(
      {},
      "missing",
      import.meta.dir,
      harness.stored
    );

    expect(await reloaded.context()).toContain(
      "previous capture failed: shell result lacks verified foreground completion metadata"
    );
  });

  test("reports an incomplete artifact only after successful metadata proof", async () => {
    const harness = await setupTestPlugin({}, "missing");
    const command = await harness.prepareCapture();

    await harness.completeCapture(command, {
      status: "completed",
      exit: 0,
      truncated: false,
    });
    expect(await harness.context()).toContain(
      "private artifact is invalid or incomplete (END required)"
    );
  });

  test("reports failed baseline storage on the next context call", async () => {
    const harness = await setupTestPlugin({}, "missing");
    const command = await harness.prepareCapture();

    expect(
      Bun.spawnSync(["bash", "-c", command], { cwd: import.meta.dir }).exitCode
    ).toBe(0);
    harness.failPublication();
    await harness.completeCapture(command, {
      status: "completed",
      exit: 0,
      truncated: false,
    });
    expect(await harness.context()).toContain(
      "capture storage failed or its counter changed"
    );
  });

  test("sweeps abandoned unclaimed artifacts and keeps claimed artifacts", async () => {
    const harness = await setupTestPlugin({}, "missing");
    const actualNow = Date.now;
    let clock = actualNow();

    Date.now = () => clock;

    try {
      const instructions = await harness.context();

      const artifact = / '(?<artifact>[^']+)' 2>\/dev\/null$/u.exec(
        instructions
      )?.[1];

      expect(artifact).toBeDefined();

      if (artifact === undefined) {
        throw new Error("Missing artifact path");
      }

      expect(existsSync(artifact)).toBe(true);
      clock += 21_000;
      await harness.executeBefore("shell", { command: "git status" });
      expect(existsSync(artifact)).toBe(false);
      expect(await harness.context()).toContain(
        "previous capture expired before its command was claimed"
      );
      const claimed = await harness.prepareCapture();

      const claimedArtifact = / '(?<artifact>[^']+)' 2>\/dev\/null$/u.exec(
        claimed
      )?.[1];

      if (claimedArtifact === undefined) {
        throw new Error("Missing claimed artifact path");
      }

      clock += 60_000;
      await harness.executeBefore("shell", { command: "git status" });
      expect(existsSync(claimedArtifact)).toBe(true);
    } finally {
      Date.now = actualNow;
    }
  });

  test("stale completion and unload do not invalidate a later baseline", async () => {
    await Promise.all(
      ["complete", "unload", "reload"].map(async (finish) => {
        const stale = await setupTestPlugin({}, "missing");
        const oldCommand = await stale.prepareCapture();

        const current = await setupTestPlugin(
          {},
          "missing",
          import.meta.dir,
          stale.stored
        );

        const command = await current.prepareCapture(undefined, {
          refresh: finish !== "reload",
        });

        const shell = Bun.spawnSync(["bash", "-c", command], {
          cwd: import.meta.dir,
        });

        expect(shell.exitCode).toBe(0);
        await current.completeCapture(command, {
          status: "completed",
          exit: 0,
          truncated: false,
        });

        await (finish === "unload"
          ? stale.close()
          : stale.completeCapture(oldCommand, {}));

        expect(await current.context()).toContain("Frozen commit baseline");
      })
    );
  });

  test("explains invalid signing config without issuing capture commands repeatedly", async () => {
    const directory = mkdtempSync(join(tmpdir(), "commit-guard-config-"));

    teardown.push(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    expect(Bun.spawnSync(["git", "init", "-q", directory]).exitCode).toBe(0);
    expect(
      Bun.spawnSync([
        "git",
        "-C",
        directory,
        "config",
        "commit.gpgsign",
        "invalid_bool",
      ]).exitCode
    ).toBe(0);
    const harness = await setupTestPlugin({}, "missing", directory);
    const command = await harness.prepareCapture();

    expect(
      Bun.spawnSync(["bash", "-c", command], { cwd: directory }).exitCode
    ).toBe(0);

    const result = await harness.completeCapture(command, {
      status: "completed",
      exit: 0,
      truncated: false,
    });

    const message = await harness.context();

    expect(message).toContain("Git could not read commit.gpgsign as valid");
    expect(message).toContain(
      "git config --show-origin --get-all commit.gpgsign"
    );
    expect(message).toContain("without changing the intended signing policy");
    expect(message).not.toContain("timeout 15s");
    expect(message).not.toContain("Frozen commit baseline");
    expect(result.content).toEqual([
      { type: "text", text: "RECEIPT_OK\n" },
      { type: "text", text: message },
    ]);
    expect(
      harness.executeBefore("shell", { command: "git commit -m bad" })
    ).rejects.toThrow("Repeating the capture will not fix it");
  });

  test("shares the baseline and refresh across root and subdirectory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "commit-guard-root-"));
    const subdirectory = join(directory, "sub");

    teardown.push(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    mkdirSync(subdirectory);
    expect(Bun.spawnSync(["git", "init", "-q", directory]).exitCode).toBe(0);
    const harness = await setupTestPlugin({}, "missing", directory);

    const command = await harness.prepareCapture(
      undefined,
      { workdir: "sub" },
      subdirectory
    );

    expect(
      Bun.spawnSync(["bash", "-c", command], { cwd: subdirectory }).exitCode
    ).toBe(0);
    await harness.completeCapture(command, {
      status: "completed",
      exit: 0,
      truncated: false,
    });
    expect(
      harness.executeBefore("shell", {
        command: "git commit -s -m 'core: Root'",
        workdir: directory,
      })
    ).resolves.toBeUndefined();
    expect(await harness.context({ workdir: "sub" })).toContain(
      "Frozen commit baseline"
    );
    await harness.context({ refresh: true, workdir: directory });
    expect(
      harness.executeBefore("shell", {
        command: "git commit -s -m 'core: Sub'",
        workdir: subdirectory,
      })
    ).rejects.toThrow("No published baseline");
    const rootCommand = await harness.prepareCapture();

    expect(
      Bun.spawnSync(["bash", "-c", rootCommand], { cwd: directory }).exitCode
    ).toBe(0);
    await harness.completeCapture(rootCommand, {
      status: "completed",
      exit: 0,
      truncated: false,
    });
    expect(
      harness.executeBefore("shell", {
        command: "git commit -s -m 'core: Sub'",
        workdir: subdirectory,
      })
    ).resolves.toBeUndefined();
    await harness.context({ refresh: true, workdir: "sub" });
    expect(
      harness.executeBefore("shell", {
        command: "git commit -s -m 'core: Root'",
        workdir: directory,
      })
    ).rejects.toThrow("No published baseline");
  });

  test("rejects impossible allowed scopes during configuration", () => {
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
  test("allows non-shell tools without interception", async () => {
    const harness = await setupTestPlugin();
    expect(
      harness.executeBefore("write", {
        path: "file.txt",
        content: "git commit invalid",
      })
    ).resolves.toBeUndefined();
  });

  test("allows shell commands that do not contain git commit", async () => {
    const harness = await setupTestPlugin();
    expect(
      harness.executeBefore("shell", { command: "git status" })
    ).resolves.toBeUndefined();
    expect(
      harness.executeBefore("bash", { command: "bun test && git log -5" })
    ).resolves.toBeUndefined();
    expect(harness.sessionLookups()).toBe(0);
    await harness.executeBefore("shell", { command: "git commit --help" });
    expect(harness.sessionLookups()).toBe(0);
    await harness.executeBefore("shell", {
      command: "git commit -s -m 'core: Check lookup'",
    });
    expect(harness.sessionLookups()).toBe(1);
  });

  test("allows conforming git commit commands", async () => {
    const harness = await setupTestPlugin();
    expect(
      harness.executeBefore("shell", {
        command: 'git commit -s -m "kernel: add support for foo"',
      })
    ).resolves.toBeUndefined();
    expect(
      harness.executeBefore("bash", {
        command: 'git commit -sm "feat(parser): add subshell support"',
      })
    ).resolves.toBeUndefined();
  });

  test("publishes a capture only after a verified foreground exit", async () => {
    const accepted = { status: "completed", exit: 0, truncated: false };

    const cases: (JsonValue | undefined)[] = [
      undefined,
      {},
      { status: "running", shellID: "sh_background", truncated: false },
      { status: "completed", exit: 7, truncated: false },
      { status: "completed", truncated: true, exit: 0 },
      { status: "completed", truncated: false, timeout: true },
      { status: "exited", exit: 0, truncated: false },
      { status: "completed", exit: 0, truncated: false, unexpected: true },
      accepted,
    ];

    await Promise.all(
      cases.map(async (metadata) => {
        const harness = await setupTestPlugin({}, "missing");
        const command = await harness.prepareCapture();

        const shell = Bun.spawnSync(["bash", "-c", command], {
          cwd: import.meta.dir,
        });

        expect(shell.exitCode).toBe(0);
        expect(shell.stdout.toString()).toBe("RECEIPT_OK\n");
        await harness.completeCapture(command, metadata);

        const commit = harness.executeBefore("shell", {
          command: 'git commit -s -m "kernel: valid capture"',
        });

        if (metadata === accepted) {
          expect(commit).resolves.toBeUndefined();
        } else {
          expect(commit).rejects.toThrow("Call commit_context");
        }
      })
    );
  });

  test("keeps the capture alive when permission approval is slow", async () => {
    const harness = await setupTestPlugin({}, "missing");
    const actualNow = Date.now;
    let clock = actualNow();

    Date.now = () => clock;

    try {
      const command = await harness.prepareCapture(() => {
        clock += 15_000;
      });

      clock += 30_000;

      const shell = Bun.spawnSync(["bash", "-c", command], {
        cwd: import.meta.dir,
      });

      expect(shell.exitCode).toBe(0);
      clock += 6000;
      await harness.completeCapture(command, {
        status: "completed",
        exit: 0,
        truncated: false,
      });
      expect(
        harness.executeBefore("shell", {
          command: 'git commit -s -m "kernel: approved capture"',
        })
      ).resolves.toBeUndefined();
    } finally {
      Date.now = actualNow;
    }
  });

  test("rejects a corrupt reference instead of capturing an unborn HEAD", async () => {
    const directory = mkdtempSync(join(tmpdir(), "commit-guard-corrupt-"));

    try {
      const initialized = Bun.spawnSync(["git", "init", "-q", directory]);

      expect(initialized.exitCode).toBe(0);
      const unborn = await setupTestPlugin({}, "missing", directory);
      const unbornCommand = await unborn.prepareCapture();

      const unbornShell = Bun.spawnSync(["bash", "-c", unbornCommand], {
        cwd: directory,
      });

      expect(unbornShell.exitCode).toBe(0);
      await unborn.completeCapture(unbornCommand, {
        status: "completed",
        exit: 0,
        truncated: false,
      });
      expect(
        unborn.executeBefore("shell", {
          command: 'git commit -s -m "kernel: valid unborn checkout"',
        })
      ).resolves.toBeUndefined();

      const branch = Bun.spawnSync([
        "git",
        "-C",
        directory,
        "symbolic-ref",
        "--short",
        "HEAD",
      ]);

      expect(branch.exitCode).toBe(0);
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
      const harness = await setupTestPlugin({}, "missing", directory);
      const command = await harness.prepareCapture();
      const shell = Bun.spawnSync(["bash", "-c", command], { cwd: directory });

      expect(shell.exitCode).not.toBe(0);
      expect(shell.stdout.toString()).not.toContain("RECEIPT_OK");
      await harness.completeCapture(command, {
        status: "completed",
        truncated: false,
        exit: shell.exitCode,
      });
      expect(
        harness.executeBefore("shell", {
          command: 'git commit -s -m "kernel: reject corrupt HEAD"',
        })
      ).rejects.toThrow("Call commit_context");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects git commit commands with invalid format before execution", async () => {
    const harness = await setupTestPlugin();
    expect(
      harness.executeBefore("shell", {
        command: "git commit -m bad",
        workdir: undefined,
      })
    ).rejects.toThrow("Cannot inspect non-JSON shell input");

    expect(
      harness.executeBefore("shell", {
        command: 'git commit -m "Missing scope entirely" -s',
      })
    ).rejects.toThrow("Missing scope in subject line");
    expect(
      harness.executeBefore("shell", {
        command: 'git com""mit -m "Missing scope entirely" -s',
      })
    ).rejects.toThrow("Missing scope in subject line");
  });

  test("settles parallel validation failures as independent tool errors", async () => {
    const harness = await setupTestPlugin();

    const settled = await Promise.allSettled([
      harness.executeBefore("shell", {
        command: 'git commit -s -m "invalid scope"',
      }),
      harness.executeBefore("shell", {
        command: 'git commit -m "kernel: missing signoff"',
      }),
    ]);

    const [scopeFailure, signoffFailure] = settled;

    expect(scopeFailure?.status).toBe("rejected");
    expect(signoffFailure?.status).toBe("rejected");

    if (
      scopeFailure?.status === "rejected" &&
      signoffFailure?.status === "rejected"
    ) {
      expect(scopeFailure.reason).toBeInstanceOf(Tool.Error);
      expect(signoffFailure.reason).toBeInstanceOf(Tool.Error);

      if (
        !(scopeFailure.reason instanceof Tool.Error) ||
        !(signoffFailure.reason instanceof Tool.Error)
      ) {
        throw new TypeError("Expected independent tool errors");
      }

      expect(scopeFailure.reason.message).toContain(
        "Missing scope in subject line"
      );
      expect(signoffFailure.reason.message).toContain("Missing commit signoff");
    }
  });

  test("rejects git commit commands missing signoff flag or trailer", async () => {
    const harness = await setupTestPlugin();
    expect(
      harness.executeBefore("shell", {
        command: 'git commit -m "kernel: fix race condition"',
      })
    ).rejects.toThrow("Missing commit signoff");
  });

  test("respects allowedScopes option", async () => {
    const harness = await setupTestPlugin({
      allowedScopes: ["kernel", "releasetools"],
    });

    expect(
      harness.executeBefore("shell", {
        command: 'git commit -s -m "kernel: fix race"',
      })
    ).resolves.toBeUndefined();

    expect(
      harness.executeBefore("shell", {
        command: 'git commit -s -m "ui: update colors"',
      })
    ).rejects.toThrow('Scope "ui" is not in the allowed scopes list');
  });

  test("respects maxLineLength option override", async () => {
    const harness = await setupTestPlugin({
      maxLineLength: 100,
    });

    const eightyChars = `kernel: ${"a".repeat(75)}`;
    expect(
      harness.executeBefore("shell", {
        command: `git commit -s -m "${eightyChars}"`,
      })
    ).resolves.toBeUndefined();
  });

  test("does not require signoff when effective commit.gpgsign is false", async () => {
    const harness = await setupTestPlugin({}, "false");

    expect(
      harness.executeBefore("shell", {
        command: 'git commit -m "kernel: add foo without signoff"',
      })
    ).resolves.toBeUndefined();

    expect(
      harness.executeBefore("shell", {
        command: 'git -C elsewhere commit -m "kernel: wrong target"',
      })
    ).rejects.toThrow("Commit target is ambiguous");

    expect(
      harness.executeBefore("shell", {
        command:
          "export GIT_DIR=/other/.git; git commit -m 'kernel: wrong target'",
      })
    ).rejects.toThrow("Commit target is ambiguous");
  });

  test("respects requireScope: false option override", async () => {
    const harness = await setupTestPlugin({
      requireScope: false,
    });

    expect(
      harness.executeBefore("shell", {
        command: 'git commit -s -m "Freeform commit title without scope"',
      })
    ).resolves.toBeUndefined();
  });

  test("validates configuration options on setup", () => {
    expect(setupTestPlugin({ requireScope: "invalid" })).rejects.toThrow(
      "Invalid plugin option requireScope; expected a boolean."
    );
    expect(setupTestPlugin({ allowedScopes: "not-an-array" })).rejects.toThrow(
      "Invalid plugin option allowedScopes; expected an array of non-empty strings."
    );
    expect(setupTestPlugin({ maxLineLength: -5 })).rejects.toThrow(
      "Invalid plugin option maxLineLength; expected an integer greater than or equal to 0."
    );
    expect(setupTestPlugin({ requireSignoff: true })).rejects.toThrow(
      "Plugin option requireSignoff has been removed"
    );
  });
});
