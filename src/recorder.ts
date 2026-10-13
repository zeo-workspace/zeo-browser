// Console and network recording, Chrome only (story 045, design.md §A7; R11.1–R11.8).
//
// - `start(tabId, onEnd)` attaches `chrome.debugger` (protocol 1.3) and enables `Runtime`, `Log`
//   and `Network` (R11.1). Nothing is attached before it (R11.2). A failed attach or enable
//   detaches and rejects with the step that failed and its cause.
// - Console entries come from `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` and
//   `Log.entryAdded` (whose sources never include the console API, so nothing is counted twice);
//   network entries from `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` /
//   `loadingFailed`. Each kind keeps the latest 200 (R11.3).
// - `stop()`, or the 120 s cap, detaches and hands back one console and one network capture
//   (R11.4): `stop()` returns them, the cap passes them to `onEnd`. A browser detach (the user's
//   Cancel on the debugging bar, the tab closed) passes them to `onEnd` with `cut_short: true`,
//   keeping what was captured (R11.5).
// - Entries are built field by field from the event parameters, never by spreading an event: no
//   header, cookie or body is ever read (R11.8). URLs (network, and the source of a console entry)
//   go through `redactUrl`; console text has every URL-shaped substring redacted the same way
//   (CORS and WebSocket messages, stack frames), before the 2 KiB cap. `page_url` is scheme, host
//   and path only, like the picker's. Strings are made well-formed and capped to the contract's
//   byte limits.
//
// This is a library: it returns errors and never logs (R13.4 — the sidebar logs event names
// only). The Firefox build never bundles it (`__HAS_DEBUGGER__`, R11.9).
import type { Attachment } from "./contract.js";
import { MAX_CAPTURE_ENTRIES, MAX_CONSOLE_TEXT_BYTES, MAX_NETWORK_URL_BYTES } from "./limits.js";
import { api } from "./platform.js";
import { pageUrlOf, redactUrl, redactUrlsInText, truncateUtf8 } from "./redact.js";

export { redactUrl } from "./redact.js";

export type ConsoleCapture = Extract<Attachment, { type: "console" }>;
export type NetworkCapture = Extract<Attachment, { type: "network" }>;
export type ConsoleEntry = ConsoleCapture["entries"][number];
export type NetworkEntry = NetworkCapture["entries"][number];
/** What a recording produces: one capture of each kind. */
export interface Captures {
  console: ConsoleCapture;
  network: NetworkCapture;
}

/** The longest a recording runs before it stops itself, in ms (R11.4). */
export const RECORDING_CAP_MS = 120_000;
/** The protocol version attached (R11.1). */
export const PROTOCOL = "1.3";
/** The domains enabled after attaching, in order (R11.1). */
export const DOMAINS = ["Runtime.enable", "Log.enable", "Network.enable"] as const;
/**
 * A short label (method, resource type, failure reason), in bytes. The contract sets no limit on
 * these; CDP values are a few bytes, so this only bounds a hostile or broken one.
 */
const MAX_LABEL_BYTES = 256;

type Params = Record<string, unknown>;
type DebuggerSource = { tabId?: number };

/** One request as it progresses; turned into a `NetworkEntry` field by field. */
interface RequestRecord {
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  started: number | null;
  ms: number | null;
  failed: string | null;
}

interface Session {
  tabId: number;
  pageUrl: string;
  onEnd: (captures: Captures) => void;
  console: ConsoleEntry[];
  network: RequestRecord[];
  /** The latest record of each request id still in `network`. */
  byId: Map<string, RequestRecord>;
  timer: ReturnType<typeof setTimeout> | undefined;
  ended: boolean;
  onEvent: (source: DebuggerSource, method: string, params?: object) => void;
  onDetach: (source: DebuggerSource, reason: string) => void;
}

let session: Session | null = null;
/**
 * The captures of a session the 120 s cap is ending (detach in flight), until `onEnd` has them:
 * a Stop that races the cap gets these instead of nothing.
 */
let ending: Promise<Captures> | null = null;

// ---------------------------------------------------------------------------------------------
// Narrowing helpers: every event parameter is untrusted shape-wise.

const isRecord = (v: unknown): v is Params => typeof v === "object" && v !== null;
const field = (o: unknown, key: string): unknown => (isRecord(o) ? o[key] : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
/** A string the contract accepts (no lone surrogate), capped to `max` UTF-8 bytes. */
const clean = (s: string, max: number): string => truncateUtf8(s.toWellFormed(), max);
/** Console text: URLs redacted first, then made well-formed and capped (R11.7, R11.8). */
const consoleText = (s: string): string => clean(redactUrlsInText(s), MAX_CONSOLE_TEXT_BYTES);

/** `url:line:col` (1-based), with the URL redacted, or null when there is no URL. */
function sourceOf(url: unknown, line: unknown, col: unknown): string | null {
  const u = str(url);
  if (u === undefined || u === "") {
    return null;
  }
  const l = num(line);
  const c = num(col);
  const loc = l === undefined ? "" : c === undefined ? `:${l + 1}` : `:${l + 1}:${c + 1}`;
  return clean(`${redactUrl(u)}${loc}`, MAX_NETWORK_URL_BYTES);
}

/** The first call frame of a `Runtime.StackTrace`, as a source. */
function frameSource(stackTrace: unknown): string | null {
  const frames = field(stackTrace, "callFrames");
  const top: unknown = Array.isArray(frames) ? frames[0] : undefined;
  return sourceOf(field(top, "url"), field(top, "lineNumber"), field(top, "columnNumber"));
}

/** A console argument (`Runtime.RemoteObject`) as text. */
function argText(arg: unknown): string {
  const value = field(arg, "value");
  if (typeof value === "string") {
    return value;
  }
  if (value !== undefined) {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return (
    str(field(arg, "unserializableValue")) ??
    str(field(arg, "description")) ??
    str(field(arg, "type")) ??
    ""
  );
}

const CONSOLE_LEVELS: Record<string, ConsoleEntry["level"]> = {
  log: "log",
  info: "info",
  debug: "debug",
  warning: "warn",
  error: "error",
  assert: "error",
  verbose: "debug",
};
const levelOf = (type: unknown): ConsoleEntry["level"] => CONSOLE_LEVELS[str(type) ?? ""] ?? "log";
const tsOf = (params: unknown): number => num(field(params, "timestamp")) ?? Date.now();

// ---------------------------------------------------------------------------------------------
// Event handling

function pushConsole(s: Session, entry: ConsoleEntry): void {
  s.console.push(entry);
  if (s.console.length > MAX_CAPTURE_ENTRIES) {
    s.console.shift();
  }
}

function pushRequest(s: Session, id: string, record: RequestRecord): void {
  s.network.push(record);
  s.byId.set(id, record);
  if (s.network.length > MAX_CAPTURE_ENTRIES) {
    const dropped = s.network.shift();
    for (const [key, rec] of s.byId) {
      if (rec === dropped) {
        s.byId.delete(key);
        break;
      }
    }
  }
}

/** Duration in ms from the request's start to a `MonotonicTime` (seconds), or null. */
function elapsed(record: RequestRecord, timestamp: unknown): number | null {
  const end = num(timestamp);
  if (record.started === null || end === undefined) {
    return null;
  }
  return Math.max(0, Math.round((end - record.started) * 1000));
}

function onConsoleEvent(s: Session, method: string, p: unknown): void {
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const args = field(p, "args");
      const text = Array.isArray(args) ? args.map(argText).join(" ") : "";
      pushConsole(s, {
        level: levelOf(field(p, "type")),
        text: consoleText(text),
        source: frameSource(field(p, "stackTrace")),
        ts: tsOf(p),
      });
      return;
    }
    case "Runtime.exceptionThrown": {
      const details = field(p, "exceptionDetails");
      const head = str(field(details, "text")) ?? "";
      const description = str(field(field(details, "exception"), "description"));
      const text = description === undefined ? head : head ? `${head} ${description}` : description;
      pushConsole(s, {
        level: "exception",
        text: consoleText(text),
        source:
          sourceOf(
            field(details, "url"),
            field(details, "lineNumber"),
            field(details, "columnNumber"),
          ) ?? frameSource(field(details, "stackTrace")),
        ts: tsOf(p),
      });
      return;
    }
    case "Log.entryAdded": {
      const entry = field(p, "entry");
      pushConsole(s, {
        level: levelOf(field(entry, "level")),
        text: consoleText(str(field(entry, "text")) ?? ""),
        source:
          sourceOf(field(entry, "url"), field(entry, "lineNumber"), undefined) ??
          frameSource(field(entry, "stackTrace")),
        ts: tsOf(entry),
      });
      return;
    }
  }
}

function onNetworkEvent(s: Session, method: string, p: unknown): void {
  const id = str(field(p, "requestId"));
  if (id === undefined) {
    return;
  }
  const record = s.byId.get(id);
  switch (method) {
    case "Network.requestWillBeSent": {
      // A redirect re-uses the request id: the hop that redirected ends with its status.
      const redirect = field(p, "redirectResponse");
      if (record !== undefined && redirect !== undefined) {
        record.status = num(field(redirect, "status")) ?? record.status;
        record.ms = elapsed(record, field(p, "timestamp"));
      }
      const request = field(p, "request");
      pushRequest(s, id, {
        method: clean(str(field(request, "method")) ?? "GET", MAX_LABEL_BYTES),
        url: clean(redactUrl(str(field(request, "url")) ?? ""), MAX_NETWORK_URL_BYTES),
        status: null,
        resourceType: clean(str(field(p, "type")) ?? "Other", MAX_LABEL_BYTES),
        started: num(field(p, "timestamp")) ?? null,
        ms: null,
        failed: null,
      });
      return;
    }
    case "Network.responseReceived": {
      if (record === undefined) {
        return;
      }
      const status = num(field(field(p, "response"), "status"));
      record.status = status === undefined ? record.status : Math.trunc(status);
      const type = str(field(p, "type"));
      if (type !== undefined) {
        record.resourceType = clean(type, MAX_LABEL_BYTES);
      }
      return;
    }
    case "Network.loadingFinished": {
      if (record !== undefined) {
        record.ms = elapsed(record, field(p, "timestamp"));
      }
      return;
    }
    case "Network.loadingFailed": {
      if (record === undefined) {
        return;
      }
      record.ms = elapsed(record, field(p, "timestamp"));
      const reason = str(field(p, "errorText")) || str(field(p, "blockedReason")) || "failed";
      record.failed = clean(reason, MAX_LABEL_BYTES);
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Captures

function captures(s: Session, cutShort: boolean): Captures {
  return {
    console: {
      type: "console",
      page_url: s.pageUrl,
      cut_short: cutShort,
      entries: s.console.map((e) => ({ level: e.level, text: e.text, source: e.source, ts: e.ts })),
    },
    network: {
      type: "network",
      page_url: s.pageUrl,
      cut_short: cutShort,
      entries: s.network.map((r) => ({
        method: r.method,
        url: r.url,
        status: r.status,
        resource_type: r.resourceType,
        ms: r.ms,
        failed: r.failed,
      })),
    },
  };
}

/**
 * The tab's `page_url`: its URL from `tabs.get`, else from the debugger's target list, reduced to
 * scheme, host and path (`pageUrlOf`). Empty when unknown or unparseable.
 */
async function readPageUrl(tabId: number): Promise<string> {
  let url: string | undefined;
  try {
    url = (await api.tabs.get(tabId)).url;
  } catch {
    // The tab is gone or unreadable; the target list below may still name it.
  }
  if (url === undefined || url === "") {
    try {
      const targets = await api.debugger.getTargets();
      url = targets.find((t) => t.tabId === tabId)?.url;
    } catch {
      // Without a URL the capture's page_url stays empty and the sidebar refuses it in words.
    }
  }
  if (url === undefined || url === "") {
    return "";
  }
  try {
    return pageUrlOf(new URL(url));
  } catch {
    return "";
  }
}

/** Detaches, ignoring the failure: the only realistic one is "not attached" (already gone). */
async function detachQuietly(tabId: number): Promise<void> {
  try {
    await api.debugger.detach({ tabId });
  } catch {
    // Already detached (the tab closed, or the browser ended the session); the background's
    // janitor covers a session left behind by a dead sidebar.
  }
}

/** Ends `s` synchronously: no more events, no timer, no listeners. Returns the captures. */
function end(s: Session, cutShort: boolean): Captures {
  s.ended = true;
  if (session === s) {
    session = null;
  }
  clearTimeout(s.timer);
  api.debugger.onEvent.removeListener(s.onEvent);
  api.debugger.onDetach.removeListener(s.onDetach);
  return captures(s, cutShort);
}

// ---------------------------------------------------------------------------------------------
// Public API

/** Whether a recording is running (or starting). */
export function isRecording(): boolean {
  return session !== null;
}

/**
 * Attaches the debugger to `tabId` and starts recording. `onEnd` receives the captures when the
 * 120 s cap or a browser detach ends the recording; `stop()` returns them instead. Rejects when a
 * recording is already running, or when the attach or an enable fails (after detaching).
 */
export async function start(tabId: number, onEnd: (captures: Captures) => void): Promise<void> {
  if (session !== null) {
    throw new Error("a recording is already running");
  }
  const s: Session = {
    tabId,
    pageUrl: "",
    onEnd,
    console: [],
    network: [],
    byId: new Map(),
    timer: undefined,
    ended: false,
    onEvent: (source, method, params) => {
      if (s.ended || source.tabId !== tabId) {
        return;
      }
      if (method.startsWith("Network.")) {
        onNetworkEvent(s, method, params);
      } else {
        onConsoleEvent(s, method, params);
      }
    },
    onDetach: (source) => {
      if (s.ended || source.tabId !== tabId) {
        return;
      }
      s.onEnd(end(s, true));
    },
  };
  session = s;
  ending = null;
  s.pageUrl = await readPageUrl(tabId);
  if (s.ended) {
    return;
  }
  api.debugger.onEvent.addListener(s.onEvent);
  api.debugger.onDetach.addListener(s.onDetach);
  const target = { tabId };
  try {
    await api.debugger.attach(target, PROTOCOL);
  } catch (err) {
    if (!s.ended) {
      end(s, false);
    }
    throw new Error("debugger attach failed", { cause: err });
  }
  if (s.ended) {
    // stop() ran while the attach was in flight, so its detach came first: detach now.
    await detachQuietly(tabId);
    return;
  }
  for (const domain of DOMAINS) {
    if (s.ended) {
      // Stopped or detached while starting: whoever ended it already has the captures.
      return;
    }
    try {
      await api.debugger.sendCommand(target, domain);
    } catch (err) {
      if (!s.ended) {
        end(s, false);
        await detachQuietly(tabId);
      }
      throw new Error(`${domain} failed`, { cause: err });
    }
  }
  if (!s.ended) {
    s.timer = setTimeout(() => {
      const result = end(s, false);
      const done = detachQuietly(tabId).then(() => result);
      ending = done;
      void done.then(() => {
        if (ending === done) {
          ending = null;
        }
        s.onEnd(result);
      });
    }, RECORDING_CAP_MS);
  }
}

/**
 * Detaches and returns the captures. While the 120 s cap is ending the recording, returns the
 * cap's captures (also handed to `onEnd`). Rejects when no recording is running.
 */
export async function stop(): Promise<Captures> {
  const s = session;
  if (s === null) {
    if (ending !== null) {
      return ending;
    }
    throw new Error("no recording is running");
  }
  const result = end(s, false);
  await detachQuietly(s.tabId);
  return result;
}
