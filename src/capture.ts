import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { gzipSync } from "node:zlib";

import type { Plugin } from "@opencode/plugin/effect";
import { Effect, Semaphore } from "effect";

import { isJSONString, isRecord } from "./types.js";
import type { CommitGuardConfig, JsonValue } from "./types.js";

const { dirname, isAbsolute, join, relative, resolve } = nodePath;

const version = 1;

const maxBytes = 262_144;

export const captureTimeout = 20_000;

const policy = "commit-guard-context-v1";

const storageLock = Semaphore.makeUnsafe(1);

type Context = Parameters<Plugin.Plugin["effect"]>[0];

export interface Baseline {
  readonly directory: string;
  readonly workdir: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly messages: readonly string[];
  readonly gpgsign: "true" | "false" | "unset" | "error";
  readonly signingkey: string | null;
}

export interface Pending {
  readonly scope: string;
  readonly command: string;
  readonly directory: string;
  readonly workdir: string;
  readonly fd: number;
  readonly identity: { dev: number; ino: number; uid: number };
  expires: number;
  readonly counter: number;
  readonly agent: string;
  readonly sessionID: string;
  claimed?: { messageID: string; id: string };
  closed?: boolean;
}

const digest = function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
};

export const scopeFor = function scopeFor(
  ctx: Context,
  sessionID: string,
  config: CommitGuardConfig,
  targetDir?: string
): string {
  const { location } = ctx;

  const directory = targetDir ?? location.directory;
  const root = findGitRoot(directory) ?? realpathSync(directory);

  return digest(
    JSON.stringify([
      version,
      location.project.id,
      sessionID,
      root,
      location.workspaceID ?? null,
      policy,
      config.requireScope,
      config.allowedScopes ?? null,
      config.maxLineLength,
    ])
  );
};

export const isGitDirectory = function isGitDirectory(dir: string): boolean {
  try {
    return existsSync(join(dir, ".git"));
  } catch {
    return false;
  }
};

export const findGitRoot = function findGitRoot(
  startDir: string
): string | undefined {
  let current: string;

  try {
    current = realpathSync(startDir);
  } catch {
    return undefined;
  }

  while (true) {
    if (isGitDirectory(current)) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return undefined;
};

export interface ResolvedTargetWorkdir {
  readonly workdir?: string;
  readonly error?: string;
}

export const findSubRepos = function findSubRepos(
  dir: string,
  maxDepth = 2
): string[] {
  const repos: string[] = [];

  const search = function search(
    currentDir: string,
    currentDepth: number
  ): void {
    if (currentDepth > maxDepth) {
      return;
    }

    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }

        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "dist"
        ) {
          continue;
        }

        const fullPath = join(currentDir, entry.name);

        if (isGitDirectory(fullPath)) {
          repos.push(fullPath);
        } else if (currentDepth < maxDepth) {
          search(fullPath, currentDepth + 1);
        }
      }
    } catch {
      // Inaccessible directory
    }
  };

  search(dir, 1);

  return repos;
};

export const resolveTargetWorkdir = function resolveTargetWorkdir(
  baseDir: string,
  requestedDir?: string
): ResolvedTargetWorkdir {
  if (requestedDir !== undefined) {
    const resolvedDir = resolve(baseDir, requestedDir);

    if (!existsSync(resolvedDir)) {
      return { error: `Directory "${requestedDir}" does not exist.` };
    }

    try {
      if (!statSync(resolvedDir).isDirectory()) {
        return { error: `Path "${requestedDir}" is not a directory.` };
      }
    } catch {
      return { error: `Could not access directory "${requestedDir}".` };
    }

    const gitRoot = findGitRoot(resolvedDir);

    if (gitRoot === undefined) {
      return {
        error: `Directory "${requestedDir}" is not a Git repository or inside one.`,
      };
    }

    return { workdir: realpathSync(resolvedDir) };
  }

  const currentGitRoot = findGitRoot(baseDir);

  if (currentGitRoot !== undefined) {
    return { workdir: realpathSync(baseDir) };
  }

  const subRepos = findSubRepos(baseDir);

  if (subRepos.length === 1) {
    return { workdir: realpathSync(subRepos[0]) };
  }

  if (subRepos.length === 0) {
    return {
      error: `No Git repository found in ${baseDir}. Specify the repository directory with the 'workdir' option, for example: commit_context({ workdir: "path/to/repo" }).`,
    };
  }

  const repoList = subRepos.map((repo) => relative(baseDir, repo)).join(", ");

  return {
    error: `The directory ${baseDir} is not a Git repository. Multiple Git repositories were found: ${repoList}.\nSpecify which repository to target with the 'workdir' option, for example:\ncommit_context({ workdir: "${relative(baseDir, subRepos[0])}" })`,
  };
};

const counterKey = function counterKey(scope: string): string {
  return `counter/${scope}`;
};

const prefix = function prefix(scope: string): string {
  return `snap/${scope}/`;
};

export const counter = function counter(
  ctx: Context,
  scope: string
): Effect.Effect<number> {
  return Effect.gen(function* readCounter() {
    const value = yield* ctx.storage.get(counterKey(scope));

    if (value === undefined) {
      return 0;
    }

    return Number.isSafeInteger(value) && Number(value) >= 0
      ? Number(value)
      : -1;
  });
};

export const invalidate = function invalidate(
  ctx: Context,
  scope: string
): Effect.Effect<number> {
  return storageLock.withPermits(1)(
    Effect.gen(function* incrementCounter() {
      const previous = yield* counter(ctx, scope);

      const next = previous < 0 ? 1 : previous + 1;

      yield* ctx.storage.set(counterKey(scope), next);

      return next;
    })
  );
};

export const invalidateOwned = function invalidateOwned(
  ctx: Context,
  attempt: Pending
): Effect.Effect<void> {
  return storageLock.withPermits(1)(
    Effect.gen(function* invalidateAttempt() {
      if ((yield* counter(ctx, attempt.scope)) === attempt.counter) {
        yield* ctx.storage.set(counterKey(attempt.scope), attempt.counter + 1);
      }
    })
  );
};

export type CaptureState =
  | "prepared"
  | "claimed"
  | "published"
  | "expired"
  | "failed";

export const recordState = function recordState(
  ctx: Context,
  attempt: Pending,
  state: CaptureState,
  reason = ""
): Effect.Effect<void> {
  return storageLock.withPermits(1)(
    Effect.gen(function* storeState() {
      if ((yield* counter(ctx, attempt.scope)) !== attempt.counter) {
        return;
      }

      yield* ctx.storage.set(`state/${attempt.scope}`, {
        state,
        reason: reason.slice(0, 256),
      });
    })
  );
};

export const captureStatus = function captureStatus(
  ctx: Context,
  scope: string
): Effect.Effect<string> {
  return Effect.gen(function* readCaptureStatus() {
    // SAFETY: Plugin storage contains JSON; validate the record before reading its fields.
    const value = yield* ctx.storage.get(`state/${scope}`);

    if (!isRecord(value)) {
      return "";
    }

    if (value.state === "expired") {
      return "The previous capture expired before its command was claimed; no matching shell result was observed. ";
    }

    if (value.state === "failed" && isJSONString(value.reason)) {
      return `The previous capture failed: ${value.reason}. `;
    }

    if (value.state === "prepared" || value.state === "claimed") {
      return "The previous capture was interrupted before publication. ";
    }

    return "";
  });
};

const validBaseline = function validBaseline(
  value: JsonValue | undefined
): value is Baseline & Record<string, JsonValue> {
  if (!isRecord(value)) {
    return false;
  }

  return (
    ["directory", "workdir", "gitDir", "commonDir"].every((key) =>
      isJSONString(value[key])
    ) &&
    (value.branch === null || isJSONString(value.branch)) &&
    (value.head === null ||
      (isJSONString(value.head) && /^[0-9a-f]{40,64}$/u.test(value.head))) &&
    Array.isArray(value.messages) &&
    value.messages.length <= 10 &&
    value.messages.every((message: JsonValue) => isJSONString(message)) &&
    isJSONString(value.gpgsign) &&
    ["true", "false", "unset", "error"].includes(value.gpgsign) &&
    (value.signingkey === null ||
      value.signingkey === "error" ||
      isJSONString(value.signingkey))
  );
};

export const load = function load(
  ctx: Context,
  scope: string
): Effect.Effect<Baseline | undefined> {
  return storageLock.withPermits(1)(
    Effect.gen(function* readBaseline() {
      const current = yield* counter(ctx, scope);

      if (current < 0) {
        return yield* Effect.succeed(undefined);
      }

      let after: string | undefined;
      let newest: { sequence: string; baseline: Baseline } | undefined;

      do {
        const page = yield* ctx.storage.scan({
          prefix: prefix(scope),
          after,
          limit: 100,
        });

        for (const record of page.entries) {
          // SAFETY: Storage returns arbitrary JSON that is checked before reading any entry fields.
          const raw = record.value;

          if (
            !isRecord(raw) ||
            raw.schema !== version ||
            raw.scope !== scope ||
            raw.counter !== current ||
            !isJSONString(raw.generation) ||
            !isJSONString(raw.sequence) ||
            !isJSONString(raw.checksum) ||
            !validBaseline(raw.baseline)
          ) {
            continue;
          }

          const { baseline } = raw;

          if (
            digest(
              JSON.stringify([
                version,
                scope,
                current,
                raw.generation,
                raw.sequence,
                baseline,
              ])
            ) !== raw.checksum
          ) {
            continue;
          }

          if (newest === undefined || raw.sequence > newest.sequence) {
            newest = { sequence: raw.sequence, baseline };
          }
        }

        after = page.next;
      } while (after !== undefined);

      return newest?.baseline;
    })
  );
};

// Each line is a base64-encoded Git result. No Git output enters the shell result.
const captureCommand = function captureCommand(path: string): string {
  if (process.platform === "win32") {
    return windowsCaptureCommand(path);
  }

  const quoted = `'${path.replaceAll("'", "'\\''")}'`;

  const script = `set -euo pipefail
ulimit -f 256
out=$1
printf "CTX1\\n" > "$out"
field() { "$@" 2>/dev/null | base64 | tr -d "\\r\\n" >> "$out"; printf "\\n" >> "$out"; }
field git rev-parse --show-toplevel
field git rev-parse --absolute-git-dir
field git rev-parse --path-format=absolute --git-common-dir
if git symbolic-ref -q --short HEAD >/dev/null 2>&1; then printf "branch\\n" >> "$out"; field git symbolic-ref -q --short HEAD; else status=$?; if [ "$status" -ne 1 ]; then exit "$status"; fi; printf "detached\\n\\n" >> "$out"; fi
if git rev-parse --verify HEAD >/dev/null 2>&1; then printf "head\\n" >> "$out"; field git rev-parse --verify HEAD; field git log -10 -z --format=%B%x00; else status=$?; if [ "$status" -ne 128 ] || ! git symbolic-ref -q HEAD >/dev/null 2>&1 || ! git status --porcelain >/dev/null 2>&1; then exit 1; fi; printf "unborn\\n\\n\\n" >> "$out"; fi
if git config --type=bool --get commit.gpgsign >/dev/null 2>&1; then printf "set\\n" >> "$out"; field git config --type=bool --get commit.gpgsign; else status=$?; if [ "$status" -eq 1 ]; then printf "unset\\n\\n" >> "$out"; else printf "error\\n\\n" >> "$out"; fi; fi
if git config --get user.signingkey >/dev/null 2>&1; then printf "set\\n" >> "$out"; field git config --get user.signingkey; else status=$?; if [ "$status" -eq 1 ]; then printf "unset\\n\\n" >> "$out"; else printf "error\\n\\n" >> "$out"; fi; fi
printf "END\\n" >> "$out"
printf "RECEIPT_OK\\n"`;

  // Bash job control assigns a process group to the worker, including its Git children.
  return `bash -c 'set -m
bash -c "$1" bash "$2" &
worker=$!
(
  sleep 15 &
  timer=$!
  trap "kill $timer 2>/dev/null" EXIT
  trap "exit 0" TERM
  wait "$timer"
  kill -KILL -- "-$worker" 2>/dev/null
) &
watchdog=$!
wait "$worker"
status=$?
kill "$watchdog" 2>/dev/null
wait "$watchdog" 2>/dev/null
exit "$status"' bash '${script.replaceAll("'", "'\\''")}' ${quoted} 2>/dev/null`;
};

const windowsCaptureCommand = function windowsCaptureCommand(
  path: string
): string {
  // EncodedCommand avoids quoting differences between cmd, PowerShell, and Git Bash.
  const script = `$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$lines = [Collections.Generic.List[string]]::new()
$lines.Add('CTX1')
function gitResult([string]$arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new('git', $arguments)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $p = [Diagnostics.Process]::new()
  $p.StartInfo = $info
  $memory = [IO.MemoryStream]::new()
  try {
    if (!$p.Start()) { throw 'Git did not start' }
    $p.BeginErrorReadLine()
    $buffer = [byte[]]::new(4096)
    while ($true) {
      $task = $p.StandardOutput.BaseStream.ReadAsync($buffer, 0, $buffer.Length)
      $remaining = 15000 - [int]$clock.ElapsedMilliseconds
      if ($remaining -le 0 -or !$task.Wait($remaining)) { throw 'Capture timed out' }
      $count = $task.Result
      if ($count -eq 0) { break }
      if ($memory.Length + $count -gt ${maxBytes}) { throw 'Capture exceeds size limit' }
      $memory.Write($buffer, 0, $count)
    }
    $remaining = 15000 - [int]$clock.ElapsedMilliseconds
    if ($remaining -le 0 -or !$p.WaitForExit($remaining)) { throw 'Capture timed out' }
    return @{ Code = $p.ExitCode; Bytes = $memory.ToArray() }
  } finally {
    if ($p.Id -and !$p.HasExited) { & taskkill.exe /PID $p.Id /T /F > $null 2>&1 }
    $p.Dispose()
    $memory.Dispose()
  }
}
function field([string]$arguments) {
  $result = gitResult $arguments
  if ($result.Code -ne 0) { throw 'Git capture failed' }
  $lines.Add([Convert]::ToBase64String($result.Bytes))
}
try {
  field 'rev-parse --show-toplevel'
  field 'rev-parse --absolute-git-dir'
  field 'rev-parse --path-format=absolute --git-common-dir'
  $branch = gitResult 'symbolic-ref -q --short HEAD'
  if ($branch.Code -eq 0) { $lines.Add('branch'); $lines.Add([Convert]::ToBase64String($branch.Bytes)) }
  elseif ($branch.Code -eq 1) { $lines.Add('detached'); $lines.Add('') }
  else { throw 'Invalid branch' }
  $head = gitResult 'rev-parse --verify HEAD'
  if ($head.Code -eq 0) {
    $lines.Add('head'); $lines.Add([Convert]::ToBase64String($head.Bytes))
    field 'log -10 -z --format=%B%x00'
  } elseif ($head.Code -eq 128 -and (gitResult 'symbolic-ref -q HEAD').Code -eq 0 -and (gitResult 'status --porcelain').Code -eq 0) {
    $lines.Add('unborn'); $lines.Add(''); $lines.Add('')
  } else { throw 'Invalid HEAD' }
  foreach ($arguments in @('config --type=bool --get commit.gpgsign', 'config --get user.signingkey')) {
    $result = gitResult $arguments
    if ($result.Code -eq 0) { $lines.Add('set'); $lines.Add([Convert]::ToBase64String($result.Bytes)) }
    elseif ($result.Code -eq 1) { $lines.Add('unset'); $lines.Add('') }
    else { $lines.Add('error'); $lines.Add('') }
  }
  $lines.Add('END')
  $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "\`n") + "\`n")
  if ($bytes.Length -gt ${maxBytes} -or $clock.ElapsedMilliseconds -ge 15000) { throw 'Capture exceeds limits' }
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(path).toString("base64")}'))
  $file = [IO.FileStream]::new($path, [IO.FileMode]::Truncate, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
  try { $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
  [Console]::Write("RECEIPT_OK\`n")
} catch { exit 1 }`;

  // Compress the script to stay below cmd.exe's 8191-character command limit.
  const compressed = gzipSync(Buffer.from(script)).toString("base64");
  const bootstrap = `$m = [IO.MemoryStream]::new([Convert]::FromBase64String('${compressed}')); $g = [IO.Compression.GZipStream]::new($m, [IO.Compression.CompressionMode]::Decompress); $r = [IO.StreamReader]::new($g, [Text.Encoding]::UTF8); try { Invoke-Expression $r.ReadToEnd() } finally { $r.Dispose(); $g.Dispose(); $m.Dispose() }`;

  return `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(bootstrap, "utf16le").toString("base64")}`;
};

export const createPending = function createPending(
  scope: string,
  sessionID: string,
  agent: string,
  counterValue: number,
  workdir: string
): Pending {
  const directory = mkdtempSync(join(tmpdir(), "commit-context-"));

  try {
    const file = join(directory, randomUUID());

    const fd = openSync(
      file,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_RDWR,
      0o600
    );

    const stat = fstatSync(fd);

    return {
      scope,
      sessionID,
      agent,
      counter: counterValue,
      directory,
      workdir,
      fd,
      identity: { dev: stat.dev, ino: stat.ino, uid: stat.uid },
      expires: Date.now() + captureTimeout,
      command: captureCommand(file),
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
};

export const cleanup = function cleanup(pending: Pending): void {
  if (pending.closed === true) {
    return;
  }

  pending.closed = true;
  closeSync(pending.fd);
  rmSync(pending.directory, { recursive: true, force: true });
};

const decode = function decode(line: string): string {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      line
    )
  ) {
    throw new Error("Invalid capture framing");
  }

  return Buffer.from(line, "base64").toString("utf-8");
};

export const importCapture = function importCapture(
  pending: Pending
): Baseline {
  const readArtifact = () => {
    const stat = fstatSync(pending.fd);

    if (
      !stat.isFile() ||
      stat.dev !== pending.identity.dev ||
      stat.ino !== pending.identity.ino ||
      stat.uid !== pending.identity.uid ||
      (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) ||
      stat.size > maxBytes ||
      stat.size === 0
    ) {
      throw new Error("Invalid private capture artifact");
    }

    const bytes = Buffer.alloc(stat.size);

    if (readSync(pending.fd, bytes, 0, stat.size, 0) !== stat.size) {
      throw new Error("Incomplete private capture artifact");
    }

    const completed = fstatSync(pending.fd);

    if (
      completed.size !== stat.size ||
      completed.dev !== stat.dev ||
      completed.ino !== stat.ino
    ) {
      throw new Error("Capture changed during import");
    }

    return bytes;
  };

  const bytes = readArtifact();

  const fields = bytes.toString("utf-8").split("\n");

  if (
    fields.length !== 15 ||
    fields[0] !== "CTX1" ||
    fields[13] !== "END" ||
    fields[14] !== ""
  ) {
    throw new Error("Incomplete capture");
  }

  const rawRoot = decode(fields[1]).trimEnd();
  const root = isAbsolute(rawRoot) ? realpathSync(resolve(rawRoot)) : rawRoot;
  const gitDir = decode(fields[2]).trimEnd();
  const commonDir = decode(fields[3]).trimEnd();
  const branch = fields[4] === "branch" ? decode(fields[5]).trimEnd() : null;
  const head = fields[6] === "head" ? decode(fields[7]).trim() : null;
  const rawLog = decode(fields[8]);

  const messages =
    head === null
      ? []
      : rawLog.split("\0\0").filter((message) => message.length > 0);

  const validateIdentity = () => {
    if (
      !isAbsolute(root) ||
      !isAbsolute(gitDir) ||
      !isAbsolute(commonDir) ||
      root !== findGitRoot(pending.workdir) ||
      !["branch", "detached"].includes(fields[4]) ||
      !["head", "unborn"].includes(fields[6]) ||
      (head !== null && !/^[a-f0-9]{40,64}$/u.test(head)) ||
      (head === null && rawLog !== "") ||
      (head !== null &&
        (messages.length === 0 ||
          messages.length > 10 ||
          !rawLog.endsWith("\0\0")))
    ) {
      throw new Error("Invalid Git baseline");
    }
  };

  validateIdentity();

  const [configState] = fields.slice(9);
  const value = decode(fields[10]).trim();

  const readSigningPolicy = (): Baseline["gpgsign"] => {
    if (configState === "set" && (value === "true" || value === "false")) {
      return value;
    }

    return configState === "unset" ? "unset" : "error";
  };

  const readSigningKey = () => {
    if (fields[11] === "set") {
      return decode(fields[12]).trim();
    }

    return fields[11] === "unset" ? null : "error";
  };

  const gpgsign = readSigningPolicy();
  const signingkey = readSigningKey();

  return {
    directory: root,
    workdir: pending.workdir,
    gitDir,
    commonDir,
    branch,
    head,
    messages,
    gpgsign,
    signingkey,
  };
};

export const publish = function publish(
  ctx: Context,
  pending: Pending,
  generation: string,
  baseline: Baseline
): Effect.Effect<boolean> {
  return storageLock.withPermits(1)(
    Effect.gen(function* writeBaseline() {
      if ((yield* counter(ctx, pending.scope)) !== pending.counter) {
        return false;
      }

      const sequence = `${Date.now().toString().padStart(15, "0")}-${randomUUID()}`;

      const checksum = digest(
        JSON.stringify([
          version,
          pending.scope,
          pending.counter,
          generation,
          sequence,
          baseline,
        ])
      );

      yield* ctx.storage.set(prefix(pending.scope) + sequence, {
        schema: version,
        scope: pending.scope,
        counter: pending.counter,
        generation,
        sequence,
        checksum,
        baseline: { ...baseline, messages: [...baseline.messages] },
      });

      let after: string | undefined;

      do {
        const page = yield* ctx.storage.scan({
          prefix: prefix(pending.scope),
          after,
          limit: 100,
        });

        for (const record of page.entries) {
          if (record.key < prefix(pending.scope) + sequence) {
            yield* ctx.storage.remove(record.key);
          }
        }

        after = page.next;
      } while (after !== undefined);

      return true;
    })
  );
};
