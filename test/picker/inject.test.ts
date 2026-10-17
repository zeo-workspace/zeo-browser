// Story 045, task 4.2 — the sidebar side of the picker: protected pages, site permission, injection.
// Requirements: R9.1, R9.9, R9.10. Contract: `src/picker/inject.ts` exports
// `isProtectedUrl(url: string): boolean` and `startPick(tab: { id: number; url: string }, api)`
// → `Promise<{ ok: true } | { ok: false; reason: string; message?: string }>`, where `api` has
// `permissions.request` and `scripting.executeScript` (the platform shim's shape).
//
// Hostile halves first:
//   - protected identity: look-alikes (a store host as a subdomain prefix, a protected scheme in
//     a query, chrome.google.com outside /webstore) are NOT protected, while the real ones are;
//   - gesture: `permissions.request` is called synchronously, before `startPick` yields once —
//     Firefox refuses it after an await; a refusal injects nothing.
import { describe, expect, it, vi } from "vitest";
import { isProtectedUrl, startPick } from "../../src/picker/inject.js";

const PROTECTED_TEXT = "Zeo cannot read this page: the browser protects it";
const api = (granted = true, exec: () => Promise<unknown> = () => Promise.resolve([])) => ({
  permissions: { request: vi.fn(() => Promise.resolve(granted)) },
  scripting: { executeScript: vi.fn(exec) },
});

describe("isProtectedUrl (R9.9)", () => {
  it("hostile: look-alikes are not protected", () => {
    for (const u of [
      "https://addons.mozilla.org.evil.example/",
      "https://example.com/?next=chrome://settings",
      "https://example.com/about:blank",
      "https://chrome.google.com/search",
      "https://notchromewebstore.google.com/",
      "http://localhost:5173/",
      "file:///tmp/page.html",
    ]) {
      expect(isProtectedUrl(u), u).toBe(false);
    }
  });

  it("the browser's protected pages are protected", () => {
    for (const u of [
      "chrome://settings",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html",
      "edge://flags",
      "about:blank",
      "about:addons",
      "moz-extension://1234/x.html",
      "view-source:https://example.com/",
      "https://chromewebstore.google.com/detail/x",
      "https://chrome.google.com/webstore/detail/x",
      "https://addons.mozilla.org/en-US/firefox/",
      "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
    ]) {
      expect(isProtectedUrl(u), u).toBe(true);
    }
  });
});

describe("startPick (R9.1, R9.10)", () => {
  it("hostile: asks for the site synchronously, before any await", () => {
    const a = api();
    void startPick({ id: 7, url: "https://app.example/path?q=1" }, a as any);
    expect(a.permissions.request).toHaveBeenCalledTimes(1);
    expect(a.permissions.request).toHaveBeenCalledWith({ origins: ["https://app.example/*"] });
  });

  it("a refused permission picks nothing", async () => {
    const a = api(false);
    const r = await startPick({ id: 7, url: "https://app.example/" }, a as any);
    expect(r.ok).toBe(false);
    expect(a.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("a granted permission injects picker.js into that tab's top frame", async () => {
    const a = api(true);
    const r = await startPick({ id: 7, url: "https://app.example/" }, a as any);
    expect(r).toEqual({ ok: true });
    expect(a.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 }, files: ["/picker.js"] }),
    );
  });

  it("a protected page asks nothing, injects nothing and says why", async () => {
    const a = api(true);
    const r = await startPick({ id: 7, url: "chrome://settings" }, a as any);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain(PROTECTED_TEXT);
    expect(a.permissions.request).not.toHaveBeenCalled();
    expect(a.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("an injection refused with 'Cannot access' is the same protected state", async () => {
    const a = api(true, () =>
      Promise.reject(
        new Error(
          "Cannot access contents of the page. Extension manifest must request permission to access the respective host.",
        ),
      ),
    );
    const r = await startPick({ id: 7, url: "https://app.example/" }, a as any);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain(PROTECTED_TEXT);
  });
});
