// @vitest-environment happy-dom
// Story 045, task 4.1 — a CSS selector that matches only the picked element (R9.6).
// Contract: `src/picker/selector.ts` exports `uniqueSelector(el: Element): string`, at most 512
// characters, trying `#id` (when unique), `[data-testid=…]` (when unique), then an
// `nth-of-type` path from the nearest unique ancestor.
//
// Hostile halves first:
//   - wrongly collapse: a DUPLICATED id must not be used (it matches two elements); identical
//     twins must get distinct selectors, each matching only itself;
//   - wrongly split: the same element asked twice gets the same selector.
import { beforeEach, describe, expect, it } from "vitest";
import { uniqueSelector } from "../../src/picker/selector.js";

function mount(markup: string) {
  const parsed = new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html");
  document.body.replaceChildren(...[...parsed.body.childNodes].map((n) => document.adoptNode(n)));
}
const only = (sel: string, el: Element) => {
  const hits = document.querySelectorAll(sel);
  expect(hits.length, sel).toBe(1);
  expect(hits[0], sel).toBe(el);
  expect(sel.length).toBeLessThanOrEqual(512);
};

beforeEach(() => document.body.replaceChildren());

describe("hostile: duplicates never collapse", () => {
  it("a duplicated id is not used; each twin is selected alone", () => {
    mount('<div><span id="dup">a</span></div><div><span id="dup">b</span></div>');
    const [a, b] = [...document.querySelectorAll("span")];
    const sa = uniqueSelector(a!)!;
    const sb = uniqueSelector(b!)!;
    expect(sb).not.toBe("#dup");
    only(sa, a!);
    only(sb, b!);
    expect(sa).not.toBe(sb);
  });

  it("identical twins without attributes get distinct selectors", () => {
    mount("<ul><li>x</li><li>x</li><li>x</li></ul>");
    const lis = [...document.querySelectorAll("li")];
    const sels = lis.map((li) => uniqueSelector(li));
    lis.forEach((li, i) => only(sels[i]!, li));
    expect(new Set(sels).size).toBe(3);
  });

  it("a duplicated data-testid falls back to something unique", () => {
    mount('<p data-testid="row">1</p><p data-testid="row">2</p>');
    const second = document.querySelectorAll("p")[1]!;
    only(uniqueSelector(second)!, second);
  });
});

describe("benign cases", () => {
  it("a unique id gives #id", () => {
    mount('<button id="save">Save</button><button>Other</button>');
    expect(uniqueSelector(document.getElementById("save")!)).toBe("#save");
  });

  it("an id that needs escaping still selects the element", () => {
    mount('<i id="1:a b">x</i>');
    const el = document.querySelector("i")!;
    only(uniqueSelector(el)!, el);
  });

  it("a unique data-testid is used when there is no id", () => {
    mount('<a data-testid="buy">Buy</a><a>Sell</a>');
    const el = document.querySelector("a")!;
    const sel = uniqueSelector(el)!;
    expect(sel).toContain("data-testid");
    only(sel, el);
  });

  it("an element under a unique ancestor is reached from it", () => {
    mount('<main id="app"><section><div><b>1</b><b>2</b></div></section></main>');
    const el = document.querySelectorAll("b")[1]!;
    only(uniqueSelector(el)!, el);
  });

  it("an id longer than 512 characters is not used, and the result stays ≤ 512", () => {
    mount(`<div><em id="${"x".repeat(600)}">x</em></div>`);
    const el = document.querySelector("em")!;
    only(uniqueSelector(el)!, el);
  });

  it("is stable: the same element gives the same selector twice", () => {
    mount("<ol><li>a</li><li>b</li></ol>");
    const el = document.querySelectorAll("li")[1]!;
    expect(uniqueSelector(el)).toBe(uniqueSelector(el));
  });
});

// Fix round 1 (tech review of 4.1): defects found in real Chromium and Firefox.
describe("fix round 1: review defects", () => {
  const nest = (depth: number) => "<div>".repeat(depth) + "<span>x</span>" + "</div>".repeat(depth);
  const comb = (depth: number): string =>
    depth === 0 ? "<b>x</b>" : `<div></div><div>${comb(depth - 1)}</div>`;

  it("S4: inside the second of two identical 41-level copies, unique and ≤ 512", () => {
    mount(nest(41) + nest(41));
    const el = document.querySelectorAll("span")[1]!;
    only(uniqueSelector(el)!, el);
  });

  it("S4: twins at every level of a 30-level comb still fit, through a descendant combinator", () => {
    mount(`<main id="app"><div>${comb(30)}</div><div>${comb(30)}</div></main>`);
    const el = document.querySelectorAll("b")[1]!;
    only(uniqueSelector(el)!, el);
  });

  it("S3: inside a shadow root the selector is checked against, and scoped to, that root", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const twins = [document.createElement("b"), document.createElement("b")];
    root.append(...twins);
    const sel = uniqueSelector(twins[1]!);
    expect(sel).not.toBeNull();
    const hits = root.querySelectorAll(sel!);
    expect(hits.length).toBe(1);
    expect(hits[0]).toBe(twins[1]);
    expect(sel!.length).toBeLessThanOrEqual(512);
  });

  it("S3: an element in no document or shadow root gets null, never an unchecked path", () => {
    const detached = document.createElement("section");
    const child = document.createElement("p");
    detached.append(child);
    expect(uniqueSelector(detached)).toBeNull();
    expect(uniqueSelector(child)).toBeNull();
  });

  it("an id holding a lone surrogate is not used: the selector stays well-formed", () => {
    mount("<div><em>x</em><em>y</em></div>");
    const el = document.querySelectorAll("em")[1]!;
    el.id = "a\uD800";
    const sel = uniqueSelector(el)!;
    expect(sel.isWellFormed()).toBe(true);
    only(sel, el);
  });
});
