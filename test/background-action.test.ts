// Story 045, task 13.2 (F1) — Chrome's toolbar icon is an action invocation, so it grants activeTab
// (design.md §A2 v5, Implementation Gotchas). Requirements: R8.1, R10.7.
//
// With `openPanelOnActionClick: true` Chrome opens the side panel itself and the click never
// reaches `action.onClicked`, so no `activeTab` grant (measured 2026-10-17, Chrome 155). The
// contract: at `runtime.onInstalled` the panel behaviour is set to `false`, and the background's
// `action.onClicked(tab)` opens the panel with `sidePanel.open({windowId: tab.windowId})` as its
// first, synchronous call — an await before it loses the gesture.
//
// Seam: as in test/background.test.ts, `src/background.ts` registers its listeners at import
// through `api`/`BROWSER` from `src/platform.ts` (mocked per browser), and every API call is logged
// in order. "First, synchronous" is checked without awaiting anything after firing the event.
//
// Hostile halves first:
// - the tab's window differs from the "current" window a query would return, so opening the
//   wrong window (or querying for it first) is caught;
// - an update, not only a fresh install, must reset the behaviour: Chrome persists it, and 0.1.0
//   installs carry `true`;
// - Firefox is the converse: its click must still toggle exactly once (a second listener added
//   for Chrome but registered for both would toggle twice and close what it opened).
//
// Materialization note: test/background.test.ts "sets openPanelOnActionClick at install (R8.1)"
// asserts `true` and must flip to `false` with this sub-task.
import { afterEach, describe, expect, it, vi } from "vitest";

type L = (...a: any[]) => any;
function fake(browser: "chrome" | "firefox") {
  const log: string[] = [];
  const listeners: Record<string, L[]> = {};
  const on = (name: string) => ({
    addListener: (f: L) => (listeners[name] ??= []).push(f),
    removeListener() {},
  });
  const spy = (name: string, ret: () => unknown = () => Promise.resolve()) =>
    vi.fn((..._args: unknown[]) => {
      log.push(name);
      return ret();
    });
  const api: any = {
    runtime: {
      id: "self",
      onInstalled: on("onInstalled"),
      onConnect: on("onConnect"),
      onMessage: on("onMessage"),
      sendMessage: spy("runtime.sendMessage"),
    },
    commands: { onCommand: on("onCommand") },
    action: { onClicked: on("onClicked") },
    // The "current" window is 9; the clicked tab lives in window 42.
    tabs: { query: spy("tabs.query", () => Promise.resolve([{ id: 3, windowId: 9 }])) },
    windows: { getCurrent: spy("windows.getCurrent", () => Promise.resolve({ id: 9 })) },
    debugger: {
      getTargets: spy("debugger.getTargets", () => Promise.resolve([])),
      detach: spy("debugger.detach"),
    },
  };
  if (browser === "chrome") {
    api.sidePanel = {
      setPanelBehavior: spy("sidePanel.setPanelBehavior"),
      open: spy("sidePanel.open"),
      close: spy("sidePanel.close"),
    };
  } else {
    api.sidebarAction = {
      toggle: spy("sidebarAction.toggle"),
      open: spy("sidebarAction.open"),
      close: spy("sidebarAction.close"),
    };
  }
  return { api, log, listeners };
}

async function load(browser: "chrome" | "firefox") {
  const f = fake(browser);
  vi.resetModules();
  vi.doMock("../src/platform.js", () => ({
    api: f.api,
    BROWSER: browser,
    HAS_DEBUGGER: browser === "chrome",
  }));
  await import("../src/background.js");
  return f;
}
const fire = (f: ReturnType<typeof fake>, name: string, ...args: unknown[]) => {
  for (const l of f.listeners[name] ?? []) {
    void l(...args);
  }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => vi.doUnmock("../src/platform.js"));

const TAB = { id: 3, windowId: 42, url: "https://app.example/" };

describe("Chrome: the toolbar click reaches action.onClicked (R8.1, R10.7, F1)", () => {
  for (const reason of ["install", "update"] as const) {
    it(`hostile: on ${reason}, the panel behaviour is set to openPanelOnActionClick false, never true`, async () => {
      const f = await load("chrome");
      fire(f, "onInstalled", { reason });
      expect(f.api.sidePanel.setPanelBehavior).toHaveBeenCalledWith({
        openPanelOnActionClick: false,
      });
      expect(f.api.sidePanel.setPanelBehavior).not.toHaveBeenCalledWith({
        openPanelOnActionClick: true,
      });
    });
  }

  it("the action.onClicked listener is registered at import, on the worker's first turn", async () => {
    const f = await load("chrome");
    expect(f.listeners.onClicked ?? []).toHaveLength(1);
  });

  it("hostile: a click opens the panel of the tab's window, first and synchronously, before any query", async () => {
    const f = await load("chrome");
    fire(f, "onInstalled", { reason: "install" });
    f.log.length = 0;
    fire(f, "onClicked", TAB);
    // Nothing awaited: the open call has happened by the time the listener returned.
    expect(f.log[0]).toBe("sidePanel.open");
    expect(f.api.sidePanel.open).toHaveBeenCalledTimes(1);
    expect(f.api.sidePanel.open).toHaveBeenCalledWith({ windowId: 42 });
    expect(f.api.sidePanel.open).not.toHaveBeenCalledWith(expect.objectContaining({ windowId: 9 }));
    expect(f.api.tabs.query).not.toHaveBeenCalled();
    expect(f.api.windows.getCurrent).not.toHaveBeenCalled();
  });

  it("a second click while the panel is open opens it again and never closes it", async () => {
    const f = await load("chrome");
    fire(f, "onClicked", TAB);
    fire(f, "onClicked", TAB);
    await tick();
    expect(f.api.sidePanel.open).toHaveBeenCalledTimes(2);
    expect(f.api.sidePanel.close).not.toHaveBeenCalled();
  });

  it("a rejected open from the click is logged by error kind, not left unhandled", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = await load("chrome");
      f.api.sidePanel.open.mockImplementationOnce(() => Promise.reject(new TypeError("no window")));
      fire(f, "onClicked", TAB);
      await tick();
      expect(f.api.sidePanel.open).toHaveBeenCalledWith({ windowId: 42 });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ error: "TypeError" }));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("Firefox: the toolbar click is unchanged (R8.2)", () => {
  it("hostile: exactly one click listener, so a click toggles exactly once, first and synchronously", async () => {
    const f = await load("firefox");
    expect(f.listeners.onClicked ?? []).toHaveLength(1);
    f.log.length = 0;
    fire(f, "onClicked", TAB);
    expect(f.log[0]).toBe("sidebarAction.toggle");
    expect(f.api.sidebarAction.toggle).toHaveBeenCalledTimes(1);
    expect(f.api.sidebarAction.open).not.toHaveBeenCalled();
    expect(f.api.sidebarAction.close).not.toHaveBeenCalled();
  });

  it("install touches no side panel API and does not throw without one", async () => {
    const f = await load("firefox");
    f.log.length = 0;
    expect(() => fire(f, "onInstalled", { reason: "install" })).not.toThrow();
    await tick();
    expect(f.log.filter((c) => c.startsWith("sidePanel") || c.startsWith("sidebarAction"))).toEqual(
      [],
    );
  });
});
