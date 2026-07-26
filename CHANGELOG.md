# Changelog

All notable changes to this project are documented in this file.

## [0.0.3] - 2026-07-26

### Documentation

- Update instructions now say to uninstall and reinstall. `npm update -g` bumps the main package without installing the matching engine package, and the loss is silent.
- Added a one-liner for checking the installed engine version.

## [0.0.2] - 2026-07-26

Calibration and documentation release. No new tools; the detection behaviour changes because the perplexity anchors were refitted against a much wider human sample.

### Changed

- **Perplexity anchors refitted to 6/30** (from 12/32), against a corpus of **25 distinct published novelists** — mid-book Project Gutenberg excerpts, Austen through Fitzgerald. That corpus measured 15.7–38.7, roughly twice the spread the earlier samples implied. At 12/32 the crossover sat at 19.6 and scored seven of those novelists as AI-leaning (Sherwood Anderson 73/100, Agatha Christie 64/100); false positives on human prose are this tool's costlier error, so the anchors gave way.
- The detector's runtime caveat and the report's closing caveat now state what the signal can and cannot see, rather than describing the calibration as a small sample.

### Fixed

- **Publishing.** The tag-triggered workflow published the root package only, from Ubuntu, pinned to a platform package that was never published and cannot be built there — an install that would have succeeded with no perplexity signal and no error. Both packages now publish in order, the engine builds on Windows, `scripts/check-native-package.js` refuses to ship a platform package missing its binaries or drifting from the version pin, and each job skips a version already on the registry so an interrupted release can be resumed.
- CI pinned Node 20, where `node --test` does not expand globs, so the whole suite reported "could not find" and failed. Pinned to 22.
- The model-runner detector blamed every unscored chunk on the time budget, when chunks are also discarded for failing the reproduction similarity check. It now names the actual cause.
- A test asserted the engine fails closed when no platform package is installed, which only passed while the package was unpublished.

### Documentation

- States plainly that **detection difficulty scales with the writing model**: llama-3-8b scores 38 and qwen3-14b 32, while Claude Opus 5 scores 19 — a `likely-human` verdict on genuinely AI-written text. No threshold separates it without condemning real novelists.
- Records that perplexity sorts by **prose ornateness rather than authorship**, so plainly-written contemporary human text scores AI-like.
- Renames the disabled HTTP model-runner section to make clear it is *not* the bundled engine; both "run a model" and were being conflated.
- Install and configuration docs now reflect the published packages: `LLAMA_ENGINE_MODEL_PATH` is the only variable an installed copy needs, since the helper resolves from the platform package.
- Licensed under MIT, with the notice shipped in both packages.

## [0.0.1] - 2026-07-26

First npm-registry publish, matching the `0.0.x` versioning convention started by `epub-mcp-server` and `fdx-mcp-server`. Two packages ship together: `human-vs-ai-mcp-server` and the prebuilt engine `human-vs-ai-mcp-server-win32-x64`, pulled in automatically on Windows x64 as an optional dependency.

(Publishing was first prepared on 2026-07-23 and dated as such here, but nothing reached the registry until 2026-07-26 — the token in use was never valid.)

### Added

- `.github/workflows/publish.yml` — publishes to the npm registry whenever a `v*` tag is pushed.
- `src/lib/checkUpdate.ts` — checks the npm registry for a newer published version at server start and, if one exists, prepends a system notice to `get_context` output advising an upgrade via `npm update -g human-vs-ai-mcp-server`.

### Changed

- Removed `"private": true` from `package.json` (it blocked `npm publish` outright).
