import { createHash, randomUUID } from "node:crypto"
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Semaphore } from "effect"
import { isJSONString, isRecord } from "./types.js"
import type { CommitGuardConfig, JsonValue } from "./types.js"

const version = 1

const maxBytes = 262144

const ttl = 20000

const policy = "commit-guard-context-v1"

const storageLock = Semaphore.makeUnsafe(1)

type Context = Parameters<Plugin.Plugin["effect"]>[0]

export interface Baseline {
  readonly directory: string
  readonly workdir: string
  readonly gitDir: string
  readonly commonDir: string
  readonly branch: string | null
  readonly head: string | null
  readonly messages: readonly string[]
  readonly gpgsign: "true" | "false" | "unset" | "error"
  readonly signingkey: string | null | "error"
}

interface Entry {
  readonly schema: number
  readonly scope: string
  readonly counter: number
  readonly generation: string
  readonly sequence: string
  readonly checksum: string
  readonly baseline: Baseline
}

export interface Pending {
  readonly scope: string
  readonly command: string
  readonly directory: string
  readonly workdir: string
  readonly file: string
  readonly fd: number
  readonly identity: { dev: number; ino: number; uid: number }
  readonly expires: number
  readonly counter: number
  readonly agent: string
  readonly sessionID: string
  claimed?: { messageID: string; id: string }
  closed?: boolean
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function scopeFor(ctx: Context, sessionID: string, config: CommitGuardConfig): string {
  const location = ctx.location

  return digest(JSON.stringify([version, location.project.id, sessionID, location.directory, location.workspaceID ?? null,
    policy, config.requireScope, config.allowedScopes ?? null, config.maxLineLength]))
}

function counterKey(scope: string): string { return `counter/${scope}` }

function prefix(scope: string): string { return `snap/${scope}/` }

export function counter(ctx: Context, scope: string): Effect.Effect<number> {
  return Effect.gen(function*() {
    const value = yield* ctx.storage.get(counterKey(scope))

    if (value === undefined) return 0

    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : -1
  })
}

export function invalidate(ctx: Context, scope: string): Effect.Effect<void> {
  return storageLock.withPermits(1)(Effect.gen(function*() {
    const previous = yield* counter(ctx, scope)

    yield* ctx.storage.set(counterKey(scope), previous < 0 ? 1 : previous + 1)
  }))
}

function validBaseline(value: JsonValue | undefined): value is Baseline & Record<string, JsonValue> {
  if (!isRecord(value)) return false

  return ["directory", "workdir", "gitDir", "commonDir"].every((key) => isJSONString(value[key])) &&
    (value["branch"] === null || isJSONString(value["branch"])) &&
    (value["head"] === null || /^[0-9a-f]{40,64}$/.test(String(value["head"]))) &&
    Array.isArray(value["messages"]) && value["messages"].length <= 10 &&
    value["messages"].every((message: JsonValue) => isJSONString(message)) &&
    ["true", "false", "unset", "error"].includes(String(value["gpgsign"])) &&
    (value["signingkey"] === null || value["signingkey"] === "error" || isJSONString(value["signingkey"]))
}

export function load(ctx: Context, scope: string): Effect.Effect<Baseline | undefined> {
  return storageLock.withPermits(1)(Effect.gen(function*() {
    const current = yield* counter(ctx, scope)

    if (current < 0) return undefined
    let after: string | undefined
    let newest: { sequence: string; baseline: Baseline } | undefined

    do {
      const page = yield* ctx.storage.scan({ prefix: prefix(scope), after, limit: 100 })

      for (const record of page.entries) {
        // SAFETY: Storage returns arbitrary JSON that is checked before reading any entry fields.
        const raw = record.value as JsonValue

        if (!isRecord(raw) || raw["schema"] !== version || raw["scope"] !== scope || raw["counter"] !== current ||
          !isJSONString(raw["generation"]) || !isJSONString(raw["sequence"]) || !isJSONString(raw["checksum"]) ||
          !validBaseline(raw["baseline"])) continue
        const baseline = raw["baseline"]

        if (digest(JSON.stringify([version, scope, current, raw["generation"], raw["sequence"], baseline])) !== raw["checksum"]) continue

        if (newest === undefined || raw["sequence"] > newest.sequence) newest = { sequence: raw["sequence"], baseline }
      }

      after = page.next
    } while (after !== undefined)

    return newest?.baseline
  }))
}

// Each line is a base64-encoded Git result. No Git output enters the shell result.
export function captureCommand(path: string): string {
  const quoted = `'${path.replaceAll("'", "'\\''")}'`

  return `timeout 15s bash -c 'set -euo pipefail
ulimit -f 256
out=$1
printf "CTX1\\n" > "$out"
field() { "$@" 2>/dev/null | base64 -w0 >> "$out"; printf "\\n" >> "$out"; }
field git rev-parse --show-toplevel
field git rev-parse --absolute-git-dir
field git rev-parse --path-format=absolute --git-common-dir
if git symbolic-ref -q --short HEAD >/dev/null 2>&1; then printf "branch\\n" >> "$out"; field git symbolic-ref -q --short HEAD; else printf "detached\\n\\n" >> "$out"; fi
if git rev-parse --verify HEAD >/dev/null 2>&1; then printf "head\\n" >> "$out"; field git rev-parse --verify HEAD; field git log -10 -z --format=%B%x00; else printf "unborn\\n\\n\\n" >> "$out"; fi
if git config --type=bool --get commit.gpgsign >/dev/null 2>&1; then printf "set\\n" >> "$out"; field git config --type=bool --get commit.gpgsign; else status=$?; if [ "$status" -eq 1 ]; then printf "unset\\n\\n" >> "$out"; else printf "error\\n\\n" >> "$out"; fi; fi
if git config --get user.signingkey >/dev/null 2>&1; then printf "set\\n" >> "$out"; field git config --get user.signingkey; else status=$?; if [ "$status" -eq 1 ]; then printf "unset\\n\\n" >> "$out"; else printf "error\\n\\n" >> "$out"; fi; fi
printf "END\\n" >> "$out"
printf "RECEIPT_OK\\n"' bash ${quoted} 2>/dev/null`
}

export function createPending(scope: string, sessionID: string, agent: string, counterValue: number, workdir: string): Pending {
  const directory = mkdtempSync(join(tmpdir(), "commit-context-"))

  try {
    const file = join(directory, randomUUID())
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600)
    const stat = fstatSync(fd)

    return { scope, sessionID, agent, counter: counterValue, directory, workdir, file, fd,
      identity: { dev: stat.dev, ino: stat.ino, uid: stat.uid }, expires: Date.now() + ttl,
      command: captureCommand(file) }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

export function cleanup(pending: Pending): void {
  if (pending.closed === true) return

  pending.closed = true
  closeSync(pending.fd)
  rmSync(pending.directory, { recursive: true, force: true })
}

function decode(line: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(line)) throw new Error("Invalid capture framing")

  return Buffer.from(line, "base64").toString("utf8")
}

export function importCapture(pending: Pending): Baseline {
  const stat = fstatSync(pending.fd)

  if (!stat.isFile() || stat.dev !== pending.identity.dev || stat.ino !== pending.identity.ino ||
    stat.uid !== pending.identity.uid || (stat.mode & 0o777) !== 0o600 || stat.size > maxBytes || stat.size === 0) {
    throw new Error("Invalid private capture artifact")
  }

  const bytes = Buffer.alloc(stat.size)

  if (readSync(pending.fd, bytes, 0, stat.size, 0) !== stat.size) throw new Error("Incomplete private capture artifact")

  const completed = fstatSync(pending.fd)

  if (completed.size !== stat.size || completed.dev !== stat.dev || completed.ino !== stat.ino) throw new Error("Capture changed during import")

  const fields = bytes.toString("utf8").split("\n")

  if (fields.length !== 15 || fields[0] !== "CTX1" || fields[13] !== "END" || fields[14] !== "") throw new Error("Incomplete capture")
  const root = decode(fields[1]!).trimEnd()
  const gitDir = decode(fields[2]!).trimEnd()
  const commonDir = decode(fields[3]!).trimEnd()
  const branch = fields[4] === "branch" ? decode(fields[5]!).trimEnd() : null
  const head = fields[6] === "head" ? decode(fields[7]!).trim() : null
  const rawLog = decode(fields[8]!)
  const messages = head === null ? [] : rawLog.split("\0\0").filter((message) => message.length > 0)

  if (!root.startsWith("/") || !gitDir.startsWith("/") || !commonDir.startsWith("/") ||
    relative(root, pending.workdir).startsWith("..") ||
    !["branch", "detached"].includes(fields[4]!) || !["head", "unborn"].includes(fields[6]!) ||
    (head !== null && !/^[a-f0-9]{40,64}$/.test(head)) ||
    (head === null && rawLog !== "") || (head !== null && (messages.length === 0 || messages.length > 10 || !rawLog.endsWith("\0\0")))) throw new Error("Invalid Git baseline")
  const configState = fields[9]
  const value = decode(fields[10]!).trim()

  const gpgsign = configState === "set" && (value === "true" || value === "false") ? value :
    configState === "unset" ? "unset" : "error"

  const signingkey = fields[11] === "set" ? decode(fields[12]!).trim() : fields[11] === "unset" ? null : "error"

  return { directory: root, workdir: pending.workdir, gitDir, commonDir, branch, head, messages, gpgsign, signingkey }
}

export function publish(ctx: Context, pending: Pending, generation: string, baseline: Baseline): Effect.Effect<boolean> {
  return storageLock.withPermits(1)(Effect.gen(function*() {
    if ((yield* counter(ctx, pending.scope)) !== pending.counter) return false
    const sequence = `${Date.now().toString().padStart(15, "0")}-${randomUUID()}`

    const entry: Entry = { schema: version, scope: pending.scope, counter: pending.counter, generation, sequence, baseline,
      checksum: digest(JSON.stringify([version, pending.scope, pending.counter, generation, sequence, baseline])) }

    yield* ctx.storage.set(prefix(pending.scope) + sequence, {
      schema: entry.schema, scope: entry.scope, counter: entry.counter, generation: entry.generation,
      sequence: entry.sequence, checksum: entry.checksum,
      baseline: { ...baseline, messages: [...baseline.messages] },
    })

    let after: string | undefined

    do {
      const page = yield* ctx.storage.scan({ prefix: prefix(pending.scope), after, limit: 100 })

      for (const record of page.entries) {
        if (record.key < prefix(pending.scope) + sequence) yield* ctx.storage.remove(record.key)
      }

      after = page.next
    } while (after !== undefined)

    return true
  }))
}
