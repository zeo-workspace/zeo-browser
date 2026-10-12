import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Assigning markup is how page or model text becomes live HTML. Only the Markdown renderer,
// which escapes raw HTML and rewrites images and links, may produce an HTML string.
const noMarkupAssignment = [
  "error",
  { property: "innerHTML", message: "Build DOM nodes; only src/sidebar/markdown.ts emits HTML." },
  { property: "outerHTML", message: "Build DOM nodes; only src/sidebar/markdown.ts emits HTML." },
];

export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/", "coverage/", "test-results/", "playwright-report/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mjs", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"],
      curly: ["error", "all"],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/sidebar/markdown.ts"],
    rules: { "no-restricted-properties": noMarkupAssignment },
  },
  {
    // Tests read markup back, strip control characters from captured logs, and cast hostile
    // inputs past the types on purpose to prove the runtime checks refuse them.
    files: ["test/**/*.ts", "e2e/**/*.ts"],
    rules: { "no-control-regex": "off", "@typescript-eslint/no-explicit-any": "off" },
  },
);
