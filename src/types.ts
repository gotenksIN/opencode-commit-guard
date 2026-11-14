import type { Schema } from "effect";

export type JsonValue = Schema.Json;

export const isJSONString = (value: unknown): value is string =>
  Object.prototype.toString.call(value) === "[object String]";

export const isJSONNumber = (value: unknown): value is number =>
  Object.prototype.toString.call(value) === "[object Number]";

export const isJSONBoolean = (value: unknown): value is boolean =>
  Object.prototype.toString.call(value) === "[object Boolean]";

export const isRecord = (
  value: unknown
): value is Record<string, JsonValue | undefined> =>
  Object.prototype.toString.call(value) === "[object Object]";

export interface CommitGuardConfig {
  readonly requireScope: boolean;
  readonly allowedScopes?: readonly string[];
  readonly maxLineLength: number;
  readonly enforceSignoff: boolean;
}

export const defaultConfig: CommitGuardConfig = {
  requireScope: true,
  allowedScopes: undefined,
  maxLineLength: 72,
  enforceSignoff: true,
};

export type ShellTokenType = "word" | "operator" | "redirect";

export interface ShellToken {
  readonly type: ShellTokenType;
  readonly value: string;
  readonly substitutions?: readonly string[];
  readonly expansion?: boolean;
  readonly heredoc?: { readonly body: string; readonly quoted: boolean };
}

export interface GitCommitInvocation {
  readonly messages: readonly string[];
  readonly filePaths: readonly string[];
  readonly stdinMessage?: string;
  readonly stdinError?: string;
  readonly hasSignoffFlag: boolean;
  readonly isAmend: boolean;
  readonly hasNoEdit?: boolean;
  readonly isFixup?: boolean;
  readonly isHelp: boolean;
  readonly targetError?: string;
  readonly messageExpansion?: boolean;
  readonly hasTrailer?: boolean;
}
