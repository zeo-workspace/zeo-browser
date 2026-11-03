# Changelog

All notable changes to zeo-browser are written here, in the format of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Earlier history lives in the git log.

## [0.2.0] — 2026-10-31

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
