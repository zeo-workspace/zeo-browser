#!/usr/bin/env node
// The GUI-proof driver (story 045, task 8.4): speaks the v2 thread channel to Zeo's devtools
// bridge socket the way the native-messaging host would, so `xvfb-proof.sh` can drive a real Zeo
// without a browser. It sends `hello`, waits through `approval_pending` for `welcome` (someone has
// to click Allow in Zeo), subscribes following the active thread, sends one message carrying one
// element and one 2x1 PNG, and prints one line per server message: a timestamp and the kind,
// plus counts. It never prints entry text, titles or page content (R13.4).
//
// Exit status: 0 once `sent` arrived and the linger window passed; 1 on any `error` reply (its
// error code is printed), on an image Zeo skipped, on a closed socket or on the timeout; 2 on a
// usage error.
//
//   node scripts/proof-session.mjs --socket <path> [--timeout <s>] [--linger <ms>]
//
// `--socket` is required on purpose, with no fallback to $XDG_RUNTIME_DIR: the run sends a real
// message into the followed thread (a model turn starts) and an Allow is persisted for the
// committed extension ID in that Zeo's profile. Point it only at a throwaway Zeo, such as the
// one xvfb-proof.sh starts.
import { createConnection } from "node:net";

const EXTENSION_ID = "dhbddmompicnipfolmglmbnlpgglojid";
// A 2x1 PNG (canonical, padded base64), the same image the contract fixtures use.
const PNG_2X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAADUExURf8AABniCTcAAAAHdElNRQfqCgsBKTsSNREcAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTEwLTExVDAxOjQxOjU5KzAwOjAwbTHXaAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0xMC0xMVQwMTo0MTo1OSswMDowMBxsb9QAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMTAtMTFUMDE6NDE6NTkrMDA6MDBLeU4LAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==";

function parseArgs(argv) {
  const options = { socket: null, timeoutSeconds: 150, lingerMs: 1500 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) {
      usage(`${flag} needs a value`);
    }
    if (flag === "--socket") {
      options.socket = value;
    } else if (flag === "--timeout") {
      options.timeoutSeconds = Number(value);
    } else if (flag === "--linger") {
      options.lingerMs = Number(value);
    } else {
      usage(`unknown argument ${flag}`);
    }
    index += 1;
  }
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    usage("--timeout must be a positive number of seconds");
  }
  if (!Number.isFinite(options.lingerMs) || options.lingerMs < 0) {
    usage("--linger must be a non-negative number of milliseconds");
  }
  if (options.socket === null) {
    usage("--socket <path> is required; point it at a throwaway Zeo's devtools socket");
  }
  return options;
}

function usage(reason) {
  process.stderr.write(`proof-session: ${reason}\n`);
  process.exit(2);
}

function log(kind, details = "") {
  process.stdout.write(`${new Date().toISOString()} ${kind}${details ? ` ${details}` : ""}\n`);
}

/** Counts and identifiers only: never text, titles, markdown or page content. */
function describe(message) {
  switch (message.kind) {
    case "snapshot":
      return `entries=${message.entries?.length ?? 0} earlier=${message.earlier ?? 0} thread=${message.thread ? "yes" : "null"}`;
    case "threads":
      return `items=${message.items?.length ?? 0}`;
    case "entry_added":
    case "entry_updated":
      return `index=${message.index}`;
    case "sent":
      return `queued=${message.queued} images=${message.images}`;
    case "status":
      return `state=${message.status?.state ?? message.state ?? "?"}`;
    case "error":
      return `error=${message.error} fatal=${message.fatal}`;
    default:
      return "";
  }
}

function sendRequest() {
  return {
    v: 2,
    kind: "send",
    id: "proof-send",
    text: "Proof: does this button reach the thread?",
    attachments: [
      {
        type: "element",
        page_url: "https://shop.example/cart",
        selector: "#buy",
        html: '<button id="buy">Buy</button>',
        dom: {
          tag: "button",
          id: "buy",
          classes: [],
          text: "Buy",
          attrs: {},
          styles: {},
          rect: { x: 10, y: 20, w: 80, h: 32 },
        },
      },
      { type: "image", mime: "image/png", data_b64: PNG_2X1, w: 2, h: 1 },
    ],
  };
}

const options = parseArgs(process.argv.slice(2));
const socket = createConnection(options.socket);
// Decode as one stream, so a multi-byte character split across chunks stays whole.
socket.setEncoding("utf8");
let buffered = "";
let finished = false;

function write(message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

function finish(code, reason) {
  if (finished) {
    return;
  }
  finished = true;
  if (reason) {
    log("exit", reason);
  }
  socket.destroy();
  process.exit(code);
}

const timeout = setTimeout(
  () => finish(1, `reason=timeout after=${options.timeoutSeconds}s`),
  options.timeoutSeconds * 1000,
);

function handle(message) {
  log(message.kind ?? "unknown", describe(message));
  switch (message.kind) {
    case "error":
      finish(1, `reason=${message.error}`);
      break;
    case "welcome":
      write({ v: 2, kind: "subscribe", id: "proof-subscribe", target: { follow: true } });
      break;
    case "snapshot":
      if (message.id === "proof-subscribe") {
        write(sendRequest());
      }
      break;
    case "sent":
      if (message.images === "skipped_unsupported") {
        finish(1, "reason=image_skipped");
        break;
      }
      clearTimeout(timeout);
      setTimeout(() => finish(0, "reason=sent"), options.lingerMs);
      break;
    default:
      break;
  }
}

socket.on("connect", () => {
  log("connected");
  write({
    v: 2,
    kind: "hello",
    id: "proof-hello",
    client: { browser: "chrome", extension_id: EXTENSION_ID, extension_version: "0.1.0" },
  });
});
socket.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim() === "") {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log("unparsable_line", `bytes=${Buffer.byteLength(line)}`);
      continue;
    }
    handle(message);
  }
});
socket.on("error", (error) => finish(1, `reason=socket_error code=${error.code ?? "unknown"}`));
socket.on("close", () => finish(1, "reason=socket_closed"));
