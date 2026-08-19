import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Minimal, uniform lint gate (AGENTS.md §19.2): catches real bugs and unused
 * code without imposing style opinions on the existing codebase.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "data/**",
      "artifacts/**",
      "coverage/**",
      ".zcode/**",
      "*.tmp.mjs"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Standalone Node scripts (demo runners) see the Node global scope.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, location: "readonly" } }
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs", "**/*.js"],
    rules: {
      // TypeScript already enforces declaration hygiene; keep the lint noise
      // focused on genuine problems.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }]
    }
  }
);