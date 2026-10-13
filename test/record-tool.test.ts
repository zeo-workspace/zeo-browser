// @vitest-environment happy-dom
// Story 045, task 4.4 (planned amendment, post-review) — the sidebar's Record flow
// (design.md §A7, §A2). Requirements: R11.1, R11.4, R11.5, R11.6.
// Seam: `mountRecordTool` from `src/sidebar/record-tool.ts`, driven with the real Composer, a fake
// page tab, a fake recorder and a fake background port.
//
// Hostile halves first: the background hears the tab BEFORE the attach (a sidebar dying mid-attach
// still leaves the janitor a tab), and a heartbeat goes out every 20 s while recording, not after.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/sidebar/composer.js";
import { mountRecordTool } from "../src/sidebar/record-tool.js";

const PAGE = "https://app.example/page";

function captures(cutShort: boolean) {
  return {
    console: {
      type: "console",
      page_url: PAGE,
      cut_short: cutShort,
      entries: [
        { level: "log", text: "a", source: null, ts: 1 },
        { level: "error", text: "b", source: "https://app.example/app.js:1:1", ts: 2 },
      ],
    },
    network: {
      type: "network",
      page_url: PAGE,
      cut_short: cutShort,
      entries: [
        {
          method: "GET",
          url: "https://api.example/x?k=…",
          status: 200,
          resource_type: "Fetch",
          ms: 12,
          failed: null,
        },
      ],
    },
  };
}

function setup(opts: { start?: () => Promise<void> } = {}) {
  document.body.replaceChildren();
  const composer = new Composer(document, {
    channel: { request: vi.fn() as any },
    hasDebugger: true,
    log: { info() {}, warn() {} },
  });
  document.body.append(composer.element);
  const order: string[] = [];
  let onEnd: ((c: unknown) => void) | null = null;
  const recorder = {
    start: vi.fn((tabId: number, end: (c: unknown) => void) => {
      order.push(`start:${tabId}`);
      onEnd = end;
      return opts.start ? opts.start() : Promise.resolve();
    }),
    stop: vi.fn(async () => captures(false)),
  };
  const posted: unknown[] = [];
  const port = {
    post: (m: { type: string }) => {
      order.push(m.type);
      posted.push(m);
    },
  };
  const notice = vi.fn();
  mountRecordTool({
    composer,
    pageTab: { current: () => ({ id: 5, windowId: 1, url: PAGE }), onChange() {} },
    recorder: recorder as any,
    port,
    notice: (key) => {
      notice(key);
      composer.notify("Recording stopped early: the debugger was detached", "error");
    },
    log: { info() {}, warn() {} },
    doc: document,
  });
  const buttons = () => Array.from(document.querySelectorAll("button"));
  const byText = (re: RegExp) => buttons().find((b) => re.test(b.textContent ?? ""))!;
  const record = () => byText(/^Record$/);
  const indicator = () => document.querySelector<HTMLElement>(".recording")!;
  const chips = () =>
    Array.from(document.querySelectorAll(".chip-label")).map((n) => n.textContent);
  return {
    composer,
    recorder,
    posted,
    order,
    notice,
    record,
    indicator,
    chips,
    end: (c: unknown) => onEnd!(c),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => vi.useRealTimers());

describe("Record → indicator → two chips (R11.1, R11.4)", () => {
  it("hostile: announces the tab before attaching, shows the indicator, and Stop gives two chips", async () => {
    const t = setup();
    expect(t.record().disabled).toBe(false);
    expect(t.indicator().hidden).toBe(true);
    t.record().click();
    expect(t.order.slice(0, 2)).toEqual(["recording", "start:5"]);
    expect(t.posted[0]).toEqual({ type: "recording", tabId: 5 });
    await flush();
    expect(t.indicator().hidden).toBe(false);
    expect(t.indicator().textContent).toMatch(/^Recording console & network — Stop \d+:\d\d$/);
    expect(t.record().disabled).toBe(true);
    t.indicator().querySelector("button")!.click();
    await flush();
    expect(t.recorder.stop).toHaveBeenCalledTimes(1);
    expect(t.chips()).toEqual(["Console · app.example (2)", "Network · app.example (1)"]);
    expect(t.composer.attachments().map((a) => a.type)).toEqual(["console", "network"]);
    expect(t.indicator().hidden).toBe(true);
    expect(t.posted.at(-1)).toEqual({ type: "recording_stopped" });
    expect(t.record().disabled).toBe(false);
    expect(t.notice).not.toHaveBeenCalled();
  });

  it("a second recording replaces the first one's chips", async () => {
    const t = setup();
    for (let i = 0; i < 2; i++) {
      t.record().click();
      await flush();
      t.indicator().querySelector("button")!.click();
      await flush();
    }
    expect(t.chips()).toHaveLength(2);
  });

  it("the elapsed time advances", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.record().click();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(t.indicator().textContent).toMatch(/1:05$/);
  });

  it("a failed start says so and leaves Record usable", async () => {
    const t = setup({
      start: () =>
        Promise.reject(
          new Error("debugger attach failed", { cause: new Error("Cannot attach to this target") }),
        ),
    });
    t.record().click();
    await flush();
    expect(document.body.textContent).toContain(
      "Zeo could not record this page: Cannot attach to this target",
    );
    expect(t.indicator().hidden).toBe(true);
    expect(t.posted.at(-1)).toEqual({ type: "recording_stopped" });
    expect(t.record().disabled).toBe(false);
  });
});

describe("heartbeat (R11.6, design.md §A2)", () => {
  it("hostile: pings every 20 s while recording and stops pinging after", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.record().click();
    await vi.advanceTimersByTimeAsync(0);
    const beats = () =>
      t.posted.filter((m) => (m as { type: string }).type === "recording_heartbeat").length;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(beats()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(beats()).toBe(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(beats()).toBe(3);
    t.end(captures(false));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(beats()).toBe(3);
  });
});

describe("cut short (R11.5)", () => {
  it("a browser detach gives the two chips and the cut-short text", async () => {
    const t = setup();
    t.record().click();
    await flush();
    t.end(captures(true));
    expect(t.chips()).toEqual(["Console · app.example (2)", "Network · app.example (1)"]);
    expect(t.notice).toHaveBeenCalledWith("recording_cut_short");
    expect(document.body.textContent).toContain(
      "Recording stopped early: the debugger was detached",
    );
    expect(t.indicator().hidden).toBe(true);
  });

  it("a capture that breaks the contract is refused in words, not attached", async () => {
    const t = setup();
    t.record().click();
    await flush();
    const bad = captures(false);
    bad.console.page_url = "";
    t.end(bad);
    expect(t.chips()).toEqual(["Network · app.example (1)"]);
    expect(document.body.textContent).toContain("Zeo could not record this page");
  });
});

describe("fix round: Stop racing the cap", () => {
  it("captures delivered by both stop() and the cap's onEnd give one pair of chips", async () => {
    const t = setup();
    t.record().click();
    await flush();
    t.indicator().querySelector("button")!.click();
    t.end(captures(false));
    await flush();
    expect(t.chips()).toEqual(["Console · app.example (2)", "Network · app.example (1)"]);
    expect(
      t.posted.filter((m) => (m as { type: string }).type === "recording_stopped"),
    ).toHaveLength(1);
  });
});
