// Story 045, task 4.3 — screenshots (design.md §A6). Requirements: R9.8, R10.1, R10.2, R10.3,
// R10.4 (Q4). Contract and assumed seams (adjust `load` and the stubs only):
//   - `captureVisible(windowId, overlay?)` wraps `api.tabs.captureVisibleTab(windowId,
//     { format: "png" })` from `src/platform.ts`; `overlay` is `{ hide(): Promise<void>;
//     show(): unknown }`, the content script's hide/show round trip;
//   - `cropAndFit(dataUrl, rect | null, viewport)` → `{ mime, data_b64, w, h }`, using the globals
//     `createImageBitmap` and `OffscreenCanvas` (stubbed here: no image decoder runs in tests).
//
// Hostile halves first:
//   - rate: three requests inside one second are spaced ≥ 500 ms apart, never failed; ONE rate
//     error is retried after 600 ms, a second fails with "screenshot failed";
//   - scale: it is `bitmap.width / viewport.innerWidth`, never `devicePixelRatio` (set to 3 here
//     so the wrong scale is visible);
//   - the overlay is shown again even when the capture fails.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const RATE = "This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.";
const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
let calls: number[];
let capture: ReturnType<typeof vi.fn>;

async function load(impl?: () => Promise<string>) {
  calls = [];
  capture = vi.fn(() => {
    calls.push(Date.now());
    return impl ? impl() : Promise.resolve(DATA_URL);
  });
  vi.resetModules();
  vi.doMock("../src/platform.js", () => ({
    api: { tabs: { captureVisibleTab: capture } },
    BROWSER: "chrome",
    HAS_DEBUGGER: true,
  }));
  return import("../src/capture.js");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("../src/platform.js");
});

describe("captureVisible (R10.1, R10.2, R10.4)", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));

  it("hostile: three quick requests are spaced ≥ 500 ms apart and all succeed", async () => {
    const { captureVisible } = await load();
    const all = Promise.all([captureVisible(1), captureVisible(1), captureVisible(1)]);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(all).resolves.toHaveLength(3);
    expect(capture).toHaveBeenCalledWith(1, { format: "png" });
    expect(calls).toHaveLength(3);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(500);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(500);
  });

  it("one rate error is retried after 600 ms", async () => {
    let n = 0;
    const { captureVisible } = await load(() =>
      n++ === 0 ? Promise.reject(new Error(RATE)) : Promise.resolve(DATA_URL),
    );
    const p = captureVisible(1);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBeTruthy();
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(600);
  });

  it("a second rate error fails with 'screenshot failed' and its cause", async () => {
    const { captureVisible } = await load(() => Promise.reject(new Error(RATE)));
    const p = captureVisible(1);
    const settled = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const error = (await settled) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/screenshot failed/);
    expect(error.cause).toBeTruthy();
  });

  it("hides the overlay before capturing and shows it after — also on failure (R10.2)", async () => {
    const order: string[] = [];
    const overlay = {
      hide: vi.fn(async () => void order.push("hide")),
      show: vi.fn(() => void order.push("show")),
    };
    const { captureVisible } = await load(() => {
      order.push("capture");
      return Promise.resolve(DATA_URL);
    });
    const ok = captureVisible(1, overlay);
    await vi.advanceTimersByTimeAsync(1000);
    await ok;
    expect(order).toEqual(["hide", "capture", "show"]);

    order.length = 0;
    const { captureVisible: failing } = await load(() => {
      order.push("capture");
      return Promise.reject(new Error("tab gone"));
    });
    const bad = failing(1, overlay).catch(() => "failed");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await bad).toBe("failed");
    expect(order[0]).toBe("hide");
    expect(order[order.length - 1]).toBe("show");
  });
});

describe("cropAndFit (R9.8, R10.3)", () => {
  let draws: number[][];
  let blobs: Array<{ type?: string; quality?: number }>;
  let sizes: number[];

  function stub(width: number, height: number, blobSizes: number[]) {
    draws = [];
    blobs = [];
    sizes = [...blobSizes];
    vi.stubGlobal("devicePixelRatio", 3);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width, height, close() {} })),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return {
            drawImage: (...a: unknown[]) => void draws.push(a.slice(1) as number[]),
            imageSmoothingQuality: "high",
          };
        }
        async convertToBlob(opts: { type?: string; quality?: number } = {}) {
          blobs.push(opts);
          const size = sizes.length > 1 ? sizes.shift()! : sizes[0]!;
          return new Blob([new Uint8Array(size)], { type: opts.type ?? "image/png" });
        }
      },
    );
  }

  it("hostile: crops in bitmap pixels using bitmap.width / innerWidth, not devicePixelRatio", async () => {
    stub(2000, 1000, [1000]);
    const { cropAndFit } = await load();
    const out = await cropAndFit(
      DATA_URL,
      { x: 10, y: 20, w: 100, h: 50 },
      { innerWidth: 1000, innerHeight: 500 },
    );
    const [sx, sy, sw, sh] = draws[0]!;
    expect([sx, sy, sw, sh]).toEqual([20, 40, 200, 100]);
    expect(out).toMatchObject({ mime: "image/png", w: 200, h: 100 });
    expect(typeof out.data_b64).toBe("string");
  });

  it("downsizes the long edge to 1568 px (R10.3)", async () => {
    stub(3136, 1000, [1000]);
    const { cropAndFit } = await load();
    const out = await cropAndFit(DATA_URL, null, { innerWidth: 3136, innerHeight: 1000 });
    expect(out.w).toBe(1568);
    expect(out.h).toBe(500);
  });

  it("clamps a rect that runs off the bitmap", async () => {
    stub(1000, 800, [1000]);
    const { cropAndFit } = await load();
    await cropAndFit(
      DATA_URL,
      { x: 900, y: 700, w: 400, h: 400 },
      { innerWidth: 1000, innerHeight: 800 },
    );
    const [sx, sy, sw, sh] = draws[0]!;
    expect(sx! + sw!).toBeLessThanOrEqual(1000);
    expect(sy! + sh!).toBeLessThanOrEqual(800);
    expect(sw).toBeGreaterThan(0);
  });

  it("re-encodes as JPEG 0.85 when the PNG is over 4 MiB (R10.3)", async () => {
    stub(1568, 1000, [5 * 1024 * 1024, 1024 * 1024]);
    const { cropAndFit } = await load();
    const out = await cropAndFit(DATA_URL, null, { innerWidth: 1568, innerHeight: 1000 });
    expect(blobs.some((b) => b.type === "image/jpeg" && b.quality === 0.85)).toBe(true);
    expect(out.mime).toBe("image/jpeg");
  });
});

// Planned amendment (post-review, task 4.3 run), under the operator's "shortcut first, least
// privilege" decision: the Screenshot path never calls permissions.request (a per-origin grant does
// not authorise captureVisibleTab; activeTab comes from the shortcut or the toolbar icon), and a
// capture refused for lack of activeTab shows one sentence. Then the whole-send byte limit.
// Requirements: R10.1, R10.6, R9.8, R7.11.
describe("Screenshot button (R10.1, R10.6)", () => {
  const flushAll = () => new Promise((r) => setTimeout(r, 0));
  const PERMISSION =
    "Zeo needs this page's permission for screenshots: press Alt+Shift+E on the page or click the Zeo toolbar icon, then try again";
  const NO_ACTIVE_TAB = () =>
    new Error("screenshot failed", {
      cause: new Error("Either the '<all_urls>' or 'activeTab' permission is required."),
    });

  async function mountTool(opts: { url?: string; include?: boolean } = {}) {
    const { mountScreenshotTool } = await import("../src/sidebar/screenshot-tool.js");
    const tools: Record<string, (() => void) | null> = {};
    const composer = {
      setTool: vi.fn((name: string, h: (() => void) | null) => void (tools[name] = h)),
      notify: vi.fn(),
      attach: vi.fn(() => 1),
      includeScreenshot: vi.fn(() => opts.include ?? false),
    };
    const page = {
      permissions: { request: vi.fn(async () => true) },
      tabs: { sendMessage: vi.fn(async () => ({ ok: true })) },
    };
    const tab = { id: 7, windowId: 3, ...(opts.url === undefined ? {} : { url: opts.url }) };
    const pageTab = { current: () => tab, onChange: vi.fn() };
    const image = { type: "image", mime: "image/png", data_b64: PNG_1X1, w: 1, h: 1 };
    const fns = {
      captureVisible: vi.fn(async () => DATA_URL),
      cropAndFit: vi.fn(async () => image),
    };
    const log = { info: vi.fn(), warn: vi.fn() };
    const tool = mountScreenshotTool(composer as any, page, pageTab, log, fns as any);
    return { tool, tools, composer, page, fns, image };
  }

  it("hostile: the click captures directly and never calls permissions.request", async () => {
    const t = await mountTool({ url: "https://app.example/a/b?q=1" });
    t.tools.screenshot!();
    await flushAll();
    expect(t.page.permissions.request).not.toHaveBeenCalled();
    expect(t.fns.captureVisible).toHaveBeenCalledWith(3, expect.anything());
    expect(t.fns.cropAndFit).toHaveBeenCalledWith(DATA_URL, null, null);
    expect(t.composer.attach).toHaveBeenCalledWith(t.image);
  });

  it("a capture refused for lack of activeTab shows the permission sentence and attaches nothing", async () => {
    const t = await mountTool({ url: "https://app.example/" });
    t.fns.captureVisible.mockRejectedValueOnce(NO_ACTIVE_TAB());
    t.tools.screenshot!();
    await flushAll();
    expect(t.composer.attach).not.toHaveBeenCalled();
    expect(t.composer.notify).toHaveBeenLastCalledWith(PERMISSION, "error");
    expect(t.page.permissions.request).not.toHaveBeenCalled();
  });

  it("hostile: a hidden URL does not block the capture", async () => {
    const t = await mountTool({});
    t.tools.screenshot!();
    await flushAll();
    expect(t.page.permissions.request).not.toHaveBeenCalled();
    expect(t.fns.captureVisible).toHaveBeenCalledWith(3, expect.anything());
    expect(t.composer.attach).toHaveBeenCalledWith(t.image);
  });

  it("any other failed capture shows its reason and attaches nothing", async () => {
    const t = await mountTool({ url: "https://app.example/" });
    t.fns.captureVisible.mockRejectedValueOnce(
      new Error("screenshot failed", { cause: new Error("tab gone") }),
    );
    t.tools.screenshot!();
    await flushAll();
    expect(t.composer.attach).not.toHaveBeenCalled();
    expect(t.composer.notify).toHaveBeenLastCalledWith(expect.stringMatching(/tab gone/), "error");
  });

  it("Include screenshot crops to the union of the picked rects (R9.8); off, it captures nothing", async () => {
    const geometry = {
      rects: [
        { x: 10, y: 20, w: 30, h: 40 },
        { x: 100, y: 5, w: 10, h: 10 },
      ],
      viewport: { innerWidth: 800, innerHeight: 600 },
    };
    const off = await mountTool({ url: "https://app.example/" });
    await off.tool.includeFor(geometry, { id: 7, windowId: 3 });
    expect(off.fns.captureVisible).not.toHaveBeenCalled();

    const on = await mountTool({ url: "https://app.example/", include: true });
    await on.tool.includeFor(geometry, { id: 7, windowId: 3 });
    expect(on.page.permissions.request).not.toHaveBeenCalled();
    expect(on.fns.cropAndFit).toHaveBeenCalledWith(
      DATA_URL,
      { x: 10, y: 5, w: 100, h: 55 },
      geometry.viewport,
    );
    expect(on.composer.attach).toHaveBeenCalledTimes(1);
  });

  it("Include screenshot refused for lack of activeTab shows the same sentence", async () => {
    const t = await mountTool({ url: "https://app.example/", include: true });
    t.fns.captureVisible.mockRejectedValueOnce(NO_ACTIVE_TAB());
    await t.tool.includeFor(
      { rects: [{ x: 0, y: 0, w: 10, h: 10 }], viewport: { innerWidth: 800, innerHeight: 600 } },
      { id: 7, windowId: 3 },
    );
    expect(t.composer.attach).not.toHaveBeenCalled();
    expect(t.composer.notify).toHaveBeenLastCalledWith(PERMISSION, "error");
  });

  it("a tab with no picker has nothing to hide; the overlay messages go to the tab", async () => {
    const { tabOverlay } = await import("../src/sidebar/screenshot-tool.js");
    const sendMessage = vi.fn(async (_tabId: number, m: { type: string }) => {
      if (m.type === "hide") {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return { ok: true };
    });
    const overlay = tabOverlay({ sendMessage }, 7);
    await expect(overlay.hide()).resolves.toBeUndefined();
    await overlay.show();
    expect(sendMessage).toHaveBeenNthCalledWith(1, 7, { type: "hide" });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 7, { type: "show" });
  });
});

describe("the whole send ≤ 8 000 000 bytes (R7.11)", () => {
  // Three PNGs of 2 700 000 base64 chars each: 8.1 MB serialised, over the limit.
  const big = (n: number) => ({
    type: "image" as const,
    mime: "image/png" as const,
    data_b64: "A".repeat(2_700_000 - n * 4),
    w: 1568,
    h: 1000,
  });

  it("hostile: a three-image send that does not fit is re-encoded at 0.85, then 0.7, then refused naming the limit", async () => {
    const { fitSend } = await import("../src/capture.js");
    const { LIMIT_TEXT } = await import("../src/sidebar/text.js");
    const reencode = vi.fn(async (img: any, _quality: number) => ({ ...img, mime: "image/jpeg" }));
    const out = await fitSend("hi", [big(0), big(1), big(2)], reencode);
    expect(out).toEqual({ ok: false, limit: "bytes" });
    expect(reencode.mock.calls.map((c) => c[1])).toEqual([0.85, 0.85, 0.85, 0.7, 0.7, 0.7]);
    expect(LIMIT_TEXT[out.ok ? "text" : out.limit]).toMatch(/8,000,000 bytes/);
  });

  it("re-encodes the largest PNG first and stops as soon as the send fits", async () => {
    const { fitSend } = await import("../src/capture.js");
    const reencode = vi.fn(async (img: any, _quality: number) => ({
      ...img,
      mime: "image/jpeg",
      data_b64: "AAAA",
    }));
    const parts = [big(2), big(0), big(1)];
    const out = await fitSend("hi", parts, reencode);
    expect(out.ok).toBe(true);
    expect(reencode).toHaveBeenCalledTimes(1);
    expect(reencode.mock.calls[0]![0]).toBe(parts[1]);
    expect(reencode.mock.calls[0]![1]).toBe(0.85);
  });

  it("a send within the limit is left untouched", async () => {
    const { fitSend } = await import("../src/capture.js");
    const reencode = vi.fn();
    const out = await fitSend("hi", [big(0)], reencode);
    expect(out.ok).toBe(true);
    expect(reencode).not.toHaveBeenCalled();
  });
});

// A real 1×1 PNG, so the attachment the tool validates carries a matching header.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// Fix round (tech review): retry timing, a queue that survives a failure, and the hide-ack
// timeout. Requirements: R10.2, R10.4.
describe("capture queue and overlay, fix round (R10.2, R10.4)", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));

  it("hostile: the retry runs ≥ 600 ms after the quota error arrives, not after the failed call", async () => {
    let n = 0;
    let errorAt = 0;
    const { captureVisible } = await load(() =>
      n++ === 0
        ? new Promise<string>((_, reject) =>
            setTimeout(() => {
              errorAt = Date.now();
              reject(new Error(RATE));
            }, 300),
          )
        : Promise.resolve(DATA_URL),
    );
    const p = captureVisible(1);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe(DATA_URL);
    expect(calls).toHaveLength(2);
    expect(calls[1]! - errorAt).toBeGreaterThanOrEqual(600);
  });

  it("a capture queued behind a failed one still runs, spaced", async () => {
    let n = 0;
    const { captureVisible } = await load(() =>
      n++ === 0 ? Promise.reject(new Error("tab gone")) : Promise.resolve(DATA_URL),
    );
    const first = captureVisible(1).catch((e: unknown) => e);
    const second = captureVisible(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(((await first) as Error).message).toMatch(/screenshot failed/);
    await expect(second).resolves.toBe(DATA_URL);
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(500);
  });

  it("hostile: a hide that is never acknowledged fails the shot after 1 s, captures nothing, and still shows", async () => {
    const { captureVisible } = await load();
    const { tabOverlay, HIDE_ACK_TIMEOUT_MS } = await import("../src/sidebar/screenshot-tool.js");
    expect(HIDE_ACK_TIMEOUT_MS).toBe(1000);
    const sendMessage = vi.fn((_tabId: number, m: { type: string }) =>
      m.type === "hide" ? new Promise(() => {}) : Promise.resolve({ ok: true }),
    );
    const shot = captureVisible(1, tabOverlay({ sendMessage }, 7)).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    const error = (await shot) as Error;
    expect(error.message).toMatch(/screenshot failed/);
    expect(String((error.cause as Error).message)).toMatch(/did not hide/);
    expect(capture).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenLastCalledWith(7, { type: "show" });
  });
});

describe("fitSend logging, fix round (R7.11)", () => {
  it("a re-encode that throws is logged by error name, then refused naming the byte limit", async () => {
    const { fitSend } = await import("../src/capture.js");
    const img = {
      type: "image" as const,
      mime: "image/png" as const,
      data_b64: "A".repeat(8_000_000),
      w: 1,
      h: 1,
    };
    const warn = vi.fn();
    const reencode = vi.fn(async () => {
      throw new TypeError("no decoder");
    });
    const out = await fitSend("", [img], reencode, { warn });
    expect(out).toEqual({ ok: false, limit: "bytes" });
    expect(warn).toHaveBeenCalledWith({ event: "screenshot_reencode_failed", error: "TypeError" });
  });
});
