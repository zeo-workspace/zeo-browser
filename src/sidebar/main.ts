// The sidebar page's entry (story 045, design.md §A4): one channel, the real storage and runtime,
// and the build's platform constants, handed to the view.
import { Channel } from "../channel.js";
import { BROWSER, HAS_DEBUGGER, api } from "../platform.js";
import { mountSidebar } from "./view.js";

const root = document.getElementById("app");
if (root === null) {
  console.warn({ event: "sidebar_root_missing" });
} else {
  mountSidebar(root, {
    channel: new Channel(),
    storage: api.storage.local,
    runtime: api.runtime,
    platform: { BROWSER, HAS_DEBUGGER },
  }).catch((err: unknown) => {
    console.warn({
      event: "sidebar_mount_failed",
      error: err instanceof Error ? err.name : "unknown",
    });
  });
}
