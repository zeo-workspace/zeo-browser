// @vitest-environment happy-dom
// Story 045, task 4.1 — the pending selection of a picking pass (R9.3; ≤ 20 elements, R7.11).
// Contract: `src/picker/selection.ts` keeps zeo-devtools' pending-set logic
// (`zeo-devtools/src/client/selection.ts`): `createSelection()` with `click(el, shift)` →
// `{ send: Element[] } | { pending: number } | { refused: "limit" }`, `take()` and `state`.
//
// Hostile halves first: twins with the same tag and text stay two (identity, not shape);
// pick order is kept even when it is not DOM order; Shift+click on a selected element removes it.
import { describe, expect, it } from "vitest";
import { createSelection } from "../../src/picker/selection.js";

const make = (n: number) =>
  Array.from({ length: n }, () => {
    const el = document.createElement("li");
    el.textContent = "same";
    document.body.append(el);
    return el;
  });

describe("pending selection", () => {
  it("hostile: identical twins stay two, in pick order", () => {
    const [a, b] = make(2);
    const s = createSelection();
    s.click(b!, true);
    expect(s.click(a!, true)).toEqual({ pending: 2 });
    expect(s.take()).toEqual([b, a]);
  });

  it("Shift+click on a selected element removes it (R9.3)", () => {
    const [a, b] = make(2);
    const s = createSelection();
    s.click(a!, true);
    s.click(b!, true);
    expect(s.click(a!, true)).toEqual({ pending: 1 });
    expect(s.take()).toEqual([b]);
  });

  it("a plain click sends that one element (R9.2)", () => {
    const [a] = make(1);
    expect(createSelection().click(a!, false)).toEqual({ send: [a] });
  });

  it("the 21st element is refused and the first 20 are kept", () => {
    const els = make(21);
    const s = createSelection();
    els.slice(0, 20).forEach((el) => s.click(el, true));
    expect(s.click(els[20]!, true)).toEqual({ refused: "limit" });
    expect(s.take()).toEqual(els.slice(0, 20));
  });

  it("take() empties the pending set", () => {
    const [a] = make(1);
    const s = createSelection();
    s.click(a!, true);
    s.take();
    expect(s.take()).toEqual([]);
  });
});
