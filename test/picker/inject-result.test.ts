// Story 045, task 4.2 fix round — what picker.js reports back through executeScript (design.md
// §A5; R9.9). The injection's `result` is the script's boot status: `mounted`, `protected` (a
// PDF viewer, whose URL is the PDF's own) or `failed`; a frame that threw has no status.
import { describe, expect, it, vi } from "vitest";
import { startPick } from "../../src/picker/inject.js";

const PROTECTED = "Zeo cannot read this page: the browser protects it";
const FAILED = "Zeo could not start the picker on this page";
const api = (results: unknown) => ({
  permissions: { request: vi.fn(async () => true) },
  scripting: { executeScript: vi.fn(async () => results) },
});
const pick = (results: unknown) =>
  startPick({ id: 7, url: "https://app.example/doc.pdf" }, api(results) as any);

describe("boot result (R9.9)", () => {
  it("hostile: a PDF viewer reported by the script is the protected state", async () => {
    const r = await pick([{ frameId: 0, result: "protected" }]);
    expect(r).toMatchObject({ ok: false, reason: "protected", message: PROTECTED });
  });

  it("a mounted picker is a start", async () => {
    expect(await pick([{ frameId: 0, result: "mounted" }])).toEqual({ ok: true });
  });

  it("a script that reports failed, threw (no result) or carries an error did not start", async () => {
    for (const results of [
      [{ frameId: 0, result: "failed" }],
      [{ frameId: 0, result: undefined }],
      [{ frameId: 0, result: null }],
      [{ frameId: 0, error: new Error("boom") }],
    ]) {
      const r = await pick(results);
      expect(r, JSON.stringify(results)).toMatchObject({
        ok: false,
        reason: "failed",
        message: FAILED,
      });
    }
  });
});
