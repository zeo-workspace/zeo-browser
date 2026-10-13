// The v2 wire contract between the extension, the native host and Zeo's devtools bridge (story
// 045, design.md §Data Models and §Validation rules). Zeo's Rust validator is held to the same
// fixture files under test/contract/, so a shape or limit changed here must change there too.
//
// Parse order is Zeo's: the version first (`unsupported_version` whatever else is wrong), then
// the kind (`unknown_kind`), and only then the shape, strictly (`bad_request`). Nothing here
// throws: every entry point answers in the contract's own terms.
//
// This module is imported by the sidebar, the picker and the background, so it uses no Node API.
import { z } from "zod";
import {
  MAX_CAPTURE_ENTRIES,
  MAX_CONSOLE_CAPTURES,
  MAX_CONSOLE_TEXT_BYTES,
  MAX_DOM_SUMMARY_BYTES,
  MAX_ELEMENTS,
  MAX_HTML_BYTES,
  MAX_ID_CHARS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_IMAGES,
  MAX_NETWORK_CAPTURES,
  MAX_NETWORK_URL_BYTES,
  MAX_PAGE_URL_BYTES,
  MAX_SELECTOR_CHARS,
  MAX_SEND_BYTES,
  MAX_SNAPSHOT_ENTRIES,
  MAX_TEXT_CHARS,
  MAX_THREADS,
  PROTOCOL_VERSION,
} from "./limits.js";
import { ATTR_ALLOWLIST, DOM_SUMMARY_MAX_BYTES, STYLE_KEYS } from "./contract-constants.js";

// No generated code: zod's JIT builds validators with `Function`, which the extension pages' CSP
// (MV3 forbids 'unsafe-eval') refuses — and even the probe is reported as a CSP violation. Set
// once here, where every bundle first loads zod.
z.config({ jitless: true });

// ---------------------------------------------------------------------------------------------
// Errors and results

export const CHANNEL_ERRORS = [
  "bad_request",
  "too_large",
  "unsupported_version",
  "unknown_kind",
  "busy",
  "overloaded",
  "not_approved",
  "approval_denied",
  "approval_timeout",
  "approval_unavailable",
  "no_thread",
  "thread_closed",
  "stale_permission",
  "ai_disabled",
  "send_failed",
  "oversized_from_zeo",
] as const;
export type ChannelError = (typeof CHANNEL_ERRORS)[number];

/** A verdict instead of a throw. `message` is English and never quotes the input's content. */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E; message: string };

// ---------------------------------------------------------------------------------------------
// String measures

const encoder = new TextEncoder();
const utf8Len = (s: string): number => encoder.encode(s).length;
const utf8Bytes = (value: unknown): number => utf8Len(JSON.stringify(value));

/** Unicode code points, the unit Rust counts as `char`; both sides must agree. */
function codePoints(s: string): number {
  // A surrogate pair is one code point; a lone surrogate counts as one, as string iteration does.
  let n = 0;
  for (let i = 0; i < s.length; i++, n++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      }
    }
  }
  return n;
}

/**
 * A string Zeo can decode: no lone UTF-16 surrogate. `JSON.stringify` writes one as a `\uD800`
 * escape, which serde_json refuses, so Zeo would answer the whole request `bad_request`.
 */
const text = () =>
  z.string().refine((s) => s.isWellFormed(), { message: "contains a lone UTF-16 surrogate" });

/** At most `max` code points. */
const maxChars = (max: number) =>
  text().refine((s) => codePoints(s) <= max, { message: `longer than ${max} characters` });

/** At most `max` UTF-8 bytes. */
const maxBytes = (max: number) =>
  text().refine((s) => utf8Len(s) <= max, { message: `longer than ${max} bytes` });

// ---------------------------------------------------------------------------------------------
// DomSummary — copied from zeo-devtools/src/contract.ts at commit b79353b (story 033), so an
// element picked here obeys the same caps 033's validator in Zeo already enforces. Keep the two in
// step: the attribute allowlist, the style keys and every cap below are 033's, not this story's.

// The zod-free constants live in contract-constants.ts so the picker bundle can do without zod.
export { ATTR_ALLOWLIST, DOM_SUMMARY_MAX_BYTES, STYLE_KEYS };

export const domSummary = z
  .strictObject({
    tag: text().min(1).max(64),
    id: text().max(128).nullable(),
    classes: z.array(text().max(128)).max(32),
    text: maxChars(500),
    attrs: z.record(z.string().regex(ATTR_ALLOWLIST), text().max(200)),
    styles: z.partialRecord(z.enum(STYLE_KEYS), text().max(200)),
    rect: z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  })
  .refine((dom) => utf8Bytes(dom) <= MAX_DOM_SUMMARY_BYTES, {
    message: `DOM summary is larger than ${MAX_DOM_SUMMARY_BYTES} bytes`,
  });
export type DomSummary = z.infer<typeof domSummary>;

// ---------------------------------------------------------------------------------------------
// Images: identity and dimensions read from the bytes themselves, with no image library.

type ImageMime = "image/png" | "image/jpeg";
type ImageHeader = { mime: ImageMime; w: number; h: number };

/** The base64 alphabet followed by at most two `=`: one character class, so no backtracking. */
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Canonical, padded standard base64 — what Rust's `base64::STANDARD` engine accepts: alphabet
 * characters, then at most two `=`, the whole a multiple of 4 long, and the unused bits of the
 * last character before the padding all zero (`btoa` always writes them so). The length and
 * character checks replace the grouped pattern `^(?:[A-Za-z0-9+/]{4})*(?:..==|...=)?$`, whose
 * per-group backtracking overflows the stack on a multi-megabyte image (V8 from about 4.47 M
 * chars, below the 4 MiB limit; Firefox reports "too much recursion").
 */
const isCanonicalBase64 = (s: string): boolean => {
  if (s.length % 4 !== 0 || !BASE64_CHARS.test(s)) {
    return false;
  }
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  if (pad === 0) {
    return true;
  }
  const last = B64_ALPHABET.indexOf(s.charAt(s.length - pad - 1));
  return last >= 0 && last % (pad === 2 ? 16 : 4) === 0;
};

/** Decoded length of canonical base64, computed without decoding it. */
const decodedLength = (b64: string): number =>
  (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

/**
 * Reads the format and pixel size from decoded image bytes (a binary string, one byte per char).
 * PNG: the signature, then the first chunk must be IHDR (width, height as u32 BE at 16 and 20).
 * JPEG: SOI, then walk the marker segments to the first SOFn (height, width as u16 BE at +5, +7).
 * Anything else, or a truncated header, is `null`.
 */
export function readImageHeader(bytes: string): ImageHeader | null {
  const at = (i: number): number => (i < bytes.length ? bytes.charCodeAt(i) : -1);
  const u16 = (i: number): number => (at(i) << 8) | at(i + 1);
  const u32 = (i: number): number => ((u16(i) << 16) | u16(i + 2)) >>> 0;

  if (bytes.length >= 24 && PNG_SIGNATURE.every((b, i) => at(i) === b)) {
    if (!IHDR.every((b, i) => at(12 + i) === b)) {
      return null;
    }
    return { mime: "image/png", w: u32(16), h: u32(20) };
  }

  if (at(0) !== 0xff || at(1) !== 0xd8) {
    return null;
  }
  let i = 2;
  while (i + 1 < bytes.length) {
    if (at(i) !== 0xff) {
      return null;
    }
    // Any number of 0xFF fill bytes may precede a marker.
    let marker = at(i + 1);
    while (marker === 0xff) {
      i++;
      marker = at(i + 1);
    }
    // Markers that stand alone, with no length: TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    // End of image or start of scan before any frame header: no dimensions to read.
    if (marker === 0xd9 || marker === 0xda || marker < 0) {
      return null;
    }
    if (i + 3 >= bytes.length) {
      return null;
    }
    const length = u16(i + 2);
    if (length < 2) {
      return null;
    }
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) {
      if (length < 7 || i + 8 >= bytes.length) {
        return null;
      }
      return { mime: "image/jpeg", h: u16(i + 5), w: u16(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/** Why an image attachment's bytes break the contract, or `null` when they do not. */
function imageProblem(img: { mime: ImageMime; data_b64: string; w: number; h: number }) {
  if (!isCanonicalBase64(img.data_b64)) {
    return "data_b64 is not canonical base64";
  }
  if (decodedLength(img.data_b64) > MAX_IMAGE_BYTES) {
    return `image is larger than ${MAX_IMAGE_BYTES} bytes decoded`;
  }
  const header = readImageHeader(atob(img.data_b64));
  if (header === null) {
    return "data_b64 is neither a PNG nor a JPEG";
  }
  if (header.mime !== img.mime) {
    return `the bytes are ${header.mime}, labelled ${img.mime}`;
  }
  if (header.w !== img.w || header.h !== img.h) {
    return "w and h do not match the image header";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Client messages (extension → Zeo)

const PAGE_URL_SCHEME = /^(?:https?|file):\/\//i;

const pageUrl = maxBytes(MAX_PAGE_URL_BYTES).refine((u) => PAGE_URL_SCHEME.test(u), {
  message: "page_url must be http:, https: or file:",
});

const requestId = maxChars(MAX_ID_CHARS);
const v2 = z.literal(PROTOCOL_VERSION);

const elementAttachment = z.strictObject({
  type: z.literal("element"),
  page_url: pageUrl,
  selector: maxChars(MAX_SELECTOR_CHARS),
  html: maxBytes(MAX_HTML_BYTES),
  dom: domSummary,
});

const imageAttachment = z
  .strictObject({
    type: z.literal("image"),
    mime: z.enum(["image/png", "image/jpeg"]),
    data_b64: z.string(),
    w: z.int().min(1).max(MAX_IMAGE_EDGE),
    h: z.int().min(1).max(MAX_IMAGE_EDGE),
  })
  .superRefine((img, ctx) => {
    const problem = imageProblem(img);
    if (problem !== null) {
      ctx.addIssue({ code: "custom", path: ["data_b64"], message: problem });
    }
  });

const consoleAttachment = z.strictObject({
  type: z.literal("console"),
  page_url: pageUrl,
  cut_short: z.boolean(),
  entries: z
    .array(
      z.strictObject({
        level: z.enum(["log", "info", "warn", "error", "debug", "exception"]),
        text: maxBytes(MAX_CONSOLE_TEXT_BYTES),
        source: text().nullable(),
        ts: z.number(),
      }),
    )
    .max(MAX_CAPTURE_ENTRIES),
});

const networkAttachment = z.strictObject({
  type: z.literal("network"),
  page_url: pageUrl,
  cut_short: z.boolean(),
  entries: z
    .array(
      z.strictObject({
        method: text(),
        url: maxBytes(MAX_NETWORK_URL_BYTES),
        status: z.int().min(100).max(599).nullable(),
        resource_type: text(),
        ms: z.number().nullable(),
        failed: text().nullable(),
      }),
    )
    .max(MAX_CAPTURE_ENTRIES),
});

export const attachment = z.discriminatedUnion("type", [
  elementAttachment,
  imageAttachment,
  consoleAttachment,
  networkAttachment,
]);
export type Attachment = z.infer<typeof attachment>;
export type AttachmentType = Attachment["type"];

/** Per-type caps of one `send`, in the order checkSend reports them. */
const COUNT_LIMITS = [
  { type: "element", max: MAX_ELEMENTS, limit: "elements" },
  { type: "image", max: MAX_IMAGES, limit: "images" },
  { type: "console", max: MAX_CONSOLE_CAPTURES, limit: "console_captures" },
  { type: "network", max: MAX_NETWORK_CAPTURES, limit: "network_captures" },
] as const;

/** The first per-type cap `attachments` breaks, or `null`. */
function brokenCount(attachments: ReadonlyArray<{ readonly type: string }>) {
  for (const cap of COUNT_LIMITS) {
    // `?.` because checkSend is handed sidebar state, not parsed input: a null slot counts as
    // nothing instead of throwing.
    if (attachments.filter((a) => a?.type === cap.type).length > cap.max) {
      return cap;
    }
  }
  return null;
}

const attachments = z.array(attachment).superRefine((list, ctx) => {
  const cap = brokenCount(list);
  if (cap !== null) {
    ctx.addIssue({ code: "custom", message: `more than ${cap.max} ${cap.type} attachments` });
  }
});

const clientSchemas = {
  hello: z.strictObject({
    v: v2,
    kind: z.literal("hello"),
    id: requestId.optional(),
    client: z.strictObject({
      browser: z.enum(["chrome", "chromium", "firefox", "unknown"]),
      extension_id: text(),
      extension_version: text(),
    }),
  }),
  list_threads: z.strictObject({ v: v2, kind: z.literal("list_threads"), id: requestId }),
  subscribe: z.strictObject({
    v: v2,
    kind: z.literal("subscribe"),
    id: requestId,
    target: z.union([
      z.strictObject({ follow: z.literal(true) }),
      z.strictObject({ thread_id: text() }),
    ]),
  }),
  send: z.strictObject({
    v: v2,
    kind: z.literal("send"),
    id: requestId,
    text: maxChars(MAX_TEXT_CHARS),
    attachments,
  }),
  cancel: z.strictObject({ v: v2, kind: z.literal("cancel"), id: requestId }),
  authorize: z.strictObject({
    v: v2,
    kind: z.literal("authorize"),
    id: requestId,
    request_id: text(),
    option_id: text(),
  }),
  open_in_zeo: z.strictObject({ v: v2, kind: z.literal("open_in_zeo"), id: requestId }),
};

export const clientMsg = z.discriminatedUnion("kind", [
  clientSchemas.hello,
  clientSchemas.list_threads,
  clientSchemas.subscribe,
  clientSchemas.send,
  clientSchemas.cancel,
  clientSchemas.authorize,
  clientSchemas.open_in_zeo,
]);
export type ClientKind = keyof typeof clientSchemas;
export const CLIENT_KINDS = Object.keys(clientSchemas) as ClientKind[];
/** One client message; `ClientMsg<"send">` narrows it to a kind. */
export type ClientMsg<K extends ClientKind = ClientKind> = Extract<
  z.infer<typeof clientMsg>,
  { kind: K }
>;

// ---------------------------------------------------------------------------------------------
// Server messages (Zeo or the host → extension)

const STATES = ["idle", "working", "awaiting_permission", "error"] as const;

const status = z.strictObject({ state: z.enum(STATES), message: z.string().nullable() });
export type Status = z.infer<typeof status>;

const threadInfo = z.strictObject({
  thread_id: z.string(),
  title: z.string(),
  project: z.string(),
  agent: z.string(),
  status: z.enum(STATES),
  followed: z.boolean(),
});
export type ThreadInfo = z.infer<typeof threadInfo>;

// `markdown` is not capped here: Zeo truncates past MAX_ENTRY_MARKDOWN_BYTES and appends its
// truncation note, so the final string may exceed the cap, and dropping a whole entry for that
// would hide more than it protects. The host's 1 000 000-byte line cap bounds it anyway.
const entry = z.strictObject({
  role: z.enum(["user", "assistant", "tool", "question", "compaction"]),
  markdown: z.string(),
  truncated: z.boolean(),
  tool: z
    .strictObject({
      title: z.string(),
      status: z.enum([
        "pending",
        "in_progress",
        "completed",
        "failed",
        "canceled",
        "awaiting_permission",
      ]),
    })
    .optional(),
});
export type Entry = z.infer<typeof entry>;

const permission = z.strictObject({
  request_id: z.string(),
  entry_index: z.int().min(0),
  title: z.string(),
  options: z.array(
    z.strictObject({
      option_id: z.string(),
      label: z.string(),
      kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
    }),
  ),
});
export type Permission = z.infer<typeof permission>;

const index = z.int().min(0);

const serverSchemas = {
  welcome: z.strictObject({
    v: v2,
    kind: z.literal("welcome"),
    id: requestId.optional(),
    // 2 today; any other number is a valid shape that the channel reads as a version mismatch.
    protocol: z.int(),
    zeo_version: z.string(),
  }),
  threads: z.strictObject({
    v: v2,
    kind: z.literal("threads"),
    id: requestId,
    items: z.array(threadInfo).max(MAX_THREADS),
  }),
  snapshot: z.strictObject({
    v: v2,
    kind: z.literal("snapshot"),
    id: requestId.optional(),
    thread: threadInfo.nullable(),
    earlier: index,
    entries: z.array(entry).max(MAX_SNAPSHOT_ENTRIES),
    status,
    permissions: z.array(permission),
  }),
  target_changed: z.strictObject({
    v: v2,
    kind: z.literal("target_changed"),
    thread: threadInfo.nullable(),
  }),
  entry_added: z.strictObject({ v: v2, kind: z.literal("entry_added"), index, entry }),
  entry_updated: z.strictObject({ v: v2, kind: z.literal("entry_updated"), index, entry }),
  entries_removed: z.strictObject({
    v: v2,
    kind: z.literal("entries_removed"),
    start: index,
    end: index,
  }),
  status: z.strictObject({ v: v2, kind: z.literal("status"), status }),
  title: z.strictObject({ v: v2, kind: z.literal("title"), title: z.string() }),
  permission_requested: z.strictObject({
    v: v2,
    kind: z.literal("permission_requested"),
    permission,
  }),
  permission_resolved: z.strictObject({
    v: v2,
    kind: z.literal("permission_resolved"),
    request_id: z.string(),
  }),
  thread_closed: z.strictObject({ v: v2, kind: z.literal("thread_closed") }),
  sent: z.strictObject({
    v: v2,
    kind: z.literal("sent"),
    id: requestId,
    queued: z.boolean(),
    images: z.enum(["included", "skipped_unsupported", "none"]),
  }),
  ok: z.strictObject({ v: v2, kind: z.literal("ok"), id: requestId }),
  approval_pending: z.strictObject({ v: v2, kind: z.literal("approval_pending") }),
  error: z.strictObject({
    v: v2,
    kind: z.literal("error"),
    id: requestId.optional(),
    error: z.enum(CHANNEL_ERRORS),
    message: z.string(),
    fatal: z.boolean(),
  }),
  bridge_unavailable: z.strictObject({
    v: v2,
    kind: z.literal("bridge_unavailable"),
    reason: z.enum(["absent", "refused", "no_runtime_dir", "permission"]),
  }),
  bridge_closed: z.strictObject({ v: v2, kind: z.literal("bridge_closed") }),
};

/**
 * What a Zeo whose bridge speaks only version 1 (0052) answers to a v2 `hello`. It has no `kind`;
 * it is accepted as its own variant so the channel can say "versions do not match" instead of
 * dropping it, and it is the only v1 shape accepted.
 */
export const v1HelloReply = z.strictObject({
  v: z.literal(1),
  ok: z.literal(false),
  error: z.literal("unsupported_version"),
  message: z.string(),
});
export type V1HelloReply = z.infer<typeof v1HelloReply>;

const v2ServerMsg = z.discriminatedUnion("kind", [
  serverSchemas.welcome,
  serverSchemas.threads,
  serverSchemas.snapshot,
  serverSchemas.target_changed,
  serverSchemas.entry_added,
  serverSchemas.entry_updated,
  serverSchemas.entries_removed,
  serverSchemas.status,
  serverSchemas.title,
  serverSchemas.permission_requested,
  serverSchemas.permission_resolved,
  serverSchemas.thread_closed,
  serverSchemas.sent,
  serverSchemas.ok,
  serverSchemas.approval_pending,
  serverSchemas.error,
  serverSchemas.bridge_unavailable,
  serverSchemas.bridge_closed,
]);
export const serverMsg = z.union([v2ServerMsg, v1HelloReply]);
export type ServerKind = keyof typeof serverSchemas;
export const SERVER_KINDS = Object.keys(serverSchemas) as ServerKind[];
/** One v2 server message; `ServerMsgOf<"snapshot">` narrows it to a kind. */
export type ServerMsgOf<K extends ServerKind = ServerKind> = Extract<
  z.infer<typeof v2ServerMsg>,
  { kind: K }
>;
/** Everything parseServer accepts: every v2 kind, plus the v1 bridge's refusal of `hello`. */
export type ServerMsg = ServerMsgOf | V1HelloReply;

// ---------------------------------------------------------------------------------------------
// Parsing

type Fail = { ok: false; error: ChannelError; message: string };
const fail = (error: ChannelError, message: string): Fail => ({ ok: false, error, message });

/** A JSON string is decoded first; anything that is not then a plain object is `null`. */
function asObject(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function shapeFailure(error: z.ZodError): Fail {
  const first = error.issues[0];
  const where = first && first.path.length > 0 ? first.path.join(".") : "message";
  return fail("bad_request", `Invalid message at ${where}: ${first?.message ?? "malformed"}`);
}

/**
 * The shared version → kind → shape pipeline. `v` decides first, as in 0052's `VersionProbe`: a
 * missing `v` is a malformed message (`bad_request`), any present value other than 2 —
 * including a non-number — is `unsupported_version`. Then a `kind` that is not a string is
 * `bad_request` and an unknown string is `unknown_kind`. Only then the strict shape runs.
 */
function parseMessage<T>(
  raw: unknown,
  kinds: readonly string[],
  schema: z.ZodType<T>,
  otherVersion: (obj: Record<string, unknown>) => Result<T, ChannelError> | null,
): Result<T, ChannelError> {
  try {
    const obj = asObject(raw);
    if (obj === null) {
      return fail("bad_request", "A message must be a JSON object");
    }
    if (!Object.hasOwn(obj, "v")) {
      return fail("bad_request", "The message has no protocol version");
    }
    if (obj.v !== PROTOCOL_VERSION) {
      return (
        otherVersion(obj) ??
        fail(
          "unsupported_version",
          `Unsupported protocol version; this extension speaks version ${PROTOCOL_VERSION}`,
        )
      );
    }
    if (typeof obj.kind !== "string") {
      return fail("bad_request", "The message has no kind");
    }
    if (!kinds.includes(obj.kind)) {
      return fail("unknown_kind", "Unknown message kind");
    }
    const result = schema.safeParse(obj);
    return result.success ? { ok: true, value: result.data } : shapeFailure(result.error);
  } catch {
    // A hand-built object (a cycle, a BigInt) can make a refinement throw; JSON input cannot.
    return fail("bad_request", "The message cannot be validated");
  }
}

/** Validates a message the extension sends, in Zeo's order: version, kind, shape. */
export function parseClient(raw: unknown): Result<ClientMsg, ChannelError> {
  return parseMessage(raw, CLIENT_KINDS, clientMsg, () => null);
}

/**
 * Validates a message from Zeo or the host. The v1 bridge's refusal of `hello` is accepted as
 * `V1HelloReply`; every other non-v2 message is `unsupported_version`.
 */
export function parseServer(raw: unknown): Result<ServerMsg, ChannelError> {
  return parseMessage<ServerMsg>(raw, SERVER_KINDS, v2ServerMsg, (obj) => {
    const v1 = v1HelloReply.safeParse(obj);
    return v1.success ? { ok: true, value: v1.data } : null;
  });
}

/** What probeServer reads: each field `null` when absent or of the wrong type. */
export type ServerProbe = { v: number; kind: string | null; protocol: number | null };

/**
 * The lenient read the channel runs before the strict parse (design.md §A3): the version, the
 * kind and a `protocol` field. The answer is `null` only when the message is not an object (or a
 * JSON string of one) or carries no numeric `v`.
 *
 * - a v2 `welcome` speaking protocol 3 → `{ v: 2, kind: "welcome", protocol: 3 }`
 * - the v1 bridge's reply to `hello` → `{ v: 1, kind: null, protocol: null }`
 *
 * The channel maps `v !== 2`, or a `welcome` whose `protocol !== 2`, to `version_mismatch`.
 */
export function probeServer(raw: unknown): ServerProbe | null {
  const obj = asObject(raw);
  if (obj === null || typeof obj.v !== "number") {
    return null;
  }
  return {
    v: obj.v,
    kind: typeof obj.kind === "string" ? obj.kind : null,
    protocol: typeof obj.protocol === "number" ? obj.protocol : null,
  };
}

// ---------------------------------------------------------------------------------------------
// The sidebar's pre-send check (R7.11)

export type SendLimit =
  "text" | "elements" | "images" | "console_captures" | "network_captures" | "bytes";

/**
 * The UTF-8 size of the `send` message these parts make, with the longest `id` the contract
 * allows, so the figure is an upper bound for any real request. `Infinity` when the parts cannot
 * be serialised at all.
 */
export function sendBytes(
  text: string,
  attachments: ReadonlyArray<{ readonly type: string }>,
): number {
  try {
    const msg = {
      v: PROTOCOL_VERSION,
      kind: "send",
      id: "x".repeat(MAX_ID_CHARS),
      text,
      attachments,
    };
    return utf8Bytes(msg);
  } catch {
    return Infinity;
  }
}

/**
 * The first limit of R7.11 a message would break, by name, in the order text, elements, images,
 * captures (console, then network), bytes — so the sidebar can refuse it before sending and say
 * which. Per-attachment limits (html, selector, image header…) belong to the picker and capture
 * code that build the attachment, and to Zeo; parseClient checks those.
 */
export function checkSend(
  text: string,
  attachments: ReadonlyArray<{ readonly type: string }>,
): { ok: true } | { ok: false; limit: SendLimit } {
  if (typeof text !== "string" || codePoints(text) > MAX_TEXT_CHARS) {
    return { ok: false, limit: "text" };
  }
  // Not a list: nothing can be counted or measured, so it is refused as unmeasurable, like a
  // message sendBytes cannot serialise.
  if (!Array.isArray(attachments)) {
    return { ok: false, limit: "bytes" };
  }
  const cap = brokenCount(attachments);
  if (cap !== null) {
    return { ok: false, limit: cap.limit };
  }
  if (sendBytes(text, attachments) > MAX_SEND_BYTES) {
    return { ok: false, limit: "bytes" };
  }
  return { ok: true };
}
