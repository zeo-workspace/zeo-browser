// Story 045, task 2.2 — the v2 contract in zod and the send limits (design.md §Data Models and
// §Validation rules). Requirements: R3.6, R3.7, R7.11, R10.3, R12.5 (Q4, Q14).
// Contract (tasks.md 2.2): `src/limits.ts` exports every number of §Validation as constants;
// `src/contract.ts` exports `parseClient(raw)` and `parseServer(raw)`, each answering
// `{ ok: true, value } | { ok: false, error: ChannelError, ... }` without throwing, and
// `checkSend(text, attachments)` answering `{ ok: true } | { ok: false, limit: string }`.
// `parseClient` sits beside `parseServer` because Task 8.1 holds the client fixtures to a
// ChannelError verdict through `src/contract.ts`.
//
// Hostile halves first:
//   - order: `v` decides before `kind`, `kind` before shape — `v: 1` with a bogus kind is
//     `unsupported_version`, never `unknown_kind`;
//   - text length counts code points: 100 000 astral characters (200 000 UTF-16 units) MUST pass,
//     100 001 BMP characters MUST fail; a lone surrogate fails (Rust cannot hold it);
//   - byte caps count UTF-8 bytes: 1 025 "é" (2 050 bytes) breaks the 2 KiB console cap;
//   - image identity: a JPEG labelled PNG and a PNG labelled JPEG are both refused, while the same
//     bytes under their true label pass; `w`/`h` must match the header.
import { describe, expect, it } from "vitest";
import { checkSend, parseClient, parseServer, probeServer, sendBytes } from "../src/contract.js";
import * as limits from "../src/limits.js";
import { JPEG_2X1, PNG_2X1, jpegClaiming, png } from "./helpers/images.js";

type R = { ok: boolean; error?: string };
const verdict = (r: unknown) => {
  const res = r as R;
  return res.ok ? "accepted" : res.error;
};
const URL_ = "https://app.example/page";
const dom = {
  tag: "b",
  id: null,
  classes: [],
  text: "x",
  attrs: {},
  styles: {},
  rect: { x: 0, y: 0, w: 1, h: 1 },
};
const element = (i = 0, over: Record<string, unknown> = {}) => ({
  type: "element",
  page_url: URL_,
  selector: `#e${i}`,
  html: "<b>x</b>",
  dom,
  ...over,
});
const image = (data_b64 = PNG_2X1, w = 2, h = 1, mime = "image/png") => ({
  type: "image",
  mime,
  data_b64,
  w,
  h,
});
const consoleCap = (n = 1, text = "t") => ({
  type: "console",
  page_url: URL_,
  cut_short: false,
  entries: Array.from({ length: n }, () => ({ level: "log", text, source: null, ts: 1 })),
});
const networkCap = (n = 1, url = "https://app.example/a?x=…") => ({
  type: "network",
  page_url: URL_,
  cut_short: false,
  entries: Array.from({ length: n }, () => ({
    method: "GET",
    url,
    status: 200,
    resource_type: "fetch",
    ms: 3,
    failed: null,
  })),
});
const send = (text: string, attachments: unknown[] = []) => ({
  v: 2,
  kind: "send",
  id: "r1",
  text,
  attachments,
});
const client = (raw: unknown) => verdict(parseClient(raw));

describe("limits.ts carries the §Validation numbers", () => {
  it("exports every size limit of the table", () => {
    const values = Object.values(limits);
    for (const n of [
      100_000,
      20,
      3,
      200,
      2048,
      16_384,
      512,
      1568,
      4 * 1024 * 1024,
      1_000_000,
      64 * 1024,
    ]) {
      expect(values, `limit ${n}`).toContain(n);
    }
  });
});

describe("parse order: v, then kind, then shape (hostile first)", () => {
  it("v: 1 with a bogus kind is unsupported_version (R3.7)", () => {
    expect(client({ v: 1, kind: "bogus", id: "a" })).toBe("unsupported_version");
  });
  it("v: 3 hello is unsupported_version", () => {
    expect(
      client({
        v: 3,
        kind: "hello",
        client: { browser: "chrome", extension_id: "x", extension_version: "1" },
      }),
    ).toBe("unsupported_version");
  });
  it("v: 2 with an unknown kind is unknown_kind (R3.6)", () => {
    expect(client({ v: 2, kind: "delete_everything", id: "a" })).toBe("unknown_kind");
  });
  it("an unknown field is bad_request", () => {
    expect(client({ v: 2, kind: "cancel", id: "a", extra: 1 })).toBe("bad_request");
  });
  it("non-objects are bad_request, never a throw", () => {
    for (const raw of [null, [], "hello", 7, [{ v: 2, kind: "cancel", id: "a" }]]) {
      expect(client(raw), JSON.stringify(raw)).toBe("bad_request");
    }
  });
  it("an id longer than 64 characters is bad_request; 64 is accepted", () => {
    expect(client({ v: 2, kind: "cancel", id: "x".repeat(65) })).toBe("bad_request");
    expect(client({ v: 2, kind: "cancel", id: "x".repeat(64) })).toBe("accepted");
  });
  it("accepts every client kind in its contract shape", () => {
    const ok = [
      {
        v: 2,
        kind: "hello",
        client: { browser: "chrome", extension_id: "abc", extension_version: "0.1.0" },
      },
      { v: 2, kind: "list_threads", id: "a" },
      { v: 2, kind: "subscribe", id: "a", target: { follow: true } },
      { v: 2, kind: "subscribe", id: "a", target: { thread_id: "t1" } },
      send("hi"),
      { v: 2, kind: "cancel", id: "a" },
      { v: 2, kind: "authorize", id: "a", request_id: "r", option_id: "o" },
      { v: 2, kind: "open_in_zeo", id: "a" },
    ];
    for (const raw of ok) {
      expect(client(raw), JSON.stringify(raw)).toBe("accepted");
    }
  });
});

describe("send limits (R7.11, R12.5, R10.3)", () => {
  it("hostile: 100 000 astral code points pass; 100 001 BMP characters fail", () => {
    expect(client(send("😀".repeat(100_000)))).toBe("accepted");
    expect(client(send("a".repeat(100_001)))).toBe("bad_request");
  });
  it("a lone surrogate is bad_request", () => {
    expect(client(send("ok \ud800 there"))).toBe("bad_request");
  });
  it("20 elements pass, 21 fail", () => {
    expect(
      client(
        send(
          "",
          Array.from({ length: 20 }, (_, i) => element(i)),
        ),
      ),
    ).toBe("accepted");
    expect(
      client(
        send(
          "",
          Array.from({ length: 21 }, (_, i) => element(i)),
        ),
      ),
    ).toBe("bad_request");
  });
  it("3 images pass, 4 fail", () => {
    expect(client(send("", [image(), image(), image()]))).toBe("accepted");
    expect(client(send("", [image(), image(), image(), image()]))).toBe("bad_request");
  });
  it("one console and one network pass; a second of either fails", () => {
    expect(client(send("", [consoleCap(), networkCap()]))).toBe("accepted");
    expect(client(send("", [consoleCap(), consoleCap()]))).toBe("bad_request");
    expect(client(send("", [networkCap(), networkCap()]))).toBe("bad_request");
  });
  it("200 entries pass, 201 fail", () => {
    expect(client(send("", [consoleCap(200)]))).toBe("accepted");
    expect(client(send("", [consoleCap(201)]))).toBe("bad_request");
    expect(client(send("", [networkCap(201)]))).toBe("bad_request");
  });
  it("hostile: console text is capped in UTF-8 bytes (2 048 ok, 1 025 'é' fails)", () => {
    expect(client(send("", [consoleCap(1, "a".repeat(2048))]))).toBe("accepted");
    expect(client(send("", [consoleCap(1, "é".repeat(1025))]))).toBe("bad_request");
  });
  it("network url: 2 048 bytes pass, 2 049 fail", () => {
    const base = "https://app.example/";
    expect(client(send("", [networkCap(1, base + "a".repeat(2048 - base.length))]))).toBe(
      "accepted",
    );
    expect(client(send("", [networkCap(1, base + "a".repeat(2049 - base.length))]))).toBe(
      "bad_request",
    );
  });
  it("element html: 16 384 bytes pass, 16 385 fail", () => {
    expect(client(send("", [element(0, { html: "a".repeat(16_384) })]))).toBe("accepted");
    expect(client(send("", [element(0, { html: "a".repeat(16_385) })]))).toBe("bad_request");
  });
  it("element selector: 512 characters pass, 513 fail", () => {
    expect(client(send("", [element(0, { selector: "#" + "a".repeat(511) })]))).toBe("accepted");
    expect(client(send("", [element(0, { selector: "#" + "a".repeat(512) })]))).toBe("bad_request");
  });
  it("page_url: http, https and file pass; javascript, data and extension schemes fail", () => {
    for (const u of ["http://localhost:5173/", "https://app.example/x", "file:///tmp/p.html"]) {
      expect(client(send("", [element(0, { page_url: u })])), u).toBe("accepted");
    }
    for (const u of [
      "javascript:alert(1)",
      "data:text/html,x",
      "chrome-extension://abc/x.html",
      "about:blank",
    ]) {
      expect(client(send("", [element(0, { page_url: u })])), u).toBe("bad_request");
    }
  });
  it("page_url longer than 2 KiB fails", () => {
    expect(
      client(send("", [element(0, { page_url: "https://a.example/" + "a".repeat(2048) })])),
    ).toBe("bad_request");
  });
  it("hostile identity: JPEG labelled PNG and PNG labelled JPEG both fail; true labels pass", () => {
    expect(client(send("", [image(JPEG_2X1, 2, 1, "image/png")]))).toBe("bad_request");
    expect(client(send("", [image(PNG_2X1, 2, 1, "image/jpeg")]))).toBe("bad_request");
    expect(client(send("", [image(JPEG_2X1, 2, 1, "image/jpeg")]))).toBe("accepted");
    expect(client(send("", [image(PNG_2X1, 2, 1, "image/png")]))).toBe("accepted");
  });
  it("w and h must match the image header", () => {
    expect(client(send("", [image(PNG_2X1, 1, 2)]))).toBe("bad_request");
    expect(client(send("", [image(JPEG_2X1, 3, 1, "image/jpeg")]))).toBe("bad_request");
  });
  it("long edge: 1 568 passes, 1 569 fails (PNG and JPEG)", () => {
    expect(client(send("", [image(png(1568, 1), 1568, 1)]))).toBe("accepted");
    expect(client(send("", [image(png(1, 1569), 1, 1569)]))).toBe("bad_request");
    expect(client(send("", [image(jpegClaiming(1569, 1), 1569, 1, "image/jpeg")]))).toBe(
      "bad_request",
    );
  });
  it("an image over 4 MiB decoded fails", () => {
    expect(client(send("", [image(png(2, 1, 4 * 1024 * 1024), 2, 1)]))).toBe("bad_request");
  });
  it("a DOM summary over 4 KiB serialized fails", () => {
    expect(client(send("", [element(0, { dom: { ...dom, text: "a".repeat(5000) } })]))).toBe(
      "bad_request",
    );
  });
});

describe("parseServer", () => {
  const entry = { role: "assistant", markdown: "hi", truncated: false };
  const snapshot = (n: number) => ({
    v: 2,
    kind: "snapshot",
    thread: null,
    earlier: 0,
    status: { state: "idle", message: null },
    permissions: [],
    entries: Array.from({ length: n }, () => entry),
  });
  it("accepts welcome, a 100-entry snapshot and the host's bridge_unavailable", () => {
    expect(verdict(parseServer({ v: 2, kind: "welcome", protocol: 2, zeo_version: "0.5.0" }))).toBe(
      "accepted",
    );
    expect(verdict(parseServer(snapshot(100)))).toBe("accepted");
    expect(verdict(parseServer({ v: 2, kind: "bridge_unavailable", reason: "absent" }))).toBe(
      "accepted",
    );
  });
  it("refuses a 101-entry snapshot, an entry without role, and an unknown error code", () => {
    expect(verdict(parseServer(snapshot(101)))).not.toBe("accepted");
    expect(
      verdict(
        parseServer({
          v: 2,
          kind: "entry_added",
          index: 0,
          entry: { markdown: "x", truncated: false },
        }),
      ),
    ).not.toBe("accepted");
    expect(
      verdict(parseServer({ v: 2, kind: "error", error: "made_up", message: "m", fatal: false })),
    ).not.toBe("accepted");
  });
  it("never throws on garbage", () => {
    for (const raw of [undefined, null, "x", 1, [], {}]) {
      expect(() => parseServer(raw)).not.toThrow();
    }
  });
});

describe("checkSend names the first broken limit (R7.11)", () => {
  const limitOf = (r: unknown) => (r as { ok: boolean; limit?: string }).limit;
  it("passes a small message", () => {
    expect(checkSend("hello", [element()])).toEqual({ ok: true });
  });
  it("order is text, elements, images, captures", () => {
    const tooManyEl = Array.from({ length: 21 }, (_, i) => element(i));
    const tooManyImg = [image(), image(), image(), image()];
    expect(limitOf(checkSend("a".repeat(100_001), tooManyEl))).toMatch(/text/i);
    expect(limitOf(checkSend("x", [...tooManyEl, ...tooManyImg]))).toMatch(/element/i);
    expect(limitOf(checkSend("x", [...tooManyImg, consoleCap(), consoleCap()]))).toMatch(/image/i);
    expect(limitOf(checkSend("x", [consoleCap(), consoleCap()]))).toMatch(/console|capture/i);
    expect(limitOf(checkSend("x", [networkCap(), networkCap()]))).toMatch(/network|capture/i);
  });
  it("different limits get different names", () => {
    const names = new Set([
      limitOf(checkSend("a".repeat(100_001), [])),
      limitOf(
        checkSend(
          "x",
          Array.from({ length: 21 }, (_, i) => element(i)),
        ),
      ),
      limitOf(checkSend("x", [image(), image(), image(), image()])),
    ]);
    expect(names.size).toBe(3);
  });
});

// Planned amendment (post-review, tasks.md 2.2): the bytes limit and the version probe.
describe("checkSend: the whole message is capped at MAX_SEND_BYTES (R7.11)", () => {
  const limitOf = (r: unknown) => (r as { ok: boolean; limit?: string }).limit;
  // checkSend counts attachments and measures bytes; it does not decode images, so a long
  // base64 run is enough to reach the cap with one image.
  const padded = (extra: number) => {
    const base = sendBytes("x", [image("")]);
    return [image("A".repeat(limits.MAX_SEND_BYTES - base + extra))];
  };
  it("the cap is 8 000 000 bytes", () => {
    expect(limits.MAX_SEND_BYTES).toBe(8_000_000);
  });
  it("sendBytes is an upper bound for a real request id", () => {
    const real = { ...send("héllo 😀", [element()]), id: crypto.randomUUID() };
    expect(sendBytes("héllo 😀", [element()])).toBeGreaterThanOrEqual(
      new TextEncoder().encode(JSON.stringify(real)).length,
    );
  });
  it("hostile: 8 000 000 bytes pass, 8 000 001 bytes are refused naming the bytes limit", () => {
    expect(sendBytes("x", padded(0))).toBe(8_000_000);
    expect(checkSend("x", padded(0))).toEqual({ ok: true });
    expect(sendBytes("x", padded(1))).toBe(8_000_001);
    expect(limitOf(checkSend("x", padded(1)))).toMatch(/byte/i);
  });
  it("bytes come last: a message over both the capture and the bytes limits names captures", () => {
    expect(limitOf(checkSend("x", [...padded(1), consoleCap(), consoleCap()]))).toMatch(
      /console|capture/i,
    );
  });
  it("never throws on garbage", () => {
    for (const [t, a] of [
      [null, []],
      ["x", null],
      ["x", [null]],
    ]) {
      expect(() => checkSend(t as any, a as any)).not.toThrow();
    }
    expect(limitOf(checkSend(7 as any, []))).toMatch(/text/i);
  });
});

describe("probeServer: the lenient read before the strict parse (design.md §A3)", () => {
  const V1_REPLY = {
    v: 1,
    ok: false,
    error: "unsupported_version",
    message: "Unsupported protocol version; Zeo speaks version 1",
  };
  it("reads a protocol-3 welcome as it is", () => {
    expect(probeServer({ v: 2, kind: "welcome", protocol: 3 })).toEqual({
      v: 2,
      kind: "welcome",
      protocol: 3,
    });
  });
  it("reads the v1 bridge's reply to hello as v 1 with no kind and no protocol", () => {
    expect(probeServer(V1_REPLY)).toEqual({ v: 1, kind: null, protocol: null });
  });
  it("is null for non-objects, invalid JSON and a missing or non-numeric v", () => {
    for (const raw of [undefined, null, 7, [], "not json", "[1]", {}, { v: "2", kind: "ok" }]) {
      expect(probeServer(raw), JSON.stringify(raw)).toBeNull();
    }
  });
  it("hostile: parseServer accepts the v1 reply but no other v1 shape", () => {
    expect(verdict(parseServer(V1_REPLY))).toBe("accepted");
    expect(verdict(parseServer({ v: 1, kind: "welcome", protocol: 1, zeo_version: "0.4.0" }))).toBe(
      "unsupported_version",
    );
    expect(verdict(parseServer({ ...V1_REPLY, ok: true }))).toBe("unsupported_version");
    expect(verdict(parseServer({ ...V1_REPLY, extra: 1 }))).toBe("unsupported_version");
  });
  it("a JSON string is decoded the same way, and invalid JSON is bad_request", () => {
    expect(probeServer(JSON.stringify(V1_REPLY))).toEqual({ v: 1, kind: null, protocol: null });
    expect(verdict(parseServer("{not json"))).toBe("bad_request");
    expect(client("{not json")).toBe("bad_request");
  });
});
