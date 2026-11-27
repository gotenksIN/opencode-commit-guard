import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import landmines from "ultracite/oxlint/landmines";

export default {
  extends: [core, antiSlop, landmines],
  jsPlugins: [...antiSlop.jsPlugins, ...landmines.jsPlugins],
  env: core.env,
  ignorePatterns: [...(core.ignorePatterns ?? []), "dist/**"],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: false }],
    "landmines-testing/no-flake-masking": [
      "error",
      { allow: { "src/capture.test.ts": 3, "test/plugin.test.ts": 36 } },
    ],
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
