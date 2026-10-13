// @vitest-environment happy-dom
// Story 045, task 4.2 — the picker content script (design.md §A5).
// Requirements: R9.1, R9.2, R9.3, R9.4, R9.5, R9.6, R9.11.
// Assumed seam (adjust the import and `start` only): `src/picker/content.ts` exports
// `startPicker({ send }): { stop(): void }`; `send(msg)` posts to the sidebar
// (`runtime.sendMessage` in production) `{ type: "picked", items, rects, viewport }`.
// The overlay lives in a CLOSED shadow root; the test records the root by wrapping
// `attachShadow` and asserts the mode it was asked for.
//
// Hostile halves first:
//   - the page's own click handler must NOT fire while picking — and MUST fire with the picker
//     off, so the first check is not vacuous; pointerdown/mousedown/mouseup are swallowed too;
//   - Shift+click twins stay two, in pick order; Shift+click again removes; Esc with nothing
//     pending sends nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPicker } from "../../src/picker/content.js";

let roots: Array<{ host: Element; root: ShadowRoot; mode: string }> = [];
const original = Element.prototype.attachShadow;
beforeEach(() => {
  roots = [];
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = original.call(this, { ...init, mode: "open" });
    roots.push({ host: this, root, mode: init.mode });
    return root;
  };
  document.head.replaceChildren();
  document.body.replaceChildren();
  const parsed = new DOMParser().parseFromString(
    '<body><button id="save">Save</button><ul><li class="c">x</li><li class="c">x</li></ul></body>',
    "text/html",
  );
  document.body.replaceChildren(...[...parsed.body.childNodes].map((n) => document.adoptNode(n)));
});
afterEach(() => {
  Element.prototype.attachShadow = original;
});

const mouse = (el: Element, type: string, init: MouseEventInit = {}) =>
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, ...init }),
  );
const clickEl = (el: Element, shift = false) => {
  for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
    mouse(el, t, { shiftKey: shift });
  }
};
const esc = () =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
const pickedMessages = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === "picked" && m.items?.length);

describe("isolation (R9.11)", () => {
  it("mounts in a closed shadow root and adds no style to the page", () => {
    const styles = document.querySelectorAll("style, link[rel=stylesheet]").length;
    const p = startPicker({ send: vi.fn() });
    expect(roots).toHaveLength(1);
    expect(roots[0]!.mode).toBe("closed");
    expect(document.querySelectorAll("style, link[rel=stylesheet]").length).toBe(styles);
    p.stop();
  });

  it("hovering shows the tag and selector in the overlay (R9.1)", () => {
    const p = startPicker({ send: vi.fn() });
    const save = document.getElementById("save")!;
    mouse(save, "pointermove");
    mouse(save, "mouseover");
    mouse(save, "mousemove");
    expect(roots[0]!.root.textContent).toContain("button · #save");
    p.stop();
  });
});

describe("page handlers (R9.5)", () => {
  it("hostile: the page never sees the picking click — and does see it with the picker off", () => {
    const save = document.getElementById("save")!;
    const seen = vi.fn();
    for (const t of ["click", "pointerdown", "mousedown", "mouseup"]) {
      save.addEventListener(t, seen);
    }
    const p = startPicker({ send: vi.fn() });
    clickEl(save, true);
    expect(seen).not.toHaveBeenCalled();
    p.stop();
    clickEl(save);
    expect(seen).toHaveBeenCalled();
  });
});

describe("picking", () => {
  it("a click attaches the element with url, unique selector, sanitized html and summary, then turns off (R9.2, R9.6)", () => {
    const send = vi.fn();
    startPicker({ send });
    const save = document.getElementById("save")!;
    save.setAttribute("onclick", "steal()");
    clickEl(save);
    const msgs = pickedMessages(send);
    expect(msgs).toHaveLength(1);
    const [item] = msgs[0].items;
    expect(item).toMatchObject({ type: "element", page_url: location.href });
    expect(document.querySelectorAll(item.selector)).toHaveLength(1);
    expect(item.html).toContain("Save");
    expect(item.html).not.toContain("steal()");
    expect(item.dom).toMatchObject({ tag: "button", id: "save" });
    expect(msgs[0].viewport).toBeTruthy();
    expect(roots[0]!.host.isConnected).toBe(false);
  });

  it("hostile: Shift+click keeps the picker on, twins stay two in pick order, Esc delivers them (R9.3, R9.4)", () => {
    const send = vi.fn();
    startPicker({ send });
    const [a, b] = [...document.querySelectorAll("li")];
    clickEl(b!, true);
    clickEl(a!, true);
    expect(pickedMessages(send)).toHaveLength(0);
    expect(roots[0]!.host.isConnected).toBe(true);
    esc();
    const msgs = pickedMessages(send);
    expect(msgs).toHaveLength(1);
    const sels = msgs[0].items.map((i: { selector: string }) => i.selector);
    expect(sels).toHaveLength(2);
    expect(document.querySelector(sels[0])).toBe(b);
    expect(document.querySelector(sels[1])).toBe(a);
    expect(roots[0]!.host.isConnected).toBe(false);
  });

  it("Shift+click on a selected element removes it", () => {
    const send = vi.fn();
    startPicker({ send });
    const [a, b] = [...document.querySelectorAll("li")];
    clickEl(a!, true);
    clickEl(b!, true);
    clickEl(a!, true);
    esc();
    const items = pickedMessages(send)[0].items;
    expect(items).toHaveLength(1);
    expect(document.querySelector(items[0].selector)).toBe(b);
  });

  it("Esc with nothing pending turns the picker off and sends nothing", () => {
    const send = vi.fn();
    startPicker({ send });
    esc();
    expect(pickedMessages(send)).toHaveLength(0);
    expect(roots[0]!.host.isConnected).toBe(false);
  });
});
