// Story 045, task 13.5 — the site a Pick asks for (R9.13, R9.20, F5).
// Measured 2026-10-17 on Firefox 158: a granted `http://localhost:8451/*` is accepted and
// `permissions.contains` reports it, yet it matches no tab — the URL stays hidden and every
// injection fails with "Missing host permission for the tab". `http://localhost/*` works: the
// page's URL is visible and the picker mounts; on the pdf.js tab the URL is visible too and the
// injection is refused, which classifies as protected. Chrome honours the port, so it keeps it.
import { describe, expect, it, vi } from "vitest";
import { originPattern, startPick } from "../../src/picker/inject.js";
import { TEXT } from "../../src/sidebar/text.js";

const api = (inject: () => Promise<unknown>) => ({
  permissions: { request: vi.fn(async () => true) },
  scripting: { executeScript: vi.fn(inject) },
});

describe("originPattern (R9.13, F5)", () => {
  it("keeps the port by default (Chrome honours it)", () => {
    expect(originPattern("http://localhost:8451/doc.pdf")).toBe("http://localhost:8451/*");
  });

  it("hostile: drops the port when asked (Firefox matches no pattern that names one)", () => {
    expect(originPattern("http://localhost:8451/doc.pdf", false)).toBe("http://localhost/*");
    expect(originPattern("https://app.example:8443/a?b=1", false)).toBe("https://app.example/*");
  });

  it("a URL with no port is the same either way", () => {
    expect(originPattern("https://app.example/", false)).toBe("https://app.example/*");
    expect(originPattern("https://app.example/", true)).toBe("https://app.example/*");
  });
});

describe("startPick asks for a pattern the browser can match (R9.13, R9.20)", () => {
  const tab = { id: 7, url: "http://localhost:8451/" };

  it("hostile, Firefox: asks for the port-less site", async () => {
    const a = api(async () => [{ result: "mounted" }]);
    await startPick(tab, a as never, false);
    expect(a.permissions.request).toHaveBeenCalledWith({ origins: ["http://localhost/*"] });
  });

  it("Chrome: asks for the site with its port", async () => {
    const a = api(async () => [{ result: "mounted" }]);
    await startPick(tab, a as never);
    expect(a.permissions.request).toHaveBeenCalledWith({ origins: ["http://localhost:8451/*"] });
  });

  it("Firefox's pdf.js tab on a held site: the refused injection reads as protected (R9.20)", async () => {
    const a = api(async () => {
      throw new Error("Missing host permission for the tab");
    });
    const r = await startPick({ id: 3, url: "http://localhost:8451/doc.pdf" }, a as never, false);
    expect(r).toMatchObject({ ok: false, reason: "protected", message: TEXT.protectedPage });
  });
});
