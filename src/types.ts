export type JsonPrimitive = string | number | boolean | null

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { readonly [key: string]: JsonValue | undefined }

export function isJSONString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

export function isJSONNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]"
}

export function isJSONBoolean(value: JsonValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]"
}

export function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value instanceof Object && !Array.isArray(value)
}

export interface CommitGuardConfig {
  readonly requireScope: boolean
  readonly allowedScopes?: readonly string[]
  readonly maxLineLength: number
  readonly requireSignoff: boolean
}

export const defaultConfig: CommitGuardConfig = {
  requireScope: true,
  allowedScopes: undefined,
  maxLineLength: 72,
  requireSignoff: true,
}

export type ShellTokenType = "word" | "operator" | "redirect"

export interface ShellToken {
  readonly type: ShellTokenType
  readonly value: string
  readonly substitutions?: readonly string[]
}

export interface GitCommitInvocation {
  readonly messages: readonly string[]
  readonly filePaths: readonly string[]
  readonly hasSignoffFlag: boolean
  readonly isAmend: boolean
  readonly hasNoEdit?: boolean
  readonly isFixup?: boolean
  readonly isHelp: boolean
  readonly directoryChanges?: readonly string[]
}

export interface OverlongLine {
  readonly lineNumber: number
  readonly length: number
  readonly text: string
}
