// @vitest-environment happy-dom
// Story 045, task 4.2 — the sidebar side of the picker (design.md §A5): the protected-page state,
// the Pick button's site permission and injection, the shortcut's `start-picker` notice, and the
// "no unique selector" reason. Requirements: R9.1, R9.6, R9.9, R9.10.
//
// Hostile halves first:
//   - a protected page keeps Pick, Screenshot and Record disabled even once their handlers exist;
//   - permissions.request runs inside the click, before the handler yields; `start-picker` (no
//     gesture) never calls it.
import { describe, expect, it, vi } from "vitest";
import { mountSidebar } from "../src/sidebar/view.js";

const PROTECTED = "Zeo cannot read this page: the browser protects it";
const NO_SELECTOR = "Zeo could not build a unique selector for this element";
const EXT_ID = "zeo-test-extension";
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakePage(
  opts: {
    url?: string;
    granted?: boolean;
    exec?: () => Promise<unknown>;
    windowId?: number;
    windowType?: string;
  } = {},
) {
  const tab: { id: number; url?: string } = { id: 7, url: opts.url };
  const listeners: Record<string, Array<(...a: any[]) => void>> = {};
  const event = (name: string) => ({
    addListener: (f: any) => (listeners[name] ??= []).push(f),
    removeListener: (f: any) => (listeners[name] = (listeners[name] ?? []).filter((g) => g !== f)),
  });
  return {
    tab,
    listeners,
    deps: {
      tabs: {
        query: vi.fn(async () => [{ ...tab }]),
        onActivated: event("onActivated"),
        onUpdated: event("onUpdated"),
      },
      windows: {
        getCurrent: vi.fn(async () => ({
          id: opts.windowId ?? 1,
          type: opts.windowType ?? "normal",
        })),
        getLastFocused: vi.fn(async () => ({ id: 1 })),
        onFocusChanged: event("onFocusChanged"),
      },
      permissions: { request: vi.fn(async () => opts.granted ?? true) },
      scripting: { executeScript: vi.fn(opts.exec ?? (async () => [])) },
    },
  };
}

async function mount(page: ReturnType<typeof fakePage>) {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const runtimeListeners: Array<(m: unknown, s?: unknown) => void> = [];
  const handle: any = await mountSidebar(root, {
    channel: { connect() {}, close() {}, request: () => new Promise(() => {}), on() {} },
    storage: { get: async () => ({}), set: async () => {} },
    runtime: {
      id: EXT_ID,
      onMessage: { addListener: (f: any) => runtimeListeners.push(f), removeListener() {} },
    },
    platform: { BROWSER: "chrome", HAS_DEBUGGER: true },
    page: page.deps,
    log: { info() {}, warn() {} },
  } as any);
  await flush();
  const button = (name: RegExp) =>
    [...root.querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))!;
  const deliver = (m: unknown, sender: unknown) => runtimeListeners.forEach((f) => f(m, sender));
  return { root, handle, button, deliver, text: () => root.textContent ?? "" };
}

describe("protected page (R9.9)", () => {
  it("hostile: disables Pick, Screenshot and Record and says why, even with handlers installed", async () => {
    const page = fakePage({ url: "chrome://settings" });
    const v = await mount(page);
    const shot = vi.fn();
    v.handle.composer.setTool("screenshot", shot);
    v.handle.composer.setTool("record", shot);
    for (const name of [/pick element/i, /screenshot/i, /record/i]) {
      expect(v.button(name).disabled, String(name)).toBe(true);
    }
    expect(v.text()).toContain(PROTECTED);
    v.button(/screenshot/i).dispatchEvent(new MouseEvent("click"));
    expect(shot).not.toHaveBeenCalled();
    expect(page.deps.permissions.request).not.toHaveBeenCalled();
  });

  it("leaving the protected page re-enables the tools and hides the sentence", async () => {
    const page = fakePage({ url: "about:blank" });
    const v = await mount(page);
    expect(v.text()).toContain(PROTECTED);
    page.tab.url = "https://app.example/";
    page.listeners.onActivated!.forEach((f) => f({ tabId: 7 }));
    await flush();
    expect(v.text()).not.toContain(PROTECTED);
    expect(v.button(/pick element/i).disabled).toBe(false);
  });

  it("an injection refused with 'Cannot access' turns the protected state on", async () => {
    const page = fakePage({
      url: "https://app.example/",
      exec: () => Promise.reject(new Error("Cannot access contents of the page.")),
    });
    const v = await mount(page);
    v.button(/pick element/i).click();
    await flush();
    expect(v.text()).toContain(PROTECTED);
    expect(v.button(/pick element/i).disabled).toBe(true);
  });
});

describe("PDF viewer (R9.9)", () => {
  it("hostile: picker.js reporting a PDF viewer turns the protected state on, and a refresh keeps it", async () => {
    const page = fakePage({
      url: "https://app.example/doc.pdf",
      exec: async () => [{ frameId: 0, result: "protected" }],
    });
    const v = await mount(page);
    v.button(/pick element/i).click();
    await flush();
    expect(v.text()).toContain(PROTECTED);
    expect(v.button(/screenshot/i).disabled).toBe(true);
    expect(v.button(/record/i).disabled).toBe(true);
    page.listeners.onUpdated!.forEach((f) => f(7));
    await flush();
    expect(v.text()).toContain(PROTECTED);
    page.tab.url = "https://app.example/page.html";
    page.listeners.onUpdated!.forEach((f) => f(7));
    await flush();
    expect(v.text()).not.toContain(PROTECTED);
  });

  it("a script that did not mount says so", async () => {
    const page = fakePage({
      url: "https://app.example/",
      exec: async () => [{ frameId: 0, result: "failed" }],
    });
    const v = await mount(page);
    v.button(/pick element/i).click();
    await flush();
    expect(v.text()).toContain("Zeo could not start the picker on this page");
  });
});

describe("which window's tab (R9.1)", () => {
  it("hostile: follows the window hosting the sidebar, not the last-focused one", async () => {
    const page = fakePage({ url: "https://app.example/", windowId: 5 });
    await mount(page);
    expect(page.deps.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 5 });
    expect(page.deps.windows.getLastFocused).not.toHaveBeenCalled();
  });

  it("from a popup window (the E2E harness) it falls back to the last-focused normal window", async () => {
    const page = fakePage({ url: "https://app.example/", windowId: 5, windowType: "popup" });
    await mount(page);
    expect(page.deps.windows.getLastFocused).toHaveBeenCalledWith({ windowTypes: ["normal"] });
    expect(page.deps.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 1 });
  });

  it("a Pick uses the tab as last read and re-reads it after the click", async () => {
    const page = fakePage({ url: "https://app.example/" });
    const v = await mount(page);
    const reads = page.deps.tabs.query.mock.calls.length;
    v.button(/pick element/i).click();
    expect(page.deps.permissions.request).toHaveBeenCalledTimes(1);
    await flush();
    expect(page.deps.tabs.query.mock.calls.length).toBe(reads + 1);
  });
});

describe("Pick element (R9.1, R9.10)", () => {
  it("hostile: asks for the site inside the click, then injects picker.js into the tab", async () => {
    const page = fakePage({ url: "https://app.example/a?b=1" });
    const v = await mount(page);
    v.button(/pick element/i).click();
    // Synchronously, before the handler has yielded once.
    expect(page.deps.permissions.request).toHaveBeenCalledWith({
      origins: ["https://app.example/*"],
    });
    await flush();
    expect(page.deps.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["picker.js"],
    });
  });

  it("a refusal injects nothing and says what is missing", async () => {
    const page = fakePage({ url: "https://app.example/", granted: false });
    const v = await mount(page);
    v.button(/pick element/i).click();
    await flush();
    expect(page.deps.scripting.executeScript).not.toHaveBeenCalled();
    expect(v.text()).toContain("Zeo needs access to this site to pick elements");
  });

  it("an address the browser hides asks nothing and points at the shortcut", async () => {
    const page = fakePage({ url: undefined });
    const v = await mount(page);
    v.button(/pick element/i).click();
    await flush();
    expect(page.deps.permissions.request).not.toHaveBeenCalled();
    expect(v.text()).toContain("Alt+Shift+E");
  });

  it("start-picker from the background re-reads the tab and never asks for a permission", async () => {
    const page = fakePage({ url: "https://app.example/" });
    const v = await mount(page);
    const reads = page.deps.tabs.query.mock.calls.length;
    v.deliver({ type: "start-picker", tabId: 7 }, { id: EXT_ID });
    await flush();
    expect(page.deps.tabs.query.mock.calls.length).toBe(reads + 1);
    expect(page.deps.permissions.request).not.toHaveBeenCalled();
    v.deliver({ type: "start-picker", tabId: 7 }, { id: "someone-else" });
    await flush();
    expect(page.deps.tabs.query.mock.calls.length).toBe(reads + 1);
  });
});

describe("no unique selector (R9.6)", () => {
  it("attaches the elements that came through and says why one did not", async () => {
    const v = await mount(fakePage({ url: "https://app.example/" }));
    v.deliver(
      {
        type: "picked",
        items: [
          {
            type: "element",
            page_url: "https://app.example/",
            selector: "#ok",
            html: "<button>Ok</button>",
            dom: {
              tag: "button",
              id: "ok",
              classes: [],
              text: "Ok",
              attrs: {},
              styles: {},
              rect: { x: 0, y: 0, w: 1, h: 1 },
            },
          },
        ],
        rects: [{ x: 0, y: 0, w: 1, h: 1 }],
        viewport: { innerWidth: 1000, innerHeight: 800 },
        skipped: 1,
      },
      { id: EXT_ID, tab: { id: 7 } },
    );
    expect(v.handle.composer.attachments()).toHaveLength(1);
    expect(v.text()).toContain(NO_SELECTOR);
  });
});

// Story 045, task 4.5 amendment: the shortcut's boot outcome, delivered by the background on the
// `sidebar` port, is shown for that tab.
describe("shortcut boot status from the background (R9.1, R9.9)", () => {
  async function mountWithPort(page: ReturnType<typeof fakePage>) {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const fromBackground: Array<(m: unknown) => void> = [];
    const port = {
      postMessage() {},
      disconnect() {},
      onMessage: { addListener: (f: (m: unknown) => void) => fromBackground.push(f) },
      onDisconnect: { addListener() {} },
    };
    const connect = vi.fn(() => port);
    await mountSidebar(root, {
      channel: { connect() {}, close() {}, request: () => new Promise(() => {}), on() {} },
      storage: { get: async () => ({}), set: async () => {} },
      runtime: {
        id: EXT_ID,
        connect,
        onMessage: { addListener() {}, removeListener() {} },
      },
      platform: { BROWSER: "firefox", HAS_DEBUGGER: false },
      page: page.deps,
      log: { info() {}, warn() {} },
    } as any);
    await flush();
    const button = (name: RegExp) =>
      [...root.querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))!;
    const push = async (m: unknown) => {
      fromBackground.forEach((f) => f(m));
      await flush();
    };
    return { connect, push, button, text: () => root.textContent ?? "" };
  }

  it("connects the sidebar port at mount and re-reads the tab on start-picker", async () => {
    const page = fakePage({ url: "https://app.example/" });
    const v = await mountWithPort(page);
    expect(v.connect).toHaveBeenCalledWith({ name: "sidebar" });
    const reads = page.deps.tabs.query.mock.calls.length;
    await v.push({ type: "start-picker", tabId: 7 });
    expect(page.deps.tabs.query.mock.calls.length).toBe(reads + 1);
    expect(page.deps.permissions.request).not.toHaveBeenCalled();
  });

  it("hostile: a protected outcome (a PDF viewer) disables the tools and says why, asking nothing", async () => {
    const page = fakePage({ url: "https://app.example/doc.pdf" });
    const v = await mountWithPort(page);
    expect(v.text()).not.toContain(PROTECTED);
    await v.push({ type: "start-picker", tabId: 7 });
    await v.push({ type: "picker-status", tabId: 7, status: "protected" });
    expect(v.text()).toContain(PROTECTED);
    expect(v.button(/pick element/i).disabled).toBe(true);
    expect(v.button(/screenshot/i).disabled).toBe(true);
    expect(page.deps.permissions.request).not.toHaveBeenCalled();
    page.tab.url = "https://app.example/page.html";
    page.listeners.onUpdated!.forEach((f) => f(7));
    await flush();
    expect(v.text()).not.toContain(PROTECTED);
  });

  it("a failed outcome shows the failure sentence", async () => {
    const v = await mountWithPort(fakePage({ url: "https://app.example/" }));
    await v.push({ type: "picker-status", tabId: 7, status: "failed" });
    expect(v.text()).toContain("Zeo could not start the picker on this page");
  });

  it("hostile: a start-picker or picker-status runtime message from a tab is ignored", async () => {
    const page = fakePage({ url: "https://app.example/" });
    const v = await mount(page);
    const reads = page.deps.tabs.query.mock.calls.length;
    const fromContent = { id: EXT_ID, tab: { id: 7, windowId: 1 } };
    v.deliver({ type: "start-picker", tabId: 7 }, fromContent);
    v.deliver({ type: "picker-status", tabId: 7, status: "protected" }, fromContent);
    v.deliver({ type: "picker-status", tabId: 7, status: "failed" }, fromContent);
    await flush();
    expect(page.deps.tabs.query.mock.calls.length).toBe(reads);
    expect(v.text()).not.toContain(PROTECTED);
    expect(v.text()).not.toContain("Zeo could not start the picker on this page");
  });

  it("an outcome for another window's tab, or a malformed one, changes nothing", async () => {
    const v = await mountWithPort(fakePage({ url: "https://app.example/" }));
    await v.push({ type: "picker-status", tabId: 99, status: "protected" });
    await v.push({ type: "picker-status", tabId: 7, status: "mounted" });
    await v.push({ type: "picker-status", tabId: "7", status: "failed" });
    expect(v.text()).not.toContain(PROTECTED);
    expect(v.text()).not.toContain("Zeo could not start the picker on this page");
    expect(v.button(/pick element/i).disabled).toBe(false);
  });
});
