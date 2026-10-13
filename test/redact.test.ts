// Story 045, task 4.4 fix round — URL redaction shared by the recorder and the picker
// (design.md §A7, §A5; R11.8, R9.7). Seam: `src/redact.ts`.
// Hostile halves: credentials never survive, in absolute or protocol-relative form; a URL in
// free text keeps its parameter names and a stack frame's `:line:col`, never the values.
import { describe, expect, it } from "vitest";
import {
  capPageUrl,
  pageUrlOf,
  redactUrl,
  redactUrlAttr,
  redactUrlsInText,
} from "../src/redact.js";

describe("credentials", () => {
  it("hostile: redactUrl drops user:pass@", () => {
    expect(decodeURIComponent(redactUrl("https://u:PW@h.example/p?a=1#x"))).toBe(
      "https://h.example/p?a=…",
    );
    expect(redactUrl("ftp://USER@h.example/f")).toBe("ftp://h.example/f");
  });

  it("hostile: redactUrlAttr drops user:pass@ in absolute and protocol-relative forms", () => {
    expect(redactUrlAttr("https://u:PW@h.example/p?a=1#x")).toBe("https://h.example/p?a=…");
    expect(redactUrlAttr("//u:PW@h.example/p")).toBe("//h.example/p");
    expect(redactUrlAttr("https:u:PW@h.example/p")).not.toMatch(/PW|u:/);
    expect(redactUrlAttr("/rel?x=1")).toBe("/rel?x=…");
  });
});

describe("redactUrlAttr whitespace and schemes", () => {
  it("trims surrounding whitespace for redaction and restores it", () => {
    expect(redactUrlAttr("  /p?t=S#f \n")).toBe("  /p?t=… \n");
    expect(redactUrlAttr("   ")).toBe("   ");
  });

  it("leaves data:, javascript: and mailto: values as they are", () => {
    for (const v of ["data:image/png;base64,AAAA", "javascript:void(0)", "mailto:a@b.example"]) {
      expect(redactUrlAttr(v)).toBe(v);
    }
  });
});

describe("redactUrlsInText", () => {
  it("hostile: redacts every URL, keeping names and a stack frame's line and column", () => {
    const out = redactUrlsInText(
      "at f (http://a.example/app.js?token=S1:12:28)\n at g (https://b.example/b.js:3)" +
        " — 'wss://w.example/s?key=S2' and file:///tmp/x?y=S3",
    );
    expect(out).not.toMatch(/S[1-3]\b/);
    const plain = decodeURIComponent(out);
    expect(plain).toContain("(http://a.example/app.js?token=…:12:28)");
    expect(plain).toContain("(https://b.example/b.js:3)");
    expect(plain).toContain("'wss://w.example/s?key=…'");
    expect(plain).toContain("file:///tmp/x?y=…");
  });

  it("leaves text without URLs alone", () => {
    expect(redactUrlsInText("TypeError: x is undefined")).toBe("TypeError: x is undefined");
  });
});

describe("page_url", () => {
  it("is scheme, host and path only", () => {
    expect(pageUrlOf(new URL("https://u:P@a.example:8443/p/q?t=S#f"))).toBe(
      "https://a.example:8443/p/q",
    );
    expect(pageUrlOf(new URL("file:///home/x.html?y=1"))).toBe("file:///home/x.html");
  });

  it("is capped at 2 KiB without cutting a %XX escape", () => {
    const url = "https://a.example/" + "a".repeat(2028) + "%E2%80%A6".repeat(4);
    const cut = capPageUrl(url);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(2048);
    expect(cut).not.toMatch(/%.?$/);
  });
});

// Added by the orchestrator after the 4.4 fix round: a bare query parameter is often the token.
describe("bare query parameters", () => {
  it("hostile: a parameter without = is replaced whole, a named one keeps its name", async () => {
    const { redactUrl, redactUrlAttr } = await import("../src/redact.js");
    expect(redactUrl("https://h.example/p?abc123SECRET&x=1")).toBe("https://h.example/p?…&x=…");
    expect(redactUrlAttr("/p?abc123SECRET")).toBe("/p?…");
  });
});
