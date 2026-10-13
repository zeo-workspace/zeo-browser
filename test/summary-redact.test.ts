// @vitest-environment happy-dom
// Story 045, task 11.1 — the DOM summary carries no editor text and no link query values
// (design.md §A5 `summary.ts` paragraph). Requirements: R9.17, R9.18.
// Contract: `src/picker/summary-redact.ts` exports
// `redactSummary(el: Element, summary: DomSummary): DomSummary`, applied by `content.ts` to
// `summarize(el, window)`'s result. Its `text` is rebuilt without the text inside `contenteditable`,
// `role=textbox` and `textarea` subtrees (the picked element itself included), under summary.ts's
// own whitespace and length rules; its `attrs.href` goes through `redactUrlAttr` (R9.15's rule);
// the result stays within `DOM_SUMMARY_MAX_BYTES`. The live page is never edited.
//
// Hostile halves first, both directions:
//   - wrongly KEEP: an editor's text survives (picked editor, nested editor, a non-editable island
//     inside an editor, role=textbox, a textarea's initial and typed text, a query value);
//   - wrongly DROP: text around a nested editor, a `contenteditable="false"` element's text, or a
//     summary with nothing to redact is altered.
// The text oracle is `summarize` itself on a control element whose editors are already empty, so
// the whitespace and the 500-character cut are summary.ts's, not re-derived here.
import { beforeEach, describe, expect, it } from "vitest";
import { redactSummary } from "../src/picker/summary-redact.js";
import { summarize } from "../src/picker/summary.js";
import { DOM_SUMMARY_MAX_BYTES } from "../src/contract-constants.js";
import { redactUrlAttr } from "../src/redact.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function parse(markup: string): Element {
  const parsed = new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html");
  return document.adoptNode(parsed.body.firstElementChild!);
}

/** Mounts `markup` as the only child of the body and returns its root element. */
function mount(markup: string): Element {
  const el = parse(markup);
  document.body.replaceChildren(el);
  return el;
}

/** `summarize` on `markup` mounted alone: the oracle for what redacted text must equal. */
function controlText(markup: string): string {
  return summarize(mount(markup), window).text;
}

/** What `content.ts` sends: summarize, then redactSummary. */
const redacted = (el: Element) => redactSummary(el, summarize(el, window));

beforeEach(() => document.body.replaceChildren());

describe("hostile: an editor's text never reaches the summary (R9.17)", () => {
  it("a picked contenteditable gives empty text and keeps every other field", () => {
    for (const value of ["true", "", "plaintext-only", "TRUE"]) {
      const el = mount(
        `<div contenteditable="${value}" class="ed" aria-label="Notes">EDITOR-SECRET <b>bold-SECRET</b></div>`,
      );
      const before = summarize(el, window);
      const out = redactSummary(el, before);
      expect(out.text, `contenteditable="${value}"`).toBe("");
      expect(JSON.stringify(out)).not.toContain("SECRET");
      expect(out).toEqual({ ...summarize(el, window), text: "" });
    }
  });

  it("a contenteditable nested in the picked element drops only its own text (hostile split)", () => {
    const markup = (editor: string) =>
      `<section>Intro BEFORE <p role="note">kept note</p> <div contenteditable="true">${editor}</div> AFTER outro</section>`;
    const el = mount(markup("EDITOR-SECRET <i>deep-SECRET</i>"));
    const out = redacted(el);
    expect(out.text).not.toContain("SECRET");
    expect(out.text).toContain("Intro BEFORE");
    expect(out.text).toContain("kept note");
    expect(out.text).toContain("AFTER outro");
    expect(out.text).toBe(controlText(markup("")));
  });

  it("a non-editable island inside an editor is still inside the editor", () => {
    const markup = (inner: string) =>
      `<article>Title <div contenteditable="true">${inner}</div> tail</article>`;
    const el = mount(markup('typed <span contenteditable="false">ISLAND-SECRET</span> more'));
    const out = redacted(el);
    expect(out.text).not.toContain("SECRET");
    expect(out.text).not.toContain("typed");
    expect(out.text).toBe(controlText(markup("")));
  });

  it("role=textbox, picked or nested, gives no editor text", () => {
    const picked = mount('<div role="textbox" aria-multiline="true">TEXTBOX-SECRET</div>');
    expect(redacted(picked).text).toBe("");

    const markup = (inner: string) =>
      `<form>Comment: <div role="textbox">${inner}</div> <span>Send</span></form>`;
    const nested = mount(markup("TEXTBOX-SECRET"));
    const out = redacted(nested);
    expect(out.text).not.toContain("SECRET");
    expect(out.text).toBe(controlText(markup("")));
    expect(out.text).toContain("Comment:");
    expect(out.text).toContain("Send");
  });

  it("a textarea with initial and typed text gives no editor text, picked or nested", () => {
    const picked = mount('<textarea name="msg">INITIAL-SECRET</textarea>') as HTMLTextAreaElement;
    picked.value = "TYPED-SECRET";
    const pickedOut = redacted(picked);
    expect(pickedOut.text).toBe("");
    expect(JSON.stringify(pickedOut)).not.toContain("SECRET");

    const label = mount("<label>Message <textarea>INITIAL-SECRET</textarea> (max 500)</label>");
    (label.querySelector("textarea") as HTMLTextAreaElement).value = "TYPED-SECRET";
    const out = redacted(label);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out.text).toContain("Message");
    expect(out.text).toContain("(max 500)");
  });

  it("the live page is not edited: the editor keeps its text after redaction", () => {
    const el = mount(
      '<section>Intro <div contenteditable="true">EDITOR-SECRET</div> <textarea>T</textarea></section>',
    );
    (el.querySelector("textarea") as HTMLTextAreaElement).value = "TYPED";
    const html = el.outerHTML;
    redacted(el);
    expect(el.outerHTML).toBe(html);
    expect(el.querySelector("[contenteditable]")!.textContent).toBe("EDITOR-SECRET");
    expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("TYPED");
  });
});

describe("hostile: no wrongful drop (the converse of R9.17)", () => {
  it('contenteditable="false" is not an editor: its text is kept', () => {
    const el = mount('<div contenteditable="false">Read-only KEPT text</div>');
    const out = redacted(el);
    expect(out.text).toBe("Read-only KEPT text");
    expect(out).toEqual(summarize(el, window));
  });

  it("keeps summary.ts's 500-character cut on the text around an editor", () => {
    const long = "word ".repeat(150);
    const markup = (inner: string) =>
      `<div>${long}<span contenteditable="true">${inner}</span> ${long}</div>`;
    const el = mount(markup("EDITOR-SECRET"));
    const out = redacted(el);
    expect(out.text).not.toContain("SECRET");
    expect([...out.text].length).toBeLessThanOrEqual(500);
    expect(out.text).toBe(controlText(markup("")));
  });
});

describe("hostile: an href leaves with no credentials, fragment or query value (R9.18)", () => {
  it("keeps scheme, host and path; every query value becomes … exactly as redactUrlAttr gives", () => {
    const raw = "https://user:pw@shop.example/p?q=SECRET&x=1#frag";
    const el = mount(`<a href="${raw}" class="buy">Buy</a>`);
    const out = redacted(el);
    expect(out.attrs.href).toBe(redactUrlAttr(raw));
    expect(out.attrs.href).toBe("https://shop.example/p?q=…&x=…");
    for (const leak of ["SECRET", "user", "pw", "frag", "x=1"]) {
      expect(out.attrs.href).not.toContain(leak);
    }
    expect(out.text).toBe("Buy");
    const plain = summarize(el, window);
    expect(out).toEqual({ ...plain, attrs: { ...plain.attrs, href: redactUrlAttr(raw) } });
  });

  it("a relative href keeps its relative form, query values redacted", () => {
    const raw = "/buy?token=QUERY-SECRET&step=2";
    const el = mount(`<a href="${raw}">Next</a>`);
    const out = redacted(el);
    expect(out.attrs.href).toBe(redactUrlAttr(raw));
    expect(out.attrs.href).toBe("/buy?token=…&step=…");
  });

  it("an href on a non-anchor element is redacted too", () => {
    const raw = "https://h.example/x?t=QUERY-SECRET";
    const el = mount(`<x-card href="${raw}">Card</x-card>`);
    expect(redacted(el).attrs.href).toBe(redactUrlAttr(raw));
  });
});

describe("benign: nothing to redact", () => {
  it("an element with no editable part and no href equals summarize's output", () => {
    const el = mount(
      '<button class="btn primary" aria-label="Buy now" type="submit" name="go">Buy <span>now</span> <input value="v"></button>',
    );
    const before = summarize(el, window);
    expect(redactSummary(el, before)).toEqual(summarize(el, window));
  });
});

describe("the result stays within DOM_SUMMARY_MAX_BYTES", () => {
  it("even when redaction lengthens the href and the rebuilt text is long", () => {
    // `1` (1 byte) becomes `…` (3 bytes): a 200-character href of `a=1&` pairs grows by ~100 bytes.
    const href = `https://h.example/p?${"a=1&".repeat(60)}`;
    const classes = Array.from({ length: 32 }, (_, i) => `c${i}-${"k".repeat(120)}`).join(" ");
    const label = "L".repeat(250);
    const text = "word ".repeat(200);
    const el = mount(
      `<a href="${href}" class="${classes}" aria-label="${label}" role="link">${text}<span contenteditable="true">EDITOR-SECRET</span>${text}</a>`,
    );
    const out = redacted(el);
    expect(bytes(out)).toBeLessThanOrEqual(DOM_SUMMARY_MAX_BYTES);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out.attrs.href ?? "").not.toMatch(/=1(&|$)/);
  });
});
