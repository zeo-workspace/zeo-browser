// @vitest-environment happy-dom
// Story 045, task 3.2 — model output rendered safely (design.md §A4 Markdown, §Security).
// Requirement: R6.8 (Q16). Contract: `src/sidebar/markdown.ts` exports
// `renderMarkdown(md: string): string`, the only HTML-producing module of the extension.
//
// Hostile halves first: raw HTML must be inert, an image must never become `<img>` (it would be
// fetched: an exfiltration channel), and a `javascript:`/`data:` link must lose its href in any
// spelling — while ordinary Markdown still renders (strong, links) so the escaping is not a
// blanket "escape everything".
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/sidebar/markdown.js";

const parse = (md: string) => new DOMParser().parseFromString(renderMarkdown(md), "text/html").body;
const hrefs = (md: string) =>
  [...parse(md).querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");

describe("raw HTML is inert", () => {
  it("a script tag is text, not an element", () => {
    const body = parse("before <script>alert(1)</script> after");
    expect(body.querySelector("script")).toBeNull();
    expect(body.textContent).toContain("<script>alert(1)</script>");
  });
  it("an img with onerror is text, and no element carries an event handler", () => {
    const body = parse('<img src=x onerror="alert(1)"> <a href="#" onclick="x()">c</a>');
    expect(body.querySelector("img")).toBeNull();
    for (const el of body.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.startsWith("on"), attr).toBe(false);
      }
    }
  });
});

describe("images are links, never loaded", () => {
  it("![alt](url) emits no <img> and a link to the url in a new tab", () => {
    const html = renderMarkdown("![diagram](https://example.invalid/p.png)");
    expect(html).not.toMatch(/<img/i);
    const a = parse("![diagram](https://example.invalid/p.png)").querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://example.invalid/p.png");
    expect(a?.textContent).toContain("diagram");
    expect(a?.getAttribute("target")).toBe("_blank");
  });
  it("an image with a javascript: source gets no javascript href", () => {
    expect(hrefs("![x](javascript:alert(1))").some((h) => /^\s*javascript:/i.test(h))).toBe(false);
    expect(renderMarkdown("![x](javascript:alert(1))")).not.toMatch(/<img/i);
  });
});

describe("links", () => {
  it("every http(s) and mailto link opens in a new tab with noopener noreferrer", () => {
    const body = parse(
      "[a](https://a.example) [b](http://b.example) [m](mailto:me@x.example) <https://c.example>",
    );
    const anchors = [...body.querySelectorAll("a")];
    expect(anchors).toHaveLength(4);
    for (const a of anchors) {
      expect(a.getAttribute("target")).toBe("_blank");
      const rel = (a.getAttribute("rel") ?? "").split(/\s+/);
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
    }
  });
  it("hostile: javascript:, data: and vbscript: links lose their href in any spelling, text kept", () => {
    for (const md of [
      "[click](javascript:alert(1))",
      "[click](JaVaScRiPt:alert(1))",
      "[click](data:text/html;base64,PHNjcmlwdD4=)",
      "[click](vbscript:msgbox)",
    ]) {
      const body = parse(md);
      expect(body.textContent, md).toContain("click");
      for (const a of body.querySelectorAll("a")) {
        expect(a.getAttribute("href") ?? "", md).toMatch(/^(https?:|mailto:)/i);
      }
    }
  });
});

it("ordinary Markdown still renders", () => {
  const body = parse("**bold** and `code`\n\n- item");
  expect(body.querySelector("strong")?.textContent).toBe("bold");
  expect(body.querySelector("code")?.textContent).toBe("code");
  expect(body.querySelector("li")?.textContent).toBe("item");
});

// Added at Run mode after the 3.2 tech review: hostile spellings the probes verified, locked in.
describe("hostile spellings found in review", () => {
  it("entity-encoded schemes are decoded before the check and dropped", () => {
    for (const md of ["[x](javascript&colon;alert(1))", "[x](&#106;avascript:alert(1))"]) {
      expect(hrefs(md), md).toEqual([]);
      expect(parse(md).textContent, md).toContain("x");
    }
  });
  it("reference-style javascript: links and data: images are dropped", () => {
    expect(hrefs("[x]\n\n[x]: javascript:alert(1)")).toEqual([]);
    const html = renderMarkdown("![x]\n\n[x]: data:image/png;base64,AAAA");
    expect(html).not.toMatch(/<img|data:/i);
  });
  it("autolinks keep only safe schemes, and data:/file: never become hrefs", () => {
    expect(hrefs("<javascript:alert(1)>")).toEqual([]);
    expect(hrefs("<a@b.example>")).toEqual(["mailto:a@b.example"]);
    expect(renderMarkdown("![x](data:image/png;base64,AAAA)")).not.toMatch(/<a|<img|data:/i);
    expect(hrefs("[x](file:///etc/passwd) ![y](file:///etc/passwd)")).toEqual([]);
  });
  it("an image inside a kept link renders as its label, never a nested anchor", () => {
    const body = parse("[![CI](https://evil.example/b.svg)](https://ok.example/ci)");
    expect(hrefs("[![CI](https://evil.example/b.svg)](https://ok.example/ci)")).toEqual([
      "https://ok.example/ci",
    ]);
    expect(body.querySelector("a")?.textContent).toBe("image: CI");
  });
});
