// The native channel client (story 045, design.md §A3, §Error Handling Strategy): it owns the
// port to the native host, says which state the connection is in, and turns Zeo's messages into
// replies (matched by `id`) and events (for the view).
//
// Every incoming message goes through two reads. `probeServer` first, so an older or newer Zeo
// becomes "versions do not match" instead of a dropped message (R8.7); then the strict
// `parseServer`, and anything it refuses is dropped and logged by kind only (R13.4).
//
// Logs are structured objects on the console (the extension's logger) and never carry message
// text, entry text, URLs or anything else Zeo or the page wrote (R13.4).
//
// What the view receives (task 3.3 renders it):
//   on("state", (state, detail?) => …) — `state` is a ConnState name; `detail` is present only for
//   the states that carry words:
//     busy, denied, approval_failed, unreachable after a fatal error
//                       → { error: ChannelError, message: string }   (Zeo's own words, shown as is)
//     version_mismatch  → { versions: { extension: { protocol: 2, version: "<manifest version>" },
//                                       zeo: { protocol: number | null, version: string | null } },
//                           error?, message? }                         (always both sides, R8.7)
//   on("event", (e: ServerEvent) => …) — every valid message that is not a state or a matched
//   reply, plus the snapshot answering the channel's own re-subscribe (R8.5).
//
// Re-subscribe (R8.5): the channel owns it, and the view may also subscribe when it sees `ready`.
// The channel sends its own only when no `subscribe` went out since the last `welcome`, and a view
// `subscribe` for the target the channel is already re-subscribing to joins that pending reply.
import {
  type ChannelError,
  type ClientKind,
  type ClientMsg,
  type ServerKind,
  type ServerMsgOf,
  SERVER_KINDS,
  parseServer,
  probeServer,
} from "./contract.js";
import { PROTOCOL_VERSION, REQUEST_TIMEOUT_MS } from "./limits.js";
import { BROWSER, api } from "./platform.js";

/** The native messaging host's name, as its manifest declares it (§C1). */
export const HOST_NAME = "dev.zeo.browser_host";

/** Reconnect delays in ms: 1, 2, 4, 8, 16, then every 30 s (R8.4). */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * The browser's words for "the host is not installed, or not for this extension" (R8.6): Chrome's
 * missing manifest, Chrome's manifest that does not list this extension, and Firefox's wording for
 * both.
 */
const NO_HOST_ERRORS = [
  "Specified native messaging host not found",
  "Access to the specified native messaging host is forbidden",
  "No such native application",
];

/** Longest Zeo version string carried into a state detail; it is shown, never logged. */
const MAX_VERSION_CHARS = 64;

/** The connection states the sidebar renders (design.md §A3). */
export type ConnState =
  | "connecting"
  | "approval_pending"
  | "ready"
  | "unreachable"
  | "no_host"
  | "version_mismatch"
  | "denied"
  | "approval_failed"
  | "busy";

/** What a state carries beyond its name, when it carries anything. */
export interface StateDetail {
  /** The error code Zeo answered with (`busy`, `approval_denied`, …). */
  error?: ChannelError;
  /** Zeo's own words for that error, shown as they are. */
  message?: string;
  /** Both sides' versions; always present for `version_mismatch` (R8.7). */
  versions?: {
    extension: { protocol: number; version: string };
    zeo: { protocol: number | null; version: string | null };
  };
}

/** A message that reaches the view as an event, not as a state or a matched reply. */
export type ServerEvent = ServerMsgOf<
  Exclude<ServerKind, "welcome" | "approval_pending" | "bridge_unavailable" | "bridge_closed">
>;

type ReplyKind = {
  hello: "welcome";
  list_threads: "threads";
  subscribe: "snapshot";
  send: "sent";
  cancel: "ok";
  authorize: "ok";
  open_in_zeo: "ok";
};
/** Kinds `request()` accepts: every client message but `hello`, which the channel owns. */
export type RequestKind = Exclude<ClientKind, "hello">;
/** A request's answer: its own reply kind, or an `error` naming why not. */
export type ServerReply<K extends RequestKind> = ServerMsgOf<ReplyKind[K]> | ServerMsgOf<"error">;
/** A request as the caller writes it; any `id` it carries is replaced. Distributive, so a union
 * of kinds stays a discriminated union. */
export type RequestMsg<K extends RequestKind> =
  ClientMsg<K> extends infer M
    ? M extends unknown
      ? Omit<M, "id"> & { id?: string }
      : never
    : never;

type SubscribeTarget = ClientMsg<"subscribe">["target"];

/** The slice of `runtime.Port` the channel uses (Firefox adds `error`). */
export type NativePort = Pick<
  chrome.runtime.Port,
  "postMessage" | "disconnect" | "onMessage" | "onDisconnect"
> & { error?: { message?: string } | null };

/** The identity the `hello` carries; the host overwrites `browser` and `extension_id`. */
export type ClientInfo = ClientMsg<"hello">["client"];

export interface ChannelDeps {
  /** Opens the native port: `runtime.connectNative` in the extension, a fake in tests. */
  connectNative(name: string): NativePort;
  /** The current `runtime.lastError?.message`; read inside `onDisconnect` (Chrome). */
  lastError(): string | undefined;
  /** The `hello`'s client identity; derived from the runtime when absent. */
  client?: ClientInfo;
  /** The structured logger; `console` when absent. */
  log?: Pick<Console, "info" | "warn">;
}

type StateListener = (state: ConnState, detail?: StateDetail) => void;
type EventListener = (event: ServerEvent) => void;

interface Pending {
  kind: RequestKind;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Settles a caller's promise. Absent for the channel's own re-subscribe until a caller asking
   * for the same target joins it.
   */
  resolve?: (reply: ServerMsgOf) => void;
  reject?: (err: Error) => void;
}

/** Two subscription targets name the same thing. */
function sameTarget(a: SubscribeTarget, b: SubscribeTarget): boolean {
  return "thread_id" in a
    ? "thread_id" in b && a.thread_id === b.thread_id
    : "follow" in b && b.follow === true;
}

/** How one session ended, and so what comes after it. */
interface Ending {
  state: ConnState;
  detail?: StateDetail;
  retry: boolean;
}

function defaultDeps(): ChannelDeps {
  return {
    connectNative: (name) => api.runtime.connectNative(name),
    lastError: () => api.runtime.lastError?.message,
  };
}

function defaultClient(): ClientInfo {
  return {
    browser: BROWSER,
    extension_id: api?.runtime?.id ?? "unknown",
    extension_version: api?.runtime?.getManifest?.().version ?? "0.0.0",
  };
}

/** A known kind as itself; anything else Zeo might have put there as "unknown" (R13.4). */
function loggableKind(kind: string | null | undefined): string | null {
  if (kind == null) {
    return null;
  }
  return (SERVER_KINDS as readonly string[]).includes(kind) ? kind : "unknown";
}

/** `zeo_version` read leniently from a message the strict parse may refuse. */
function zeoVersion(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const version = (raw as Record<string, unknown>).zeo_version;
  return typeof version === "string" ? version.slice(0, MAX_VERSION_CHARS) : null;
}

/** How a fatal `error` from Zeo or the host ends the session. */
function fatalEnding(error: ChannelError, message: string): Ending {
  const detail: StateDetail = { error, message };
  switch (error) {
    case "approval_denied":
      return { state: "denied", detail, retry: false };
    case "approval_timeout":
    case "approval_unavailable":
      // No retry: each attempt would raise a new approval notification in Zeo (design.md §A3).
      return { state: "approval_failed", detail, retry: false };
    case "busy":
    case "overloaded":
      return { state: "busy", detail, retry: true };
    default:
      return { state: "unreachable", detail, retry: true };
  }
}

/**
 * The native channel. `connect()` opens it, `close()` ends it for good (until the next
 * `connect()`), `request()` sends a message and waits for its reply, and `on()` listens to the
 * connection state and to Zeo's events.
 */
export class Channel {
  private readonly deps: ChannelDeps;
  private readonly log: Pick<Console, "info" | "warn">;
  private readonly client: ClientInfo;
  private readonly stateListeners: StateListener[] = [];
  private readonly eventListeners: EventListener[] = [];
  private readonly pending = new Map<string, Pending>();

  private port: NativePort | null = null;
  /** Bumped per port, so a late callback from an old port is ignored. */
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private current: ConnState = "connecting";
  /** Counts setState calls, so a nested one ends the outer listener loop. */
  private stateSeq = 0;
  /** Set by close(), cleared by connect(): nothing reopens a closed channel by itself. */
  private closed = false;
  /** The last subscription the caller asked for, re-sent after a reconnect (R8.5). */
  private target: SubscribeTarget | null = null;
  /** Whether a `subscribe` went out since the last `welcome`, answered or still in flight. */
  private subscribedThisSession = false;
  /** The channel's own re-subscribe while it waits for its reply. */
  private ownSubscribe: { id: string; target: SubscribeTarget } | null = null;

  constructor(deps?: ChannelDeps) {
    this.deps = deps ?? defaultDeps();
    this.log = this.deps.log ?? console;
    this.client = this.deps.client ?? defaultClient();
  }

  /** The state last reported. */
  get state(): ConnState {
    return this.current;
  }

  /** Opens the port now; also the "Try again" after a terminal state. */
  connect(): void {
    this.closed = false;
    this.cancelRetry();
    this.teardown(new Error("Reconnecting to Zeo"));
    this.attempt = 0;
    this.log.info({ event: "channel_connect" });
    const generation = this.generation;
    this.setState("connecting");
    // A listener may have called close() or connect() itself; that call decides what happens.
    if (!this.closed && generation === this.generation) {
      this.open();
    }
  }

  /** Disconnects and cancels every timer; the sidebar calls it on pagehide (R8.9). */
  close(): void {
    this.closed = true;
    this.cancelRetry();
    this.teardown(new Error("The channel was closed"));
    this.log.info({ event: "channel_closed" });
  }

  /** Sends `msg` with a fresh `id` and resolves with the reply carrying that `id`. */
  request<K extends RequestKind>(msg: RequestMsg<K> & { kind: K }): Promise<ServerReply<K>> {
    // A generic `K` does not narrow; the concrete union does.
    const req = msg as unknown as RequestMsg<RequestKind>;
    const kind = req.kind;
    if (req.kind === "subscribe") {
      // Kept even when the send fails, so the next reconnect attaches to the user's choice.
      this.target = { ...req.target };
    }
    if (this.port === null || this.current !== "ready") {
      return Promise.reject(new Error("Zeo is not connected", { cause: { kind } }));
    }
    if (req.kind === "subscribe") {
      const joined = this.joinOwnSubscribe(req.target);
      if (joined !== null) {
        return joined as Promise<ServerReply<K>>;
      }
      this.subscribedThisSession = true;
    }
    return new Promise<ServerReply<K>>((resolve, reject) => {
      const id = this.send({ ...msg, id: crypto.randomUUID() }, kind, {
        resolve: resolve as (reply: ServerMsgOf) => void,
        reject,
      });
      if (id === null) {
        reject(new Error("Zeo is not connected", { cause: { kind } }));
      }
    });
  }

  /**
   * A caller's `subscribe` for the target the channel's own re-subscribe is already waiting on
   * takes over that reply instead of sending a second message; `null` when there is none to join.
   */
  private joinOwnSubscribe(target: SubscribeTarget): Promise<ServerMsgOf> | null {
    const own = this.ownSubscribe;
    const pending = own === null ? undefined : this.pending.get(own.id);
    if (
      own === null ||
      pending === undefined ||
      pending.resolve ||
      !sameTarget(own.target, target)
    ) {
      return null;
    }
    return new Promise<ServerMsgOf>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
  }

  on(ev: "state", f: StateListener): void;
  on(ev: "event", f: EventListener): void;
  on(ev: "state" | "event", f: StateListener | EventListener): void {
    if (ev === "state") {
      this.stateListeners.push(f as StateListener);
    } else {
      this.eventListeners.push(f as EventListener);
    }
  }

  // -------------------------------------------------------------------------------------------
  // The port

  private open(): void {
    // Never two ports: whatever is open now is released and its callbacks are ignored.
    this.releasePort();
    const generation = ++this.generation;
    let port: NativePort;
    try {
      port = this.deps.connectNative(HOST_NAME);
    } catch (err) {
      // A synchronous refusal reads like a disconnect carrying the same browser error.
      this.disconnected(err instanceof Error ? err.message : undefined);
      return;
    }
    this.port = port;
    port.onMessage.addListener((raw: unknown) => {
      if (generation === this.generation) {
        this.receive(raw);
      }
    });
    port.onDisconnect.addListener(() => {
      if (generation !== this.generation) {
        return;
      }
      // Firefox puts the reason on the port, Chrome on runtime.lastError; reading lastError here
      // is also what keeps Chrome from reporting it as unchecked.
      const chromeError = this.deps.lastError();
      this.disconnected(port.error?.message ?? chromeError);
    });
    const hello: ClientMsg<"hello"> = {
      v: PROTOCOL_VERSION,
      kind: "hello",
      client: this.client,
    };
    this.post(hello);
  }

  /** Posts on the current port; a dead port counts as a disconnect. */
  private post(msg: unknown): boolean {
    const port = this.port;
    if (port === null) {
      return false;
    }
    try {
      port.postMessage(msg);
      return true;
    } catch (err) {
      this.disconnected(err instanceof Error ? err.message : undefined);
      return false;
    }
  }

  /** Sends a request and registers its pending reply; `null` when nothing could be sent. */
  private send(
    msg: Record<string, unknown> & { id: string },
    kind: RequestKind,
    settle: Pick<Pending, "resolve" | "reject">,
  ): string | null {
    const id = msg.id;
    const timer = setTimeout(() => this.timedOut(id), REQUEST_TIMEOUT_MS);
    this.pending.set(id, { kind, timer, ...settle });
    if (!this.post(msg)) {
      clearTimeout(timer);
      this.pending.delete(id);
      return null;
    }
    return id;
  }

  private timedOut(id: string): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    this.log.warn({ event: "channel_request_timeout", kind: pending.kind });
    pending.reject?.(
      new Error("Zeo did not answer", {
        cause: { kind: pending.kind, timeout_ms: REQUEST_TIMEOUT_MS },
      }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Incoming messages

  private receive(raw: unknown): void {
    const probe = probeServer(raw);
    const handshaking = this.current !== "ready";
    if (
      handshaking &&
      probe !== null &&
      (probe.v !== PROTOCOL_VERSION ||
        (probe.kind === "welcome" && probe.protocol !== PROTOCOL_VERSION))
    ) {
      this.versionMismatch(probe.v === PROTOCOL_VERSION ? probe.protocol : probe.v, raw);
      return;
    }
    const parsed = parseServer(raw);
    if (!parsed.ok || !("kind" in parsed.value)) {
      // A v1 reply outside the handshake is as meaningless here as a malformed message.
      this.log.warn({ event: "channel_invalid", kind: loggableKind(probe?.kind) });
      return;
    }
    const msg = parsed.value;
    switch (msg.kind) {
      case "welcome":
        this.welcomed();
        return;
      case "approval_pending":
        this.setState("approval_pending");
        return;
      case "bridge_unavailable":
      case "bridge_closed":
        this.end({ state: "unreachable", retry: true });
        return;
      case "error":
        if (msg.fatal) {
          this.settle(msg);
          this.end(this.fatalEnding(msg.error, msg.message));
          return;
        }
        break;
    }
    if ("id" in msg && typeof msg.id === "string") {
      this.settle(msg);
      return;
    }
    this.emitEvent(msg as ServerEvent);
  }

  /** Resolves the request `msg` answers; a reply nobody waits for is dropped. */
  private settle(msg: ServerMsgOf): void {
    const id = "id" in msg ? msg.id : undefined;
    const pending = id === undefined ? undefined : this.pending.get(id);
    if (id === undefined || pending === undefined) {
      if (id !== undefined) {
        this.log.info({ event: "channel_unmatched_reply", kind: msg.kind });
      }
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (this.ownSubscribe?.id === id) {
      this.ownSubscribe = null;
    }
    if (pending.resolve) {
      pending.resolve(msg);
    } else {
      // The channel's own re-subscribe: its snapshot refreshes the view (R8.5).
      this.emitEvent(msg as ServerEvent);
    }
  }

  private welcomed(): void {
    if (this.current === "ready") {
      return;
    }
    this.attempt = 0;
    this.subscribedThisSession = false;
    const generation = this.generation;
    // The listeners run first, so a view that subscribes on `ready` makes the channel's own
    // re-subscribe unnecessary.
    this.setState("ready");
    if (
      this.closed ||
      generation !== this.generation ||
      this.subscribedThisSession ||
      this.target === null
    ) {
      return;
    }
    const target = { ...this.target };
    const id = this.send(
      { v: PROTOCOL_VERSION, kind: "subscribe", target, id: crypto.randomUUID() },
      "subscribe",
      {},
    );
    if (id !== null) {
      this.subscribedThisSession = true;
      this.ownSubscribe = { id, target };
    }
  }

  private versionMismatch(zeoProtocol: number | null, raw: unknown): void {
    this.end({ state: "version_mismatch", retry: false, detail: this.versions(zeoProtocol, raw) });
  }

  /** Both sides' versions; Zeo's are `null` where its message does not say. */
  private versions(zeoProtocol: number | null, raw: unknown): StateDetail {
    return {
      versions: {
        extension: { protocol: PROTOCOL_VERSION, version: this.client.extension_version },
        zeo: { protocol: zeoProtocol, version: zeoVersion(raw) },
      },
    };
  }

  /** How a fatal `error` from Zeo or the host ends the session. */
  private fatalEnding(error: ChannelError, message: string): Ending {
    if (error === "unsupported_version") {
      return {
        state: "version_mismatch",
        retry: false,
        detail: { error, message, ...this.versions(null, null) },
      };
    }
    return fatalEnding(error, message);
  }

  // -------------------------------------------------------------------------------------------
  // Endings and retries

  /** The port went away by itself: the host is missing, or Zeo is unreachable. */
  private disconnected(browserError: string | undefined): void {
    const noHost =
      browserError !== undefined && NO_HOST_ERRORS.some((e) => browserError.includes(e));
    this.log.info({
      event: "channel_disconnected",
      reason: noHost ? "no_host" : browserError === undefined ? "closed" : "error",
    });
    this.end(noHost ? { state: "no_host", retry: false } : { state: "unreachable", retry: true });
  }

  /** Ends the current session, reports `ending`, and schedules the next attempt if any. */
  private end(ending: Ending): void {
    this.teardown(new Error("Zeo disconnected", { cause: { state: ending.state } }));
    const generation = this.generation;
    this.setState(ending.state, ending.detail);
    // A listener that called close() or connect() has already decided what comes next.
    if (ending.retry && !this.closed && generation === this.generation) {
      this.scheduleRetry();
    }
  }

  /** Disconnects the current port, if any, and makes its late callbacks stale. */
  private releasePort(): void {
    this.generation++;
    const port = this.port;
    this.port = null;
    if (port !== null) {
      try {
        port.disconnect();
      } catch {
        // Already disconnected: nothing left to release.
      }
    }
  }

  /** Drops the port (ignoring its late callbacks) and fails every pending request. */
  private teardown(reason: Error): void {
    this.releasePort();
    this.ownSubscribe = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject?.(reason);
    }
    this.pending.clear();
  }

  private scheduleRetry(): void {
    this.cancelRetry();
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      // The state stays as it is (unreachable, busy) until Zeo answers, so the banner does not
      // flicker to "connecting" on every attempt.
      this.open();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Listeners

  private setState(state: ConnState, detail?: StateDetail): void {
    if (state !== this.current) {
      this.log.info({ event: "channel_state", state, error: detail?.error });
    }
    this.current = state;
    const seq = ++this.stateSeq;
    for (const f of this.stateListeners) {
      // A listener that moved the channel to another state (connect() inside a callback) has
      // already told every listener the newer one; telling the rest this older one would leave
      // them behind.
      if (seq !== this.stateSeq) {
        return;
      }
      try {
        if (detail === undefined) {
          f(state);
        } else {
          f(state, detail);
        }
      } catch (err) {
        this.log.warn({
          event: "channel_listener_failed",
          on: "state",
          error: err instanceof Error ? err.name : typeof err,
        });
      }
    }
  }

  private emitEvent(event: ServerEvent): void {
    for (const f of this.eventListeners) {
      try {
        f(event);
      } catch (err) {
        this.log.warn({
          event: "channel_listener_failed",
          on: "event",
          error: err instanceof Error ? err.name : typeof err,
        });
      }
    }
  }
}
