// Story 045, task 8.3 — Playwright for the sidebar E2E (design.md §Testing Strategy).
// Chromium only: branded Google Chrome ignores --load-extension since 137, and Playwright's
// Firefox cannot load extensions. The spec launches its own persistent context (an extension
// needs one), so no browser `use` options live here.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // One fake Zeo socket and one profile per test file: keep it to one worker.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "test-results",
});
