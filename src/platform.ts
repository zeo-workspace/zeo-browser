// The one place that knows which browser this is (story 045, design.md §A1). Firefox exposes the
// WebExtension API as `browser` (and a `chrome` alias); Chrome only as `chrome`. Every module
// reaches the API through `api`, so tests mock this module instead of a global.
//
// `__BROWSER__` and `__HAS_DEBUGGER__` are injected by scripts/build.mjs (esbuild `define`), which
// lets esbuild drop the other browser's branches. Under vitest nothing injects them, so each is
// read behind a `typeof` guard and falls back to runtime detection.

export type Browser = "chrome" | "firefox";

type Globals = { browser?: typeof chrome; chrome?: typeof chrome };
const globals = globalThis as Globals;

/**
 * The WebExtension API. Outside an extension page (Node, tests) neither global exists and this is
 * `undefined` at runtime; tests that reach it mock this module.
 */
export const api: typeof chrome = (globals.browser ?? globals.chrome) as typeof chrome;

function detectBrowser(): Browser {
  // `runtime.getBrowserInfo` exists only in Firefox.
  const runtime = globals.browser?.runtime as { getBrowserInfo?: unknown } | undefined;
  return typeof runtime?.getBrowserInfo === "function" ? "firefox" : "chrome";
}

/** Which build this is. */
export const BROWSER: Browser = typeof __BROWSER__ !== "undefined" ? __BROWSER__ : detectBrowser();

/** Whether `chrome.debugger` exists here (Chrome only; Firefox has no such API, R11.9). */
export const HAS_DEBUGGER: boolean =
  typeof __HAS_DEBUGGER__ !== "undefined"
    ? __HAS_DEBUGGER__
    : BROWSER === "chrome" && typeof api?.debugger?.attach === "function";
