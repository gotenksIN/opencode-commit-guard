import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Agent } from "@opencode/core/agent";
import { CodeModeTool } from "@opencode/core/codemode/tool";
import { Config } from "@opencode/core/config";
import { Database } from "@opencode/core/database/database";
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder";
import { Environment } from "@opencode/core/environment/index";
import { FileAccess } from "@opencode/core/file-access";
import { FileMutation } from "@opencode/core/file-mutation";
import { FileWrite } from "@opencode/core/file-write";
import { Watcher } from "@opencode/core/filesystem/watcher";
import { Flag } from "@opencode/core/flag";
import { Job } from "@opencode/core/job";
import { KV } from "@opencode/core/kv";
import { Location } from "@opencode/core/location";
import { Permission } from "@opencode/core/permission";
import { PersistentPty } from "@opencode/core/persistent-pty";
import { PluginHost } from "@opencode/core/plugin/host";
import { AbsolutePath } from "@opencode/core/schema";
import { Session } from "@opencode/core/session";
import { SessionMessage } from "@opencode/core/session/message";
import { Shell } from "@opencode/core/shell";
import { ShellSelect } from "@opencode/core/shell/select";
import { Tool } from "@opencode/core/tool";
import { ShellTool } from "@opencode/core/tool/plugin/shell";
import { Workspace } from "@opencode/core/workspace";
import type { Plugin } from "@opencode/plugin/effect";
import { Document, Info } from "@opencode/schema/config";
import { ConfigToolOutput } from "@opencode/schema/config/tool-output";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { Global } from "@opencode/util/global";
import { Cause, Effect, Exit, Layer, References, Scope } from "effect";

import plugin from "../index.js";
import type { JsonValue } from "../src/types.js";

type HookEvent = Parameters<Parameters<Plugin.Context["tool"]["hook"]>[1]>[0];

export type BeforeEvent = Exclude<HookEvent, { status: string }>;

export interface HostOptions {
  /** Plugin options passed through the real host context. */
  readonly options?: Plugin.Context["options"];
  /** Session and host location directory. */
  readonly directory: string;
  /** Enable the `full_codemode` flag. */
  readonly codemode?: boolean;
  /** Bind the host location to a remote workspace. */
  readonly workspace?: string;
  /** Shared SQLite database file; defaults to a private in-memory database. */
  readonly database?: string;
  /** Session ID shared with another host over the same database. */
  readonly sessionID?: Session.ID;
  /** Workspace of the created session location; defaults to the host workspace. */
  readonly sessionWorkspace?: string;
  /** Shell tool output byte limit from OpenCode configuration. */
  readonly maxOutputBytes?: number;
  /** Registers host hooks before the plugin loads, so they run first. */
  readonly setup?: (
    ctx: Plugin.Context
  ) => Effect.Effect<unknown, never, Scope.Scope>;
}

const root = LayerNode.group([
  PluginHost.requirements,
  Config.node,
  Environment.node,
  FileAccess.node,
  FileMutation.node,
  FileWrite.node,
  Flag.node,
  Job.node,
  Shell.node,
  Shell.daemonNode,
  ShellSelect.node,
]);

const disabledPty = Layer.mock(PersistentPty.Service, {
  createPipe: () =>
    Effect.fail(
      new PersistentPty.UnavailableError({ message: "process daemon disabled" })
    ),
  listPipes: () => Effect.succeed([]),
  handoffPrepared: () => false,
});

const agent = Agent.ID.make("build");

const toError = (cause: Cause.Cause<unknown>): Error => {
  const failure = Cause.findErrorOption(cause);
  const value = failure._tag === "Some" ? failure.value : Cause.squash(cause);

  return value instanceof Error
    ? value
    : new Error("Host call failed", { cause: value });
};

export const createHost = async (input: HostOptions) => {
  const directory = mkdtempSync(path.join(tmpdir(), "commit-guard-host-"));
  const scope = await Effect.runPromise(Scope.make());
  const gitConfig = path.join(directory, "gitconfig");
  let closed = false;
  let failStorage = false;
  const denied = new Set<string>();

  writeFileSync(gitConfig, "");

  const close = async () => {
    if (closed) {
      return;
    }

    closed = true;

    try {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };

  try {
    const layer = AppNodeBuilder.build(root, [
      Global.node.replace(
        Global.layerWith({
          home: directory,
          data: path.join(directory, "data"),
          cache: path.join(directory, "cache"),
          config: path.join(directory, "config"),
          state: path.join(directory, "state"),
          tmp: path.join(directory, "tmp"),
          bin: path.join(directory, "bin"),
          log: path.join(directory, "log"),
          repos: path.join(directory, "repos"),
        })
      ),
      Config.node.replace(
        Config.testLayer(
          input.maxOutputBytes === undefined
            ? []
            : [
                new Document({
                  type: "document",
                  info: new Info({
                    tool_output: new ConfigToolOutput.Info({
                      max_bytes: input.maxOutputBytes,
                    }),
                  }),
                }),
              ]
        )
      ),
      Watcher.node.replace(Watcher.testLayer),
      PersistentPty.node.replace(disabledPty),
      ...(input.database === undefined
        ? []
        : [
            Database.node.replace(
              Database.configured({ path: input.database })
            ),
          ]),
      Location.node.replace(
        Location.boundNode(
          Location.Ref.make({
            directory: AbsolutePath.make(input.directory),
            workspaceID:
              input.workspace === undefined
                ? undefined
                : Workspace.ID.make(input.workspace),
          })
        )
      ),
      KV.node.replace(
        KV.node.mapLayer((original) =>
          Layer.effect(
            KV.Service,
            Effect.gen(function* injectedKV() {
              const kv = yield* KV.Service;

              return {
                ...kv,
                set: (key, value) =>
                  failStorage && key.includes("snap/")
                    ? Effect.die(new Error("Storage unavailable"))
                    : kv.set(key, value),
              };
            })
          ).pipe(Layer.provide(original))
        )
      ),
      Permission.node.replace(
        Permission.node.mapLayer((original) =>
          Layer.effect(
            Permission.Service,
            Effect.gen(function* permissionLayer() {
              const service = yield* Permission.Service;

              // Skip permission prompts; deny only the configured actions.
              return {
                ...service,
                assert: (request) =>
                  denied.has(request.action)
                    ? Effect.fail(
                        new Permission.BlockedError({
                          rules: [],
                          permission: request.action,
                          resources: request.resources,
                        })
                      )
                    : Effect.void,
              };
            })
          ).pipe(Layer.provide(original))
        )
      ),
    ]);

    const overrides = input.codemode === true ? "full_codemode" : undefined;

    const services = await Effect.runPromise(
      Layer.buildWithScope(layer, scope).pipe(
        Effect.provideService(Flag.Overrides, overrides),
        Effect.provideService(References.MinimumLogLevel, "None")
      )
    );

    const provide = <A, E>(
      effect: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>
    ) =>
      effect.pipe(
        Effect.provide(services),
        Scope.provide(scope),
        Effect.provideService(Flag.Overrides, overrides),
        Effect.provideService(References.MinimumLogLevel, "None")
      );

    const run = async <A, E>(
      effect: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>
    ) => {
      const exit = await Effect.runPromiseExit(provide(effect));

      if (Exit.isFailure(exit)) {
        throw toError(exit.cause);
      }

      return exit.value;
    };

    const ctx = await run(
      PluginHost.make({ list: () => Effect.succeed([]) }, plugin.id)
    );

    // Isolate Git in host shells from user, system, and inherited configuration.
    await run(
      ctx.shell.hook("create.before", (event) =>
        Effect.sync(() => {
          event.env.GIT_CONFIG_GLOBAL = gitConfig;
          event.env.GIT_CONFIG_NOSYSTEM = "1";
          event.env.GIT_CONFIG_COUNT = "0";
          event.env.GIT_CONFIG_PARAMETERS = undefined;
          event.env.GIT_AUTHOR_NAME = "Test";
          event.env.GIT_AUTHOR_EMAIL = "test@example.com";
          event.env.GIT_COMMITTER_NAME = "Test";
          event.env.GIT_COMMITTER_EMAIL = "test@example.com";
        })
      )
    );
    await run(ShellTool.Plugin.effect(ctx));

    if (input.setup !== undefined) {
      await run(input.setup(ctx));
    }

    const sessions = await run(Session.Service);

    const session =
      input.sessionID === undefined
        ? await run(
            sessions.create({
              location: Location.Ref.make({
                directory: AbsolutePath.make(input.directory),
                workspaceID:
                  input.sessionWorkspace === undefined
                    ? ctx.location.workspaceID
                    : Workspace.ID.make(input.sessionWorkspace),
              }),
            })
          )
        : await run(sessions.get(input.sessionID));

    let pluginScope: Scope.Closeable | undefined;

    // PluginHost.make passes empty options; supply the plugin entry options.
    const load = async (options: Plugin.Context["options"] = {}) => {
      const current = await Effect.runPromise(Scope.make());

      pluginScope = current;
      await run(Effect.addFinalizer(() => Scope.close(current, Exit.void)));
      await run(
        plugin.effect({ ...ctx, options }).pipe(Scope.provide(current))
      );
    };

    await load(input.options);

    const execute = async (name: string, callInput: JsonValue) => {
      const id = `call_${randomUUID()}`;

      return await run(
        Effect.gen(function* executeCall() {
          const tools = yield* Tool.Service;

          const snapshot = yield* tools.snapshot(
            undefined,
            overrides === undefined
              ? undefined
              : { services: yield* CodeModeTool.services }
          );

          return yield* snapshot.execute({
            sessionID: session.id,
            agent,
            messageID: SessionMessage.ID.make(`msg_${id}`),
            call: { type: "tool-call", id, name, input: callInput },
          });
        })
      );
    };

    return {
      session: session.id,
      close,
      execute,
      unload: async () => {
        if (pluginScope !== undefined) {
          await Effect.runPromise(Scope.close(pluginScope, Exit.void));
        }
      },
      reload: load,
      failStorage: () => {
        failStorage = true;
      },
      deny: (action: string) => {
        denied.add(action);
      },
      hook: async (
        name: "execute.before",
        handler: (event: BeforeEvent) => Effect.Effect<void>
      ) => {
        await run(ctx.tool.hook(name, handler));
      },
      move: async (target: string) => {
        await run(
          sessions.move({
            sessionID: session.id,
            directory: AbsolutePath.make(target),
          })
        );

        // The session runner applies a move at its next step boundary.
        const settle = async (remaining: number): Promise<void> => {
          const moved = await run(sessions.get(session.id));

          if (moved.location.directory === target) {
            return;
          }

          if (remaining === 0) {
            throw new Error(`Session did not move to ${target}`);
          }

          await Bun.sleep(10);
          await settle(remaining - 1);
        };

        await settle(500);
      },
      removeSession: async () => {
        await run(sessions.remove(session.id));
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
};

export type Host = Awaited<ReturnType<typeof createHost>>;
