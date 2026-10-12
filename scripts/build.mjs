// Builds dist/chrome and dist/firefox from one source tree, then zips dist/firefox into
// dist/zeo-browser-firefox.zip. Exits non-zero, naming the path, on any failure.
import { mkdir, readdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildManifest } from "./manifest.mjs";
import { extensionIdFromKey } from "./extension-id.mjs";
import { storeZip } from "./zip.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

// Output name → source entry. picker.js is injected by scripting.executeScript({files}), so it
// must be one self-contained classic script.
const ENTRIES = {
  background: "src/background.ts",
  "sidebar/main": "src/sidebar/main.ts",
  picker: "src/picker/content.ts",
};
const STATIC = ["src/sidebar/index.html", "src/sidebar/style.css"];

async function fsStep(what, path, fn) {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`${what} ${relative(ROOT, path) || path} failed`, { cause: err });
  }
}

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFiles(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

async function buildBrowser(browser) {
  const out = join(DIST, browser);
  await fsStep("creating", out, () => mkdir(join(out, "sidebar"), { recursive: true }));
  for (const [name, src] of Object.entries(ENTRIES)) {
    await build({
      entryPoints: [join(ROOT, src)],
      outfile: join(out, `${name}.js`),
      bundle: true,
      format: name === "picker" ? "iife" : "esm",
      target: browser === "chrome" ? "chrome116" : "firefox128",
      platform: "browser",
      legalComments: "none",
      logLevel: "silent",
      define: {
        __HAS_DEBUGGER__: browser === "chrome" ? "true" : "false",
        __BROWSER__: JSON.stringify(browser),
      },
    }).catch((err) => {
      const detail = (err.errors ?? []).map((e) => e.text).join("; ");
      throw new Error(`esbuild failed for ${browser} ${src}: ${detail || err.message}`, {
        cause: err,
      });
    });
  }
  for (const src of STATIC) {
    const dest = join(out, relative(join(ROOT, "src"), join(ROOT, src)));
    await fsStep("copying", join(ROOT, src), () => copyFile(join(ROOT, src), dest));
  }
  const manifestPath = join(out, "manifest.json");
  await fsStep("writing", manifestPath, () =>
    writeFile(manifestPath, JSON.stringify(buildManifest(browser), null, 2) + "\n"),
  );
}

async function zipFirefox() {
  const dir = join(DIST, "firefox");
  const files = [];
  for (const full of await fsStep("listing", dir, () => listFiles(dir))) {
    const data = await fsStep("reading", full, () => readFile(full));
    files.push({ name: relative(dir, full).split(sep).join("/"), data });
  }
  const zipPath = join(DIST, "zeo-browser-firefox.zip");
  await fsStep("writing", zipPath, () => writeFile(zipPath, storeZip(files)));
}

async function main() {
  await fsStep("removing", DIST, () => rm(DIST, { recursive: true, force: true }));
  await buildBrowser("chrome");
  await buildBrowser("firefox");
  await zipFirefox();
  const id = extensionIdFromKey(String(buildManifest("chrome").key));
  console.log(`zeo-browser build ok: dist/chrome, dist/firefox, dist/zeo-browser-firefox.zip`);
  console.log(`chrome extension id: ${id}`);
}

main().catch((err) => {
  console.error(`zeo-browser build failed: ${err.message}`);
  if (err.cause) {
    console.error(`  cause: ${err.cause.message ?? err.cause}`);
  }
  process.exitCode = 1;
});
