#!/usr/bin/env bash
# Story 068, task 2.1 — the check suite as it runs inside the disposable guest that
# scripts/ci-vm.sh boots. It is a separate file so shellcheck reads it; ci-vm.sh copies the
# host's copy in, so any --ref can be tested with the current steps.
#
# Usage: ci-guest.sh <source dir> <log dir>
# Each step logs to <log dir>/<step>.log and prints one key=value line. The first failing step
# is written to <log dir>/FAILED and ends the run with exit 1.
set -euo pipefail

src=${1:?usage: ci-guest.sh <source dir> <log dir>}
logs=${2:?usage: ci-guest.sh <source dir> <log dir>}
mkdir -p "$logs"
export PATH="/opt/node/bin:$PATH"
# The e2e specs and the host integration suite skip without the host binary; ci-vm.sh copies it.
: "${ZEO_BROWSER_HOST_BIN:?ZEO_BROWSER_HOST_BIN must name the zeo-browser-host binary}"
export ZEO_BROWSER_HOST_BIN
cd "$src"

step() {
  local name=$1 start rc
  shift
  start=$SECONDS
  if "$@" >"$logs/$name.log" 2>&1; then rc=0; else rc=$?; fi
  printf 'ci-guest: step=%s status=%s exit=%d seconds=%d\n' \
    "$name" "$([[ $rc -eq 0 ]] && echo ok || echo failed)" "$rc" "$((SECONDS - start))"
  if [[ $rc -ne 0 ]]; then
    printf '%s\n' "$name" >"$logs/FAILED"
    tail -n 30 "$logs/$name.log" >&2
    exit 1
  fi
}

# Playwright's JSON report is the only place the skipped count is machine-readable; a skipped
# spec would otherwise pass the run while proving nothing.
# `step` calls this from an `if`, where set -e is off, so every exit code is checked by hand.
e2e_no_skips() {
  local rc=0
  PLAYWRIGHT_JSON_OUTPUT_NAME="$logs/e2e.json" npm run e2e -- --reporter=list,json --forbid-only || rc=$?
  [[ -f "$logs/e2e.json" ]] || return "$((rc == 0 ? 1 : rc))"
  # shellcheck disable=SC2016 # the ${...} below are JavaScript template literals
  node -e '
    const { stats } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(`e2e: expected=${stats.expected} skipped=${stats.skipped} unexpected=${stats.unexpected} flaky=${stats.flaky}`);
    if (stats.expected === 0 || stats.skipped !== 0 || stats.unexpected !== 0) process.exit(1);
  ' "$logs/e2e.json" || return 1
  return "$rc"
}

# The CDN download has stalled mid-transfer with no error (2026-11-04, 30% for 9 minutes), so
# each attempt is bounded and one retry is allowed.
browsers() {
  local attempt
  for attempt in 1 2; do
    timeout 5m npx playwright install chromium && return 0
    echo "browsers: attempt $attempt failed or timed out"
  done
  return 1
}

# The release assets come from the guest that just tested them: the Chrome zip, made with the
# repository's deterministic store-only zip (scripts/zip.mjs), and its SHA256SUMS line.
package() {
  local version out
  version=$(node -p 'require("./package.json").version')
  out="$logs/artifacts"
  mkdir -p "$out"
  node --input-type=module -e '
    import { readdir, readFile, writeFile } from "node:fs/promises";
    import { join, relative, sep } from "node:path";
    import { storeZip } from "./scripts/zip.mjs";
    const [dir, dest] = process.argv.slice(1);
    const files = [];
    for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const full = join(e.parentPath, e.name);
      files.push({ name: relative(dir, full).split(sep).join("/"), data: await readFile(full) });
    }
    await writeFile(dest, storeZip(files));
  ' dist/chrome "$out/zeo-browser-chrome-$version.zip"
  (cd "$out" && sha256sum "zeo-browser-chrome-$version.zip" >"SHA256SUMS-zeo-browser-$version")
  cat "$out/SHA256SUMS-zeo-browser-$version"
}

versions() {
  node --version
  npm --version
  git rev-parse HEAD
}

dependencies() {
  npm ls markdown-it vite happy-dom minimatch
}

step versions versions
step npm-ci npm ci --no-audit --no-fund
step dependencies dependencies
step format npm run format:check
step lint npm run lint
step typecheck npm run typecheck
step unit npm test
step build npm run build
# System libraries were installed by root before the suite (ci-vm.sh); only the browser here.
step browsers browsers
step e2e e2e_no_skips
step package package
