import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Phase 0: lightweight, non-type-checked rules — there is no production code yet.
// Type-aware rules and eslint-plugin-boundaries (ring / no-sibling-import
// enforcement) come online in Phase 1 with the first real cross-package import.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/*.tsbuildinfo",
      "**/node_modules/**",
      "vendor/**",
      "apps/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
