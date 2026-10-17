// The picker content script (story 045, design.md §A5; R9.1–R9.6, R9.9, R9.11). Injected on
// demand with `scripting.executeScript({files: ["/picker.js"]})` into the top frame, bundled as
// one IIFE whose completion value is the boot status (see `boot` and scripts/build.mjs).
//
// - Overlay: a `<div>` host holding a CLOSED shadow root, so the page's styles cannot reach it and
//   its `<style>` never reaches the page. The host is a built-in element on purpose: a custom tag
//   could be defined by the page, which could then read the closed root through
//   `attachInternals` or make `attachShadow` throw. Where the browser has popovers, the host is
//   a manual popover in the top layer, above modal dialogs, popovers and fullscreen elements, and
//   it is raised again when a newer one opens. It draws the hover highlight, the
//   `<tag> · <selector>` label and an outline per pending element; `pointer-events: none` keeps it
//   out of hit testing, except the shield over a hovered frame.
// - Picking: a primary-button press picks on `pointerdown` — a disabled control gets pointer
//   events but no click. A plain press picks that element (plus any pending ones) and ends;
//   Shift+press toggles an element in the pending set; Esc ends and delivers the pending set.
// - Page handlers (R9.5): pointer and mouse button events, click included, are stopped on
//   `window` in the capture phase, and after a pick ends the rest of that press (up to its click)
//   is still swallowed. A page listener registered on `window` in the capture phase *before*
//   picker.js was injected runs first and still sees pointerdown/pointerup/click; no content
//   script can prevent that.
// - Frames: listeners in the top frame never see input inside an iframe, so a hovered
//   iframe/frame/embed/object is covered by a shield that takes pointer events; a press on it
//   picks the frame element itself.
// - Target: `composedPath()[0]`, the innermost element a window listener may see. It is kept when
//   it is in the light DOM, or in an open shadow root with a selector unique in that root (the
//   selector is then scoped to that root); otherwise the shadow host is used, walking outwards.
// - Delivery: one `{type: "picked", items, rects, viewport, skipped}` message. An element with no
//   unique selector is left out and counted in `skipped`, so the sidebar can say why.
// - If the page removes the overlay, the picker stops and delivers nothing.
// - `hide` / `show` (for screenshots, Task 4.3) toggle the overlay and are answered after two
//   animation frames, once the change has been painted.
// - A PDF viewer is a protected page whose URL is the PDF's own: the script refuses to mount there
//   and reports `protected`.
import type { Attachment } from "../contract.js";
import { MAX_ELEMENTS } from "../limits.js";
import { api } from "../platform.js";
import { pageUrlOf } from "../redact.js";
import { sanitizedOuterHtml } from "./html.js";
import { createSelection } from "./selection.js";
import { uniqueSelector } from "./selector.js";
import { summarize } from "./summary.js";
import { redactSummary } from "./summary-redact.js";

export type ElementItem = Extract<Attachment, { type: "element" }>;
export interface PickRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the content script posts to the sidebar (`src/sidebar/view.ts` receives it). */
export interface PickedMessage {
  type: "picked";
  items: ElementItem[];
  /** One rect per item, in viewport CSS pixels, for "Include screenshot" (R9.8). */
  rects: PickRect[];
  viewport: { innerWidth: number; innerHeight: number };
  /** Elements left out because no selector matches only them (R9.6). */
  skipped: number;
}

export interface PickerOptions {
  /** Posts to the sidebar; `runtime.sendMessage` in production. */
  send: (message: PickedMessage) => void;
  /** Called once when the picker ends, however it ends. */
  onEnd?: () => void;
}

export interface PickerHandle {
  /** Ends the picker without delivering anything. Safe to call twice. */
  stop(): void;
  /** Hides the overlay; resolves once two animation frames have passed. */
  hide(): Promise<void>;
  /** Shows the overlay again; resolves once two animation frames have passed. */
  show(): Promise<void>;
  readonly active: boolean;
}

/** The overlay messages the sidebar sends before and after a screenshot (Task 4.3). */
export const OVERLAY_MESSAGES = ["hide", "show"] as const;
export type OverlayMessage = { type: (typeof OVERLAY_MESSAGES)[number] };

/**
 * What an injection of picker.js evaluates to (the `result` of `executeScript`): the picker is
 * running, the page is one the browser protects, or the script could not start it.
 */
export type BootStatus = "mounted" | "protected" | "failed";

/** Button events of a picking press the page must not see (R9.5). */
const SWALLOWED = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"];
/** How long the rest of a picking press is swallowed when it has no click (a disabled control). */
const PRESS_TAIL_MS = 1000;
/** Elements whose content is another document, which top-frame listeners cannot see into. */
const FRAME_TAGS = new Set(["iframe", "frame", "embed", "object"]);
/** Chrome's PDF viewer extension, embedded by the viewer's wrapper page. */
const PDF_VIEWER_ORIGIN = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";
const LIMIT_TEXT = `At most ${MAX_ELEMENTS} elements per pick`;
const NO_SELECTOR_TEXT = "no unique selector";

// `:host` declarations marked !important win over the page's own rules for the host element
// (the inner context wins for important declarations), and over the UA's popover styles.
const STYLE = `
:host {
  all: initial !important;
  display: block !important;
  position: fixed !important;
  inset: 0 !important;
  width: auto !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  overflow: visible !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
}
.layer[hidden] { display: none; }
.highlight, .mark, .tip, .shield { position: fixed; box-sizing: border-box; }
.highlight {
  display: none;
  border: 2px solid #7c3aed;
  background: rgba(124, 58, 237, 0.12);
  border-radius: 2px;
}
.mark { border: 2px dashed #7c3aed; border-radius: 2px; }
.shield { display: none; pointer-events: auto; cursor: crosshair; background: transparent; }
.tip {
  display: none;
  max-width: 60vw;
  padding: 2px 6px;
  border-radius: 4px;
  background: #1e1b2e;
  color: #fff;
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`;

/** Resolves after two animation frames: the first runs before the paint, the second after it. */
function afterTwoFrames(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

// Kept importable from here for the picker tests; it lives in src/redact.ts with pageUrlOf.
export { capPageUrl } from "../redact.js";

/** The page URL without its query and fragment, as story 033 sends it (`src/redact.ts`). */
function pageUrl(): string {
  return pageUrlOf(location);
}

/**
 * Whether `doc` is a browser PDF viewer: a document served as a PDF, or the viewer's wrapper page
 * (a body holding only the PDF embed, or an embed of Chrome's PDF viewer extension). Its URL is
 * the PDF's own, so the URL check in the sidebar cannot see it.
 */
export function isPdfViewer(doc: Document): boolean {
  if (doc.contentType === "application/pdf") {
    return true;
  }
  const body = doc.body;
  const only = body !== null && body.childElementCount === 1 ? body.firstElementChild : null;
  if (only?.localName === "embed" && only.getAttribute("type") === "application/pdf") {
    return true;
  }
  return Array.from(doc.querySelectorAll("embed[src], iframe[src]")).some((el) =>
    (el.getAttribute("src") ?? "").startsWith(PDF_VIEWER_ORIGIN),
  );
}

const isElement = (node: unknown): node is Element =>
  typeof node === "object" && node !== null && (node as Node).nodeType === Node.ELEMENT_NODE;

const isShadowRoot = (node: Node): node is ShadowRoot =>
  node.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in node;

const isFrame = (el: Element): boolean => FRAME_TAGS.has(el.localName);

/**
 * The page element an event is about: the innermost one, kept when its selector can be built in
 * its own root (always attempted for the light DOM), else its shadow host, outwards. Events on
 * the overlay are not about the page: `ours` is returned for them.
 */
function targetOf(event: Event, host: Element): Element | "ours" | null {
  const path = event.composedPath();
  if (path.includes(host)) {
    return "ours";
  }
  const first = path[0];
  let el: Element | null = isElement(first)
    ? first
    : ((first as Node | undefined)?.parentElement ?? null);
  while (el !== null) {
    const root = el.getRootNode();
    if (!isShadowRoot(root)) {
      return el;
    }
    if (root.mode === "open" && uniqueSelector(el) !== null) {
      return el;
    }
    el = root.host;
  }
  return null;
}

function rectOf(el: Element): PickRect {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

function place(node: HTMLElement, r: PickRect): void {
  node.style.left = `${r.x}px`;
  node.style.top = `${r.y}px`;
  node.style.width = `${r.w}px`;
  node.style.height = `${r.h}px`;
}

/** Builds the `picked` message for `elements`, or null when there is nothing to say. */
export function describePick(elements: readonly Element[]): PickedMessage | null {
  const page_url = pageUrl();
  const items: ElementItem[] = [];
  const rects: PickRect[] = [];
  let skipped = 0;
  for (const el of elements) {
    const selector = uniqueSelector(el);
    if (selector === null) {
      skipped += 1;
      continue;
    }
    items.push({
      type: "element",
      page_url,
      selector,
      html: sanitizedOuterHtml(el),
      dom: redactSummary(el, summarize(el, window)),
    });
    rects.push(rectOf(el));
  }
  if (items.length === 0 && skipped === 0) {
    return null;
  }
  return {
    type: "picked",
    items,
    rects,
    viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
    skipped,
  };
}

const canPopover = (el: HTMLElement): boolean =>
  typeof el.showPopover === "function" && typeof el.hidePopover === "function";

/** Puts `host` in the top layer, or moves it back on top; a no-op without popover support. */
function raise(host: HTMLElement): void {
  if (!canPopover(host) || !host.isConnected) {
    return;
  }
  let open = false;
  try {
    open = host.matches(":popover-open");
  } catch {
    // An engine without the pseudo-class: treat the popover as closed.
  }
  try {
    if (open) {
      host.hidePopover();
    }
    host.showPopover();
  } catch {
    // A page that blocks popovers leaves the overlay at z-index 2147483647: still drawn above
    // everything outside the top layer.
  }
}

/** Starts the picker on this page: mounts the overlay and takes over pointer input. */
export function startPicker(options: PickerOptions): PickerHandle {
  const doc = document;
  const selection = createSelection();
  selection.toggle();
  const lifetime = new AbortController();
  const listen = { capture: true, signal: lifetime.signal };
  const observers: MutationObserver[] = [];

  const host = doc.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  const style = doc.createElement("style");
  style.textContent = STYLE;
  const layer = doc.createElement("div");
  layer.className = "layer";
  const marks = doc.createElement("div");
  const highlight = doc.createElement("div");
  highlight.className = "highlight";
  const shield = doc.createElement("div");
  shield.className = "shield";
  const tip = doc.createElement("div");
  tip.className = "tip";
  layer.append(marks, highlight, shield, tip);
  root.append(style, layer);
  if (canPopover(host)) {
    host.setAttribute("popover", "manual");
  }
  doc.documentElement.append(host);
  raise(host);

  let active = true;
  let hovered: Element | null = null;
  let hoveredLabel = "";

  const pending = (): Element[] =>
    selection.state.mode === "picking" ? selection.state.pending : [];

  const renderMarks = () => {
    marks.replaceChildren(
      ...pending().map((el) => {
        const mark = doc.createElement("div");
        mark.className = "mark";
        place(mark, rectOf(el));
        return mark;
      }),
    );
  };

  const renderHover = () => {
    if (hovered === null || !hovered.isConnected) {
      highlight.style.display = "none";
      shield.style.display = "none";
      tip.style.display = "none";
      return;
    }
    const r = rectOf(hovered);
    place(highlight, r);
    highlight.style.display = "block";
    // Only a frame needs the shield: its own input never reaches this frame's listeners.
    place(shield, r);
    shield.style.display = isFrame(hovered) ? "block" : "none";
    tip.textContent = hoveredLabel;
    tip.style.left = `${Math.max(4, r.x)}px`;
    tip.style.top = `${r.y > 28 ? r.y - 24 : r.y + r.h + 4}px`;
    tip.style.display = "block";
  };

  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  /** Keeps swallowing the rest of a press that ended the picker, up to its click. */
  const swallowPressTail = () => {
    const tail = new AbortController();
    const timer = setTimeout(() => tail.abort(), PRESS_TAIL_MS);
    const opts = { capture: true, signal: tail.signal };
    // A function of its own: the same (type, listener, capture) as the picker's would be dropped
    // as a duplicate, then removed with the picker's listeners.
    const swallowTail = (event: Event) => swallow(event);
    for (const type of SWALLOWED) {
      if (type !== "pointerdown" && type !== "click") {
        window.addEventListener(type, swallowTail, opts);
      }
    }
    // The click is the press's last event: swallowed, it closes the tail.
    window.addEventListener(
      "click",
      (event) => {
        swallow(event);
        clearTimeout(timer);
        tail.abort();
      },
      opts,
    );
  };

  const end = (deliver: readonly Element[]) => {
    if (!active) {
      return;
    }
    active = false;
    selection.escape();
    lifetime.abort();
    observers.forEach((o) => o.disconnect());
    // The overlay leaves the page before the selectors are built, so none depends on it.
    host.remove();
    const message = describePick(deliver);
    if (message !== null) {
      options.send(message);
    }
    options.onEnd?.();
  };

  /** The element a press or hover is about: the hovered frame when it lands on the shield. */
  const subjectOf = (event: Event): Element | null => {
    const target = targetOf(event, host);
    if (target === "ours") {
      return hovered !== null && isFrame(hovered) ? hovered : null;
    }
    return target;
  };

  // `pointerdown` is swallowed by the listener that picks: a second listener on window would be
  // cut off by the first one's stopImmediatePropagation.
  for (const type of SWALLOWED) {
    if (type !== "pointerdown") {
      window.addEventListener(type, swallow, listen);
    }
  }

  window.addEventListener(
    "pointerdown",
    (event) => {
      swallow(event);
      if (event.button !== 0) {
        return;
      }
      const target = subjectOf(event);
      if (target === null) {
        return;
      }
      const result = selection.click(target, event.shiftKey);
      if ("send" in result) {
        // A plain press delivers what was pending, then the pressed element, within the cap.
        const taken = selection.take();
        const all =
          taken.includes(target) || taken.length >= MAX_ELEMENTS ? taken : [...taken, target];
        swallowPressTail();
        end(all);
        return;
      }
      if ("refused" in result) {
        hoveredLabel = LIMIT_TEXT;
      }
      renderMarks();
      renderHover();
    },
    listen,
  );

  const onHover = (event: Event) => {
    const target = subjectOf(event);
    if (target !== hovered) {
      hovered = target;
      hoveredLabel =
        target === null
          ? ""
          : `${target.localName} · ${uniqueSelector(target) ?? NO_SELECTOR_TEXT}`;
    }
    renderHover();
  };
  window.addEventListener("pointermove", onHover, listen);
  window.addEventListener("mouseover", onHover, listen);

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || event.isComposing) {
        return;
      }
      // Esc belongs to the picker while it is on: a modal under inspection stays open.
      event.preventDefault();
      event.stopImmediatePropagation();
      end(selection.take());
    },
    listen,
  );

  window.addEventListener(
    "scroll",
    () => {
      renderMarks();
      renderHover();
    },
    { passive: true, capture: true, signal: lifetime.signal },
  );

  // A newer top-layer element (popover, dialog, fullscreen) would cover the overlay: raise it.
  const onTopLayerChange = (event: Event) => {
    if (event.target !== host) {
      raise(host);
    }
  };
  window.addEventListener("toggle", onTopLayerChange, listen);
  doc.addEventListener("fullscreenchange", onTopLayerChange, listen);

  // The page removing the overlay ends the picker. A dialog opening raises it (older browsers
  // fire no toggle event for dialogs).
  const removal = new MutationObserver(() => {
    if (!host.isConnected) {
      end([]);
    }
  });
  removal.observe(doc.documentElement, { childList: true });
  const dialogs = new MutationObserver((records) => {
    if (records.some((r) => r.target !== host)) {
      raise(host);
    }
  });
  dialogs.observe(doc.documentElement, { subtree: true, attributeFilter: ["open"] });
  observers.push(removal, dialogs);

  return {
    stop: () => end([]),
    hide: () => {
      layer.hidden = true;
      return afterTwoFrames();
    },
    show: () => {
      layer.hidden = false;
      return afterTwoFrames();
    },
    get active() {
      return active;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Entry: what runs when picker.js is injected into a page.

interface PickerGlobal {
  picker: PickerHandle | null;
  listening: boolean;
  /** Read back by the bundle's last statement, which is the injection's `result`. */
  status: BootStatus;
}
/** The key of the isolated world's picker state; scripts/build.mjs reads `.status` through it. */
export const GLOBAL_KEY = Symbol.for("zeo-browser.picker");

const isOverlayMessage = (m: unknown): m is OverlayMessage =>
  typeof m === "object" &&
  m !== null &&
  (OVERLAY_MESSAGES as readonly unknown[]).includes((m as { type?: unknown }).type);

/**
 * Starts the picker unless one is already running in this page, and answers `hide` / `show`.
 * Injecting twice runs this twice in the same isolated world; the state on `globalThis` (which is
 * the content script's own, not the page's) keeps it to one overlay and one listener. The outcome
 * is left in `status`, which the bundle evaluates to last.
 */
export function boot(): void {
  const runtime = (api as typeof chrome | undefined)?.runtime;
  if (typeof runtime?.id !== "string") {
    // Not inside an extension (a unit test importing this module): nothing to start.
    return;
  }
  const g = globalThis as unknown as Record<symbol, PickerGlobal | undefined>;
  const state = (g[GLOBAL_KEY] ??= { picker: null, listening: false, status: "failed" });
  if (isPdfViewer(document)) {
    state.status = "protected";
    return;
  }
  if (!state.listening) {
    state.listening = true;
    runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      if (sender.id !== runtime.id || !isOverlayMessage(message)) {
        return false;
      }
      const picker = state.picker;
      const done = picker
        ? message.type === "hide"
          ? picker.hide()
          : picker.show()
        : afterTwoFrames();
      void done.then(() => sendResponse({ ok: true }));
      return true;
    });
  }
  if (state.picker?.active) {
    state.status = "mounted";
    return;
  }
  try {
    state.picker = startPicker({
      send: (message) => {
        runtime.sendMessage(message).catch((err: unknown) => {
          // The sidebar was closed between the pick and the delivery: nothing to attach to.
          console.warn({
            event: "picker_send_failed",
            error: err instanceof Error ? err.name : "unknown",
          });
        });
      },
      onEnd: () => {
        state.picker = null;
      },
    });
    state.status = "mounted";
  } catch (err) {
    state.picker = null;
    state.status = "failed";
    console.warn({
      event: "picker_mount_failed",
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

boot();
