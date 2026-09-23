import {
  defaultConfig,
  isJSONBoolean,
  isJSONNumber,
  isJSONString,
  isRecord,
} from "./types.js"
import type { CommitGuardConfig, JsonValue } from "./types.js"

export function parseConfig(options: JsonValue | undefined): CommitGuardConfig {
  if (options === undefined) {
    return defaultConfig
  }

  if (!isRecord(options)) {
    throw new Error("Invalid plugin options; expected an object.")
  }

  const rawRequireScope = options["requireScope"]
  let requireScope = defaultConfig.requireScope

  if (rawRequireScope !== undefined) {
    if (!isJSONBoolean(rawRequireScope)) {
      throw new Error("Invalid plugin option requireScope; expected a boolean.")
    }

    requireScope = rawRequireScope
  }

  const rawAllowedScopes = options["allowedScopes"]
  let allowedScopes: readonly string[] | undefined = defaultConfig.allowedScopes

  if (rawAllowedScopes !== undefined) {
    if (!Array.isArray(rawAllowedScopes)) {
      throw new Error("Invalid plugin option allowedScopes; expected an array of non-empty strings.")
    }

    const scopes: string[] = []

    for (const item of rawAllowedScopes) {
      if (!isJSONString(item) || item.trim().length === 0) {
        throw new Error("Invalid plugin option allowedScopes; expected an array of non-empty strings.")
      }

      scopes.push(item.trim())
    }

    allowedScopes = scopes.length > 0 ? scopes : undefined
  }

  const rawMaxLineLength = options["maxLineLength"]
  let maxLineLength = defaultConfig.maxLineLength

  if (rawMaxLineLength !== undefined) {
    if (!isJSONNumber(rawMaxLineLength) || !Number.isSafeInteger(rawMaxLineLength) || rawMaxLineLength < 0) {
      throw new Error("Invalid plugin option maxLineLength; expected an integer greater than or equal to 0.")
    }

    // SAFETY: isJSONNumber and Number.isSafeInteger verify rawMaxLineLength is an integer number.
    maxLineLength = rawMaxLineLength as number
  }

  if (options["requireSignoff"] !== undefined) {
    throw new Error("Plugin option requireSignoff has been removed; signoff follows the captured effective commit.gpgsign value.")
  }

  return {
    requireScope,
    allowedScopes,
    maxLineLength,
    enforceSignoff: defaultConfig.enforceSignoff,
  }
}
