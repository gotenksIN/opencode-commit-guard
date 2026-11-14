import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  proseWrap: "preserve",
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), "dist/**"],
});
