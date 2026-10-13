// The picked element's outer HTML as sent to Zeo (story 045, design.md §A5; R9.6, R9.7): built
// from a deep copy with form state, user-typed text, script/style/noscript contents, event
// handlers and token-like attributes stripped, then capped at `MAX_HTML_BYTES` of UTF-8 on a
// character boundary. The live element is never modified.
//
// The copy lives in an inert document (no browsing context), so nothing in it fetches: copying
// inside the page makes Chromium re-request images and videos and Firefox re-request
// `<video preload>`, which would tell the page's server that a pick happened.
import { MAX_HTML_BYTES } from "../limits.js";
import { redactSrcset, redactUrlAttr } from "../redact.js";

export const TRUNCATION_MARKER = "<!-- truncated -->";

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Elements whose contents are code or styling, or what the user typed, never page text. */
const EMPTIED = new Set(["script", "style", "noscript", "textarea"]);
/** Attributes always dropped: form state, subresource and inline-script tokens, inline documents. */
const DROPPED_ATTRS = new Set(["value", "checked", "selected", "integrity", "nonce", "srcdoc"]);
/** `data-*` attribute names that usually carry a credential. */
const TOKEN_DATA_ATTR = /token|csrf|xsrf|secret|key|auth|session|nonce/i;
/** `<meta>` names (or `http-equiv`) whose `content` is a credential. */
const TOKEN_META = /csrf|token/i;
/** URL-valued attributes whose query values and fragment are redacted (`data` only on object). */
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "cite"]);
/** Attributes holding a comma-separated list of URL candidates with descriptors. */
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);

const encoder = new TextEncoder();

/** Text inside a rich-text editor is user input, like a form value (R9.7, decision N1). */
function isEditor(el: Element): boolean {
  const editable = el.getAttribute("contenteditable");
  const roles = (el.getAttribute("role") ?? "").toLowerCase().split(/\s+/);
  return (editable !== null && editable.toLowerCase() !== "false") || roles.includes("textbox");
}

function isTokenMeta(el: Element): boolean {
  if (el.localName !== "meta") {
    return false;
  }
  const name = el.getAttribute("name") ?? "";
  const httpEquiv = el.getAttribute("http-equiv") ?? "";
  return TOKEN_META.test(name) || TOKEN_META.test(httpEquiv);
}

function shouldDrop(name: string, tokenMeta: boolean): boolean {
  return (
    name.startsWith("on") ||
    DROPPED_ATTRS.has(name) ||
    name.startsWith("ng-reflect-") ||
    (name.startsWith("data-") && TOKEN_DATA_ATTR.test(name)) ||
    (tokenMeta && name === "content")
  );
}

/** Strips one copied element in place, then the content of a `<template>`, recursively. */
function sanitizeElement(el: Element): void {
  const tokenMeta = isTokenMeta(el);
  const emptied = EMPTIED.has(el.localName.toLowerCase()) || isEditor(el);
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (shouldDrop(name, tokenMeta)) {
      // removeAttributeNode, not removeAttribute: the latter lowercases its argument on HTML
      // elements, so a `setAttributeNS(null, "onClick")` attribute would survive it.
      el.removeAttributeNode(attr);
    } else if (URL_ATTRS.has(name) || (name === "data" && el.localName === "object")) {
      attr.value = redactUrlAttr(attr.value);
    } else if (SRCSET_ATTRS.has(name)) {
      attr.value = redactSrcset(attr.value);
    }
  }
  if (emptied) {
    el.replaceChildren();
  }
  if (el.localName === "template" && el.namespaceURI === HTML_NS) {
    // A template's content is a separate fragment that querySelectorAll never enters.
    sanitizeTree((el as HTMLTemplateElement).content);
  }
}

function sanitizeTree(root: Element | DocumentFragment): void {
  if (root.nodeType === Node.ELEMENT_NODE) {
    sanitizeElement(root as Element);
  }
  for (const el of Array.from(root.querySelectorAll("*"))) {
    sanitizeElement(el);
  }
}

/**
 * Serialises `el` as outer HTML. `getHTML()` on a detached wrapper gives the copy's own markup
 * with the HTML serialisation rules (XMLSerializer would add an `xmlns`), and is a read: the
 * markup never becomes live.
 */
function serialize(el: Element): string {
  const wrapper = el.ownerDocument.createElement("div");
  wrapper.append(el);
  return wrapper.getHTML();
}

/** The longest prefix of `html` that fits `max` UTF-8 bytes without splitting a character. */
function utf8Prefix(html: string, max: number): string {
  const bytes = encoder.encode(html);
  let end = max;
  // Back off continuation bytes (10xxxxxx) so the cut lands on the start of a character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** Caps `html` at `MAX_HTML_BYTES`, ending a cut one with `TRUNCATION_MARKER`. */
function cap(html: string): string {
  if (encoder.encode(html).length <= MAX_HTML_BYTES) {
    return html;
  }
  const room = MAX_HTML_BYTES - encoder.encode(TRUNCATION_MARKER).length;
  return utf8Prefix(html, room) + TRUNCATION_MARKER;
}

/** The sanitised outer HTML of `el`, well-formed UTF-16, at most `MAX_HTML_BYTES` UTF-8 bytes. */
export function sanitizedOuterHtml(el: Element): string {
  const inert = el.ownerDocument.implementation.createHTMLDocument("");
  const copy = inert.importNode(el, true);
  sanitizeTree(copy);
  // A lone surrogate (the DOM allows them) would make the contract refuse the attachment.
  return cap(serialize(copy).toWellFormed());
}
