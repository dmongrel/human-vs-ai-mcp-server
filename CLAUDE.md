# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

An MCP (Model Context Protocol) server providing tooling to:
- Detect AI usage in text (estimate likelihood a given text was AI-generated), with an explainable per-signal breakdown.
- Offer recommendations to humanize AI-generated text.

Published on GitHub at [dmongrel/human-vs-ai-mcp-server](https://github.com/dmongrel/human-vs-ai-mcp-server) (`master` is the default and only branch); not yet published to npm — see [README.md](./README.md) for install/usage and [TOOLS.md](./TOOLS.md) for the maintained tool reference.

## Commands

- Install: `npm install`
- Build: `npm run build` (runs `tsc`, emits to `dist/`)
- Run: `npm start` (runs `dist/index.js`; build first)
- Test: `npm test` (compiles `src` including `*.test.ts` files to `dist-test/` via `tsconfig.test.json`, then runs `node --test` against the compiled output). There is no lint config yet.

## Architecture

- TypeScript compiles from `src/` to `dist/` (see `tsconfig.json`: `commonjs` module, `es2016` target, `strict` mode, `outDir: dist`).
- `src/index.ts` is the entry point (shebang `#!/usr/bin/env node`, also wired as the `bin` target in `package.json`): constructs an `McpServer`, registers tools with `server.registerTool(name, { title, description, inputSchema }, handler)` using `zod` schemas, then connects a `StdioServerTransport`. Tool `description` fields are kept short by design — detailed usage docs live behind the `get_context` tool instead (see `src/context.ts`), so keep new tools' descriptions terse and put the real explanation in `CONTEXT`.
- `src/lib/detectAiUsage.ts` — the heuristic AI-detection engine. Each signal (sentence-length burstiness, lexical diversity, AI stock-phrase frequency, readability uniformity, markdown-in-prose artifacts, em dash overuse) is an isolated function returned in a `detectors` array and combined via weighted average into a 0-100 score. Add new signals by adding one function + one array entry; nothing else needs to change. Research references are cited in comments at the top of the file. An optional `type: "creative" | "strategic"` parameter selects a `WEIGHT_PROFILES` entry that reweights the signals and adjusts markdown/em-dash saturation thresholds for that genre (see comments above `WEIGHT_PROFILES`); omit it for the genre-agnostic `default` profile. An optional `ignoreMd` boolean strips literal `*`/`_`/`#` characters (via `stripMarkdownMarkup` in `text.ts`) before analysis, neutralizing the markdown detector's header/bold counts without affecting `-` bullet lines.
- `src/lib/humanizeText.ts` — builds actionable `{ issue, suggestion, evidence }` recommendations on top of the same signals; does not rewrite text itself. Also accepts the same `type` and `ignoreMd` parameters as `detectAiUsage`; `type` maps through `HUMANIZE_PROFILES` to per-check thresholds (e.g. `strategic` skips the markdown recommendation entirely; `creative` tolerates more em dashes/readability drift). When calling both tools on the same text, pass the same `type`/`ignoreMd` to each for consistent results.
- `src/lib/aiPhrases.ts` — the list of known LLM stock phrases used by the phrase-frequency detector; extend this list as new "AI tells" are documented.
- `src/lib/text.ts` — hand-written tokenization/statistics helpers (sentence/paragraph splitting, syllable counting, mean/stdev, `stripMarkdownMarkup`). Deliberately dependency-free per project convention — prefer writing small routines here over adding an npm package.
- `src/lib/io.ts` — shared input/output handling for tools: `resolveInputText` accepts either `text` or `filePath` (exactly one required); `deliverOutput` returns content inline or writes it to `reportPath` if given, creating directories as needed.
- `src/context.ts` — the `CONTEXT` map backing the `get_context` tool. Keep this in sync with `TOOLS.md` when tool behavior changes.
- `src/lib/*.test.ts` — tests colocated with the modules they cover, using Node's built-in `node:test`/`node:assert` (no test framework dependency). `tsconfig.json` excludes `*.test.ts` from the publish build; `tsconfig.test.json` includes them and outputs to `dist-test/` for `npm test`. Running `node --test` directly against a *directory* has been observed to hang on Windows — the `test` script instead passes an explicit glob (`dist-test/**/*.test.js`), which is reliable; keep that pattern if editing the script.
- `examples/` — three `.md` fixtures of creative prose used for manually exercising the detection/humanization tools against realistic long-form text (not wired into the automated test suite).

## Conventions

- Keep runtime dependencies minimal (currently just `@modelcontextprotocol/sdk` and `zod`). Prefer hand-written implementations for small routines over adding a new package.
- `package.json` is set up npm-publish-style (`bin`, `files`, `prepublishOnly`) but `private: true` is intentionally left set and the project has not been registered/published — do not flip that or run `npm publish` without explicit instruction.
- Update `TOOLS.md` and `src/context.ts` together whenever a tool's inputs, outputs, or behavior change.
