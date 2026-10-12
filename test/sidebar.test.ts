// @vitest-environment happy-dom
// Story 045, task 3.3 — the sidebar view and composer (design.md §A4).
// Requirements: R5.1, R5.3, R5.4, R5.5, R5.6, R5.8, R6.1, R6.4, R6.5, R6.6, R6.7, R7.1, R7.2,
// R7.4, R7.5, R7.6, R7.7, R7.8, R7.9, R7.10, R7.11, R8.4, R8.6, R8.8, R8.9, R8.10, R9.12,
// R10.5, R11.9 (Q4, Q17).
//
// Assumed seam (adjust `mount` and `FakeChannel.reply` only if they move):
//   `mountSidebar(root: HTMLElement, deps)` from `src/sidebar/view.ts` (may return a Promise),
//   with `deps = { channel, storage, runtime, platform: { BROWSER, HAS_DEBUGGER } }`:
//   - `channel` has the §A3 interface (`connect`, `close`, `request`, `on("state"|"event")`);
//     a reply — error replies included — resolves `request()` with the ServerMsg;
//   - `storage` is `chrome.storage.local`-shaped (`get`, `set`);
//   - `runtime.onMessage` delivers `{ type: "picked", items, rects, viewport }` from the picker.
//   The target menu is a `<select>` whose first option is "Follow active thread".
//
// Hostile halves first:
//   - transcript identity: `entry_updated` at index 1 replaces index 1 only (never appends, never
//     touches 0); `entries_removed` [1, 2) removes exactly that entry;
//   - target identity: a stored pinned thread restores pinned (not follow), and "follow" restores
//     follow; choosing a thread persists only `target`;
//   - permissions: `permission_resolved` for ANOTHER request leaves the card; its own removes it;
//   - composer: a failed send keeps the text and chips; only `sent` clears them.
import { afterEach, describe, expect, it } from "vitest";
import { mountSidebar } from "../src/sidebar/view.js";

type Pending = { msg: any; resolve: (v: unknown) => void; reject: (e: unknown) => void };
class FakeChannel {
  private stateL: Array<(...a: any[]) => void> = [];
  private eventL: Array<(e: any) => void> = [];
  requests: Pending[] = [];
  connected = 0;
  closed = 0;
  connect() {
    this.connected++;
  }
  close() {
    this.closed++;
  }
  request(msg: any) {
    return new Promise((resolve, reject) => this.requests.push({ msg, resolve, reject }));
  }
  on(ev: string, f: any) {
    (ev === "state" ? this.stateL : this.eventL).push(f);
  }
  state(s: unknown) {
    for (const f of this.stateL) {
      f(s);
    }
  }
  event(e: unknown) {
    for (const f of this.eventL) {
      f(e);
    }
  }
  last(kind: string) {
    return [...this.requests].reverse().find((r) => r.msg.kind === kind);
  }
  reply(kind: string, value: object) {
    const r = this.last(kind);
    if (!r) {
      throw new Error(`no ${kind} request was made`);
    }
    r.resolve({ v: 2, id: r.msg.id, ...value });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const idle = { state: "idle", message: null };
const thread = (id: string, title: string, followed = true) => ({
  thread_id: id,
  title,
  project: "app",
  agent: "Claude",
  status: "idle",
  followed,
});
const entry = (markdown: string, role = "assistant", extra: object = {}) => ({
  role,
  markdown,
  truncated: false,
  ...extra,
});
const snapshot = (over: object = {}) => ({
  kind: "snapshot",
  thread: thread("t1", "Fix the build"),
  earlier: 0,
  entries: [entry("first")],
  status: idle,
  permissions: [],
  ...over,
});
const dom = {
  tag: "button",
  id: "save",
  classes: [],
  text: "Save",
  attrs: {},
  styles: {},
  rect: { x: 0, y: 0, w: 1, h: 1 },
};
const picked = (n: number) => ({
  type: "picked",
  items: Array.from({ length: n }, (_, i) => ({
    type: "element",
    page_url: "https://app.example/",
    selector: `#e${i}`,
    html: "<button>Save</button>",
    dom,
  })),
  rects: [],
  viewport: { innerWidth: 1000, innerHeight: 800 },
});

let root: HTMLElement;
let channel: FakeChannel;
let stored: Record<string, unknown>;
let runtimeListeners: Array<(m: unknown, s?: unknown, r?: unknown) => void>;
// What mountSidebar returns (amendment): the page tools' entry points.
let handle: any;
// Fix round N1: `picked` is accepted only from this extension's content script.
const EXT_ID = "zeo-test-extension";
const pageSender = { id: EXT_ID, tab: { id: 1 } };

async function mount(opts: { stored?: Record<string, unknown>; hasDebugger?: boolean } = {}) {
  root = document.createElement("div");
  document.body.replaceChildren(root);
  channel = new FakeChannel();
  stored = { ...(opts.stored ?? {}) };
  runtimeListeners = [];
  const storage = {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) {
        return { ...stored };
      }
      const ks = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => k in stored).map((k) => [k, stored[k]]));
    },
    set: async (obj: Record<string, unknown>) => void Object.assign(stored, obj),
    remove: async (k: string) => void delete stored[k],
  };
  const runtime = {
    id: EXT_ID,
    onMessage: { addListener: (f: any) => runtimeListeners.push(f), removeListener() {} },
    connect: () => ({
      onDisconnect: { addListener() {} },
      onMessage: { addListener() {} },
      postMessage() {},
      disconnect() {},
    }),
  };
  const hasDebugger = opts.hasDebugger ?? true;
  handle = await mountSidebar(root, {
    channel,
    storage,
    runtime,
    platform: { BROWSER: hasDebugger ? "chrome" : "firefox", HAS_DEBUGGER: hasDebugger },
  } as any);
  await flush();
}

async function ready(snap: object = snapshot()) {
  channel.state("ready");
  await flush();
  channel.reply("subscribe", snap);
  await flush();
}

const text = () => root.textContent ?? "";
const buttons = () => [...root.querySelectorAll("button")];
const button = (name: RegExp) => {
  const b = buttons().find(
    (x) => name.test(x.textContent ?? "") || name.test(x.getAttribute("aria-label") ?? ""),
  );
  if (!b) {
    throw new Error(
      `no button ${name}: ${buttons()
        .map((x) => x.textContent)
        .join(" | ")}`,
    );
  }
  return b;
};
const composer = () => root.querySelector("textarea") as HTMLTextAreaElement;
async function type(value: string) {
  composer().value = value;
  composer().dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}
async function click(b: HTMLElement) {
  b.click();
  await flush();
}

afterEach(() => document.body.replaceChildren());

describe("connection banners (R8.4, R8.6, R8.8, R5.6)", () => {
  it("each connection state has its exact words", async () => {
    await mount();
    channel.state("unreachable");
    await flush();
    expect(text()).toContain("Zeo is not running, or its devtools bridge is off");
    channel.state("no_host");
    await flush();
    expect(text()).toContain("The Zeo browser host is not installed (USE=browser-extension)");
    channel.state("approval_pending");
    await flush();
    expect(text()).toContain("Approve this browser in Zeo");
  });

  it("a snapshot with no thread says so", async () => {
    await mount();
    await ready(snapshot({ thread: null, entries: [] }));
    expect(text()).toContain("No active agent thread in Zeo");
  });
});

describe("transcript", () => {
  it("renders entries in order, earlier count with Open in Zeo, question, tool, truncation, status (R6.1, R6.5–R6.7)", async () => {
    await mount();
    await ready(
      snapshot({
        earlier: 7,
        entries: [
          entry("hello agent", "user"),
          entry("hello human"),
          entry("", "question"),
          entry("ran it", "tool", { tool: { title: "Run cargo test", status: "completed" } }),
          entry("long text", "assistant", { truncated: true }),
        ],
        status: { state: "error", message: "Rate limited" },
      }),
    );
    const t = text();
    expect(t.indexOf("hello agent")).toBeLessThan(t.indexOf("hello human"));
    expect(t).toMatch(/7 earlier entries/);
    expect(button(/open in zeo/i)).toBeTruthy();
    expect(t).toContain("The agent asked a question — answer it in Zeo");
    expect(t).toContain("Run cargo test");
    expect(t).toMatch(/completed/i);
    expect(t).toContain("(truncated — open in Zeo for the rest)");
    expect(t).toContain("Rate limited");
  });

  it("no earlier-count line when earlier is 0", async () => {
    await mount();
    await ready();
    expect(text()).not.toMatch(/earlier entries/);
  });

  it("each status state is shown", async () => {
    await mount();
    await ready();
    for (const [state, words] of [
      ["working", /working/i],
      ["awaiting_permission", /permission/i],
      ["idle", /idle/i],
    ] as const) {
      channel.event({ v: 2, kind: "status", status: { state, message: null } });
      await flush();
      expect(text()).toMatch(words);
    }
  });

  it("hostile: entry_updated replaces by index; entries_removed splices exactly the range (R6.4)", async () => {
    await mount();
    await ready(snapshot({ entries: [entry("zero"), entry("one"), entry("two")] }));
    channel.event({ v: 2, kind: "entry_updated", index: 1, entry: entry("ONE-v2") });
    await flush();
    let t = text();
    expect(t).toContain("zero");
    expect(t).toContain("ONE-v2");
    expect(t).not.toMatch(/\bone\b/);
    expect(t.indexOf("zero")).toBeLessThan(t.indexOf("ONE-v2"));
    expect(t.indexOf("ONE-v2")).toBeLessThan(t.indexOf("two"));
    channel.event({ v: 2, kind: "entry_added", index: 3, entry: entry("three") });
    channel.event({ v: 2, kind: "entries_removed", start: 1, end: 2 });
    await flush();
    t = text();
    expect(t).not.toContain("ONE-v2");
    for (const w of ["zero", "two", "three"]) {
      expect(t).toContain(w);
    }
  });

  it("target_changed and title update the header (R5.3)", async () => {
    await mount();
    await ready();
    channel.event({ v: 2, kind: "target_changed", thread: thread("t2", "Write the docs") });
    await flush();
    expect(text()).toContain("Write the docs");
    channel.event({ v: 2, kind: "title", title: "Docs, renamed" });
    await flush();
    expect(text()).toContain("Docs, renamed");
  });

  it("thread_closed offers to follow the active thread (R5.5)", async () => {
    await mount({ stored: { target: { thread_id: "t1" } } });
    await ready();
    channel.event({ v: 2, kind: "thread_closed" });
    await flush();
    expect(text()).toContain("This thread was closed in Zeo");
    await click(button(/follow the active thread/i));
    expect(channel.last("subscribe")?.msg.target).toEqual({ follow: true });
  });
});

describe("thread choice (R5.1, R5.4, R5.8, R8.10)", () => {
  it("hostile: a stored pinned thread restores pinned, not follow", async () => {
    await mount({ stored: { target: { thread_id: "t9" } } });
    channel.state("ready");
    await flush();
    expect(channel.last("subscribe")?.msg.target).toEqual({ thread_id: "t9" });
  });

  it("a stored follow restores follow, and nothing stored means follow", async () => {
    await mount({ stored: { target: "follow" } });
    channel.state("ready");
    await flush();
    expect(channel.last("subscribe")?.msg.target).toEqual({ follow: true });
    await mount();
    channel.state("ready");
    await flush();
    expect(channel.last("subscribe")?.msg.target).toEqual({ follow: true });
  });

  it("the menu lists Follow plus the threads; choosing one pins it and stores only `target`", async () => {
    await mount();
    await ready(snapshot({ entries: [entry("SECRET-TRANSCRIPT")] }));
    const select = root.querySelector("select") as HTMLSelectElement;
    select.dispatchEvent(new Event("focus"));
    select.dispatchEvent(new Event("mousedown"));
    await flush();
    if (channel.last("list_threads")) {
      channel.reply("list_threads", {
        kind: "threads",
        items: [thread("t1", "Fix the build"), thread("t2", "Write the docs", false)],
      });
      await flush();
    }
    const labels = [...select.options].map((o) => o.textContent ?? "");
    expect(labels[0]).toMatch(/follow active thread/i);
    expect(labels.join("|")).toContain("Write the docs");
    const t2 = [...select.options].find((o) => (o.textContent ?? "").includes("Write the docs"))!;
    select.value = t2.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(channel.last("subscribe")?.msg.target).toEqual({ thread_id: "t2" });
    expect(stored.target).toEqual({ thread_id: "t2" });
    expect(Object.keys(stored)).toEqual(["target"]);
    expect(JSON.stringify(stored)).not.toContain("SECRET-TRANSCRIPT");
  });
});

describe("composer", () => {
  it("Send is disabled with no text and no attachment, enabled with text (R7.8)", async () => {
    await mount();
    await ready();
    expect(button(/^send$/i).disabled).toBe(true);
    await type("hello");
    expect(button(/^send$/i).disabled).toBe(false);
    await type("");
    expect(button(/^send$/i).disabled).toBe(true);
  });

  it("send while working: 'Queued in Zeo' and the composer is cleared (R7.1, R7.2)", async () => {
    await mount();
    await ready();
    await type("please continue");
    await click(button(/^send$/i));
    const req = channel.last("send");
    expect(req?.msg).toMatchObject({
      v: 2,
      kind: "send",
      text: "please continue",
      attachments: [],
    });
    channel.reply("send", { kind: "sent", queued: true, images: "none" });
    await flush();
    expect(text()).toContain("Queued in Zeo");
    expect(composer().value).toBe("");
  });

  it("hostile: a failed send keeps the text and chips and shows the reason (R7.9)", async () => {
    await mount();
    await ready();
    for (const f of runtimeListeners) {
      f(picked(1), pageSender);
    }
    await flush();
    await type("keep me");
    await click(button(/^send$/i));
    channel.reply("send", {
      kind: "error",
      error: "send_failed",
      message: "The agent is not connected",
      fatal: false,
    });
    await flush();
    expect(composer().value).toBe("keep me");
    expect(text()).toContain("The agent is not connected");
    expect(text()).toMatch(/button · /);
  });

  it("images skipped by the agent are reported (R10.5); AI disabled is reported (R7.10)", async () => {
    await mount();
    await ready();
    await type("one");
    await click(button(/^send$/i));
    channel.reply("send", { kind: "sent", queued: false, images: "skipped_unsupported" });
    await flush();
    expect(text()).toContain("Sent without images: this agent does not accept images");
    await type("two");
    await click(button(/^send$/i));
    channel.reply("send", {
      kind: "error",
      error: "ai_disabled",
      message: "AI is disabled in Zeo",
      fatal: false,
    });
    await flush();
    expect(text()).toContain("AI is disabled in Zeo");
  });

  it("a message over a limit is refused before sending, naming the limit (R7.11)", async () => {
    await mount();
    await ready();
    await type("a".repeat(100_001));
    const b = button(/^send$/i);
    if (!b.disabled) {
      await click(b);
    }
    expect(channel.last("send")).toBeUndefined();
    expect(text()).toMatch(/text|100[ ,.]?000/i);
  });

  it("removing a chip drops its attachment from the next send (R9.12)", async () => {
    await mount();
    await ready();
    for (const f of runtimeListeners) {
      f(picked(2), pageSender);
    }
    await flush();
    const removes = buttons().filter((b) =>
      /remove/i.test((b.getAttribute("aria-label") ?? "") + (b.textContent ?? "")),
    );
    expect(removes.length).toBe(2);
    await click(removes[0]!);
    await type("one element");
    await click(button(/^send$/i));
    const att = channel.last("send")?.msg.attachments as Array<{ selector: string }>;
    expect(att).toHaveLength(1);
    expect(att[0]!.selector).toBe("#e1");
  });

  it("Stop sends cancel (R7.4)", async () => {
    await mount();
    await ready();
    channel.event({ v: 2, kind: "status", status: { state: "working", message: null } });
    await flush();
    await click(button(/stop/i));
    expect(channel.last("cancel")).toBeTruthy();
  });
});

describe("permissions (R7.5–R7.7)", () => {
  const perm = (id: string) => ({
    request_id: id,
    entry_index: 0,
    title: `Run tool ${id}`,
    options: [
      { option_id: "allow", label: "Allow once", kind: "allow_once" },
      { option_id: "deny", label: "Reject", kind: "reject_once" },
    ],
  });

  it("shows the card, answers with the chosen option, and removes it only on its own resolution", async () => {
    await mount();
    await ready();
    channel.event({ v: 2, kind: "permission_requested", permission: perm("p1") });
    await flush();
    expect(text()).toContain("Run tool p1");
    await click(button(/allow once/i));
    expect(channel.last("authorize")?.msg).toMatchObject({ request_id: "p1", option_id: "allow" });
    channel.event({ v: 2, kind: "permission_resolved", request_id: "p-other" });
    await flush();
    expect(text()).toContain("Run tool p1");
    channel.event({ v: 2, kind: "permission_resolved", request_id: "p1" });
    await flush();
    expect(text()).not.toContain("Run tool p1");
  });
});

describe("platform and lifecycle", () => {
  it("Record is rendered with a debugger, and absent without one (R11.9)", async () => {
    await mount({ hasDebugger: true });
    expect(buttons().some((b) => /record/i.test(b.textContent ?? ""))).toBe(true);
    await mount({ hasDebugger: false });
    expect(buttons().some((b) => /record/i.test(b.textContent ?? ""))).toBe(false);
  });

  it("pagehide closes the channel (R8.9)", async () => {
    await mount();
    expect(channel.connected).toBeGreaterThan(0);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(channel.closed).toBe(1);
  });

  it("every control has an accessible name (Q17)", async () => {
    await mount();
    await ready();
    for (const b of buttons()) {
      expect(
        (b.textContent ?? "").trim() || b.getAttribute("aria-label"),
        b.outerHTML,
      ).toBeTruthy();
    }
    for (const el of root.querySelectorAll("textarea, select, input")) {
      const id = el.getAttribute("id");
      const labelled =
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby") ||
        (id && root.querySelector(`label[for="${id}"]`)) ||
        el.closest("label");
      expect(labelled, el.outerHTML).toBeTruthy();
    }
  });
});

// Planned amendment (post-review, task 3.3): compaction, Open in Zeo, the two notices Task 4
// raises, and the words of the version-mismatch and fatal-error states.
describe("amendment: compaction, Open in Zeo, notices, state details", () => {
  // The fake's `state()` passes no detail; the real channel's listener takes one (StateDetail).
  const stateWith = (s: string, detail: object) => {
    for (const f of (channel as any).stateL) {
      f(s, detail);
    }
  };

  it("a compaction entry says so (R6.5)", async () => {
    await mount();
    await ready(snapshot({ entries: [entry("", "compaction")] }));
    expect(text()).toContain("Context compacted");
  });

  it("Open in Zeo sends open_in_zeo and shows its error (R5.7)", async () => {
    await mount();
    await ready();
    await click(button(/open in zeo/i));
    expect(channel.last("open_in_zeo")?.msg).toMatchObject({ v: 2, kind: "open_in_zeo" });
    channel.reply("open_in_zeo", {
      kind: "error",
      error: "no_thread",
      message: "The thread has no window in Zeo",
      fatal: false,
    });
    await flush();
    expect(text()).toContain("The thread has no window in Zeo");
  });

  it("the page tools' two notices have their exact words (R11.7, R10.6)", async () => {
    await mount();
    await ready();
    handle.showNotice("recording_cut_short");
    expect(text()).toContain("Recording stopped early: the debugger was detached");
    handle.showNotice("screenshot_access");
    expect(text()).toContain("Zeo needs access to this site to take a screenshot");
  });

  it("version_mismatch names both sides, and an unknown Zeo side says unknown (R8.7)", async () => {
    await mount();
    stateWith("version_mismatch", {
      versions: {
        extension: { protocol: 2, version: "0.1.0" },
        zeo: { protocol: 3, version: "9.0.0" },
      },
    });
    let t = text();
    expect(t).toMatch(/version/i);
    expect(t).toContain("0.1.0");
    expect(t).toContain("protocol 2");
    expect(t).toContain("9.0.0");
    expect(t).toContain("protocol 3");
    stateWith("version_mismatch", {
      versions: {
        extension: { protocol: 2, version: "0.1.0" },
        zeo: { protocol: null, version: null },
      },
    });
    t = text();
    expect(t).toContain("0.1.0");
    expect(t).toMatch(/Zeo unknown \(protocol unknown\)/);
  });

  it("a fatal error shows Zeo's own message, and Try again reconnects (§A3)", async () => {
    await mount();
    const before = channel.connected;
    stateWith("denied", { error: "approval_denied", message: "Denied in Zeo by the user" });
    expect(text()).toContain("Denied in Zeo by the user");
    await click(button(/try again/i));
    expect(channel.connected).toBe(before + 1);
  });
});

// Fix round (tech review S1–S3, N1, N2, N8).
describe("fix round: in-flight chips, failed subscribes, picker senders, resync", () => {
  const pickedOne = (selector: string) => {
    const m = picked(1);
    m.items[0]!.selector = selector;
    return m;
  };
  const deliver = (m: unknown, sender: unknown = pageSender) => {
    for (const f of runtimeListeners) {
      f(m, sender);
    }
  };
  const chipCount = () =>
    buttons().filter((b) => /remove/i.test(b.getAttribute("aria-label") ?? "")).length;

  it("S1: a chip attached while a send is in flight survives that send's `sent`", async () => {
    await mount();
    await ready();
    deliver(pickedOne("#first"));
    await flush();
    await type("with one chip");
    await click(button(/^send$/i));
    expect((channel.last("send")?.msg.attachments as any[]).map((a) => a.selector)).toEqual([
      "#first",
    ]);
    deliver(pickedOne("#second"));
    await flush();
    channel.reply("send", { kind: "sent", queued: false, images: "none" });
    await flush();
    expect(composer().value).toBe("");
    expect(chipCount()).toBe(1);
    expect(handle.composer.attachments().map((a: any) => a.selector)).toEqual(["#second"]);
  });

  it("S2: a failed subscribe after a retarget clears thread A and ignores A's later events", async () => {
    await mount();
    await ready(snapshot({ entries: [entry("A-ENTRY")] }));
    const select = root.querySelector("select") as HTMLSelectElement;
    select.dispatchEvent(new Event("focus"));
    await flush();
    channel.reply("list_threads", {
      kind: "threads",
      items: [thread("t1", "Fix the build"), thread("t2", "Write the docs", false)],
    });
    await flush();
    select.value = [...select.options].find((o) =>
      o.textContent!.includes("Write the docs"),
    )!.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    channel.reply("subscribe", {
      kind: "error",
      error: "thread_closed",
      message: "That thread was closed",
      fatal: false,
    });
    await flush();
    expect(root.querySelector("h1")?.textContent).not.toContain("Fix the build");
    expect(text()).not.toContain("A-ENTRY");
    channel.event({ v: 2, kind: "entry_added", index: 1, entry: entry("A-LATE") });
    channel.event({ v: 2, kind: "title", title: "A renamed" });
    await flush();
    expect(text()).not.toContain("A-LATE");
    expect(text()).not.toContain("A renamed");
    expect(text()).toContain("This thread was closed in Zeo");
    expect(button(/follow the active thread/i)).toBeTruthy();
  });

  it("S3: a subscribe that is rejected says so in the banner", async () => {
    await mount();
    channel.state("ready");
    await flush();
    channel.last("subscribe")!.reject(new Error("Zeo did not answer"));
    await flush();
    expect(text()).toContain("Zeo did not answer");
  });

  it("N1: a foreign sender, or a sender without a tab, attaches nothing", async () => {
    await mount();
    await ready();
    deliver(picked(1), { id: "someone-else", tab: { id: 1 } });
    deliver(picked(1), { id: EXT_ID });
    for (const f of runtimeListeners) {
      f(picked(1)); // no sender at all
    }
    await flush();
    expect(chipCount()).toBe(0);
    deliver(picked(1));
    await flush();
    expect(chipCount()).toBe(1);
  });

  it("N1: pick geometry is kept only when it is finite and bounded", async () => {
    await mount();
    await ready();
    deliver({ ...picked(1), rects: [{ x: 1, y: 2, w: 3, h: 4 }] });
    expect(handle.lastPick()).toEqual({
      rects: [{ x: 1, y: 2, w: 3, h: 4 }],
      viewport: { innerWidth: 1000, innerHeight: 800 },
    });
    deliver({ ...picked(1), rects: [{ x: Infinity, y: 0, w: 1, h: 1 }] });
    expect(handle.lastPick()).toBeNull();
    deliver({ ...picked(1), viewport: { innerWidth: 1e12, innerHeight: 800 } });
    expect(handle.lastPick()).toBeNull();
  });

  it("N2: an index past the end re-subscribes instead of guessing", async () => {
    await mount();
    await ready(snapshot({ entries: [entry("zero")] }));
    const before = channel.requests.filter((r) => r.msg.kind === "subscribe").length;
    channel.event({ v: 2, kind: "entry_added", index: 5, entry: entry("FIVE") });
    channel.event({ v: 2, kind: "entry_updated", index: 9, entry: entry("NINE") });
    await flush();
    const subs = channel.requests.filter((r) => r.msg.kind === "subscribe");
    expect(subs.length).toBe(before + 1);
    expect(subs.at(-1)!.msg.target).toEqual({ follow: true });
    expect(text()).not.toContain("FIVE");
    channel.reply("subscribe", snapshot({ entries: [entry("zero"), entry("resynced")] }));
    await flush();
    expect(text()).toContain("resynced");
  });

  it("N8: a later successful list_threads clears the header error", async () => {
    await mount();
    await ready();
    const select = root.querySelector("select") as HTMLSelectElement;
    select.dispatchEvent(new Event("focus"));
    await flush();
    channel.reply("list_threads", {
      kind: "error",
      error: "bad_request",
      message: "LIST-FAILED",
      fatal: false,
    });
    await flush();
    expect(text()).toContain("LIST-FAILED");
    select.dispatchEvent(new Event("focus"));
    await flush();
    channel.reply("list_threads", { kind: "threads", items: [thread("t1", "Fix the build")] });
    await flush();
    expect(text()).not.toContain("LIST-FAILED");
  });
});
