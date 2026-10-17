// @vitest-environment happy-dom
// Story 045, task 13.3 (F2) — the address and screenshot sentences name the key the user has
// actually bound to `start-picker`, read with `commands.getAll()` when the sentence is shown, and
// say "the Pick element shortcut" when nothing is bound.
// Requirements: R9.10 (address sentence), R10.8 (screenshot sentence, `<shortcut>` as in R9.10).
// design.md §A5 "Site access" (v5) and §A1 commands row (default `Alt+Shift+D`).
//
// Seam: the design pins only `commands.getAll()`, not where the sidebar reaches it. The fake is
// therefore offered on every route an extension page can take — `deps.commands`,
// `deps.page.commands` and the mocked `api.commands` of `src/platform.ts` — all backed by the same
// mutable list, so the test describes the behaviour, not the wiring.
//
// Hostile halves first, for "the key bound to start-picker":
//   - wrong collapse: another command (`open-sidebar`, listed first) is bound and start-picker is
//     not — the sentence must fall back, never borrow Alt+Shift+Y;
//   - wrong split: the user rebinds start-picker between two showings — the second sentence must
//     name the new key, not a value read once at mount (and the reverse, bound -> unbound);
//   - a rebound key must appear instead of the default (no hard-coded Alt+Shift+D or Alt+Shift+E);
//   - an empty shortcut, a missing `shortcut` field and an absent start-picker all mean unbound.
// Only then the benign default.
import { afterEach, describe, expect, it, vi } from "vitest";

const EXT_ID = "zeo-test-extension";
const flush = () => new Promise((r) => setTimeout(r, 0));

const FALLBACK = "the Pick element shortcut";
const ADDRESS = (key: string) =>
  `Zeo cannot see this page's address yet: on that page, press ${key} (Pick element) or click the Zeo toolbar icon`;
const SCREENSHOT = (key: string) =>
  `Zeo needs this page's permission for screenshots: press ${key} on the page or click the Zeo toolbar icon, then try again`;

/** What `commands.getAll()` resolves to; tests rebind keys by replacing `bindings.list`. */
type Command = { name?: string; description?: string; shortcut?: string };
const OPEN_SIDEBAR: Command = {
  name: "open-sidebar",
  description: "Open",
  shortcut: "Alt+Shift+Y",
};
const picker = (shortcut?: string): Command =>
  shortcut === undefined
    ? { name: "start-picker", description: "Pick element" }
    : { name: "start-picker", description: "Pick element", shortcut };

function fakeCommands(list: Command[]) {
  const bindings = { list };
  const commands = {
    getAll: vi.fn(async () => bindings.list.map((c) => ({ ...c }))),
    onCommand: { addListener() {}, removeListener() {} },
  };
  return { bindings, commands };
}

/** A capture refused for lack of activeTab, as Chrome words it. */
const NO_ACTIVE_TAB = () =>
  Promise.reject(new Error("Either the '<all_urls>' or 'activeTab' permission is required."));

function fakePage(url: string | undefined, commands: unknown) {
  const tab: { id: number; url?: string } = { id: 7, url };
  const event = () => ({ addListener() {}, removeListener() {} });
  return {
    tabs: {
      query: vi.fn(async () => [{ ...tab }]),
      sendMessage: vi.fn(async () => ({ ok: true })),
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
    },
    windows: {
      getCurrent: vi.fn(async () => ({ id: 1, type: "normal" })),
      getLastFocused: vi.fn(async () => ({ id: 1 })),
      onFocusChanged: event(),
    },
    permissions: { request: vi.fn(async () => true) },
    scripting: { executeScript: vi.fn(async () => []) },
    commands,
  };
}

async function mount(list: Command[], url: string | undefined) {
  const { bindings, commands } = fakeCommands(list);
  const captureVisibleTab = vi.fn(NO_ACTIVE_TAB);
  vi.resetModules();
  vi.doMock("../src/platform.js", () => ({
    api: { tabs: { captureVisibleTab }, commands },
    BROWSER: "chrome",
    HAS_DEBUGGER: false,
  }));
  const { mountSidebar } = await import("../src/sidebar/view.js");
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const page = fakePage(url, commands);
  await mountSidebar(root, {
    channel: { connect() {}, close() {}, request: () => new Promise(() => {}), on() {} },
    storage: { get: async () => ({}), set: async () => {} },
    runtime: {
      id: EXT_ID,
      onMessage: { addListener() {}, removeListener() {} },
    },
    platform: { BROWSER: "chrome", HAS_DEBUGGER: false },
    page,
    commands,
    log: { info() {}, warn() {} },
  } as any);
  await flush();
  const button = (name: RegExp) =>
    [...root.querySelectorAll("button")].find((b) => name.test(b.textContent ?? ""))!;
  const text = () => root.textContent ?? "";
  return { bindings, commands, page, captureVisibleTab, button, text };
}

type View = Awaited<ReturnType<typeof mount>>;

/** The two surfaces that carry `<shortcut>`: how to make each sentence appear. */
const SURFACES = [
  {
    name: "address sentence (R9.10)",
    url: undefined,
    sentence: ADDRESS,
    show: async (v: View) => {
      v.button(/pick element/i).click();
      await vi.waitFor(() => expect(v.text()).toMatch(/press .+ \(Pick element\)/), {
        timeout: 2000,
      });
    },
  },
  {
    name: "screenshot sentence (R10.8)",
    url: "https://app.example/",
    sentence: SCREENSHOT,
    show: async (v: View) => {
      const calls = v.captureVisibleTab.mock.calls.length;
      v.button(/^screenshot$/i).click();
      await vi.waitFor(
        () => {
          expect(v.captureVisibleTab.mock.calls.length).toBeGreaterThan(calls);
          expect(v.text()).toMatch(/permission for screenshots: press .+ on the page/);
        },
        { timeout: 3000 },
      );
    },
  },
] as const;

afterEach(() => {
  vi.doUnmock("../src/platform.js");
  vi.resetModules();
});

describe.each(SURFACES)("$name names the key bound to start-picker", (s) => {
  it("hostile: start-picker unbound while open-sidebar is bound says the fallback, never Alt+Shift+Y", async () => {
    const v = await mount([OPEN_SIDEBAR, picker("")], s.url);
    await s.show(v);
    expect(v.text()).toContain(s.sentence(FALLBACK));
    expect(v.text()).not.toContain("Alt+Shift+Y");
    expect(v.commands.getAll).toHaveBeenCalled();
  });

  it("hostile: a rebound key is named instead of the default", async () => {
    const v = await mount([OPEN_SIDEBAR, picker("Ctrl+Shift+K")], s.url);
    await s.show(v);
    expect(v.text()).toContain(s.sentence("Ctrl+Shift+K"));
    expect(v.text()).not.toContain("Alt+Shift+D");
    expect(v.text()).not.toContain("Alt+Shift+E");
  });

  it("hostile: the key is read when the sentence is shown, not once at mount", async () => {
    const v = await mount([OPEN_SIDEBAR, picker("Alt+Shift+D")], s.url);
    await s.show(v);
    expect(v.text()).toContain(s.sentence("Alt+Shift+D"));

    // The user rebinds it in the browser's shortcut settings, then meets the sentence again.
    v.bindings.list = [OPEN_SIDEBAR, picker("Ctrl+Shift+K")];
    await s.show(v);
    await vi.waitFor(() => expect(v.text()).toContain(s.sentence("Ctrl+Shift+K")));
    expect(v.text()).not.toContain("Alt+Shift+D");

    // …and then clears it.
    v.bindings.list = [OPEN_SIDEBAR, picker("")];
    await s.show(v);
    await vi.waitFor(() => expect(v.text()).toContain(s.sentence(FALLBACK)));
    expect(v.text()).not.toContain("Ctrl+Shift+K");
  });

  it.each([
    ["has no shortcut field", [OPEN_SIDEBAR, picker(undefined)]],
    ["is missing from commands.getAll()", [OPEN_SIDEBAR]],
  ])("start-picker that %s counts as unbound", async (_label, list) => {
    const v = await mount(list as Command[], s.url);
    await s.show(v);
    expect(v.text()).toContain(s.sentence(FALLBACK));
  });

  it("the default binding is named as Alt+Shift+D", async () => {
    const v = await mount([picker("Alt+Shift+D"), OPEN_SIDEBAR], s.url);
    await s.show(v);
    expect(v.text()).toContain(s.sentence("Alt+Shift+D"));
    expect(v.text()).not.toContain("Alt+Shift+E");
  });
});

describe("reading the shortcut does not cost the click its gesture (R9.13)", () => {
  it("hostile: with commands available, a visible URL still asks for the site synchronously in the click", async () => {
    const v = await mount([OPEN_SIDEBAR, picker("Alt+Shift+D")], "https://app.example/a?b=1");
    v.button(/pick element/i).click();
    // Before the handler has yielded once: no `await commands.getAll()` may precede it.
    expect(v.page.permissions.request).toHaveBeenCalledWith({ origins: ["https://app.example/*"] });
  });
});
