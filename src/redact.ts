// URL redaction shared by the recorder and the picker (story 045, design.md §A7, §A5; R11.8,
// R9.7): the fragment is dropped and every query value becomes `…`, keeping each parameter's
// name (repeated names too) and the path.
//
// Credentials (`user:pass@`) are dropped everywhere.
//
// Entry points, because their inputs differ:
// - `redactUrl` takes an absolute URL from a CDP event and returns the parsed, normalised form;
//   an unparseable one becomes `<unparseable url>`.
// - `redactUrlAttr` takes an attribute value as written in a page (`href="/buy?x=1"`) and keeps
//   its relative or absolute form and its surrounding whitespace; schemes with no query semantics
//   (`javascript:`, `mailto:`, `data:`…) stay as they are.
// - `redactUrlsInText` redacts every URL-shaped substring of free text (console messages, stack
//   traces), keeping a stack frame's trailing `:line:col`.
// - `pageUrlOf` / `capPageUrl` build an attachment's `page_url`: scheme, host and path only (story
//   033's rule), capped at 2 KiB without cutting a `%XX` escape.
//
// This module imports only the zod-free limits: picker.js bundles it and must stay small.
import { MAX_PAGE_URL_BYTES } from "./limits.js";

export const UNPARSEABLE_URL = "<unparseable url>";

/** The value every query parameter gets. */
const REDACTED = "…";

/** Schemes whose query and fragment are redacted in a page attribute. */
const ATTR_REDACTED_SCHEMES = new Set(["http:", "https:", "file:", "ws:", "wss:", "ftp:"]);
/** Base for parsing relative attribute values; only the scheme of the result is read. */
const RELATIVE_BASE = "https://relative.invalid/";
/** `scheme://user:pass@` or `//user:pass@` at the start of an attribute value. */
const ATTR_USERINFO = /^((?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/)[^/?#\\]*@/;
/** A URL inside free text: up to whitespace, a quote, a bracket or a backtick. */
const URL_IN_TEXT = /\b(?:https?|wss?|ftp|file):\/\/[^\s'"<>()`]+/g;
/** A stack frame's `:line` or `:line:col` at the end of a URL. */
const LINE_COL = /(?::\d+){1,2}$/;

const encoder = new TextEncoder();

/**
 * `url` without its fragment, with every query value replaced by `…`. Names are kept as written;
 * a parameter written without `=` (`?abc123`) is often the token itself, so it becomes `…` whole.
 */
function redactQuery(url: string): string {
  const withoutFragment = url.split("#", 1)[0] ?? "";
  const q = withoutFragment.indexOf("?");
  if (q === -1) {
    return withoutFragment;
  }
  const query = withoutFragment
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      if (pair === "") {
        return pair;
      }
      const eq = pair.indexOf("=");
      return eq === -1 ? REDACTED : `${pair.slice(0, eq)}=${REDACTED}`;
    })
    .join("&");
  return `${withoutFragment.slice(0, q)}?${query}`;
}

/**
 * An absolute URL with its fragment dropped and every query value replaced by `…` (R11.8). A
 * `data:` URL carries its content in the URL itself, so only its scheme is kept.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return UNPARSEABLE_URL;
  }
  if (parsed.protocol === "data:") {
    return `data:${REDACTED}`;
  }
  parsed.username = "";
  parsed.password = "";
  return redactQuery(parsed.href);
}

/**
 * A URL-valued page attribute, redacted like `redactUrl` but keeping the relative or absolute
 * form as written. Unparseable values become `<unparseable url>`.
 */
export function redactUrlAttr(value: string): string {
  const core = value.trim();
  if (core === "") {
    return value;
  }
  const lead = value.slice(0, value.indexOf(core));
  const trail = value.slice(lead.length + core.length);
  let parsed: URL;
  try {
    parsed = new URL(core, RELATIVE_BASE);
  } catch {
    return UNPARSEABLE_URL;
  }
  if (!ATTR_REDACTED_SCHEMES.has(parsed.protocol)) {
    return value;
  }
  let url = core.replace(ATTR_USERINFO, "$1");
  if (url === core) {
    // Credentials in a form the pattern does not cover: `https:u:p@h` (credentials on a page of
    // another scheme) or a backslash authority. Either parse finding them means the value carries
    // them (the base has none), so fall back to that parse's normalised form without them.
    let absolute: URL | null = null;
    try {
      absolute = new URL(core);
    } catch {
      // Relative: only the parse against the base applies.
    }
    const withCredentials = [absolute, parsed].find(
      (u) => u !== null && (u.username !== "" || u.password !== ""),
    );
    if (withCredentials) {
      withCredentials.username = "";
      withCredentials.password = "";
      url = withCredentials.href;
    }
  }
  return `${lead}${redactQuery(url)}${trail}`;
}

/**
 * `text` with every URL-shaped substring redacted by `redactUrl`, keeping a stack frame's
 * trailing `:line:col` (`at https://x/app.js?token=S:12:28` → `at https://x/app.js?token=…:12:28`).
 */
export function redactUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    const suffix = match.match(LINE_COL)?.[0] ?? "";
    return redactUrl(match.slice(0, match.length - suffix.length)) + suffix;
  });
}

/**
 * Cuts `url` to `MAX_PAGE_URL_BYTES` UTF-8 bytes on a character boundary, and never inside a
 * `%XX` escape: a dangling `%` or `%X` would make the URL unparseable.
 */
export function capPageUrl(url: string): string {
  if (encoder.encode(url).length <= MAX_PAGE_URL_BYTES) {
    return url;
  }
  let out = "";
  let bytes = 0;
  for (const ch of url) {
    bytes += encoder.encode(ch).length;
    if (bytes > MAX_PAGE_URL_BYTES) {
      break;
    }
    out += ch;
  }
  const pct = out.lastIndexOf("%");
  return pct !== -1 && pct > out.length - 3 ? out.slice(0, pct) : out;
}

/**
 * A page's URL for `page_url`: scheme, host and path, without credentials, query or fragment
 * (they often carry tokens: OAuth's `#access_token=`, a magic link's `?token=`), capped by
 * `capPageUrl`. `origin` is not used: it is "null" for `file:` pages.
 */
export function pageUrlOf(loc: { protocol: string; host: string; pathname: string }): string {
  return capPageUrl(`${loc.protocol}//${loc.host}${loc.pathname}`);
}

/**
 * A `srcset` list with each candidate's URL redacted and its descriptor (`2x`, `640w`) kept. It
 * follows the shape of the HTML parsing algorithm: separators are whitespace and commas, a URL
 * runs to the next whitespace (trailing commas end the candidate), and a descriptor runs to the
 * next comma outside parentheses. So `a.jpg 1x,b.jpg?t=S 2x` redacts both URLs.
 */
export function redactSrcset(value: string): string {
  let out = "";
  let i = 0;
  const n = value.length;
  const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
  while (i < n) {
    let j = i;
    while (j < n && (isSpace(value[j]) || value[j] === ",")) {
      j++;
    }
    out += value.slice(i, j);
    i = j;
    if (i >= n) {
      break;
    }
    while (j < n && !isSpace(value[j])) {
      j++;
    }
    const token = value.slice(i, j);
    const url = token.replace(/,+$/, "");
    out += redactUrlAttr(url) + token.slice(url.length);
    i = j;
    if (url.length < token.length) {
      continue;
    }
    let depth = 0;
    while (j < n && !(value[j] === "," && depth === 0)) {
      if (value[j] === "(") {
        depth++;
      } else if (value[j] === ")") {
        depth = Math.max(0, depth - 1);
      }
      j++;
    }
    out += value.slice(i, j);
    i = j;
  }
  return out;
}

/** `s` cut to at most `max` UTF-8 bytes on a character boundary (never half a code point). */
export function truncateUtf8(s: string, max: number): string {
  if (encoder.encode(s).length <= max) {
    return s;
  }
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const size = encoder.encode(ch).length;
    if (bytes + size > max) {
      break;
    }
    bytes += size;
    end += ch.length;
  }
  return s.slice(0, end);
}
