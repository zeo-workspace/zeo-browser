// Story 045, task 8.2 — the built `zeo-browser-host` over real stdio frames against a fake Zeo on a
// temp unix socket (design.md §B4, §Testing Strategy). Requirements: R2.1–R2.9, R13.3, R13.4 (Q13).
// The binary comes from ZEO_BROWSER_HOST_BIN. Unset, the suite is reported SKIPPED, never passed.
// Frames are a u32 length in NATIVE byte order — little-endian on x86_64, asserted below.
//
// Hostile halves first:
//   - identity: a `client` forged in the page's hello is overwritten from the arguments, for both
//     argument shapes (Chrome origin; Firefox manifest path + add-on id);
//   - caps: 8 MiB + 1 from the extension and 1 000 001 bytes from Zeo are refused while the
//     connection lives on, and exactly 1 000 000 bytes from Zeo pass;
//   - stdout carries frames and nothing else; stderr never carries message content.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BIN = process.env.ZEO_BROWSER_HOST_BIN;
const CHROME_ARGS = ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"];
const FIREFOX_ARGS = [
  "/usr/lib64/mozilla/native-messaging-hosts/dev.zeo.browser_host.json",
  "zeo-browser@zeo.dev",
];
const SECRET = "SECRET-MESSAGE-TEXT";

function frame(value: unknown | Buffer): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
}

class Host {
  frames: any[] = [];
  raw = Buffer.alloc(0);
  stderr = "";
  exit: Promise<number | null>;
  constructor(readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on("data", (d: Buffer) => {
      this.raw = Buffer.concat([this.raw, d]);
    });
    proc.stderr.on("data", (d: Buffer) => (this.stderr += d.toString()));
    this.exit = new Promise((r) => proc.on("exit", (code) => r(code)));
  }
  /** Parses stdout as frames; throws if any byte is not part of a frame (R2.8). */
  parse(final = false) {
    const out: any[] = [];
    let at = 0;
    while (at + 4 <= this.raw.length) {
      const len = this.raw.readUInt32LE(at);
      if (at + 4 + len > this.raw.length) {
        break;
      }
      out.push(JSON.parse(this.raw.subarray(at + 4, at + 4 + len).toString("utf8")));
      at += 4 + len;
    }
    if (final && at !== this.raw.length) {
      throw new Error(`stdout has ${this.raw.length - at} stray bytes`);
    }
    this.frames = out;
    return out;
  }
  send(v: unknown | Buffer) {
    this.proc.stdin.write(frame(v));
  }
  async waitFrame(pred: (f: any) => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const f = this.parse().find(pred);
      if (f) {
        return f;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no matching frame; got ${JSON.stringify(this.parse()).slice(0, 500)}`);
  }
}

class FakeZeo {
  lines: string[] = [];
  sockets: Socket[] = [];
  server!: Server;
  constructor(readonly path: string) {}
  async start() {
    this.server = createServer((s) => {
      this.sockets.push(s);
      let buf = "";
      s.on("data", (d) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          this.lines.push(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      s.on("error", () => {});
    });
    await new Promise<void>((r) => this.server.listen(this.path, r));
  }
  write(text: string) {
    for (const s of this.sockets) {
      s.write(text);
    }
  }
  async waitLines(n: number, ms = 3000) {
    const end = Date.now() + ms;
    while (this.lines.length < n && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.lines.map((l) => JSON.parse(l));
  }
  async stop() {
    for (const s of this.sockets) {
      s.destroy();
    }
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const hello = {
  v: 2,
  kind: "hello",
  client: { browser: "firefox", extension_id: "forged", extension_version: "0.1.0" },
};
let dir: string;
let zeo: FakeZeo;
const hosts: Host[] = [];
function host(
  args: string[],
  env: Record<string, string | undefined> = { ZEO_DEVTOOLS_SOCKET: join(dir, "devtools.sock") },
) {
  const h = new Host(
    spawn(BIN!, args, { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv }),
  );
  hosts.push(h);
  return h;
}

describe.skipIf(!BIN)("zeo-browser-host", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zeo-host-"));
    zeo = new FakeZeo(join(dir, "devtools.sock"));
    await zeo.start();
  });
  afterEach(async () => {
    for (const h of hosts.splice(0)) {
      h.proc.kill("SIGKILL");
    }
    await zeo.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  it("frames are little-endian on this machine (native order)", () => {
    expect(endianness()).toBe("LE");
  });

  it("hostile: Chrome-shaped arguments overwrite a forged hello identity (R2.7, R2.1)", async () => {
    const h = host(CHROME_ARGS);
    h.send(hello);
    const [line] = await zeo.waitLines(1);
    expect(line.client.extension_id).toBe("abcdefghijklmnopabcdefghijklmnop");
    expect(["chrome", "chromium"]).toContain(line.client.browser);
    expect(line.client.extension_version).toBe("0.1.0");
  });

  it("hostile: Firefox-shaped arguments give the add-on id", async () => {
    const h = host(FIREFOX_ARGS);
    h.send({
      ...hello,
      client: { browser: "chrome", extension_id: "forged", extension_version: "0.1.0" },
    });
    const [line] = await zeo.waitLines(1);
    expect(line.client).toMatchObject({ browser: "firefox", extension_id: "zeo-browser@zeo.dev" });
  });

  it("relays both ways: one compact line per frame, one frame per line (R2.1)", async () => {
    const h = host(CHROME_ARGS);
    h.send(hello);
    h.send({ v: 2, kind: "send", id: "s1", text: `line one\nline two ${SECRET}`, attachments: [] });
    const lines = await zeo.waitLines(2);
    expect(zeo.lines[1]).not.toMatch(/\n/);
    expect(lines[1].text).toBe(`line one\nline two ${SECRET}`);
    zeo.write(JSON.stringify({ v: 2, kind: "welcome", protocol: 2, zeo_version: "0.5.0" }) + "\n");
    await h.waitFrame((f) => f.kind === "welcome");
  });

  it("an 8 MiB + 1 frame or a non-object answers bad_request and keeps the connection (R2.5)", async () => {
    const h = host(CHROME_ARGS);
    h.send(hello);
    await zeo.waitLines(1);
    h.send(
      Buffer.from(
        JSON.stringify({
          v: 2,
          kind: "send",
          id: "big",
          text: "a".repeat(8 * 1024 * 1024),
          attachments: [],
        }),
      ),
    );
    await h.waitFrame((f) => f.kind === "error" && f.error === "bad_request", 10_000);
    h.send([1, 2, 3]);
    h.send(Buffer.from("not json"));
    await new Promise((r) => setTimeout(r, 300));
    expect(h.parse().filter((f) => f.error === "bad_request").length).toBeGreaterThanOrEqual(3);
    h.send({ v: 2, kind: "cancel", id: "c1" });
    const lines = await zeo.waitLines(2);
    expect(lines.map((l) => l.kind)).toEqual(["hello", "cancel"]);
  });

  it("hostile: 1 000 001 bytes from Zeo give oversized_from_zeo; 1 000 000 pass; the next line arrives (R2.6)", async () => {
    const h = host(CHROME_ARGS);
    h.send(hello);
    await zeo.waitLines(1);
    const sized = (n: number) => {
      const base = JSON.stringify({ v: 2, kind: "title", title: "" });
      return JSON.stringify({ v: 2, kind: "title", title: "x".repeat(n - base.length) });
    };
    zeo.write(sized(1_000_001) + "\n");
    zeo.write(sized(1_000_000) + "\n");
    zeo.write(JSON.stringify({ v: 2, kind: "thread_closed" }) + "\n");
    await h.waitFrame((f) => f.kind === "thread_closed", 5000);
    const kinds = h.parse().map((f) => (f.kind === "error" ? f.error : f.kind));
    expect(kinds).toEqual(["oversized_from_zeo", "title", "thread_closed"]);
    expect(h.parse()[1].title.length).toBeGreaterThan(999_000);
  });

  it("an absent socket: one bridge_unavailable 'absent' frame, exit 0 (R2.2)", async () => {
    const h = host(CHROME_ARGS, { ZEO_DEVTOOLS_SOCKET: join(dir, "nothing.sock") });
    expect(await h.exit).toBe(0);
    expect(h.parse(true)).toEqual([{ v: 2, kind: "bridge_unavailable", reason: "absent" }]);
  });

  it("a refused socket: bridge_unavailable 'refused', exit 0 (R2.2)", async () => {
    // A socket file bound but never listened on refuses every connect (ECONNREFUSED); python's
    // socket module leaves the file in place on exit, unlike Node's net.Server.
    const stale = join(dir, "stale.sock");
    execFileSync("python3", [
      "-c",
      "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])",
      stale,
    ]);
    const h = host(CHROME_ARGS, { ZEO_DEVTOOLS_SOCKET: stale });
    expect(await h.exit).toBe(0);
    expect(h.parse(true)).toEqual([{ v: 2, kind: "bridge_unavailable", reason: "refused" }]);
  });

  it("Zeo closing: one bridge_closed frame, exit 0 (R2.3)", async () => {
    const h = host(CHROME_ARGS);
    h.send(hello);
    await zeo.waitLines(1);
    for (const s of zeo.sockets) {
      s.end();
    }
    expect(await h.exit).toBe(0);
    expect(h.parse(true).at(-1)).toEqual({ v: 2, kind: "bridge_closed" });
  });

  it("stdin closing: the socket is closed and the host exits within 1 s (R2.4)", async () => {
    const h = host(CHROME_ARGS);
    h.send(hello);
    await zeo.waitLines(1);
    const closed = new Promise<void>((r) => zeo.sockets[0]!.on("close", () => r()));
    const t0 = Date.now();
    h.proc.stdin.end();
    const code = await h.exit;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(code).toBe(0);
    await closed;
  });

  it("without ZEO_DEVTOOLS_SOCKET it uses $XDG_RUNTIME_DIR/zeo/devtools.sock (R2.9)", async () => {
    const runtime = join(dir, "run");
    await mkdir(join(runtime, "zeo"), { recursive: true, mode: 0o700 });
    const other = new FakeZeo(join(runtime, "zeo", "devtools.sock"));
    await other.start();
    const h = host(CHROME_ARGS, { XDG_RUNTIME_DIR: runtime });
    h.send(hello);
    expect((await other.waitLines(1))[0].kind).toBe("hello");
    expect(zeo.lines).toHaveLength(0);
    await other.stop();
  });

  it("no usable runtime dir: bridge_unavailable 'no_runtime_dir', exit 0", async () => {
    const h = host(CHROME_ARGS, { XDG_RUNTIME_DIR: "relative/dir" });
    expect(await h.exit).toBe(0);
    expect(h.parse(true)).toEqual([{ v: 2, kind: "bridge_unavailable", reason: "no_runtime_dir" }]);
  });

  it("hostile: stdout is frames only; stderr is key=value and never carries content (R2.8, R13.3, R13.4)", async () => {
    const h = host(CHROME_ARGS);
    h.send(hello);
    h.send({ v: 2, kind: "send", id: "s", text: SECRET, attachments: [] });
    await zeo.waitLines(2);
    zeo.write(
      JSON.stringify({
        v: 2,
        kind: "entry_added",
        index: 0,
        entry: { role: "assistant", markdown: SECRET, truncated: false },
      }) + "\n",
    );
    await h.waitFrame((f) => f.kind === "entry_added");
    h.proc.stdin.end();
    await h.exit;
    expect(() => h.parse(true)).not.toThrow();
    const lines = h.stderr.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toMatch(/^zeo-browser-host event=[a-z_]+( [a-z_]+=("[^"]*"|\S+))*$/);
    }
    expect(h.stderr).toMatch(/event=start/);
    expect(h.stderr).toMatch(/event=exit/);
    expect(h.stderr).not.toContain(SECRET);
  });

  // Added at Run mode (refine v3: R2.10–R2.12).

  it("hostile: a later hello is overwritten too, never just the first (R2.10)", async () => {
    const h = host(CHROME_ARGS);
    h.send(hello);
    h.send({
      ...hello,
      client: { browser: "firefox", extension_id: "second-forgery", extension_version: "0.2.0" },
    });
    const lines = await zeo.waitLines(2);
    expect(lines.map((l) => l.client.extension_id)).toEqual([
      "abcdefghijklmnopabcdefghijklmnop",
      "abcdefghijklmnopabcdefghijklmnop",
    ]);
    expect(lines[1].client.extension_version).toBe("0.2.0");
  });

  it("hostile: a message before the first hello is dropped and answered bad_request (R2.11)", async () => {
    const h = host(CHROME_ARGS);
    h.send({ v: 2, kind: "send", id: "early", text: SECRET, attachments: [] });
    const refusal = await h.waitFrame((f) => f.kind === "error");
    expect(refusal).toMatchObject({ id: "early", error: "bad_request", fatal: false });
    h.send(hello);
    const lines = await zeo.waitLines(1);
    expect(lines.map((l) => l.kind)).toEqual(["hello"]);
    expect(zeo.lines.join("\n")).not.toContain(SECRET);
  });

  it("hostile: arguments that only look like a browser's give the unknown identity", async () => {
    for (const args of [
      ["chrome-extension://abcdefghijklmnopabcdefghijklmnoq/"], // 'q' is outside a..p
      ["chrome-extension://abcdefghijklmnop/"], // too short
      ["https://abcdefghijklmnopabcdefghijklmnop/"],
      ["/tmp/dev.zeo.browser_host.json"], // Firefox shape without the add-on id
    ]) {
      zeo.lines.length = 0;
      const h = host(args);
      h.send(hello);
      const [line] = await zeo.waitLines(1);
      expect(line.client, JSON.stringify(args)).toMatchObject({
        browser: "unknown",
        extension_id: "",
      });
      h.proc.stdin.end();
      await h.exit;
    }
  });

  it("a relative ZEO_DEVTOOLS_SOCKET: bridge_unavailable 'absent', exit 0 (R2.12)", async () => {
    const h = host(CHROME_ARGS, { ZEO_DEVTOOLS_SOCKET: "devtools.sock" });
    expect(await h.exit).toBe(0);
    expect(h.parse(true)).toEqual([{ v: 2, kind: "bridge_unavailable", reason: "absent" }]);
  });
});

describe.runIf(!BIN)("zeo-browser-host (binary not provided)", () => {
  it.skip("SKIPPED: ZEO_BROWSER_HOST_BIN is unset; build the host and point it at the binary", () => {});
  console.log("SKIPPED host integration: ZEO_BROWSER_HOST_BIN is unset");
});
