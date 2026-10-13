// Story 045, task 4.5 — the background opens the sidebar inside the user gesture (design.md §A2).
// Requirements: R8.1, R8.2, R8.3, R9.1.
// Seam: `src/background.ts` registers its listeners at import through `api`, `BROWSER` from
// `src/platform.ts` (mocked here per browser). Every API call is logged in order, so "first
// statement, no await before it" is checked as: the gesture-bound call has happened by the time
// the listener returns synchronously, and no other API call precedes it.
//
// Hostile halves first: on Firefox the toggle/open is synchronous and first (an await before it
// is refused by Firefox); on Chrome sidePanel.open runs before any tabs/windows query; the picker
// start is not posted before the sidebar announces itself.
import { afterEach, describe, expect, it, vi } from "vitest";

type L = (...a: any[]) => any;
function fake(browser: "chrome" | "firefox") {
  const log: string[] = [];
  const listeners: Record<string, L[]> = {};
  const on = (name: string) => ({
    addListener: (f: L) => (listeners[name] ??= []).push(f),
    removeListener() {},
  });
  const spy = (name: string, ret: unknown = Promise.resolve()) =>
    vi.fn((...args: unknown[]) => {
      log.push(name);
      void args;
      return ret;
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
    tabs: { query: spy("tabs.query", Promise.resolve([{ id: 3, windowId: 9 }])) },
    windows: { getCurrent: spy("windows.getCurrent", Promise.resolve({ id: 9 })) },
    debugger: {
      getTargets: spy("debugger.getTargets", Promise.resolve([])),
      detach: spy("debugger.detach"),
    },
  };
  if (browser === "chrome") {
    api.sidePanel = {
      setPanelBehavior: spy("sidePanel.setPanelBehavior"),
      open: spy("sidePanel.open"),
    };
  } else {
    api.sidebarAction = { toggle: spy("sidebarAction.toggle"), open: spy("sidebarAction.open") };
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
afterEach(() => vi.doUnmock("../src/platform.js"));

const TAB = { id: 3, windowId: 9, url: "https://app.example/" };

describe("Chrome", () => {
  it("sets openPanelOnActionClick at install (R8.1)", async () => {
    const f = await load("chrome");
    fire(f, "onInstalled", { reason: "install" });
    expect(f.api.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
  });

  it("hostile: open-sidebar calls sidePanel.open synchronously and first (R8.3)", async () => {
    const f = await load("chrome");
    f.log.length = 0;
    fire(f, "onCommand", "open-sidebar", TAB);
    expect(f.log[0]).toBe("sidePanel.open");
    expect(f.api.sidePanel.open).toHaveBeenCalledWith(expect.objectContaining({ windowId: 9 }));
  });
});

describe("Firefox", () => {
  it("hostile: the toolbar click toggles the sidebar synchronously and first (R8.2)", async () => {
    const f = await load("firefox");
    f.log.length = 0;
    fire(f, "onClicked", TAB);
    expect(f.log[0]).toBe("sidebarAction.toggle");
  });

  it("open-sidebar opens it synchronously and first (R8.3)", async () => {
    const f = await load("firefox");
    f.log.length = 0;
    fire(f, "onCommand", "open-sidebar", TAB);
    expect(f.log[0]).toBe("sidebarAction.open");
    expect(f.api.sidebarAction.toggle).not.toHaveBeenCalled();
  });
});

describe("start-picker (R9.1)", () => {
  for (const browser of ["chrome", "firefox"] as const) {
    it(`${browser}: opens the sidebar first, posts start-picker only once the sidebar announces itself`, async () => {
      const f = await load(browser);
      f.log.length = 0;
      fire(f, "onCommand", "start-picker", TAB);
      expect(f.log[0]).toBe(browser === "chrome" ? "sidePanel.open" : "sidebarAction.open");
      const posted: unknown[] = [];
      const port = {
        name: "sidebar",
        postMessage: (m: unknown) => posted.push(m),
        onDisconnect: { addListener() {} },
        onMessage: { addListener() {} },
      };
      await new Promise((r) => setTimeout(r, 0));
      const early = [
        ...posted,
        ...f.api.runtime.sendMessage.mock.calls.map((c: unknown[]) => c[0]),
      ];
      expect(early).not.toContainEqual(expect.objectContaining({ type: "start-picker" }));
      fire(f, "onConnect", port);
      await new Promise((r) => setTimeout(r, 0));
      const sent = [...posted, ...f.api.runtime.sendMessage.mock.calls.map((c: unknown[]) => c[0])];
      expect(sent).toContainEqual({ type: "start-picker", tabId: 3 });
    });
  }
});

// Planned amendment (post-review): the background injects picker.js itself under the shortcut's
// activeTab grant, and the boot outcome reaches the sidebar.
describe("start-picker injection and boot status (R9.1, R9.9, amendment)", () => {
  const sidebarPort = () => {
    const posted: unknown[] = [];
    const port = {
      name: "sidebar",
      postMessage: (m: unknown) => posted.push(m),
      onDisconnect: { addListener() {} },
      onMessage: { addListener() {} },
    };
    return { port, posted };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  async function loadWithScripting(browser: "chrome" | "firefox", result: () => Promise<unknown>) {
    const f = await load(browser);
    f.api.scripting = { executeScript: vi.fn(result) };
    f.api.permissions = { request: vi.fn(async () => true) };
    return f;
  }

  for (const browser of ["chrome", "firefox"] as const) {
    it(`${browser}: injects picker.js into tab.id and asks for no permission`, async () => {
      const f = await loadWithScripting(browser, async () => [{ frameId: 0, result: "mounted" }]);
      fire(f, "onCommand", "start-picker", TAB);
      await tick();
      expect(f.api.scripting.executeScript).toHaveBeenCalledWith({
        target: { tabId: 3 },
        files: ["picker.js"],
      });
      expect(f.api.permissions.request).not.toHaveBeenCalled();
      const s = sidebarPort();
      fire(f, "onConnect", s.port);
      await tick();
      expect(s.posted).toEqual([{ type: "start-picker", tabId: 3 }]);
    });
  }

  it("hostile: a protected URL is not injected, and the sidebar hears it is protected", async () => {
    const f = await loadWithScripting("chrome", async () => []);
    fire(f, "onCommand", "start-picker", { ...TAB, url: "chrome://settings/" });
    const s = sidebarPort();
    fire(f, "onConnect", s.port);
    await tick();
    expect(f.api.scripting.executeScript).not.toHaveBeenCalled();
    expect(f.api.permissions.request).not.toHaveBeenCalled();
    expect(s.posted).toEqual([
      { type: "start-picker", tabId: 3 },
      { type: "picker-status", tabId: 3, status: "protected" },
    ]);
  });

  it("a PDF viewer reported by picker.js reaches an already-connected sidebar as protected", async () => {
    const f = await loadWithScripting("chrome", async () => [{ frameId: 0, result: "protected" }]);
    const s = sidebarPort();
    fire(f, "onConnect", s.port);
    fire(f, "onCommand", "start-picker", TAB);
    // Already connected: the start-picker goes out at once, the outcome once injection resolves.
    expect(s.posted).toEqual([{ type: "start-picker", tabId: 3 }]);
    await tick();
    expect(s.posted).toEqual([
      { type: "start-picker", tabId: 3 },
      { type: "picker-status", tabId: 3, status: "protected" },
    ]);
  });

  it("a script that did not mount reaches the sidebar as failed", async () => {
    const f = await loadWithScripting("firefox", async () => [{ frameId: 0, result: "failed" }]);
    fire(f, "onCommand", "start-picker", TAB);
    await tick();
    const s = sidebarPort();
    fire(f, "onConnect", s.port);
    expect(s.posted).toEqual([
      { type: "start-picker", tabId: 3 },
      { type: "picker-status", tabId: 3, status: "failed" },
    ]);
  });

  it("an injection refused for lack of access is the protected state", async () => {
    const f = await loadWithScripting("chrome", () =>
      Promise.reject(new Error("Cannot access contents of the page.")),
    );
    fire(f, "onCommand", "start-picker", TAB);
    await tick();
    const s = sidebarPort();
    fire(f, "onConnect", s.port);
    expect(s.posted).toContainEqual({ type: "picker-status", tabId: 3, status: "protected" });
  });

  it("an already-open sidebar the background holds no port for hears it by broadcast", async () => {
    vi.useFakeTimers();
    try {
      const f = await loadWithScripting("firefox", async () => [{ frameId: 0, result: "failed" }]);
      fire(f, "onCommand", "start-picker", TAB);
      await vi.advanceTimersByTimeAsync(999);
      expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.api.runtime.sendMessage.mock.calls.map((c: unknown[]) => c[0])).toEqual([
        { type: "start-picker", tabId: 3 },
        { type: "picker-status", tabId: 3, status: "failed" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("no broadcast once a sidebar has connected, and none of a stale pick to a late sidebar", async () => {
    vi.useFakeTimers();
    try {
      const f = await loadWithScripting("chrome", async () => [{ frameId: 0, result: "mounted" }]);
      fire(f, "onCommand", "start-picker", TAB);
      fire(f, "onConnect", sidebarPort().port);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.api.runtime.sendMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(15_000);
      const late = sidebarPort();
      fire(f, "onConnect", late.port);
      expect(late.posted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("every open promise's rejection is logged by kind, never as an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = await load("chrome");
      f.api.sidePanel.open.mockReturnValueOnce(Promise.reject(new TypeError("no window")));
      fire(f, "onCommand", "open-sidebar", TAB);
      await tick();
      expect(warn).toHaveBeenCalledWith({ event: "sidebar_open_failed", error: "TypeError" });
      const g = await load("firefox");
      g.api.sidebarAction.toggle.mockReturnValueOnce(Promise.reject(new Error("x")));
      fire(g, "onClicked", TAB);
      await tick();
      expect(warn).toHaveBeenCalledWith({ event: "sidebar_toggle_failed", error: "Error" });
    } finally {
      warn.mockRestore();
    }
  });
});

// Tech-review should-fix: a `sidebar` port opened by a content script is not the sidebar.
describe("only this extension's sidebar page is trusted (R9.1, R11.6)", () => {
  const port = (sender: object) => {
    const posted: unknown[] = [];
    const p = {
      name: "sidebar",
      sender,
      postMessage: (m: unknown) => posted.push(m),
      disconnect: vi.fn(),
      onDisconnect: { addListener() {} },
      onMessage: { addListener() {} },
    };
    return { port: p, posted };
  };
  const CONTENT = { id: "self", url: "https://app.example/", tab: { id: 3 } };
  const SIDEBAR = { id: "self", url: "chrome-extension://self/sidebar/index.html" };

  for (const browser of ["chrome", "firefox"] as const) {
    it(`${browser} hostile: a content-script port gets no start-picker and is disconnected`, async () => {
      vi.useFakeTimers();
      try {
        const f = await load(browser);
        f.api.runtime.getURL = (p: string) => `chrome-extension://self/${p}`;
        f.api.scripting = { executeScript: vi.fn(async () => [{ result: "mounted" }]) };
        const evil = port(CONTENT);
        fire(f, "onConnect", evil.port);
        fire(f, "onCommand", "start-picker", TAB);
        const late = port(CONTENT);
        fire(f, "onConnect", late.port);
        expect(evil.posted).toEqual([]);
        expect(late.posted).toEqual([]);
        expect(evil.port.disconnect).toHaveBeenCalled();
        // It did not count as the sidebar announcing itself: the broadcast still goes out.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(f.api.runtime.sendMessage).toHaveBeenCalledWith({ type: "start-picker", tabId: 3 });
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("a port from the extension's own sidebar page is delivered to", async () => {
    const f = await load("chrome");
    f.api.runtime.getURL = (p: string) => `chrome-extension://self/${p}`;
    fire(f, "onCommand", "open-sidebar", TAB);
    fire(f, "onCommand", "start-picker", TAB);
    const good = port(SIDEBAR);
    fire(f, "onConnect", good.port);
    expect(good.posted).toContainEqual({ type: "start-picker", tabId: 3 });
    expect(good.port.disconnect).not.toHaveBeenCalled();
  });

  it("a page of another extension, or another origin's URL, is refused", async () => {
    const f = await load("firefox");
    f.api.runtime.getURL = (p: string) => `moz-extension://self-uuid/${p}`;
    fire(f, "onCommand", "start-picker", TAB);
    const other = port({ id: "other", url: "moz-extension://other-uuid/sidebar/index.html" });
    const spoof = port({ id: "self", url: "https://moz-extension.example/" });
    fire(f, "onConnect", other.port);
    fire(f, "onConnect", spoof.port);
    expect(other.posted).toEqual([]);
    expect(spoof.posted).toEqual([]);
  });
});
