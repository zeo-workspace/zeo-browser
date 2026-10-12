// Story 045, task 1.2 — the Chrome extension ID derived from the manifest key (R1.2).
// Contract: `scripts/extension-id.mjs` exports `extensionIdFromKey(b64Der: string): string` —
// SHA-256 of the DER SubjectPublicKeyInfo, first 32 hex digits, each mapped 0-f to a-p.
//
// The oracle is computed outside JavaScript, at authoring time, from a throwaway RSA-2048 key
// whose private half was deleted: `sha256sum pub.der | cut -c1-32 | tr '0-9a-f' 'a-p'`.
// Hostile halves: a key one byte different gives a different ID (no collapse); the same key
// with whitespace (as it may be wrapped in a file) gives the same ID (no split).
import { describe, expect, it } from "vitest";
import { extensionIdFromKey } from "../scripts/extension-id.mjs";

const KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA058+VnT0+XyegNnL8A1jYTpAvKSjKwNVQMF9msybPUJvZQdZrd0RrsMbi27i9V69/y9JOt7tKsjtmY4tVV/EZ5BPo9Skz7Mz9icde292MpEjKM8OusMakNTw4bbkwBYKnrN82OegE7kqEGobhYElLKlsuwKoqQzC5Jd74vD4wmCFOCGjSJbKmHJ0kX48rNiDgFtP0cP4Q0HnJmRRfjSxtF1fe4TaIH+TnlPVjuPxhajTbz1gjXwgMy44+MbiEwhp0EURJu/MqdRg/bje+VVopChVOSz++bskFtXABK1jZUsAQeVDx+hTVZFK4VIPu6iXfYxvdsdxyL2N0h7a6zLYlwIDAQAB";
const ID = "adhcbbdboapcdjnggpcmcnmmdockbmnk";

describe("extensionIdFromKey", () => {
  it("matches the externally computed ID", () => {
    expect(extensionIdFromKey(KEY)).toBe(ID);
  });

  it("is 32 characters drawn from a-p only", () => {
    expect(extensionIdFromKey(KEY)).toMatch(/^[a-p]{32}$/);
  });

  it("hostile (collapse): a key differing in one byte gives a different ID", () => {
    const der = Buffer.from(KEY, "base64");
    der[der.length - 10] ^= 0x01;
    expect(extensionIdFromKey(der.toString("base64"))).not.toBe(ID);
  });

  it("hostile (split): the same key wrapped across lines gives the same ID", () => {
    const wrapped = KEY.match(/.{1,64}/g)!.join("\n") + "\n";
    expect(extensionIdFromKey(wrapped)).toBe(ID);
  });

  it("refuses input that is not base64 with an Error, never a bogus ID", () => {
    expect(() => extensionIdFromKey("not base64 at all!*")).toThrow(Error);
    expect(() => extensionIdFromKey("")).toThrow(Error);
  });
});
