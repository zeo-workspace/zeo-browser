// Story 068, task 4.1 — E2E: the Chrome artefact built for 0.2.1 (`dist/chrome`) renders the
// GHSA-gfr2-rv44-r23c input in linear time, so the next entry is not held behind it. Requirement:
// Expected Behavior 5 (0.2.1 ships markdown-it 15.0.3 in the Chrome artefact) and Expected
// Behavior 1 at runtime. Tool: playwright (@playwright/test), Chromium with the unpacked build,
// the real host binary and a fake Zeo socket, as e2e/sidebar.spec.ts.
//
// Why behaviour and not a version string: the bundle carries no markdown-it version (esbuild
// inlines `dist/markdown-it.mjs`, which has no banner), so `grep 15.0.3` on `sidebar/main.js`
// finds nothing on either version. What the artefact proves is how it renders.
//
// The input is one entry of 200 000 lines, an unclosed title: markdown-it 15.0.2 needs seconds for
// it (about 1.6 s at 100 000 lines under Node, roughly 4x per doubling), 15.0.3 about a tenth of a
// second. It is past Zeo's 64 KiB entry truncation on purpose: the extension does not enforce that
// cap (contract.ts), and the line is inside the host's MAX_ZEO_LINE_BYTES, the bound it relies on.
// The sidebar renders on one thread, so an entry pushed after it shows only once it is rendered.
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { buildManifest } from "../scripts/manifest.mjs";
import { extensionIdFromKey } from "../scripts/extension-id.mjs";
import { MAX_ZEO_LINE_BYTES } from "../src/limits.js";
import { entry, startFakeZeoV2, type FakeZeoV2 } from "./fake-zeo.js";

const DIST = fileURLToPath(new URL("../dist/chrome", import.meta.url));
const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/page.html", import.meta.url)),
  "utf8",
);
const BIN = process.env.ZEO_BROWSER_HOST_BIN;
const ID = extensionIdFromKey((buildManifest("chrome") as { key: string }).key);

/** From the push of the entry after the hostile one to that entry on screen. */
const NEXT_ENTRY_BUDGET_MS = 3000;
const LINES = 200_000;

// Same refusal as sidebar.spec.ts: the browser runs headed, so only under `xvfb-run`.
const UNDER_XVFB =
  process.env.DISPLAY !== undefined &&
  /\/xvfb-run\.[^/]+\/Xauthority$/.test(process.env.XAUTHORITY ?? "");
if (!UNDER_XVFB) {
  throw new Error(
    "e2e/markdown-redos.spec.ts refuses to run outside xvfb-run (it drives a headed browser): " +
      "use `npm run e2e`",
  );
}

const BROWSER_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    (e): e is [string, string] => e[0] !== "WAYLAND_DISPLAY" && e[1] !== undefined,
  ),
);

test.skip(
  !BIN || !existsSync(join(DIST, "manifest.json")),
  "SKIPPED: set ZEO_BROWSER_HOST_BIN and run `npm run build` first",
);

let fake: FakeZeoV2;
let server: Server | undefined;
let profile: string | undefined;
let context: BrowserContext | undefined;

async function serveFixture(): Promise<string> {
  const s = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }).end(FIXTURE);
  });
  server = s;
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
}

/** Launches Chromium with the unpacked build and a host wrapper pointed at the fake Zeo. */
async function launchWithHost(url: string): Promise<BrowserContext> {
  const dir = await mkdtemp(join(tmpdir(), "zeo-e2e-redos-"));
  profile = dir;
  const wrapper = join(dir, "host.sh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexport ZEO_DEVTOOLS_SOCKET='${fake.path}'\nexec '${BIN}' "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  await mkdir(join(dir, "NativeMessagingHosts"), { recursive: true });
  await writeFile(
    join(dir, "NativeMessagingHosts", "dev.zeo.browser_host.json"),
    JSON.stringify({
      name: "dev.zeo.browser_host",
      description: "test",
      path: wrapper,
      type: "stdio",
      allowed_origins: [`chrome-extension://${ID}/`],
    }),
  );
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: false,
    env: BROWSER_ENV,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      "--ozone-platform=x11",
    ],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(url);
  return ctx;
}

/** Opens the sidebar page in a popup and waits for the fake Zeo's snapshot. */
async function openReadySidebar(ctx: BrowserContext): Promise<Page> {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const opened = ctx.waitForEvent("page", (p) => p.url().includes("/sidebar/index.html"));
  await sw.evaluate(
    (url) => chrome.windows.create({ url, type: "popup", width: 420, height: 800, focused: false }),
    `chrome-extension://${ID}/sidebar/index.html`,
  );
  const sidebar = await opened;
  await sidebar.waitForLoadState();
  await expect(sidebar.getByText("hello from zeo")).toBeVisible();
  return sidebar;
}

test.beforeEach(async () => {
  fake = await startFakeZeoV2();
});
test.afterEach(async () => {
  await context?.close().catch(() => {});
  context = undefined;
  await fake.dispose();
  const s = server;
  server = undefined;
  if (s) {
    await new Promise<void>((r) => s.close(() => r()));
  }
  if (profile) {
    await rm(profile, { recursive: true, force: true });
  }
});

test("hostile: a 200 000-line unclosed reference definition does not hold the next entry back", async () => {
  test.setTimeout(120_000);
  context = await launchWithHost(await serveFixture());
  const sidebar = await openReadySidebar(context);

  const hostile = {
    v: 2,
    kind: "entry_added",
    index: 1,
    entry: entry('[a]: /u "' + "x\n".repeat(LINES)),
  };
  // Reachable as one Zeo line: inside the host's cap, so the host forwards it rather than refusing.
  expect(Buffer.byteLength(JSON.stringify(hostile) + "\n")).toBeLessThanOrEqual(MAX_ZEO_LINE_BYTES);

  fake.push(hostile);
  const pushed = Date.now();
  fake.push({ v: 2, kind: "entry_added", index: 2, entry: entry("NEXT-ENTRY-SENTINEL") });
  await expect(sidebar.getByText("NEXT-ENTRY-SENTINEL")).toBeVisible({
    timeout: NEXT_ENTRY_BUDGET_MS,
  });
  const shownAfter = Date.now() - pushed;

  // The fix must not drop the content: the definition is invalid, so it is paragraph text.
  await expect(sidebar.locator("main")).toContainText('[a]: /u "x x x');
  expect(shownAfter, `next entry shown ${shownAfter} ms after the push`).toBeLessThan(
    NEXT_ENTRY_BUDGET_MS,
  );
});
