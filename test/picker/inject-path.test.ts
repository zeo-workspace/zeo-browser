// Story 045, task 13.1 — Firefox loads the picker (live-proof finding F3, design.md §A5 and
// Implementation Gotchas v5). Requirement: R9.1.
//
// Contract: every `scripting.executeScript` that injects the picker names `files: ["/picker.js"]`
// — an absolute path. Firefox resolves a relative `files` entry against the CALLING page
// (`sidebar/index.html` → `sidebar/picker.js`, which does not exist), Chrome against the
// extension root; the absolute form resolves to the root in both. Two callers inject:
//   - the Pick button, through `startPick` (src/picker/inject.ts), from the sidebar page;
//   - the `start-picker` shortcut, through the background (src/background.ts), under activeTab.
//
// Hostile halves first:
//   - a relative spelling ("picker.js", "./picker.js") resolved against the sidebar page lands
//     in sidebar/ — the assertion resolves the injected path against the sidebar page and
//     requires the extension root, so no relative spelling passes;
//   - both callers must agree: the shortcut path is checked on its own, on both browsers, so a
//     fix applied to one caller only stays red.
import { afterEach, describe, expect, it, vi } from "vitest";
import { injectPicker, startPick } from "../../src/picker/inject.js";

const SIDEBAR_PAGE = "moz-extension://4f1c2d3e-0000-4000-8000-000000000045/sidebar/index.html";
const PICKER_AT_ROOT = "moz-extension://4f1c2d3e-0000-4000-8000-000000000045/picker.js";

/** The `files` of the one executeScript call a spy saw. */
function injectedFiles(exec: ReturnType<typeof vi.fn>): string[] {
  expect(exec).toHaveBeenCalledTimes(1);
  const arg = exec.mock.calls[0]![0] as { files?: unknown };
  expect(Array.isArray(arg.files)).toBe(true);
  return arg.files as string[];
}

/** Each injected file must resolve to the extension root when Firefox resolves it from the sidebar. */
function expectResolvesAtRoot(files: string[]): void {
  expect(files).toHaveLength(1);
  expect(new URL(files[0]!, SIDEBAR_PAGE).href).toBe(PICKER_AT_ROOT);
}

describe("the Pick button path: startPick (R9.1, F3)", () => {
  const api = () => ({
    permissions: { request: vi.fn(async () => true) },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: "mounted" }]) },
  });

  it("hostile: the injected path resolves to the extension root from the sidebar page", async () => {
    const a = api();
    await startPick({ id: 7, url: "https://app.example/" }, a as any);
    expectResolvesAtRoot(injectedFiles(a.scripting.executeScript));
  });

  it("injects exactly files: ['/picker.js'] into the tab's top frame", async () => {
    const a = api();
    const r = await startPick({ id: 7, url: "https://app.example/" }, a as any);
    expect(r).toEqual({ ok: true });
    expect(a.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["/picker.js"],
    });
  });

  it("injectPicker (the shared injector) names '/picker.js' too", async () => {
    const exec = vi.fn(async () => [{ frameId: 0, result: "mounted" }]);
    await injectPicker(11, { executeScript: exec } as any);
    expect(exec).toHaveBeenCalledWith({ target: { tabId: 11 }, files: ["/picker.js"] });
  });
});

// The shortcut path: the background registers its listeners at import through `api`/`BROWSER`
// from src/platform.ts, mocked per browser (same seam as test/background.test.ts).
type L = (...a: any[]) => any;
function fake(browser: "chrome" | "firefox") {
  const listeners: Record<string, L[]> = {};
  const on = (name: string) => ({
    addListener: (f: L) => (listeners[name] ??= []).push(f),
    removeListener() {},
  });
  const api: any = {
    runtime: {
      id: "self",
      onInstalled: on("onInstalled"),
      onConnect: on("onConnect"),
      onMessage: on("onMessage"),
      sendMessage: vi.fn(async () => undefined),
    },
    commands: { onCommand: on("onCommand") },
    action: { onClicked: on("onClicked") },
    tabs: { query: vi.fn(async () => [{ id: 3, windowId: 9 }]) },
    windows: { getCurrent: vi.fn(async () => ({ id: 9 })) },
    debugger: { getTargets: vi.fn(async () => []), detach: vi.fn(async () => undefined) },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, result: "mounted" }]) },
    permissions: { request: vi.fn(async () => true) },
  };
  if (browser === "chrome") {
    api.sidePanel = {
      setPanelBehavior: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
    };
  } else {
    api.sidebarAction = {
      toggle: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
    };
  }
  return { api, listeners };
}

async function load(browser: "chrome" | "firefox") {
  const f = fake(browser);
  vi.resetModules();
  vi.doMock("../../src/platform.js", () => ({
    api: f.api,
    BROWSER: browser,
    HAS_DEBUGGER: browser === "chrome",
  }));
  await import("../../src/background.js");
  return f;
}
afterEach(() => vi.doUnmock("../../src/platform.js"));

const TAB = { id: 3, windowId: 9, url: "https://app.example/" };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the shortcut path: start-picker in the background (R9.1, F3)", () => {
  for (const browser of ["firefox", "chrome"] as const) {
    it(`hostile, ${browser}: the shortcut injects '/picker.js', resolving at the extension root`, async () => {
      const f = await load(browser);
      for (const l of f.listeners.onCommand ?? []) {
        void l("start-picker", TAB);
      }
      await tick();
      const files = injectedFiles(f.api.scripting.executeScript);
      expectResolvesAtRoot(files);
      expect(f.api.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 3 },
        files: ["/picker.js"],
      });
    });
  }
});
