// The key the user has bound to `start-picker`, for the sentences that tell them to press it
// (story 045, design.md §A5 v5; R9.10, R10.8).
//
// It is read with `commands.getAll()` each time a sentence is shown, never cached: the user can
// rebind or clear the key in the browser's shortcut settings while the sidebar stays open. A
// command with no shortcut (Chrome reports "" when unbound; Firefox may omit the field), a
// missing `start-picker`, a missing commands API, or a failed read all mean "unbound", which the
// sentences word as `PICK_SHORTCUT_UNBOUND`. Another command's key is never borrowed.
//
// Callers must not await this before a `permissions.request` that needs the click's user
// gesture (R9.13): it is read only on paths that request nothing.
import { PICK_SHORTCUT_UNBOUND } from "./text.js";

/** The command whose key the sentences name (manifest.base.json). */
export const PICK_COMMAND = "start-picker";

/** The slice of `commands` the sidebar uses (`api.commands` from `src/platform.ts`). */
export interface CommandsApi {
  getAll(): Promise<Array<{ name?: string; shortcut?: string }>>;
}

/**
 * The key bound to `start-picker`, or `PICK_SHORTCUT_UNBOUND`. Never rejects: a failed read is
 * logged and words the sentence as unbound.
 */
export async function pickShortcut(
  commands: CommandsApi | undefined,
  log?: Pick<Console, "warn">,
): Promise<string> {
  if (commands === undefined) {
    return PICK_SHORTCUT_UNBOUND;
  }
  try {
    const all = await commands.getAll();
    const key = all.find((c) => c.name === PICK_COMMAND)?.shortcut?.trim();
    return key ? key : PICK_SHORTCUT_UNBOUND;
  } catch (err) {
    log?.warn({
      event: "sidebar_commands_read_failed",
      error: err instanceof Error ? err.name : typeof err,
    });
    return PICK_SHORTCUT_UNBOUND;
  }
}
