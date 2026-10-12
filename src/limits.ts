// Every number of the v2 contract's limit table (story 045, design.md §Validation rules), in one
// place. Zeo's Rust validator and the host are held to the same numbers through the fixture files
// under test/contract/, so a limit changed here must change there too.
//
// "chars" are Unicode code points (what Rust counts as `char`), "bytes" are UTF-8 bytes.
// This module is imported by the sidebar, the picker and the background, so it uses no Node API.

/** The protocol version this extension speaks. */
export const PROTOCOL_VERSION = 2;

// Transport, enforced by the host (B4) and Zeo's bridge (B1).
/** Extension → host frame, in bytes (the host refuses a longer one with `bad_request`). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Zeo → host line, in bytes (the host answers `oversized_from_zeo` past it). */
export const MAX_ZEO_LINE_BYTES = 1_000_000;
/** One session line from the host to Zeo, in bytes (`too_large` past it). */
export const MAX_SESSION_LINE_BYTES = 8 * 1024 * 1024;
/** Browser sessions Zeo serves at once (`busy` past it). */
export const MAX_BROWSER_SESSIONS = 4;
/** Lines queued towards one browser session (`overloaded` past it). */
export const MAX_OUTGOING_QUEUE = 256;
/** Time Zeo waits for `hello` after accepting a connection, in ms. */
export const HELLO_DEADLINE_MS = 5_000;
/** Time Zeo waits for the user's approval, in ms (`approval_timeout` past it). */
export const APPROVAL_WAIT_MS = 120_000;

// Request identity.
/** A request `id`, in chars. */
export const MAX_ID_CHARS = 64;

// `send`, enforced by the sidebar (checkSend) and Zeo (B1).
/** `send.text`, in chars. */
export const MAX_TEXT_CHARS = 100_000;
/** Element attachments per `send`. */
export const MAX_ELEMENTS = 20;
/** Image attachments per `send`. */
export const MAX_IMAGES = 3;
/** Console captures per `send`. */
export const MAX_CONSOLE_CAPTURES = 1;
/** Network captures per `send`. */
export const MAX_NETWORK_CAPTURES = 1;
/** Entries in one console or network capture. */
export const MAX_CAPTURE_ENTRIES = 200;
/** A console entry's `text`, in bytes. */
export const MAX_CONSOLE_TEXT_BYTES = 2048;
/** A network entry's `url`, in bytes. */
export const MAX_NETWORK_URL_BYTES = 2048;
/** An attachment's `page_url`, in bytes (and `http:`, `https:` or `file:` only). */
export const MAX_PAGE_URL_BYTES = 2048;
/** `element.html`, in bytes. */
export const MAX_HTML_BYTES = 16_384;
/** `element.selector`, in chars. */
export const MAX_SELECTOR_CHARS = 512;
/** `element.dom` serialized as JSON, in bytes (033's cap). */
export const MAX_DOM_SUMMARY_BYTES = 4096;
/** An image's long edge, in pixels (R10.3). */
export const MAX_IMAGE_EDGE = 1568;
/** An image's decoded size, in bytes (R10.3). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** The whole `send` message serialized as JSON, in bytes (R7.11). */
export const MAX_SEND_BYTES = 8_000_000;

// What Zeo sends, enforced by Zeo (B2).
/** An entry's markdown, in bytes, before Zeo truncates it and sets `truncated: true`. */
export const MAX_ENTRY_MARKDOWN_BYTES = 64 * 1024;
/** Entries in a snapshot; `earlier` counts the rest. */
export const MAX_SNAPSHOT_ENTRIES = 100;
/** Threads in a `threads` reply. */
export const MAX_THREADS = 50;
/** Updates per second Zeo sends for one entry (coalesced past it). */
export const MAX_ENTRY_UPDATES_PER_SECOND = 10;

// The sidebar (A3).
/** Time a request waits for its reply, in ms ("Zeo did not answer" past it). */
export const REQUEST_TIMEOUT_MS = 15_000;
