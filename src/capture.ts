// Screenshots (story 045, design.md §A6; R9.8, R10.1–R10.4, R7.11).
//
// - `captureVisible(windowId, overlay?)` wraps `tabs.captureVisibleTab(windowId, {format: "png"})`
//   in a serial queue: calls start at least 500 ms apart, so a burst is spaced instead of failing
//   on the browser's 2-per-second quota (R10.4). One quota error is retried after 600 ms; any
//   other failure, or a second quota error, rejects with "screenshot failed" and its cause. The
//   picker overlay is hidden before the capture and shown again after it, also on failure (R10.2).
// - `cropAndFit(dataUrl, rect, viewport)` decodes the capture with `createImageBitmap`, crops it in
//   bitmap pixels (scale `bitmap.width / viewport.innerWidth`, the viewport the content script
//   reported, never `devicePixelRatio`), clamps the crop to the bitmap, downsizes the long edge to
//   1568 px and encodes PNG, or JPEG 0.85 when the PNG is over 4 MiB (R9.8, R10.3).
// - `fitSend(text, attachments)` is the composer's last step before a send: a message over
//   `MAX_SEND_BYTES` has its PNG images re-encoded as JPEG 0.85, then 0.7, and is refused naming
//   the byte limit when it still does not fit (R7.11).
//
// Nothing here touches `api` at import time: the sidebar imports this module in every test.
import { type Attachment, type SendLimit, checkSend } from "./contract.js";
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE } from "./limits.js";
import { api } from "./platform.js";

export type ImageAttachment = Extract<Attachment, { type: "image" }>;
type ImageMime = ImageAttachment["mime"];

/** A rectangle in the page's CSS pixels, relative to the viewport. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The page's viewport in CSS pixels, as the content script reported it. */
export interface Viewport {
  innerWidth: number;
  innerHeight: number;
}

/** The content script's overlay round trip: `hide` resolves once the change is painted. */
export interface Overlay {
  hide(): Promise<void>;
  show(): unknown;
}

/** Minimum time between two `captureVisibleTab` calls, in ms (R10.4). */
export const CAPTURE_SPACING_MS = 500;
/** Wait before the one retry of a quota error, in ms. */
export const RATE_RETRY_MS = 600;
/** JPEG quality when a PNG capture is over `MAX_IMAGE_BYTES` (R10.3). */
export const JPEG_QUALITY = 0.85;
/** JPEG qualities `fitSend` tries, in order (R7.11). */
export const SEND_FIT_QUALITIES = [0.85, 0.7] as const;

const RATE_ERROR = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/;
const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The one rejection every screenshot failure becomes. */
export function screenshotFailed(cause: unknown): Error {
  return new Error("screenshot failed", { cause });
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------------------------
// Capture

/** The end of the queue: every capture waits for the one before it. */
let queue: Promise<unknown> = Promise.resolve();
/** When the last `captureVisibleTab` call was made (`Date.now()`), or never. */
let lastCall = Number.NEGATIVE_INFINITY;

/** Resolves once `gap` ms have passed since the last `captureVisibleTab` call. */
async function spaced(gap: number): Promise<void> {
  const wait = lastCall + gap - Date.now();
  if (wait > 0) {
    await sleep(wait);
  }
}

/** One `captureVisibleTab` call, at least `gap` ms after the previous one. */
async function call(windowId: number, gap: number): Promise<string> {
  await spaced(gap);
  lastCall = Date.now();
  return api.tabs.captureVisibleTab(windowId, { format: "png" });
}

async function captureOnce(windowId: number, overlay: Overlay | undefined): Promise<string> {
  try {
    // Spaced first, hidden second: the overlay is off the page only around the capture itself.
    await spaced(CAPTURE_SPACING_MS);
    await overlay?.hide();
    try {
      return await call(windowId, CAPTURE_SPACING_MS);
    } catch (err) {
      if (!RATE_ERROR.test(messageOf(err))) {
        throw err;
      }
      // The retry is timed from when the quota error arrived, not from when the call was made.
      lastCall = Date.now();
      return await call(windowId, RATE_RETRY_MS);
    }
  } catch (err) {
    throw screenshotFailed(err);
  } finally {
    try {
      await overlay?.show();
    } catch {
      // The tab went away between the capture and `show`: no overlay is left to show.
    }
  }
}

/**
 * A PNG data URL of the visible area of `windowId`'s active tab. Requests are served one at a
 * time and at least 500 ms apart; `overlay`, when given, is hidden for the capture and shown
 * again afterwards, whatever happens.
 */
export function captureVisible(windowId: number, overlay?: Overlay): Promise<string> {
  const run = queue.then(() => captureOnce(windowId, overlay));
  // A failed capture must not stall the ones queued behind it.
  queue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------------------------
// Encoding

/** The decoded bytes of a base64 string. */
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/** Standard padded base64 of `bytes` (chunked: spreading 4 MiB at once overflows the stack). */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** The bytes of a `data:<mime>;base64,` URL, as a Blob. */
function dataUrlBlob(dataUrl: string): Blob {
  const match = dataUrl.match(DATA_URL);
  if (match === null) {
    throw new Error("the capture is not a base64 data URL");
  }
  return new Blob([fromBase64(match[2]!)], { type: match[1] });
}

async function encode(
  canvas: OffscreenCanvas,
  mime: ImageMime,
  quality?: number,
): Promise<{ mime: ImageMime; data_b64: string; size: number }> {
  const blob = await canvas.convertToBlob(
    quality === undefined ? { type: mime } : { type: mime, quality },
  );
  return { mime, data_b64: toBase64(new Uint8Array(await blob.arrayBuffer())), size: blob.size };
}

/** The 2D context of `canvas`; a canvas without one cannot draw the capture. */
function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("no 2D canvas context");
  }
  return ctx;
}

/** The crop, in whole bitmap pixels, of `rect` (CSS pixels) clamped to the bitmap. */
function cropBox(
  bitmap: { width: number; height: number },
  rect: Rect | null,
  viewport: Viewport | null,
): { sx: number; sy: number; sw: number; sh: number } {
  if (rect === null) {
    return { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height };
  }
  if (viewport === null || !(viewport.innerWidth > 0)) {
    throw new Error("a crop needs the page's viewport");
  }
  // The bitmap is the page's viewport at the device's scale. The page's own figure relates the
  // two; this page's devicePixelRatio does not (zoom and display scaling differ per page).
  const scale = bitmap.width / viewport.innerWidth;
  const clampX = (v: number) => Math.min(Math.max(v, 0), bitmap.width);
  const clampY = (v: number) => Math.min(Math.max(v, 0), bitmap.height);
  // Outwards to whole pixels, so the box covers the elements; the epsilon absorbs float noise.
  const x0 = clampX(Math.floor(rect.x * scale + 1e-6));
  const y0 = clampY(Math.floor(rect.y * scale + 1e-6));
  const x1 = clampX(Math.ceil((rect.x + rect.w) * scale - 1e-6));
  const y1 = clampY(Math.ceil((rect.y + rect.h) * scale - 1e-6));
  if (x1 <= x0 || y1 <= y0) {
    throw new Error("the picked elements are outside the visible area");
  }
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}

/**
 * Crops a PNG capture to `rect` (the whole capture when `rect` is null) and fits it to the image
 * limits: long edge ≤ 1568 px, PNG, or JPEG 0.85 when the PNG is over 4 MiB. `viewport` is the
 * page's, as the content script reported it, and is required with a `rect`.
 */
export async function cropAndFit(
  dataUrl: string,
  rect: Rect | null,
  viewport: Viewport | null,
): Promise<ImageAttachment> {
  try {
    const bitmap = await createImageBitmap(dataUrlBlob(dataUrl));
    try {
      const { sx, sy, sw, sh } = cropBox(bitmap, rect, viewport);
      const fit = Math.min(1, MAX_IMAGE_EDGE / Math.max(sw, sh));
      const w = Math.min(MAX_IMAGE_EDGE, Math.max(1, Math.round(sw * fit)));
      const h = Math.min(MAX_IMAGE_EDGE, Math.max(1, Math.round(sh * fit)));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = context2d(canvas);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
      let out = await encode(canvas, "image/png");
      if (out.size > MAX_IMAGE_BYTES) {
        out = await encode(canvas, "image/jpeg", JPEG_QUALITY);
      }
      if (out.size > MAX_IMAGE_BYTES) {
        throw new Error(`the image is over ${MAX_IMAGE_BYTES} bytes even as JPEG`);
      }
      return { type: "image", mime: out.mime, data_b64: out.data_b64, w, h };
    } finally {
      bitmap.close();
    }
  } catch (err) {
    throw screenshotFailed(err);
  }
}

/** `img` re-encoded as JPEG at `quality`, at the same pixel size. */
export async function reencodeJpeg(
  img: ImageAttachment,
  quality: number,
): Promise<ImageAttachment> {
  const bitmap = await createImageBitmap(new Blob([fromBase64(img.data_b64)], { type: img.mime }));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    context2d(canvas).drawImage(bitmap, 0, 0);
    const out = await encode(canvas, "image/jpeg", quality);
    return {
      type: "image",
      mime: out.mime,
      data_b64: out.data_b64,
      w: bitmap.width,
      h: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

/** The smallest rectangle holding every one of `rects`, or null for none. */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) {
    return null;
  }
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------------------------------------
// The whole send (R7.11)

export type FitResult =
  { ok: true; attachments: Attachment[]; reencoded: number } | { ok: false; limit: SendLimit };

/**
 * The attachments of a send that fits `MAX_SEND_BYTES`. A message over the byte limit has its PNG
 * images re-encoded as JPEG 0.85, largest first and one at a time until it fits; then, again from
 * the original PNGs, as JPEG 0.7. Still over, or an image that cannot be re-encoded, is refused
 * naming the byte limit. Any other limit is refused as it is: re-encoding changes only bytes.
 * A re-encode that throws is logged on `log` (its error name only) before the refusal.
 */
export async function fitSend(
  text: string,
  attachments: readonly Attachment[],
  reencode: (img: ImageAttachment, quality: number) => Promise<ImageAttachment> = reencodeJpeg,
  log: Pick<Console, "warn"> = console,
): Promise<FitResult> {
  const verdict = checkSend(text, attachments);
  if (verdict.ok) {
    return { ok: true, attachments: [...attachments], reencoded: 0 };
  }
  if (verdict.limit !== "bytes") {
    return verdict;
  }
  const pngs = attachments
    .map((a, i) => ({ a, i }))
    .filter(
      (e): e is { a: ImageAttachment; i: number } =>
        e.a.type === "image" && e.a.mime === "image/png",
    )
    .sort((p, q) => q.a.data_b64.length - p.a.data_b64.length);
  for (const quality of SEND_FIT_QUALITIES) {
    const next = [...attachments];
    let reencoded = 0;
    for (const { a, i } of pngs) {
      try {
        next[i] = await reencode(a, quality);
      } catch (err) {
        log.warn({
          event: "screenshot_reencode_failed",
          error: err instanceof Error ? err.name : typeof err,
        });
        return { ok: false, limit: "bytes" };
      }
      reencoded++;
      if (checkSend(text, next).ok) {
        return { ok: true, attachments: next, reencoded };
      }
    }
  }
  return { ok: false, limit: "bytes" };
}
