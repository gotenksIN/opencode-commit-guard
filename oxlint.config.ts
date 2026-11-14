import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default {
  extends: [core, antiSlop],
  env: core.env,
  ignorePatterns: [...(core.ignorePatterns ?? []), "dist/**"],
  rules: {
    "typescript/consistent-indexed-object-style": "error",
    "unicorn/no-immediate-mutation": "error",
    "unicorn/prefer-reflect-apply": "error",
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-runtime-typeof": "error",
  },
  overrides: [
    {
      files: ["src/capture.ts", "src/shell.ts"],
      rules: {
        "no-bitwise": ["error", { allow: ["&", "|"] }],
      },
    },
  ],
};
