// Story 045 (R9.17, R9.18, design.md §A5): what the picker removes from 033's DOM summary before
// it leaves the page. summary.ts is a byte copy of zeo-devtools and is never edited, so the
// redaction runs on its output instead.
import type { DomSummary } from "../contract.js";
import { DOM_SUMMARY_MAX_BYTES } from "../contract-constants.js";
import { redactUrlAttr } from "../redact.js";
import { isEditor } from "./html.js";
import { summarize } from "./summary.js";

/**
 * `summarize` reads the window only for computed styles; the text is all that is taken from the
 * second call, so a window that reports no styles is enough and keeps the copy off the page.
 */
const NO_STYLES_WINDOW = {
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
} as unknown as Window;

const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function hasEditorText(el: Element): boolean {
  return (
    isEditor(el) ||
    el.localName === "textarea" ||
    el.querySelector("[contenteditable], [role], textarea") !== null
  );
}

/**
 * The summary's text with every editor subtree emptied, the picked element included. The copy
 * lives in an inert document: cloning inside the live page would make the browser fetch its
 * images again.
 */
function textWithoutEditors(el: Element): string {
  const inert = document.implementation.createHTMLDocument("");
  const copy = inert.importNode(el, true);
  for (const node of [copy, ...Array.from(copy.querySelectorAll("*"))]) {
    if (isEditor(node) || node.localName === "textarea") {
      node.replaceChildren();
    }
  }
  return summarize(copy, NO_STYLES_WINDOW).text;
}

/** summary.ts's own order of sacrifice: text first, then classes, styles and attributes. */
function fitToCap(summary: DomSummary): DomSummary {
  if (utf8Bytes(summary) > DOM_SUMMARY_MAX_BYTES && summary.text !== "") {
    const chars = [...summary.text];
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      summary.text = chars.slice(0, mid).join("");
      if (utf8Bytes(summary) <= DOM_SUMMARY_MAX_BYTES) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    summary.text = chars.slice(0, lo).join("");
  }
  while (utf8Bytes(summary) > DOM_SUMMARY_MAX_BYTES && summary.classes.length > 0) {
    summary.classes.pop();
  }
  const styleKeys = Object.keys(summary.styles) as Array<keyof DomSummary["styles"]>;
  while (utf8Bytes(summary) > DOM_SUMMARY_MAX_BYTES && styleKeys.length > 0) {
    delete summary.styles[styleKeys.pop()!];
  }
  const attrKeys = Object.keys(summary.attrs);
  while (utf8Bytes(summary) > DOM_SUMMARY_MAX_BYTES && attrKeys.length > 0) {
    delete summary.attrs[attrKeys.pop()!];
  }
  return summary;
}

/**
 * `summary` (summarize's output for `el`) without editor text (R9.17) and with `href` redacted
 * as the outer HTML's URL attributes are (R9.18). Returns `summary` itself when there is nothing
 * to remove; the page is never edited.
 */
export function redactSummary(el: Element, summary: DomSummary): DomSummary {
  const editor = hasEditorText(el);
  const href = summary.attrs.href;
  if (!editor && href === undefined) {
    return summary;
  }
  const out: DomSummary = {
    ...summary,
    classes: [...summary.classes],
    attrs: { ...summary.attrs },
    styles: { ...summary.styles },
  };
  if (editor) {
    out.text = textWithoutEditors(el);
  }
  if (href !== undefined) {
    out.attrs.href = redactUrlAttr(href);
  }
  return fitToCap(out);
}
