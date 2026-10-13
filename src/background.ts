// The background (story 045, design.md §A2): gesture-bound actions and the debugger janitor.
//
// Each concern lives in its own module and is installed here, at import, so the browser finds
// every listener registered on the worker's first turn:
// - the debugger janitor (Chrome only, Task 4.4): `background/janitor.ts`;
// - opening the sidebar and starting the picker (Task 4.5): `background/sidebar.ts`.
//
// The janitor is installed behind `__HAS_DEBUGGER__` itself, not only `HAS_DEBUGGER`: esbuild folds
// the build constant, so the Firefox bundle drops the janitor module entirely (R11.9). Under
// vitest nothing defines the constant and `HAS_DEBUGGER` (mocked per test) decides.
import { installDebuggerJanitor } from "./background/janitor.js";
import { type SidebarApi, installSidebarActions } from "./background/sidebar.js";
import { BROWSER, HAS_DEBUGGER, api } from "./platform.js";

// `sidebarAction` is Firefox's and absent from `@types/chrome`, hence the cast to the slice used.
installSidebarActions(api as unknown as SidebarApi, BROWSER);

if ((typeof __HAS_DEBUGGER__ === "undefined" || __HAS_DEBUGGER__) && HAS_DEBUGGER) {
  installDebuggerJanitor(api);
}
