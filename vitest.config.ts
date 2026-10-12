import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    // Node by default; the DOM suites opt in with `@vitest-environment happy-dom`, which also
    // replaces the global URL and breaks fileURLToPath(new URL(…, import.meta.url)).
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
