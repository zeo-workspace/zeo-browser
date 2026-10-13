// A fake Zeo devtools bridge speaking the v2 thread channel (story 045): a real `net.Server` on a
// temp unix socket that records every message and answers through a scriptable handler. Used by
// the E2E (task 8.3) and the proof-session test (task 8.4). Test support only — never imported
// by `src/`.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Msg = Record<string, any>;
export type Handler = (msg: Msg, reply: (m: Msg) => void, socket: Socket) => void;

export const thread = (id = "t1", title = "Fix the build", followed = true) => ({
  thread_id: id,
  title,
  project: "app",
  agent: "Claude",
  status: "idle",
  followed,
});
export const entry = (markdown: string, role = "assistant") => ({
  role,
  markdown,
  truncated: false,
});
export const idle = { state: "idle", message: null };

export const defaultHandler: Handler = (msg, reply) => {
  const id = msg.id;
  switch (msg.kind) {
    case "hello":
      reply({ v: 2, kind: "welcome", ...(id ? { id } : {}), protocol: 2, zeo_version: "0.5.0" });
      break;
    case "list_threads":
      reply({ v: 2, kind: "threads", id, items: [thread()] });
      break;
    case "subscribe":
      reply({
        v: 2,
        kind: "snapshot",
        id,
        thread: thread(),
        earlier: 0,
        entries: [entry("hello from zeo")],
        status: idle,
        permissions: [],
      });
      break;
    case "send":
      reply({ v: 2, kind: "sent", id, queued: false, images: "none" });
      break;
    default:
      reply({ v: 2, kind: "ok", id });
  }
};

export interface FakeZeoV2 {
  path: string;
  dir: string;
  received: Msg[];
  receivedAt: number[];
  sockets: Set<Socket>;
  handler: Handler;
  push(msg: Msg): void;
  waitFor(kind: string, ms?: number): Promise<Msg>;
  stop(): Promise<void>;
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export async function startFakeZeoV2(): Promise<FakeZeoV2> {
  const dir = await mkdtemp(join(tmpdir(), "zeo-fake-v2-"));
  const path = join(dir, "devtools.sock");
  let server: Server | undefined;
  const fake: FakeZeoV2 = {
    path,
    dir,
    received: [],
    receivedAt: [],
    sockets: new Set(),
    handler: defaultHandler,
    push(msg) {
      for (const s of fake.sockets) {
        s.write(JSON.stringify(msg) + "\n");
      }
    },
    async waitFor(kind, ms = 5000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = [...fake.received].reverse().find((m) => m.kind === kind);
        if (hit) {
          return hit;
        }
        if (Date.now() > end) {
          throw new Error(
            `fake Zeo never received ${kind}; got ${fake.received.map((m) => m.kind).join(",")}`,
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    async stop() {
      for (const s of fake.sockets) {
        s.destroy();
      }
      fake.sockets.clear();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      server = undefined;
    },
    async start() {
      server = createServer((socket) => {
        fake.sockets.add(socket);
        let buf = "";
        socket.on("data", (d) => {
          buf += d.toString("utf8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            let msg: Msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue;
            }
            fake.received.push(msg);
            fake.receivedAt.push(Date.now());
            fake.handler(msg, (m) => socket.write(JSON.stringify(m) + "\n"), socket);
          }
        });
        socket.on("close", () => fake.sockets.delete(socket));
        socket.on("error", () => {});
      });
      await new Promise<void>((r) => server!.listen(path, r));
    },
    async dispose() {
      await fake.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
  await fake.start();
  return fake;
}
