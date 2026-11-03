# Changelog

All notable changes to zeo-browser are written here, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Earlier history lives in the git log.

## [0.2.0] — 2026-11-03

Pairs with Zeo 0.8.0.

### Added

- The thread snapshot's optional `subagents` list — each child's `title` and `status`
  (`running`, `waiting`, `done`, `failed`, `canceled`, `unknown`) — is accepted. Zeo sends it
  for a thread with ACP subagents and omits it otherwise.
- The `unconfirmed` thread state, which Zeo sends for a resumed session whose activity the
  agent has not reported yet, is accepted and shown as "Not confirmed yet".

### Fixed

- 0.1.x refused a whole snapshot carrying either of the above, so such a thread did not show
  in the sidebar at all.

### Security

- zod 4.6.7 and markdown-it 15.0.3, both bundled into the extension: zod 4.6.5 could exhaust
  memory validating an oversized constrained collection (GHSA-mrhx-c7xc-m3w5), and markdown-it
  15.0.2 had two quadratic-time slowdowns (GHSA-gfr2-rv44-r23c; GHSA-vfgh-jcmw-g37q, not
  reachable here since inline HTML is off). Both inputs come from the local Zeo.
