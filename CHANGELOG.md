# Changelog

All notable changes to this project are documented in this file.

## [0.0.1] - 2026-07-23

First real npm-registry publish, matching the `0.0.x` versioning convention started by `epub-mcp-server` and `fdx-mcp-server`.

### Added

- `.github/workflows/publish.yml` — publishes to the npm registry whenever a `v*` tag is pushed.
- `src/lib/checkUpdate.ts` — checks the npm registry for a newer published version at server start and, if one exists, prepends a system notice to `get_context` output advising an upgrade via `npm update -g human-vs-ai-mcp-server`.

### Changed

- Removed `"private": true` from `package.json` (it blocked `npm publish` outright).
