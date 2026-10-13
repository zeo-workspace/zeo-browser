// The picker's pending selection (story 045, design.md §A5; R9.2, R9.3). It mirrors the logic of
// zeo-devtools/src/client/selection.ts (story 033): pure, no DOM access, so it is unit-testable.
// Elements are compared by identity, so two twins with the same tag and text stay two, and the
// pending set keeps pick order, not DOM order.
import { MAX_ELEMENTS } from "../limits.js";

export type SelectionState = { mode: "off" } | { mode: "picking"; pending: Element[] };
export type ClickResult = { send: Element[] } | { pending: number } | { refused: "limit" };

export function createSelection() {
  let state: SelectionState = { mode: "off" };
  return {
    get state(): SelectionState {
      return state;
    },
    toggle(): void {
      state = state.mode === "off" ? { mode: "picking", pending: [] } : { mode: "off" };
    },
    escape(): void {
      state = { mode: "off" };
    },
    /**
     * A plain click sends one element (R9.2); Shift+click adds it to, or removes it from, the
     * pending set (R9.3). Past `MAX_ELEMENTS` a new element is refused and the set is kept.
     */
    click(el: Element, shift: boolean): ClickResult {
      if (state.mode === "off") {
        state = { mode: "picking", pending: [] };
      }
      if (!shift) {
        return { send: [el] };
      }
      const pending = state.pending;
      const at = pending.indexOf(el);
      if (at !== -1) {
        pending.splice(at, 1);
      } else if (pending.length >= MAX_ELEMENTS) {
        return { refused: "limit" };
      } else {
        pending.push(el);
      }
      return { pending: pending.length };
    },
    /** Takes the pending elements, leaving the picker on and the pending set empty. */
    take(): Element[] {
      if (state.mode === "off") {
        return [];
      }
      const taken = state.pending;
      state = { mode: "picking", pending: [] };
      return taken;
    },
  };
}
export type Selection = ReturnType<typeof createSelection>;
