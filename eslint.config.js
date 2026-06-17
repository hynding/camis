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
      "generated/**",
      "**/__golden__/**",
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
  {
    files: ["packages/ir-schema/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@camis/*", "!@camis/expr"],
              message:
                "ir-schema may only import @camis/expr; it must not import other @camis packages.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "packages/adapter-strapi/src/**/*.ts",
      "packages/adapter-filament/src/**/*.ts",
      "packages/adapter-express/src/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@camis/adapter-*", "!@camis/adapter-kernel"],
              message:
                "Adapters must not import sibling adapters; lift shared logic into a shared package.",
            },
          ],
        },
      ],
    },
  },
);
