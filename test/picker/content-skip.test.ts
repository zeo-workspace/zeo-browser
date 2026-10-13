// @vitest-environment happy-dom
// Story 045, task 4.2 — an element with no unique selector (R9.6). `uniqueSelector` returns null
// for `#nosel` here; the picker must leave that element out, say how many it left out, and still
// deliver the others of the same pass.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/picker/selector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/picker/selector.js")>();
  return {
    uniqueSelector: (el: Element) => (el.id === "nosel" ? null : actual.uniqueSelector(el)),
  };
});

const { startPicker } = await import("../../src/picker/content.js");

beforeEach(() => {
  const parsed = new DOMParser().parseFromString(
    '<body><button id="ok">Ok</button><span id="nosel">x</span></body>',
    "text/html",
  );
  document.body.replaceChildren(...[...parsed.body.childNodes].map((n) => document.adoptNode(n)));
});

const clickEl = (el: Element, shiftKey = false) => {
  for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
    el.dispatchEvent(
      new MouseEvent(t, { bubbles: true, cancelable: true, composed: true, shiftKey }),
    );
  }
};
const esc = () =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

describe("no unique selector (R9.6)", () => {
  it("skips that element, counts it, and still delivers the rest of the pass", () => {
    const send = vi.fn();
    startPicker({ send });
    clickEl(document.getElementById("nosel")!, true);
    clickEl(document.getElementById("ok")!, true);
    esc();
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]![0];
    expect(msg.type).toBe("picked");
    expect(msg.skipped).toBe(1);
    expect(msg.items).toHaveLength(1);
    expect(msg.items[0].selector).toBe("#ok");
    expect(msg.rects).toHaveLength(1);
  });

  it("a pass made only of such elements still tells the sidebar, with no item", () => {
    const send = vi.fn();
    startPicker({ send });
    clickEl(document.getElementById("nosel")!);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ type: "picked", items: [], skipped: 1 });
  });
});
