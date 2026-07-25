# Design: bundled-engine model-perplexity detector (`llama-engine`)

**Date**: 2026-07-25
**Status**: proposed

## Purpose

Add a second, independent model-perplexity detection signal to `detect_ai_usage`, alongside the existing (disabled) `modelPerplexity.ts`/`modelRunner.ts` HTTP-based path. The existing path talks to a running LM Studio/Ollama server and was found structurally broken: its verbatim-echo technique requires greedy decoding to pass a similarity check, and greedy decoding makes any successfully-reproduced text score near-zero perplexity regardless of actual content — three different human-written chapters all returned an identical score in testing. See `README.md`'s "Model runner (currently disabled)" section for the full prior investigation.

This design instead performs **teacher-forced perplexity**: feed the model the actual text and read back its own log-probability for each *real* next token, with no generation step and no decoding bias. This is the same technique llama.cpp's own `llama-perplexity` CLI uses (`tools/perplexity/perplexity.cpp`), reimplemented as a small Go helper so it can be bundled into this npm package rather than shelling out to a separately-installed CLI.

## Non-goals

- Not replacing or removing the existing `modelRunner.ts`/`modelPerplexity.ts` HTTP path — both remain, independently gated, so there's a fallback if this technique also proves unworkable.
- Not implementing safetensors→GGUF conversion — llama.cpp's engine only reads GGUF; users are expected to supply an already-converted `.gguf` file (widely available as community quantizations on Hugging Face for popular models). Converting a model with no published GGUF is documented as a manual, out-of-scope step.
- Not building/publishing platforms beyond Windows x64 in this pass — macOS (arm64/x64), Linux x64, and Windows ARM64 are documented for a future implementer (see "Future platforms" below) but not built now.
- Not finalizing the perplexity→0-100 score calibration — that requires empirical testing against real human/AI text (using the fixture model below) and is explicitly follow-up work, not part of this design.

## Architecture

```
Node MCP server (TS)
  └─ src/lib/llamaEngine.ts          — spawns helper, JSON in/out over stdin/stdout, timeout, fail-open
       └─ subprocess: llama-engine-helper (Go, one-shot per call)
            └─ purego → libllama (llama.cpp's engine, dynamically loaded at runtime)
                 └─ <model>.gguf     — separately downloaded, path supplied by the user
```

Node spawns the helper fresh for every `detect_ai_usage` call (no long-running daemon, no lifecycle/health-check management, nothing left running if the MCP server crashes — consistent with the project's existing fail-open, nothing-lingers philosophy). Input goes over **stdin**, not argv: OS command-line length limits (Windows caps around 32K characters) would truncate a novel chapter passed as an argument.

## Go helper I/O contract

Binary name: `llama-engine-helper`. No argv. Reads one JSON request from stdin, writes exactly one JSON response to stdout, exits 0 on success or non-zero on failure (with a JSON error object on stdout either way — Node never needs to parse bare stderr text to know why it failed).

**Request (stdin)**:
```json
{
  "modelPath": "F:\\models\\Qwen2.5-1.5B-Instruct.Q4_K_M.gguf",
  "text": "the full chunk of prose to score",
  "ctxSize": 2048,
  "timeoutMs": 60000
}
```
- `ctxSize` sizes non-overlapping windows the helper splits `text` into. No sliding-window/stride (unlike `llama-perplexity`'s `--ppl-stride`) — there's no generation step to make the extra complexity worthwhile, matching the simplification `modelRunner.ts` already made for its own chunking.
- `timeoutMs` bounds the whole run. The helper checks elapsed time between chunks and stops early, returning results for whatever chunks completed — mirrors `MODEL_RUNNER_TIMEOUT_MS`'s "average whatever finished" behavior rather than all-or-nothing failure.

**Response (stdout, success)**:
```json
{
  "ok": true,
  "perplexity": 14.2,
  "tokensEvaluated": 1843,
  "chunks": [
    { "tokens": 512, "perplexity": 13.8 },
    { "tokens": 512, "perplexity": 15.1 }
  ],
  "modelName": "qwen2.5-1.5b-instruct",
  "timedOut": false
}
```
`perplexity` is the token-count-weighted average across chunks, not a plain mean — chunk lengths aren't guaranteed equal once a timeout cuts things short. Per-chunk detail is retained (the Go side computes it anyway) so `humanizeText.ts` could eventually surface "which part of the document was most/least predictable," though that's not required for v1.

**Response (stdout, failure)**:
```json
{ "ok": false, "error": "model load failed: file not found" }
```

**Internal implementation**: tokenize the whole input once, then per chunk — build a batch of that chunk's tokens, one `llama_decode` call (teacher-forced, no sampling), pull logits at every position, log-softmax against the actual next token in that same chunk, average into that chunk's perplexity. This is the same ~150-line orchestration `perplexity.cpp` does in llama.cpp itself, translated to Go calls against the purego binding — the heavy lifting (matrix math, KV cache, quantized kernels) stays inside `libllama`.

## TS-side integration

- **`src/lib/llamaEngine.ts`** — new module, sibling to `modelRunner.ts`. Exports `scorePerplexityViaEngine(text, opts)`: resolves the helper binary's path, spawns it, writes the JSON request to stdin, reads stdout, enforces `LLAMA_ENGINE_TIMEOUT_MS` via a `child_process` timeout/kill, parses the response, and fails open to `null` on any spawn error, non-zero exit, malformed JSON, or `ok: false` — same contract shape as `scorePerplexity()`.
- **`src/lib/detectors/llamaEnginePerplexity.ts`** — new `Detector`, sibling to `modelPerplexity.ts`. **`enabled: false` by default** until calibrated, same conservatism as the existing disabled detector. Reads `LLAMA_ENGINE_MODEL_PATH` to decide whether to attempt a run at all — unset means `run()` returns `null` immediately at zero cost.
- **Coexistence with `modelRunner.ts`**: both detectors register independently in `CORE_DETECTORS`, each gated by its own env var, fully isolated files — adding this one doesn't touch the HTTP-based one, by design (per project decision: keep both, in case of needing to switch back).
- **Env vars** (deliberately avoiding "TOKEN" in any name, per explicit instruction — some scanning/CI tooling flags that substring as a potential secret):
  - `LLAMA_ENGINE_MODEL_PATH` — required to enable the detector; absolute path to a `.gguf` file.
  - `LLAMA_ENGINE_CTX_SIZE` — optional, mirrors llama.cpp's own `--ctx-size` flag naming.
  - `LLAMA_ENGINE_TIMEOUT_MS` — optional, default `60000`, same default as `MODEL_RUNNER_TIMEOUT_MS`.

## Scoring and calibration

The helper returns a raw `perplexity` float. Mapping that to the 0-100 "AI-likelihood" contribution every other detector produces requires empirical calibration against real human vs. AI text — explicitly **not** resolved by this design. `llamaEnginePerplexity.ts` ships with an obviously-provisional linear/log mapping between two placeholder perplexity bounds, clearly commented as unvalidated, in the same spirit as `emDash.ts`/`markdownInProse.ts` each owning their own calibration constants — this detector just starts with unproven ones. Calibration work uses the fixture model below.

## Repo layout

Go helper source lives inside this repo: **`native/llama-engine/`** (`main.go`, `go.mod`, a Go test file exercising chunking/weighted-averaging against a fake/injectable decode function — not a real model, so CI never needs a `.gguf`). A separate build step (e.g. `npm run build:native`, distinct from the existing `tsc`-based `npm run build`) cross-compiles it and drops output into the platform package directory before publish — a normal TypeScript-only contributor never needs a Go toolchain installed.

## npm distribution

Following the pattern `esbuild`/`sharp`/`swc` use for prebuilt native binaries:

- New sibling package **`human-vs-ai-mcp-server-win32-x64`**, containing `llama-engine-helper.exe` plus the `libllama.dll` it loads via purego at runtime (no cgo/static link — purego dlopens the DLL dynamically). `package.json` sets `"os": ["win32"]`, `"cpu": ["x64"]` so npm only installs it on matching machines.
- Main package adds it under `optionalDependencies`; `llamaEngine.ts` resolves the helper's path at runtime (e.g. via `require.resolve`) rather than a hardcoded relative path — this is what lets future platform packages (see below) be added without touching resolution code, only the platform-package list.
- Both packages version in lockstep, `optionalDependencies` pinned to an exact match.
- Building the Go helper (which needs `libllama.dll` + headers to build against) happens in the release pipeline, not on a consumer's machine — `npm install` only ever downloads prebuilt binaries. This satisfies "shipped in npm publish, not separately downloaded" for the *engine*; the model file remains the one deliberately-separate download.

## Testing

- **Go side**: `native/llama-engine/`'s own `go test` — unit-tests the chunking/weighted-averaging logic against a fake decode function returning canned logits, not a real model.
- **TS side**: `llamaEngine.test.ts` stubs `child_process.spawn` the same way `modelRunner.test.ts` stubs `globalThis.fetch` — feed canned stdout JSON, assert fail-open behavior on bad exit codes/malformed JSON/timeout.
- **Manual end-to-end**: run the real helper against `F:\models\Qwen2.5-1.5B-Instruct.Q4_K_M.gguf` and the `examples/` fixtures once the helper exists — this is also where actual calibration numbers come from.

## Future platforms (documentation deliverable, not built now)

A doc (e.g. `native/llama-engine/PLATFORMS.md`) for a future implementer — human or AI — covering:

**Windows ARM64**: Go and purego both cross-compile to `windows/arm64` without a C toolchain. The blocker is sourcing `libllama.dll` for win-arm64 — llama.cpp's own GitHub Releases already publish `bin-win-arm64` artifacts; building it yourself needs an ARM64 Windows toolchain or runner. New package: `human-vs-ai-mcp-server-win32-arm64`.

**macOS arm64 (Apple Silicon)**: llama.cpp has a Metal backend worth using here, which means building on a real arm64 Mac (GitHub Actions `macos-14`+), not cross-compiling. **Code-signing/Gatekeeper is the real gotcha**: an unsigned `.dylib` downloaded via npm and `dlopen`'d at runtime can be quarantined or blocked. At minimum ad-hoc sign (`codesign --sign -`) during build; full notarization removes the warning but adds an Apple Developer account dependency to the release pipeline. Package: `human-vs-ai-mcp-server-darwin-arm64`.

**macOS x64 (Intel)**: same Gatekeeper concern. Build on an Intel runner (`macos-13`) rather than cross-compiling via osxcross. Follow Node's convention of separate per-arch packages (`darwin-x64` / `darwin-arm64`), not a universal binary. Package: `human-vs-ai-mcp-server-darwin-x64`.

**Linux x64**: easiest to build (any `ubuntu-latest` runner), CPU inference via AVX2 baseline. **glibc versioning bites here** — build on an older baseline (e.g. `ubuntu-20.04` or a manylinux-style container) rather than the newest runner, to avoid `GLIBC_2.3x not found` failures on older distros. Set `$ORIGIN`-relative rpath on the helper so `libllama.so` resolves from alongside it without requiring `LD_LIBRARY_PATH`. musl/Alpine deliberately deferred unless a real need appears. Package: `human-vs-ai-mcp-server-linux-x64`.

**Cross-cutting, for any platform added**: a CI matrix job per OS/arch that actually *runs* the built helper against a small fixture model + text and checks for valid JSON — cross-compiling Go is easy, but only a real run on real hardware proves the llama.cpp binary genuinely works on that target. Pin a specific llama.cpp release/commit for the engine per platform in one documented place, so upgrading it is a deliberate, all-platforms-at-once action; the Go↔TS JSON contract must stay stable across engine version bumps regardless. Confirm llama.cpp's MIT license carries no copyleft obligations before shipping compiled binaries (expected to be a non-issue, worth stating explicitly).

## Open items deferred to implementation/calibration phase

- Exact provisional perplexity→score bounds in `llamaEnginePerplexity.ts` (placeholder until calibration).
- Exact Go build/cross-compile command wiring in `package.json`/CI for `win32-x64`.
- Whether per-chunk detail (`chunks` array) gets surfaced anywhere user-facing, or stays internal for now.
