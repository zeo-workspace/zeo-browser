// The zod-free part of the DOM summary contract (story 045, design.md §A5): the values
// `src/picker/summary.ts` imports (its `DomSummary` is a type, erased from the bundle). contract.ts re-exports them, so every other module keeps importing
// them from there. They live here because the picker bundle must not carry zod: scripts/build.mjs
// resolves summary.ts's `../contract.js` to this file for the picker entry only, which leaves
// summary.ts a byte-for-byte copy of zeo-devtools' file.
//
// Copied from zeo-devtools/src/contract.ts at commit b79353b (story 033), so an element picked here
// obeys the same caps 033's validator in Zeo already enforces. Keep the two in step.
import { MAX_DOM_SUMMARY_BYTES } from "./limits.js";

/**
 * 033's name for `MAX_DOM_SUMMARY_BYTES`, kept so `src/picker/summary.ts` stays a byte-for-byte
 * copy of `zeo-devtools/src/client/summary.ts`, which imports it under this name.
 */
export const DOM_SUMMARY_MAX_BYTES = MAX_DOM_SUMMARY_BYTES;

/** Attribute names a DOM summary may carry: `role`, `aria-*`, `href`, `type`, `name`, `alt`. */
export const ATTR_ALLOWLIST = /^(role|aria-[a-z-]+|href|type|name|alt)$/;

/** The computed styles a DOM summary may carry, in the order the picker reads them. */
export const STYLE_KEYS = [
  "display",
  "position",
  "box-sizing",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "border-radius",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
  "gap",
  "flex-direction",
  "justify-content",
  "align-items",
  "grid-template-columns",
  "opacity",
  "z-index",
  "overflow",
] as const;
