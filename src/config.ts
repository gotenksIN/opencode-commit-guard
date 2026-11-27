import type { Plugin } from "@opencode/plugin/effect";

import { scopePattern } from "./scope.js";
import {
  defaultConfig,
  isJSONBoolean,
  isJSONNumber,
  isJSONString,
  isRecord,
} from "./types.js";
import type { CommitGuardConfig, JsonValue } from "./types.js";

export const parseConfig = (
  options: Plugin.Context["options"] | JsonValue | undefined
) => {
  if (options === undefined) {
    return defaultConfig;
  }

  if (!isRecord(options)) {
    throw new Error("Invalid plugin options; expected an object.");
  }

  if (options.requireSignoff !== undefined) {
    throw new Error(
      "Plugin option requireSignoff has been removed; signoff follows the captured effective commit.gpgsign value. Valid options: requireScope, allowedScopes, maxLineLength."
    );
  }

  const validOptions = ["requireScope", "allowedScopes", "maxLineLength"];

  const unknownKeys = Object.keys(options).filter(
    (key) => !validOptions.includes(key)
  );

  if (unknownKeys.length > 0) {
    throw new Error(
      `Unrecognized plugin options: ${unknownKeys.join(", ")}. Valid options: ${validOptions.join(", ")}.`
    );
  }

  const {
    requireScope = defaultConfig.requireScope,
    maxLineLength = defaultConfig.maxLineLength,
    allowedScopes: rawScopes,
  } = options;

  if (!isJSONBoolean(requireScope)) {
    throw new Error("Invalid plugin option requireScope; expected a boolean.");
  }

  if (
    !isJSONNumber(maxLineLength) ||
    !Number.isSafeInteger(maxLineLength) ||
    maxLineLength < 0
  ) {
    throw new Error(
      "Invalid plugin option maxLineLength; expected an integer greater than or equal to 0."
    );
  }

  let allowedScopes: string[] | undefined;

  if (rawScopes !== undefined) {
    if (!Array.isArray(rawScopes)) {
      throw new TypeError(
        "Invalid plugin option allowedScopes; expected an array of non-empty strings."
      );
    }

    const scopes: string[] = [];

    for (const item of rawScopes) {
      if (!isJSONString(item) || item.trim().length === 0) {
        throw new Error(
          "Invalid plugin option allowedScopes; expected an array of non-empty strings."
        );
      }

      const trimmed = item.trim();

      if (scopePattern.exec(`${trimmed}: Subject`)?.[1] !== trimmed) {
        throw new Error(
          `Invalid plugin option allowedScopes; scope ${JSON.stringify(item)} cannot match the commit scope syntax.`
        );
      }

      scopes.push(trimmed);
    }

    allowedScopes = scopes.length > 0 ? scopes : undefined;
  }

  return {
    requireScope,
    allowedScopes,
    maxLineLength,
    enforceSignoff: defaultConfig.enforceSignoff,
  } satisfies CommitGuardConfig;
};
