import { afterEach, describe, expect, test } from "bun:test";
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

import { Agent, Location, Tool } from "@opencode/plugin/effect";
import type { Plugin } from "@opencode/plugin/effect";
import { DateTime, Effect, Exit, Schema, Scope, Stream } from "effect";

import plugin from "../index.js";
import { resolveTargetWorkdir } from "../src/capture.js";
import { parseConfig } from "../src/config.js";
import type { JsonValue } from "../src/types.js";
import { isJSONString } from "../src/types.js";
import { createTempRepo, expectRejects, withFakeNow } from "./helpers.js";

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

type HookRegistry<Names extends keyof HookEvents = keyof HookEvents> = {
  [Name in Names]?: (
    event: HookEvents[Name]
  ) => Effect.Effect<void, HookFailures[Name]>;
};

const unused = (method: string) => () => Effect.die(`unused ${method}`);

const hasDomainMethods = <Key extends string>(
  table: Record<string, () => Effect.Effect<never>>,
  methods: readonly Key[]
): table is Record<Key, () => Effect.Effect<never>> =>
  methods.every((method) => Object.hasOwn(table, method));

const domainMethods = <Key extends string>(
  domain: string,
  methods: readonly Key[]
) => {
  const table = Object.fromEntries(
    methods.map((method) => [method, unused(`${domain}.${method}`)])
  );

  if (!hasDomainMethods(table, methods)) {
    throw new Error(`Incomplete ${domain} stub`);
  }

  return table;
};

const unusedDomains = {
  app: { name: "test", version: "test", channel: "test" },
  agent: domainMethods("agent", ["get", "list", "transform", "reload"]),
  aisdk: domainMethods("aisdk", ["hook"]),
  command: domainMethods("command", ["list", "transform", "reload"]),
  credential: domainMethods("credential", ["activate"]),
  event: {
    subscribe: () => Stream.fromEffect(Effect.die("unused event.subscribe")),
  },
  experimental: {
    terminal: domainMethods("experimental.terminal", ["read"]),
    generate: domainMethods("experimental.generate", [
      "text",
      "image",
      "decisions",
    ]),
    artifact: domainMethods("experimental.artifact", ["transform", "reload"]),
  },
  generate: { text: unused("generate.text") },
  integration: {
    list: unused("integration.list"),
    get: unused("integration.get"),
    transform: unused("integration.transform"),
    reload: unused("integration.reload"),
    connect: domainMethods("integration.connect", ["key", "external"]),
    oauth: domainMethods("integration.oauth", [
      "connect",
      "status",
      "complete",
      "cancel",
    ]),
    command: domainMethods("integration.command", [
      "connect",
      "status",
      "cancel",
    ]),
    connection: domainMethods("integration.connection", [
      "active",
      "resolve",
      "status",
    ]),
  },
  mcp: domainMethods("mcp", ["list", "transform", "reload"]),
  model: domainMethods("model", ["list", "default", "transform", "reload"]),
  permission: domainMethods("permission", [
    "list",
    "get",
    "reply",
    "hook",
    "assert",
  ]),
  plugin: { list: unused("plugin.list") },
  provider: domainMethods("provider", ["list", "get", "transform", "reload"]),
  reference: domainMethods("reference", ["list", "transform", "reload"]),
  rpc: Object.assign(() => Effect.runSync(Effect.die("unused rpc.call")), {
    register: unused("rpc.register"),
  }),
  shell: domainMethods("shell", ["hook"]),
  skill: domainMethods("skill", ["list", "transform", "reload"]),
  vcs: {
    get: unused("vcs.get"),
    base: unused("vcs.base"),
    status: unused("vcs.status"),
    diff: unused("vcs.diff"),
    branch: domainMethods("vcs.branch", ["list"]),
    transform: unused("vcs.transform"),
    reload: unused("vcs.reload"),
  },
  websearch: domainMethods("websearch", [
    "providers",
    "query",
    "transform",
    "reload",
  ]),
  worktree: domainMethods("worktree", [
    "list",
    "create",
    "remove",
    "refresh",
    "transform",
    "reload",
  ]),
};

const unusedSession = {
  ...domainMethods("session", [
    "list",
    "create",
    "remove",
    "switchAgent",
    "switchModel",
    "prompt",
    "generate",
    "command",
    "compact",
    "synthetic",
    "interrupt",
    "update",
    "move",
    "context",
    "wait",
    "hook",
  ]),
  instructions: {
    entry: domainMethods("session.instructions.entry", [
      "list",
      "put",
      "remove",
    ]),
  },
};

const teardown: (() => void | Promise<void>)[] = [];

const runCapture = (command: string, directory: string) => {
  const captured = Bun.spawnSync(["bash", "-c", command], {
    cwd: directory,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(directory, "global-config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
    },
  });

  expect(captured.exitCode).toBe(0);
  expect(captured.stdout.toString()).toBe("RECEIPT_OK\n");
};

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
  stored = new Map<string, JsonValue>(),
  workspace: "local" | "remote" | "mismatch" = "local"
) {
  const directory =
    signing === "missing"
      ? sessionDirectory
      : createTempRepo(teardown, signing === "unset" ? undefined : signing);

  const hooks: HookRegistry = {};
  const tools = new Map<string, Tool.Info>();
  let failPublication = false;
  let sessionLookups = 0;

  const absolute = Schema.String.pipe(Schema.brand("AbsolutePath")).make(
    directory
  );

  const location = Location.Info.make({
    directory: absolute,
    workspaceID:
      workspace === "remote"
        ? Schema.String.pipe(Schema.brand("Workspace.ID")).make("wrk_remote")
        : undefined,
    project: {
      id: Schema.String.pipe(Schema.brand("Project.ID")).make("test-project"),
      directory: absolute,
      canonical: absolute,
    },
  });

  let sessionLocation = location;

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
            location: {
              directory: sessionLocation.directory,
              workspaceID:
                workspace === "mismatch"
                  ? Schema.String.pipe(Schema.brand("Workspace.ID")).make(
                      "wrk_remote"
                    )
                  : sessionLocation.workspaceID,
            },
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
          const registered: HookRegistry<Name> = hooks;
          registered[name] = runHook;

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

  const context = async (
    request: HookEvents["execute.before"]["input"] = {}
  ) => {
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
    moveSession: (target: string) => {
      sessionLocation = Location.Info.make({
        project: location.project,
        workspaceID: location.workspaceID,
        directory: Schema.String.pipe(Schema.brand("AbsolutePath")).make(
          target
        ),
      });
    },
    sessionLookups: () => sessionLookups,
    failPublication: () => {
      failPublication = true;
    },
    executeBefore: async (
      tool: string,
      input: HookEvents["execute.before"]["input"]
    ) => {
      const hook = hooks["execute.before"];

      if (hook !== undefined) {
        await Effect.runPromise(
          hook({
            ...toolContext,
            tool,
            input,
            id: Tool.CallID.make("call"),
          })
        );
      }
    },
    prepareCapture: async (
      onPrepared?: () => void,
      request: HookEvents["execute.before"]["input"] = {},
      workdir = directory
    ) => {
      const text = await context(request);
      const command = text.split("\n").slice(1).join("\n");

      onPrepared?.();

      const hook = hooks["execute.before"];

      if (hook === undefined) {
        throw new Error("Capture admission hook is unavailable");
      }

      await Effect.runPromise(
        hook({
          ...toolContext,
          tool: "shell",
          input: { command, workdir },
        })
      );

      return command;
    },
    completeCapture: async (
      command: string,
      metadata?: Tool.Result["metadata"],
      result?: Tool.Result,
      id = "capture"
    ) => {
      const hook = hooks["execute.after"];

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
          metadata,
        },
      };

      await Effect.runPromise(hook(event));

      return event.result;
    },
    failCapture: async (command: string, error: Tool.Error) => {
      const hook = hooks["execute.after"];

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

      await Effect.runPromise(hook(event));

      return event.error;
    },
    captureRepo: async (
      request: HookEvents["execute.before"]["input"] = {},
      workdir = directory
    ) => {
      const command = await harness.prepareCapture(undefined, request, workdir);

      runCapture(command, workdir);

      return await harness.completeCapture(command, {
        status: "completed",
        exit: 0,
        truncated: false,
      });
    },
  };

  if (signing !== "missing") {
    await harness.captureRepo();
    sessionLookups = 0;
  }

  return harness;
};

describe("opencode-commit-guard plugin", () => {
  test.each<"remote" | "mismatch">(["remote", "mismatch"])(
    "rejects %s workspace captures and commits",
    async (workspace) => {
      const harness = await setupTestPlugin(
        {},
        "missing",
        import.meta.dir,
        new Map(),
        workspace
      );

      expect(await harness.context()).toContain(
        "unavailable for remote workspaces"
      );
      await expectRejects(
        harness.executeBefore("shell", {
          command: "git commit -s -m 'core: Subject'",
        }),
        workspace === "remote"
          ? "Remote workspace"
          : "Commit target is ambiguous"
      );
    }
  );

  test("accepts undefined optional input fields and canonicalizes symlink workdirs", async () => {
    const directory = createTempRepo(teardown);
    const target = join(directory, "sub");
    const linked = join(directory, "linked");

    mkdirSync(target);
    symlinkSync(target, linked, "junction");
    const harness = await setupTestPlugin({}, "missing", directory);

    await harness.captureRepo(
      { directory: "linked", refresh: undefined },
      linked
    );
    await harness.executeBefore("shell", {
      command: "git commit -s -m 'core: Symlink'",
      workdir: "linked",
      background: undefined,
    });
    expect(
      await harness.context({ workdir: "sub", refresh: undefined })
    ).toContain("Frozen commit baseline");
    await expectRejects(
      harness.executeBefore("shell", {
        command: "git commit -s -m 'core: Missing'",
        workdir: "absent",
      }),
      "[commit-guard] Cannot access the shell workdir"
    );
    await Promise.all(
      [null, [], { workdir: 1 }, { directory: false }, { refresh: "true" }].map(
        async (input) => {
          await expectRejects(harness.context(input), "[commit-guard]");
        }
      )
    );
  });

  test("discovers subrepositories and remembers explicit targets only outside a repository", async () => {
    const base = mkdtempSync(join(tmpdir(), "commit-guard-discovery-"));

    teardown.push(() => {
      rmSync(base, { recursive: true, force: true });
    });
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
    const first = createTempRepo(teardown, undefined, base);
    const harness = await setupTestPlugin({}, "missing", base);

    expect(resolveTargetWorkdir(base).workdir).toBe(first);
    await harness.captureRepo({ directory: first }, first);
    const second = createTempRepo(teardown, undefined, base);

    expect(resolveTargetWorkdir(base).error).toContain(
      "Multiple Git repositories"
    );
    expect(await harness.context()).toContain(
      `Frozen commit baseline for ${first}`
    );
    await harness.captureRepo({ workdir: second, refresh: true }, second);
    harness.moveSession(first);
    expect(await harness.context()).toContain(
      `Frozen commit baseline for ${first}`
    );
    harness.moveSession(base);
    expect(await harness.context()).toContain(
      `Frozen commit baseline for ${first}`
    );
  });

  test.each([null, [], false, "options", 1].map((options) => ({ options })))(
    "rejects non-object configuration: %j",
    ({ options }) => {
      expect(() => parseConfig(options)).toThrow("expected an object");
    }
  );

  test("normalizes empty allowlists and rejects unknown configuration keys", () => {
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

  test("appends frozen guidance to copied capture content and structured output", async () => {
    const directory = createTempRepo(teardown, "true");

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

    runCapture(command, directory);
    const result = await harness.completeCapture(command, metadata, original);

    await harness.executeBefore("shell", {
      command: "git commit -s -m 'core: Inline capture'",
    });
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

    await expectRejects(
      harness.executeBefore("shell", { command: "git commit -m bad" }),
      "No published baseline"
    );
    await expectRejects(
      harness.executeBefore("shell", { command: "git commit -m bad" }),
      'Commit after the shell result reports "Frozen commit baseline"; otherwise call commit_context again'
    );

    await Promise.all(
      ["--help", "-h"].map(async (flag) => {
        await harness.executeBefore("shell", {
          command: `git commit ${flag}`,
        });
      })
    );
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
    await expectRejects(
      harness.executeBefore("shell", {
        command: `${command} `,
        workdir: import.meta.dir,
      }),
      "Pre-execution shell inspection failed"
    );
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
      'Commit after the shell result reports "Frozen commit baseline"; otherwise call commit_context again'
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

    runCapture(command, import.meta.dir);
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
    await withFakeNow(async (advance) => {
      const instructions = await harness.context();

      const artifact = / '(?<artifact>[^']+)' 2>\/dev\/null$/u.exec(
        instructions
      )?.[1];

      expect(artifact).toBeDefined();

      if (artifact === undefined) {
        throw new Error("Missing artifact path");
      }

      expect(existsSync(artifact)).toBe(true);
      advance(21_000);
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

      advance(60_000);
      await harness.executeBefore("shell", { command: "git status" });
      expect(existsSync(claimedArtifact)).toBe(true);
    });
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

        runCapture(command, import.meta.dir);
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
    const directory = createTempRepo(teardown, "invalid_bool");
    const harness = await setupTestPlugin({}, "missing", directory);
    const command = await harness.prepareCapture();

    runCapture(command, directory);

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
    await expectRejects(
      harness.executeBefore("shell", { command: "git commit -m bad" }),
      "Repeating the capture will not fix it"
    );
  });

  test("shares the baseline and refresh across root and subdirectory", async () => {
    const directory = createTempRepo(teardown);
    const subdirectory = join(directory, "sub");

    mkdirSync(subdirectory);
    const harness = await setupTestPlugin({}, "missing", directory);

    await harness.captureRepo({ workdir: "sub" }, subdirectory);
    await harness.executeBefore("shell", {
      command: "git commit -s -m 'core: Root'",
      workdir: directory,
    });
    expect(await harness.context({ workdir: "sub" })).toContain(
      "Frozen commit baseline"
    );
    await harness.context({ refresh: true, workdir: directory });
    await expectRejects(
      harness.executeBefore("shell", {
        command: "git commit -s -m 'core: Sub'",
        workdir: subdirectory,
      }),
      "No published baseline"
    );
    await harness.captureRepo();
    await harness.executeBefore("shell", {
      command: "git commit -s -m 'core: Sub'",
      workdir: subdirectory,
    });
    await harness.context({ refresh: true, workdir: "sub" });
    await expectRejects(
      harness.executeBefore("shell", {
        command: "git commit -s -m 'core: Root'",
        workdir: directory,
      }),
      "No published baseline"
    );
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
    await harness.executeBefore("write", {
      path: "file.txt",
      content: "git commit invalid",
    });
  });

  test("allows shell commands that do not contain git commit", async () => {
    const harness = await setupTestPlugin();
    await harness.executeBefore("shell", { command: "git status" });
    await harness.executeBefore("bash", { command: "bun test && git log -5" });
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
    await harness.executeBefore("shell", {
      command: 'git commit -s -m "kernel: add support for foo"',
    });
    await harness.executeBefore("bash", {
      command: 'git commit -sm "feat(parser): add subshell support"',
    });
  });

  test("publishes a capture only after a verified foreground exit", async () => {
    const accepted = { status: "completed", exit: 0, truncated: false };

    const cases: (Tool.Result["metadata"] | undefined)[] = [
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

        runCapture(command, import.meta.dir);
        await harness.completeCapture(command, metadata);

        const commit = harness.executeBefore("shell", {
          command: 'git commit -s -m "kernel: valid capture"',
        });

        await (metadata === accepted
          ? commit
          : expectRejects(commit, "Call commit_context"));
      })
    );
  });

  test("keeps the capture alive when permission approval is slow", async () => {
    const harness = await setupTestPlugin({}, "missing");
    await withFakeNow(async (advance) => {
      const command = await harness.prepareCapture(() => {
        advance(15_000);
      });

      advance(30_000);

      runCapture(command, import.meta.dir);
      advance(6000);
      await harness.completeCapture(command, {
        status: "completed",
        exit: 0,
        truncated: false,
      });
      await harness.executeBefore("shell", {
        command: 'git commit -s -m "kernel: approved capture"',
      });
    });
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
      await unborn.executeBefore("shell", {
        command: 'git commit -s -m "kernel: valid unborn checkout"',
      });

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
      await expectRejects(
        harness.executeBefore("shell", {
          command: 'git commit -s -m "kernel: reject corrupt HEAD"',
        }),
        "Call commit_context"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects git commit commands with invalid format before execution", async () => {
    const harness = await setupTestPlugin();
    await harness.executeBefore("shell", {
      command: "git status",
      workdir: undefined,
    });

    await Promise.all(
      [
        null,
        [],
        "git status",
        { command: 1 },
        { command: "git status", workdir: 1 },
        { command: "git status", background: "false" },
      ].map(
        async (input) =>
          await expectRejects(
            harness.executeBefore("shell", input),
            "[commit-guard]"
          )
      )
    );

    await expectRejects(
      harness.executeBefore("shell", {
        command: 'git commit -m "Missing scope entirely" -s',
      }),
      "Missing scope in subject line"
    );
    await expectRejects(
      harness.executeBefore("shell", {
        command: 'git com""mit -m "Missing scope entirely" -s',
      }),
      "Missing scope in subject line"
    );
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
    await expectRejects(
      harness.executeBefore("shell", {
        command: 'git commit -m "kernel: fix race condition"',
      }),
      "Missing commit signoff"
    );
  });

  test("respects allowedScopes option", async () => {
    const harness = await setupTestPlugin({
      allowedScopes: ["kernel", "releasetools"],
    });

    await harness.executeBefore("shell", {
      command: 'git commit -s -m "kernel: fix race"',
    });

    await expectRejects(
      harness.executeBefore("shell", {
        command: 'git commit -s -m "ui: update colors"',
      }),
      'Scope "ui" is not in the allowed scopes list'
    );
  });

  test("respects maxLineLength option override", async () => {
    const harness = await setupTestPlugin({
      maxLineLength: 100,
    });

    const eightyChars = `kernel: ${"a".repeat(75)}`;
    await harness.executeBefore("shell", {
      command: `git commit -s -m "${eightyChars}"`,
    });
  });

  test("does not require signoff when effective commit.gpgsign is false", async () => {
    const harness = await setupTestPlugin({}, "false");

    await harness.executeBefore("shell", {
      command: 'git commit -m "kernel: add foo without signoff"',
    });

    await expectRejects(
      harness.executeBefore("shell", {
        command: 'git -C elsewhere commit -m "kernel: wrong target"',
      }),
      "Commit target is ambiguous"
    );

    await expectRejects(
      harness.executeBefore("shell", {
        command:
          "export GIT_DIR=/other/.git; git commit -m 'kernel: wrong target'",
      }),
      "Commit target is ambiguous"
    );
  });

  test("respects requireScope: false option override", async () => {
    const harness = await setupTestPlugin({
      requireScope: false,
    });

    await harness.executeBefore("shell", {
      command: 'git commit -s -m "Freeform commit title without scope"',
    });
  });

  test("validates configuration options on setup", async () => {
    await expectRejects(
      setupTestPlugin({ requireScope: "invalid" }),
      "Invalid plugin option requireScope; expected a boolean."
    );
    await expectRejects(
      setupTestPlugin({ allowedScopes: "not-an-array" }),
      "Invalid plugin option allowedScopes; expected an array of non-empty strings."
    );
    await expectRejects(
      setupTestPlugin({ maxLineLength: -5 }),
      "Invalid plugin option maxLineLength; expected an integer greater than or equal to 0."
    );
    await expectRejects(
      setupTestPlugin({ requireSignoff: true }),
      "Plugin option requireSignoff has been removed"
    );
  });
});
