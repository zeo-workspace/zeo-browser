// Story 045, task 8.4 — the GUI-proof driver `scripts/proof-session.mjs`, run against the fake
// Zeo the E2E uses (design.md §Testing Strategy, GUI proof). Requirements: R4.1, R4.2, R7.1,
// R7.3 (its part: the driver sends through the channel, never a composer), R12.1, R13.4 (Q13).
// Contract (tasks.md 8.4): `node scripts/proof-session.mjs --socket <path>` sends hello, waits
// through approval_pending for welcome, subscribes with follow, sends one message with one
// element and one 2×1 PNG, and prints each server message KIND with a timestamp; it exits
// non-zero naming the error kind on any `error`, and never prints entry text.
//
// Hostile halves first: entry text the fake puts in the snapshot never reaches stdout; an `error`
// reply is a non-zero exit, while the same flow without it exits 0.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClient } from "../src/contract.js";
import {
  defaultHandler,
  entry,
  idle,
  startFakeZeoV2,
  thread,
  type FakeZeoV2,
} from "../e2e/fake-zeo.js";

const SCRIPT = fileURLToPath(new URL("../scripts/proof-session.mjs", import.meta.url));
const SECRET = "SECRET-ENTRY-TEXT";

function run(socket: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, "--socket", socket]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const kill = setTimeout(() => p.kill("SIGKILL"), 15_000);
    p.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ code, out, err });
    });
  });
}

let fake: FakeZeoV2;
beforeEach(async () => {
  fake = await startFakeZeoV2();
  fake.handler = (msg, reply, s) => {
    if (msg.kind === "hello") {
      reply({ v: 2, kind: "approval_pending" });
      setTimeout(() => reply({ v: 2, kind: "welcome", protocol: 2, zeo_version: "0.5.0" }), 100);
    } else if (msg.kind === "subscribe") {
      reply({
        v: 2,
        kind: "snapshot",
        id: msg.id,
        thread: thread(),
        earlier: 0,
        entries: [entry(SECRET)],
        status: idle,
        permissions: [],
      });
    } else {
      defaultHandler(msg, reply, s);
    }
  };
});
afterEach(async () => fake.dispose());

describe("proof-session.mjs", () => {
  it("drives hello → approval → follow → one send with an element and a PNG, and exits 0", async () => {
    const r = await run(fake.path);
    expect(r.code, r.err).toBe(0);
    expect(fake.received.map((m) => m.kind)).toEqual(["hello", "subscribe", "send"]);
    expect(fake.received[1]!.target).toEqual({ follow: true });
    const send = fake.received[2]!;
    expect((parseClient(send) as { ok: boolean }).ok).toBe(true);
    const types = send.attachments.map((a: { type: string }) => a.type).sort();
    expect(types).toEqual(["element", "image"]);
    const img = send.attachments.find((a: { type: string }) => a.type === "image");
    expect(img).toMatchObject({ mime: "image/png", w: 2, h: 1 });
  });

  it("prints kinds with timestamps and never the entry text (R13.4)", async () => {
    const r = await run(fake.path);
    expect(r.out + r.err).not.toContain(SECRET);
    for (const kind of ["approval_pending", "welcome", "snapshot", "sent"]) {
      expect(r.out).toContain(kind);
    }
    const lines = r.out.trim().split("\n");
    expect(lines.every((l) => /\d{2}:\d{2}:\d{2}|\d{4}-\d{2}-\d{2}T|\b\d{10,13}\b/.test(l))).toBe(
      true,
    );
  });

  it("hostile: an error reply exits non-zero naming the error kind", async () => {
    const base = fake.handler;
    fake.handler = (msg, reply, s) =>
      msg.kind === "send"
        ? reply({
            v: 2,
            kind: "error",
            id: msg.id,
            error: "send_failed",
            message: "no agent",
            fatal: false,
          })
        : base(msg, reply, s);
    const r = await run(fake.path);
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).toContain("send_failed");
  });

  // Added at Run mode (group 8 review).

  it("hostile: a send whose image was not included is not a passing proof", async () => {
    const base = fake.handler;
    fake.handler = (msg, reply, s) =>
      msg.kind === "send"
        ? reply({ v: 2, kind: "sent", id: msg.id, queued: false, images: "skipped_unsupported" })
        : base(msg, reply, s);
    const r = await run(fake.path);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("images=skipped_unsupported");
  });

  it("refuses to run without an explicit --socket, so it never reaches a real profile by default", async () => {
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const p = spawn(process.execPath, [SCRIPT], {
        env: { ...process.env, XDG_RUNTIME_DIR: fake.dir },
      });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("exit", (code) => resolve({ code, err }));
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("--socket");
    expect(fake.received).toHaveLength(0);
  });
});
