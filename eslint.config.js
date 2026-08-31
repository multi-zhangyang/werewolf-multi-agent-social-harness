import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const societyUiRestrictions = [
  {
    selector: "JSXOpeningElement[name.name=/^(button|input|textarea|select)$/]",
    message: "Society UI must compose the corresponding shadcn/ui primitive."
  },
  {
    selector: "CallExpression[callee.object.name='window'][callee.property.name='confirm']",
    message: "Use shadcn AlertDialog for destructive confirmation."
  },
  {
    selector: "JSXAttribute[name.name='className'][value.type='Literal'][value.value=/animate-spin/]",
    message: "Use the shadcn Spinner or Skeleton component for loading state."
  },
  {
    selector: "JSXAttribute[name.name='className'][value.type='Literal'][value.value=/\\bspace-[xy]-/]",
    message: "Use flex/grid with gap so spacing remains predictable across responsive layouts."
  },
  {
    selector: "JSXAttribute[name.name='className'][value.type='Literal'][value.value=/text-\\[/]",
    message: "Use the Society typography scale (text-xs/sm/base/lg/2xl/3xl), not an arbitrary font size."
  },
  {
    selector: "JSXAttribute[name.name='className'][value.type='Literal'][value.value=/(?:text|bg|border)-(?:red|green|blue|yellow|purple|orange|pink|slate|gray|zinc|neutral|stone)-/]",
    message: "Use semantic Society/shadcn color tokens instead of a raw palette color."
  }
];

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
    // Standalone Node scripts (demo runners) see the Node global scope; the
    // browser-driving QA scripts additionally touch `window` inside page
    // callbacks, which runs in the browser, not in Node.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, location: "readonly", document: "readonly", window: "readonly", getComputedStyle: "readonly" } }
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
  },
  {
    files: ["src/App.tsx", "src/components/society/**/*.tsx"],
    rules: {
      "no-restricted-syntax": ["error", ...societyUiRestrictions]
    }
  },
  {
    files: ["src/components/society/live-stream.tsx", "src/components/society/turn-card.tsx", "src/components/society/turn-cognition.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...societyUiRestrictions,
        {
          selector: "JSXAttribute[name.name='className'][value.type='Literal'][value.value=/(?:overflow-y-auto|overflow-auto|overflow-scroll)/]",
          message: "The Society message stage must use AI Elements Conversation for scrolling."
        }
      ]
    }
  }
);
