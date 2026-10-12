import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    environment: "happy-dom",
    include: ["test/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
