// Story 045, task 4.4 — console and network recording on Chrome, and the debugger janitor
// (design.md §A7, §A2). Requirements: R11.1–R11.8, R13.4 (Q16).
// Contract and assumed seams (adjust `load` only): `src/recorder.ts` exports
// `start(tabId, onEnd)`, `stop(): Promise<{ console, network }>` and `redactUrl(url)`; it reaches
// `chrome.debugger` and `chrome.tabs` through `api` from `src/platform.ts` (mocked here);
// `onEnd(captures)` is called when the 120 s cap or a browser detach ends the recording.
// The janitor is in `src/background.ts`: when the sidebar's `runtime.connect({ name: "sidebar" })`
// port disconnects, it detaches every attached debugger target.
//
// Hostile halves first:
//   - the ring buffer keeps the LATEST 200, not the first 200;
//   - headers, cookies and bodies present in the CDP events never reach a capture, and a network
//     entry has exactly the contract's six fields (built field by field, never spread);
//   - redaction keeps parameter NAMES and the path, replaces every value and drops the fragment;
//   - the janitor detaches only the tab its sidebar announced (amended at Run mode, see below).
import { afterEach, describe, expect, it, vi } from "vitest";

type L = (...a: any[]) => void;
function fakeChrome() {
  const onEvent: L[] = [];
  const onDetach: L[] = [];
  const onConnect: L[] = [];
  const dbg = {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    sendCommand: vi.fn(async () => ({})),
    getTargets: vi.fn(async () => [] as unknown[]),
    onEvent: { addListener: (f: L) => onEvent.push(f), removeListener: () => {} },
    onDetach: { addListener: (f: L) => onDetach.push(f), removeListener: () => {} },
  };
  const api = {
    debugger: dbg,
    tabs: { get: vi.fn(async (id: number) => ({ id, url: "https://app.example/page" })) },
    runtime: {
      id: "self",
      lastError: undefined,
      onConnect: { addListener: (f: L) => onConnect.push(f) },
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      sendMessage: vi.fn(),
    },
    commands: { onCommand: { addListener: () => {} } },
    action: { onClicked: { addListener: () => {} } },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}), open: vi.fn(async () => {}) },
  };
  const fire = (method: string, params: object, tabId = 5) =>
    onEvent.forEach((f) => f({ tabId }, method, params));
  return { api, dbg, fire, onDetach, onConnect };
}

async function load(f = fakeChrome(), module = "../src/recorder.js") {
  vi.resetModules();
  vi.doMock("../src/platform.js", () => ({ api: f.api, BROWSER: "chrome", HAS_DEBUGGER: true }));
  return { f, mod: (await import(module)) as any };
}
afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("../src/platform.js");
});

const consoleCall = (text: string) => ({
  type: "log",
  args: [{ type: "string", value: text }],
  timestamp: 1,
  stackTrace: {
    callFrames: [{ url: "https://app.example/app.js", lineNumber: 9, columnNumber: 2 }],
  },
});

describe("redactUrl (R11.8)", () => {
  it("hostile: keeps names and path, replaces every value, drops the fragment", async () => {
    const { mod } = await load();
    const r = (u: string) => decodeURIComponent(mod.redactUrl(u));
    expect(r("https://a.example/p/q?token=SECRET&x=1#frag")).toBe(
      "https://a.example/p/q?token=…&x=…",
    );
    expect(r("https://a.example/p?id=1&id=2")).toBe("https://a.example/p?id=…&id=…");
    expect(r("https://a.example/plain")).toBe("https://a.example/plain");
    expect(r("https://a.example/p?q=a%20b%26c")).not.toContain("a b");
    expect(mod.redactUrl("not a url")).toBe("<unparseable url>");
  });
});

describe("debugger lifetime (R11.1, R11.2, R11.4–R11.6)", () => {
  it("never attaches before start (R11.2)", async () => {
    const { f } = await load();
    expect(f.dbg.attach).not.toHaveBeenCalled();
  });

  it("start attaches 1.3 and enables Runtime, Log and Network (R11.1)", async () => {
    const { f, mod } = await load();
    await mod.start(5, vi.fn());
    expect(f.dbg.attach).toHaveBeenCalledWith({ tabId: 5 }, "1.3");
    const methods = f.dbg.sendCommand.mock.calls.map((c: unknown[]) => c[1]);
    expect(methods).toEqual(
      expect.arrayContaining(["Runtime.enable", "Log.enable", "Network.enable"]),
    );
  });

  it("stop detaches and returns one console and one network capture, not cut short (R11.4)", async () => {
    const { f, mod } = await load();
    await mod.start(5, vi.fn());
    f.fire("Runtime.consoleAPICalled", consoleCall("hello"));
    const c = await mod.stop();
    expect(f.dbg.detach).toHaveBeenCalledWith({ tabId: 5 });
    expect(c.console).toMatchObject({
      type: "console",
      cut_short: false,
      page_url: "https://app.example/page",
    });
    expect(c.network).toMatchObject({ type: "network", cut_short: false });
  });

  it("the 120 s cap detaches and delivers the captures — not before (R11.4)", async () => {
    vi.useFakeTimers();
    const { f, mod } = await load();
    const onEnd = vi.fn();
    await mod.start(5, onEnd);
    await vi.advanceTimersByTimeAsync(119_900);
    expect(f.dbg.detach).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.dbg.detach).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]![0].console.cut_short).toBe(false);
  });

  it("a browser detach (Cancel on the bar, tab closed) ends it cut short, keeping what was captured (R11.5)", async () => {
    for (const reason of ["canceled_by_user", "target_closed"]) {
      const { f, mod } = await load();
      const onEnd = vi.fn();
      await mod.start(5, onEnd);
      f.fire("Runtime.consoleAPICalled", consoleCall("kept"));
      f.onDetach.forEach((l) => l({ tabId: 5 }, reason));
      await Promise.resolve();
      expect(onEnd, reason).toHaveBeenCalledTimes(1);
      const c = onEnd.mock.calls[0]![0];
      expect(c.console.cut_short).toBe(true);
      expect(c.console.entries.map((e: { text: string }) => e.text)).toContain("kept");
    }
  });
});

describe("entries (R11.3, R11.7, R11.8)", () => {
  it("hostile: keeps the latest 200 console entries", async () => {
    const { f, mod } = await load();
    await mod.start(5, vi.fn());
    for (let i = 0; i < 250; i++) {
      f.fire("Runtime.consoleAPICalled", consoleCall(`m${i}`));
    }
    const c = await mod.stop();
    expect(c.console.entries).toHaveLength(200);
    expect(c.console.entries[0].text).toBe("m50");
    expect(c.console.entries[199].text).toBe("m249");
  });

  it("console entries carry level, text ≤ 2 KiB, source and time; exceptions are recorded", async () => {
    const { f, mod } = await load();
    await mod.start(5, vi.fn());
    f.fire("Runtime.consoleAPICalled", consoleCall("x".repeat(5000)));
    f.fire("Runtime.exceptionThrown", {
      timestamp: 2,
      exceptionDetails: {
        text: "Uncaught",
        url: "https://app.example/app.js",
        lineNumber: 3,
        columnNumber: 1,
        exception: { description: "TypeError: boom" },
      },
    });
    const [log, exc] = (await mod.stop()).console.entries;
    expect(new TextEncoder().encode(log.text).length).toBeLessThanOrEqual(2048);
    expect(log.level).toBe("log");
    expect(log.source).toMatch(/app\.js/);
    expect(typeof log.ts).toBe("number");
    expect(exc.level).toBe("exception");
    expect(exc.text).toContain("TypeError: boom");
  });

  it("hostile: network entries have exactly six fields and no header, cookie or body", async () => {
    const { f, mod } = await load();
    await mod.start(5, vi.fn());
    for (let i = 0; i < 205; i++) {
      f.fire("Network.requestWillBeSent", {
        requestId: `n${i}`,
        timestamp: 1,
        type: "Fetch",
        request: { method: "GET", url: `https://api.example/i/${i}` },
      });
    }
    f.fire("Network.requestWillBeSent", {
      requestId: "r1",
      timestamp: 1,
      type: "Fetch",
      request: {
        method: "POST",
        url: "https://api.example/x?token=SECRET-TOKEN#frag",
        headers: { Cookie: "sid=SECRET-COOKIE" },
        postData: "password=SECRET-BODY",
      },
    });
    f.fire("Network.responseReceived", {
      requestId: "r1",
      timestamp: 1.1,
      type: "Fetch",
      response: {
        status: 201,
        headers: { "set-cookie": "SECRET-SET" },
        headersText: "SECRET-HEADERS",
      },
    });
    f.fire("Network.loadingFinished", { requestId: "r1", timestamp: 1.25 });
    f.fire("Network.requestWillBeSent", {
      requestId: "r2",
      timestamp: 2,
      type: "Script",
      request: { method: "GET", url: "https://cdn.example/a.js" },
    });
    f.fire("Network.loadingFailed", {
      requestId: "r2",
      timestamp: 2.5,
      type: "Script",
      errorText: "net::ERR_BLOCKED",
    });
    const c = await mod.stop();
    expect(JSON.stringify(c)).not.toMatch(/SECRET/);
    expect(c.network.entries.length).toBeLessThanOrEqual(200);
    const post = c.network.entries.find((e: { method: string }) => e.method === "POST");
    expect(Object.keys(post).sort()).toEqual([
      "failed",
      "method",
      "ms",
      "resource_type",
      "status",
      "url",
    ]);
    expect(decodeURIComponent(post.url)).toBe("https://api.example/x?token=…");
    expect(post.status).toBe(201);
    expect(String(post.resource_type).toLowerCase()).toBe("fetch");
    expect(post.ms).toBeCloseTo(250, 0);
    expect(post.failed).toBeNull();
    const failed = c.network.entries.find((e: { url: string }) => e.url.includes("cdn.example"));
    expect(failed).toMatchObject({ status: null, failed: "net::ERR_BLOCKED" });
  });
});

// The authored "detaches attached targets" case was replaced at Run mode, as tasks.md 4.4 planned:
// getTargets().attached does not say who attached, so the janitor acts only on the announced tab.
// Planned amendment (post-review, tasks.md 4.4; design.md §A2): the janitor detaches only the tab
// the sidebar announced, never one it was not told about, whatever getTargets reports.
describe("janitor, announced tab only (R11.6, post-review)", () => {
  function sidebarPort() {
    const message: L[] = [];
    const disconnect: L[] = [];
    const port = {
      name: "sidebar",
      onDisconnect: { addListener: (l: L) => disconnect.push(l) },
      onMessage: { addListener: (l: L) => message.push(l) },
      postMessage() {},
    };
    return {
      port,
      send: (m: unknown) => message.forEach((l) => l(m)),
      close: () => disconnect.forEach((l) => l(port)),
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("hostile: detaches the announced tab and no other, even when getTargets reports both attached", async () => {
    const f = fakeChrome();
    f.dbg.getTargets.mockResolvedValue([
      { tabId: 1, attached: true, type: "page", id: "a" },
      { tabId: 3, attached: true, type: "page", id: "c" },
    ]);
    await load(f, "../src/background.js");
    const p = sidebarPort();
    f.onConnect.forEach((l) => l(p.port));
    p.send({ type: "recording", tabId: 3 });
    p.send({ type: "recording_heartbeat" });
    p.close();
    await settle();
    expect(f.dbg.detach.mock.calls.map((c: any[]) => c[0])).toEqual([{ tabId: 3 }]);
    expect(f.dbg.getTargets).not.toHaveBeenCalled();
  });

  it("hostile: a sidebar that announced nothing, or stopped, detaches nothing", async () => {
    const f = fakeChrome();
    f.dbg.getTargets.mockResolvedValue([{ tabId: 1, attached: true, type: "page", id: "a" }]);
    await load(f, "../src/background.js");
    const silent = sidebarPort();
    const stopped = sidebarPort();
    f.onConnect.forEach((l) => l(silent.port));
    f.onConnect.forEach((l) => l(stopped.port));
    stopped.send({ type: "recording", tabId: 1 });
    stopped.send({ type: "recording_stopped" });
    silent.close();
    stopped.close();
    await settle();
    expect(f.dbg.detach).not.toHaveBeenCalled();
  });

  it("closing one sidebar leaves another sidebar's recording attached", async () => {
    const f = fakeChrome();
    await load(f, "../src/background.js");
    const a = sidebarPort();
    const b = sidebarPort();
    f.onConnect.forEach((l) => l(a.port));
    f.onConnect.forEach((l) => l(b.port));
    a.send({ type: "recording", tabId: 7 });
    b.send({ type: "recording", tabId: 8 });
    a.close();
    await settle();
    expect(f.dbg.detach.mock.calls.map((c: any[]) => c[0])).toEqual([{ tabId: 7 }]);
  });

  it("ignores a 'not attached' error and malformed announcements", async () => {
    const f = fakeChrome();
    f.dbg.detach.mockRejectedValue(new Error("Debugger is not attached to the tab with id: 4."));
    await load(f, "../src/background.js");
    const p = sidebarPort();
    f.onConnect.forEach((l) => l(p.port));
    p.send({ type: "recording", tabId: "4" });
    p.send({ type: "recording", tabId: -1 });
    p.send(null);
    p.send({ type: "recording", tabId: 4 });
    p.close();
    await settle();
    expect(f.dbg.detach.mock.calls.map((c: any[]) => c[0])).toEqual([{ tabId: 4 }]);
  });

  it("hostile: a content script's sidebar-named port cannot make the janitor detach", async () => {
    const f = fakeChrome();
    await load(f, "../src/background.js");
    const p = sidebarPort();
    const disconnect = vi.fn();
    Object.assign(p.port, {
      sender: { id: "self", url: "https://app.example/", tab: { id: 9 } },
      disconnect,
    });
    f.onConnect.forEach((l) => l(p.port));
    p.send({ type: "recording", tabId: 9 });
    p.close();
    await settle();
    expect(f.dbg.detach).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });

  it("is not installed without a debugger (Firefox)", async () => {
    const f = fakeChrome();
    // Any read of `api.debugger` is counted: on Firefox nothing may reach for it.
    let debuggerReads = 0;
    Object.defineProperty(f.api, "debugger", {
      get: () => {
        debuggerReads++;
        return f.dbg;
      },
    });
    vi.resetModules();
    vi.doMock("../src/platform.js", () => ({
      api: f.api,
      BROWSER: "firefox",
      HAS_DEBUGGER: false,
    }));
    await import("../src/background.js");
    // A sidebar port that announced a recording and then went away detaches nothing.
    const p = sidebarPort();
    f.onConnect.forEach((l) => l(p.port));
    p.send({ type: "recording", tabId: 4 });
    p.close();
    await settle();
    expect(f.dbg.detach).not.toHaveBeenCalled();
    expect(debuggerReads).toBe(0);
  });
});

describe("recorder edges", () => {
  it("redactUrl keeps only the scheme of a data: URL", async () => {
    const { mod } = await load();
    expect(mod.redactUrl("data:text/plain,SECRET-BODY")).toBe("data:…");
  });

  it("a failed enable detaches and rejects naming the step", async () => {
    const f = fakeChrome();
    (f.dbg.sendCommand as any).mockImplementation(async (_t: unknown, m: string) => {
      if (m === "Log.enable") {
        throw new Error("boom");
      }
      return {};
    });
    const { mod } = await load(f);
    await expect(mod.start(5, vi.fn())).rejects.toThrow("Log.enable failed");
    expect(f.dbg.detach).toHaveBeenCalledWith({ tabId: 5 });
    expect(mod.isRecording()).toBe(false);
  });

  it("a second start while recording is refused, and events from other tabs are ignored", async () => {
    const { f, mod } = await load();
    await mod.start(5, vi.fn());
    await expect(mod.start(6, vi.fn())).rejects.toThrow(/already running/);
    f.fire("Runtime.consoleAPICalled", consoleCall("other tab"), 6);
    const c = await mod.stop();
    expect(c.console.entries).toHaveLength(0);
  });

  it("text is capped on a character boundary and made well-formed", async () => {
    const { f, mod } = await load();
    await mod.start(5, vi.fn());
    f.fire("Runtime.consoleAPICalled", consoleCall("é".repeat(1500) + "\uD800"));
    const [entry] = (await mod.stop()).console.entries;
    expect(new TextEncoder().encode(entry.text).length).toBe(2048);
    expect(entry.text.isWellFormed()).toBe(true);
  });

  it("Log.entryAdded becomes a console entry with its mapped level", async () => {
    const { f, mod } = await load();
    await mod.start(5, vi.fn());
    f.fire("Log.entryAdded", {
      entry: {
        source: "network",
        level: "warning",
        text: "w",
        url: "https://a.example/x?k=S",
        lineNumber: 0,
        timestamp: 3,
      },
    });
    const [entry] = (await mod.stop()).console.entries;
    expect(entry).toEqual({ level: "warn", text: "w", source: "https://a.example/x?k=…:1", ts: 3 });
  });
});

// Fix round (tech review, measured in Chromium): page_url, URLs inside console text, the failure
// reason fallback, and Stop racing the 120 s cap.
describe("fix round: no token leaves through page_url or console text", () => {
  it("hostile: page_url is scheme, host and path only — no credentials, query or fragment", async () => {
    const f = fakeChrome();
    f.api.tabs.get.mockImplementation(async (id: number) => ({
      id,
      url: "https://u:PW@app.example/x?pq=PAGESECRET#access_token=FRAGSECRET",
    }));
    const { mod } = await load(f);
    await mod.start(5, vi.fn());
    const c = await mod.stop();
    expect(c.console.page_url).toBe("https://app.example/x");
    expect(c.network.page_url).toBe("https://app.example/x");
    expect(JSON.stringify(c)).not.toMatch(/SECRET|PW|pq=|#/);
  });

  it("page_url falls back to the debugger's target list when tabs.get hides the URL", async () => {
    const f = fakeChrome();
    f.api.tabs.get.mockImplementation(async (id: number) => ({ id }) as any);
    f.dbg.getTargets.mockResolvedValue([
      { tabId: 5, attached: true, type: "page", id: "a", url: "http://127.0.0.1:8080/p?t=S" },
    ]);
    const { mod } = await load(f);
    await mod.start(5, vi.fn());
    expect((await mod.stop()).console.page_url).toBe("http://127.0.0.1:8080/p");
  });

  it("hostile: CORS, WebSocket and stack-frame URLs in console text keep names, not values", async () => {
    const { f, mod } = await load();
    await mod.start(5, vi.fn());
    f.fire("Log.entryAdded", {
      entry: {
        source: "network",
        level: "error",
        text: "Access to fetch at 'https://api.example/x?token=S1#S0' from origin 'https://app.example' has been blocked by CORS policy",
        timestamp: 1,
      },
    });
    f.fire("Log.entryAdded", {
      entry: {
        source: "network",
        level: "error",
        text: "WebSocket connection to 'wss://ws.example/s?key=S2' failed:",
        timestamp: 2,
      },
    });
    f.fire("Runtime.exceptionThrown", {
      timestamp: 3,
      exceptionDetails: {
        text: "Uncaught",
        exception: {
          description: "TypeError: boom\n    at f (http://app.example/app.js?token=S3:12:28)",
        },
      },
    });
    f.fire("Runtime.consoleAPICalled", consoleCall("see https://u:PW@h.example/p?sid=S4 now"));
    const entries = (await mod.stop()).console.entries;
    const texts = entries.map((e: { text: string }) => decodeURIComponent(e.text));
    expect(JSON.stringify(entries)).not.toMatch(/S[0-4]\b|PW/);
    expect(texts[0]).toContain("'https://api.example/x?token=…'");
    expect(texts[1]).toContain("'wss://ws.example/s?key=…'");
    expect(texts[2]).toContain("(http://app.example/app.js?token=…:12:28)");
    expect(texts[3]).toBe("see https://h.example/p?sid=… now");
  });

  it("a failure with an empty errorText falls back to blockedReason, then to 'failed'", async () => {
    const { f, mod } = await load();
    await mod.start(5, vi.fn());
    for (const [id, extra] of [
      ["b1", { errorText: "", blockedReason: "mixed-content" }],
      ["b2", { errorText: "" }],
    ] as const) {
      f.fire("Network.requestWillBeSent", {
        requestId: id,
        timestamp: 1,
        type: "Image",
        request: { method: "GET", url: `https://cdn.example/${id}` },
      });
      f.fire("Network.loadingFailed", { requestId: id, timestamp: 1.5, type: "Image", ...extra });
    }
    const failed = (await mod.stop()).network.entries.map((e: { failed: string }) => e.failed);
    expect(failed).toEqual(["mixed-content", "failed"]);
  });
});

describe("fix round: Stop racing the 120 s cap", () => {
  it("hostile: a Stop while the cap is detaching gets the cap's captures, not an error", async () => {
    vi.useFakeTimers();
    const f = fakeChrome();
    let release!: () => void;
    f.dbg.detach.mockImplementation(() => new Promise<void>((r) => (release = r)));
    const { mod } = await load(f);
    const onEnd = vi.fn();
    await mod.start(5, onEnd);
    f.fire("Runtime.consoleAPICalled", consoleCall("kept"));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.dbg.detach).toHaveBeenCalledTimes(1);
    const stopped = mod.stop();
    release();
    const c = await stopped;
    expect(c.console.entries.map((e: { text: string }) => e.text)).toEqual(["kept"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]![0]).toEqual(c);
    await expect(mod.stop()).rejects.toThrow(/no recording/);
  });
});
