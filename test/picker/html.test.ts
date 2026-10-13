// @vitest-environment happy-dom
// Story 045, task 4.1 — the outer HTML sent to Zeo, sanitized and capped (R9.6, R9.7).
// Contract: `src/picker/html.ts` exports `sanitizedOuterHtml(el: Element): string` — form values,
// `script`/`style`/`noscript` contents and `on*` attributes stripped from a clone; capped at
// 16 KiB of UTF-8 on a character boundary with a `<!-- truncated -->` marker.
//
// Hostile halves first: secrets typed into the live page (property values, not only attributes)
// must not leak; an UPPERCASE handler is still a handler — while harmless attributes (class,
// href, aria-label) MUST survive, so "strip everything" fails too; the live element is untouched.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachment } from "../../src/contract.js";
import { sanitizedOuterHtml } from "../../src/picker/html.js";

const CAP = 16 * 1024;
const bytes = (s: string) => new TextEncoder().encode(s).length;

function mount(markup: string): Element {
  const parsed = new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html");
  const el = document.adoptNode(parsed.body.firstElementChild!);
  document.body.replaceChildren(el);
  return el;
}

beforeEach(() => document.body.replaceChildren());

describe("hostile: nothing secret leaves the page", () => {
  it("strips typed and attribute form values, password, textarea, checked and selected", () => {
    const form = mount(
      '<form class="f"><input name="u" value="ATTR-SECRET"><input type="password" name="p">' +
        '<textarea name="t">TEXTAREA-SECRET</textarea><input type="checkbox" checked>' +
        "<select><option>a</option><option selected>OPTION-PICKED</option></select></form>",
    );
    (form.querySelector('input[name="u"]') as HTMLInputElement).value = "TYPED-SECRET";
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = "hunter2";
    (form.querySelector("textarea") as HTMLTextAreaElement).value = "TYPED-TEXTAREA";
    const out = sanitizedOuterHtml(form);
    for (const secret of [
      "ATTR-SECRET",
      "TYPED-SECRET",
      "hunter2",
      "TEXTAREA-SECRET",
      "TYPED-TEXTAREA",
    ]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).not.toMatch(/\svalue=/i);
    expect(out).not.toMatch(/\schecked/i);
    expect(out).not.toMatch(/\sselected/i);
    expect(out).toContain('name="u"');
  });

  it("drops script, style and noscript contents", () => {
    const el = mount(
      "<div><script>SCRIPT-BODY()</script><style>.x{STYLE-BODY:1}</style><noscript>NOSCRIPT-BODY</noscript><p>kept</p></div>",
    );
    const out = sanitizedOuterHtml(el);
    for (const s of ["SCRIPT-BODY", "STYLE-BODY", "NOSCRIPT-BODY"]) {
      expect(out).not.toContain(s);
    }
    expect(out).toContain("kept");
  });

  it("drops every on* attribute in any case, keeps harmless attributes", () => {
    const el = mount(
      '<a class="btn" href="/buy" aria-label="Buy now" onclick="steal()" ONMOUSEOVER="x()"><span onfocus="y()">Buy</span></a>',
    );
    const out = sanitizedOuterHtml(el);
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).toContain('class="btn"');
    expect(out).toContain('href="/buy"');
    expect(out).toContain('aria-label="Buy now"');
  });

  it("leaves the live element untouched", () => {
    const el = mount('<div onclick="keep()"><input value="live"></div>');
    (el.querySelector("input") as HTMLInputElement).value = "typed";
    sanitizedOuterHtml(el);
    expect(el.getAttribute("onclick")).toBe("keep()");
    expect((el.querySelector("input") as HTMLInputElement).value).toBe("typed");
  });
});

describe("cap", () => {
  it("over 16 KiB: ≤ 16 KiB of valid UTF-8 ending with the truncation marker", () => {
    const el = mount(`<p>${"日本é".repeat(4000)}</p>`);
    const out = sanitizedOuterHtml(el);
    expect(bytes(out)).toBeLessThanOrEqual(CAP);
    expect(out.trimEnd().endsWith("<!-- truncated -->")).toBe(true);
    expect(out).not.toContain("�");
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(out)),
    ).not.toThrow();
  });

  it("under the cap: the whole element and no marker", () => {
    const el = mount("<p>short</p>");
    const out = sanitizedOuterHtml(el);
    expect(out).toBe("<p>short</p>");
    expect(out).not.toContain("truncated");
  });
});

// Fix round 1 (tech review of 4.1): defects found in real Chromium and Firefox, and the
// orchestrator's decisions N1-N4 on what else counts as a secret.
describe("fix round 1: review defects", () => {
  it("B1: a <template>'s content is sanitized with the same rules", () => {
    const el = mount(
      '<div><template><script>TPL-SCRIPT()</script><img src="x.png" onerror="TPL-HANDLER()">' +
        '<input value="TPL-VALUE"><textarea>TPL-TEXTAREA</textarea></template></div>',
    );
    const out = sanitizedOuterHtml(el);
    for (const secret of ["TPL-SCRIPT", "TPL-HANDLER", "TPL-VALUE", "TPL-TEXTAREA"]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).not.toMatch(/\svalue=/i);
  });

  it("S1: the clone is never owned by the page's document (no refetch of media)", () => {
    const el = mount('<div><img src="a.png" loading="lazy"><video preload="auto"></video></div>');
    const clones: Node[] = [];
    const original = Node.prototype.cloneNode;
    const spy = vi.spyOn(Node.prototype, "cloneNode").mockImplementation(function (
      this: Node,
      deep?: boolean,
    ) {
      const copy = original.call(this, deep);
      clones.push(copy);
      return copy;
    });
    try {
      const out = sanitizedOuterHtml(el);
      expect(out).toContain('src="a.png"');
    } finally {
      spy.mockRestore();
    }
    for (const copy of clones) {
      expect(copy.ownerDocument).not.toBe(document);
    }
  });

  it("S2: a lone surrogate leaves well-formed and the contract accepts the attachment", () => {
    const el = mount("<p>x</p>");
    el.textContent = "a\uD800b";
    const html = sanitizedOuterHtml(el);
    expect(html.isWellFormed()).toBe(true);
    const parsed = attachment.safeParse({
      type: "element",
      page_url: "https://example.com/",
      selector: "p",
      html,
      dom: {
        tag: "p",
        id: null,
        classes: [],
        text: "",
        attrs: {},
        styles: {},
        rect: { x: 0, y: 0, w: 0, h: 0 },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("S5: attributes set with mixed case through setAttributeNS are still stripped", () => {
    const el = mount("<div><input></div>");
    el.setAttributeNS(null, "onClick", "MIXED-HANDLER()");
    el.querySelector("input")!.setAttributeNS(null, "VALUE", "MIXED-VALUE");
    const out = sanitizedOuterHtml(el);
    expect(out).not.toContain("MIXED-HANDLER");
    expect(out).not.toContain("MIXED-VALUE");
  });
});

describe("fix round 1: orchestrator decisions N1-N4", () => {
  it("N1: rich-text editors lose their text and keep the element and its attributes", () => {
    const el = mount(
      '<div><div class="ed" contenteditable="true"><p>EDITOR-TEXT</p></div>' +
        '<div contenteditable="">EMPTY-VALUE-TEXT</div>' +
        '<div role="textbox" aria-label="Message">TEXTBOX-TEXT</div>' +
        '<div contenteditable="false">kept text</div></div>',
    );
    const out = sanitizedOuterHtml(el);
    for (const secret of ["EDITOR-TEXT", "EMPTY-VALUE-TEXT", "TEXTBOX-TEXT"]) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('<div class="ed" contenteditable="true"></div>');
    expect(out).toContain('aria-label="Message"');
    expect(out).toContain("kept text");
  });

  it("N2: token-like attributes are dropped, URL queries redacted, style kept", () => {
    const el = mount(
      '<div data-csrf-token="T1" data-Session-id="T2" data-api-key="T3" data-row="7" ' +
        'ng-reflect-model="T4" style="color: red">' +
        '<script integrity="sha384-T5" nonce="T6" src="/a.js?sig=T7"></script>' +
        '<a href="https://x.test/p?token=T8&amp;page=2#T9">go</a><a href="/buy">buy</a>' +
        '<form action="/s?auth=T10"><button formaction="/f?k=T11">b</button></form>' +
        '<video poster="/v.jpg?t=T12"></video><blockquote cite="/c?q=T13"></blockquote>' +
        '<object data="/o.pdf?x=T14"></object>' +
        '<meta name="csrf-token" content="T15"><meta http-equiv="X-Token" content="T16">' +
        '<meta name="viewport" content="width=device-width"></div>',
    );
    const out = sanitizedOuterHtml(el);
    for (let i = 1; i <= 16; i += 1) {
      expect(out, `T${i}`).not.toMatch(new RegExp(`T${i}\\b`));
    }
    expect(out).toContain('data-row="7"');
    expect(out).toContain('style="color: red"');
    expect(out).toContain("token=…&amp;page=…");
    expect(out).not.toContain("#");
    expect(out).toContain('href="/buy"');
    expect(out).toContain('content="width=device-width"');
  });

  it("N3: srcdoc is dropped", () => {
    const el = mount('<div><iframe srcdoc="<p>SRCDOC-SECRET</p>"></iframe></div>');
    expect(sanitizedOuterHtml(el)).not.toContain("SRCDOC-SECRET");
  });

  it("srcset candidates are redacted one by one, descriptors kept (task 4.4)", () => {
    const el = mount(
      '<picture><source srcset="/a.webp?sig=S1 1x,/b.webp?sig=S2 2x">' +
        '<img src="/c.jpg?t=S3#S4" srcset="https://x.test/d.jpg?w=S5 640w, /e,f.jpg?h=S6 1280w"></picture>',
    );
    const out = sanitizedOuterHtml(el);
    for (let i = 1; i <= 6; i += 1) {
      expect(out, `S${i}`).not.toMatch(new RegExp(`S${i}\\b`));
    }
    expect(out).toContain('srcset="/a.webp?sig=… 1x,/b.webp?sig=… 2x"');
    expect(out).toContain('srcset="https://x.test/d.jpg?w=… 640w, /e,f.jpg?h=… 1280w"');
    expect(out).toContain('src="/c.jpg?t=…"');
  });

  it("N4: javascript: links are left as they are", () => {
    const el = mount('<a href="javascript:void(0)">x</a>');
    expect(sanitizedOuterHtml(el)).toBe('<a href="javascript:void(0)">x</a>');
  });
});
