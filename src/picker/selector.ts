// A CSS selector that matches only the picked element at pick time (story 045, design.md §A5;
// R9.6). Candidates, in order: `#id`, `[data-testid="…"]`, then a path of `tag` /
// `tag:nth-of-type(n)` steps — the shortest unique tail of it, or the path from the nearest
// unique ancestor, or, when those pass `MAX_SELECTOR_CHARS`, descendant combinators from a unique
// ancestor. Every candidate is built with `CSS.escape`, and nothing is returned unless it matches
// exactly one element — the picked one — in the element's own root and fits the cap.
//
// The root is the element's document or, for an element inside a shadow tree, its shadow root:
// a selector built in a shadow root is scoped to that root and means nothing from the document.
import { MAX_SELECTOR_CHARS } from "../limits.js";

type Scope = Document | ShadowRoot;

/** Steps searched by the descendant fallback: past this many, no selector fits the cap anyway. */
const MAX_DESCENDANT_STEPS = 16;

/** The element's document or shadow root; null for a detached subtree, which has no selector. */
function scopeOf(el: Element): Scope | null {
  const root = el.getRootNode();
  if (root.nodeType === Node.DOCUMENT_NODE) {
    return root as Document;
  }
  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && "host" in root) {
    return root as ShadowRoot;
  }
  return null;
}

/**
 * True when `sel` is well-formed, fits the cap and matches `el` alone in `scope`. A selector the
 * engine cannot parse counts as not unique: some engines refuse escapes that `CSS.escape`
 * legitimately produces.
 */
function selectsOnly(scope: Scope, sel: string, el: Element): boolean {
  // `length` counts UTF-16 units, never fewer than code points, so this also bounds the
  // contract's code-point cap. A lone surrogate would make the contract refuse the selector.
  if (sel.length > MAX_SELECTOR_CHARS || !sel.isWellFormed()) {
    return false;
  }
  try {
    const hits = scope.querySelectorAll(sel);
    return hits.length === 1 && hits[0] === el;
  } catch {
    return false;
  }
}

/** `#id` and `[data-testid="…"]` for `el`, in that order, when it carries them. */
function attributeCandidates(el: Element): string[] {
  const candidates: string[] = [];
  if (el.id !== "") {
    candidates.push(`#${CSS.escape(el.id)}`);
  }
  const testId = el.getAttribute("data-testid");
  if (testId !== null) {
    candidates.push(`[data-testid="${CSS.escape(testId)}"]`);
  }
  return candidates;
}

const sameType = (a: Element, b: Element) =>
  a.localName === b.localName && a.namespaceURI === b.namespaceURI;

/** `tag` when `el` is the only one of its type among its siblings, else `tag:nth-of-type(n)`. */
function stepOf(el: Element): string {
  const tag = CSS.escape(el.localName);
  let n = 1;
  for (let sib = el.previousElementSibling; sib !== null; sib = sib.previousElementSibling) {
    if (sameType(sib, el)) {
      n += 1;
    }
  }
  let alone = n === 1;
  for (let sib = el.nextElementSibling; alone && sib !== null; sib = sib.nextElementSibling) {
    alone = !sameType(sib, el);
  }
  return alone ? tag : `${tag}:nth-of-type(${n})`;
}

/** The first candidate that selects `ancestor` alone: its id, its test id, or its bare tag. */
function anchorOf(scope: Scope, ancestor: Element): string | null {
  const candidates = [...attributeCandidates(ancestor), CSS.escape(ancestor.localName)];
  return candidates.find((sel) => selectsOnly(scope, sel, ancestor)) ?? null;
}

/**
 * Shortens the child chain `below` (the steps from just under `anchor` down to the element) by
 * keeping its first `i` and last `j` steps joined by a descendant combinator, fewest steps first.
 */
function descendantPath(scope: Scope, el: Element, anchor: string, below: string[]): string | null {
  const k = below.length;
  for (let total = 1; total < Math.min(k, MAX_DESCENDANT_STEPS); total += 1) {
    for (let i = 0; i < total; i += 1) {
      const head = [anchor, ...below.slice(0, i)].join(" > ");
      const sel = `${head} ${below.slice(k - (total - i)).join(" > ")}`;
      if (selectsOnly(scope, sel, el)) {
        return sel;
      }
    }
  }
  return null;
}

/**
 * Returns a selector matching only `el` within its own document or shadow root, at most
 * `MAX_SELECTOR_CHARS` long, or null when none exists (a detached element, or a tree where
 * nothing unique fits the cap). The caller skips a null element and says why.
 */
export function uniqueSelector(el: Element): string | null {
  const scope = scopeOf(el);
  if (scope === null) {
    return null;
  }
  for (const sel of attributeCandidates(el)) {
    if (selectsOnly(scope, sel, el)) {
      return sel;
    }
  }

  // `steps` runs top-down and ends with `el`'s own step; `anchors` remembers each unique
  // ancestor and how many of the steps lie below it, for the descendant fallback.
  const steps: string[] = [stepOf(el)];
  const anchors: Array<{ anchor: string; depth: number }> = [];
  for (let ancestor = el.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    const tail = steps.join(" > ");
    if (selectsOnly(scope, tail, el)) {
      return tail;
    }
    const anchor = anchorOf(scope, ancestor);
    if (anchor !== null) {
      const anchored = `${anchor} > ${tail}`;
      if (selectsOnly(scope, anchored, el)) {
        return anchored;
      }
      anchors.push({ anchor, depth: steps.length });
    }
    steps.unshift(stepOf(ancestor));
  }
  const whole = steps.join(" > ");
  if (selectsOnly(scope, whole, el)) {
    return whole;
  }
  for (const { anchor, depth } of anchors) {
    const found = descendantPath(scope, el, anchor, steps.slice(steps.length - depth));
    if (found !== null) {
      return found;
    }
  }
  return null;
}
