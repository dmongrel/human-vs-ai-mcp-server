# Human vs AI MCP Server

## Description

**`human-vs-ai-mcp-server`** is a Model Context Protocol (MCP) server that gives AI agents tools to reason about AI-authored text: estimating whether a piece of text was AI-generated, and getting concrete recommendations for making AI-leaning text read more naturally human.

Detection and recommendations are built on explainable, dependency-free stylometric heuristics (sentence-length burstiness, lexical diversity, known LLM stock phrases, readability uniformity, markdown-in-prose artifacts, n-gram repetition, paragraph coherence) rather than an opaque trained classifier — every score comes with the reasoning behind it. See [TOOLS.md](./TOOLS.md) for the full tool list and [`get_context`](./TOOLS.md#get_context) for in-depth methodology notes.

**This is a plugin-based project at its core.** `detect_ai_usage`'s scoring isn't a monolithic algorithm — it's a weighted combination of independent signal modules, each implementing a shared `Detector` interface and contributing (or omitting) its own score. Every built-in signal is written against that same interface, so removing one, retuning one, or adding a new one never touches the others. That interface is also open to third parties: drop a plain `.js` file into a directory referenced by `PLUGINS_DIR` and the server auto-discovers and loads it at runtime, no fork required. See [Plugins](#plugins) below for the interface, a worked example, and the trust model.

Written in TypeScript, it runs on Node.js using the stdio transport protocol, making it suitable for integration with any MCP-compatible client such as Claude Desktop or Claude Code.

---

## Table of Contents

- [Status](#status)
- [Installation](#installation)
- [Usage](#usage)
- [Tools](#tools)
- [Plugins](#plugins)
- [Bundled engine perplexity — **the** perplexity signal this project uses](#bundled-engine-perplexity)
- [HTTP model runner — a separate, **disabled** experiment](#http-model-runner-disabled)
- [Testing](#testing)
- [Design principles](#design-principles)

---

## Status

**`v0.0.1`** — published on npm as [`human-vs-ai-mcp-server`](https://www.npmjs.com/package/human-vs-ai-mcp-server), alongside the prebuilt engine package `human-vs-ai-mcp-server-win32-x64`. Under active development at `0.0.x`; expect the tool set to change.

**Tools:** `detect_ai_usage`, `humanize_text`, `get_context` — all implemented.

**Signals:** 8 active, 2 deliberately disabled.

| | signal | state |
|---|---|---|
| ✅ | sentence-length burstiness, lexical diversity, AI stock phrases, readability uniformity, markdown-in-prose, em dash overuse, n-gram repetition | active |
| ✅ | bundled llama.cpp engine perplexity | active; contributes only when `LLAMA_ENGINE_MODEL_PATH` is set |
| ❌ | HTTP model-runner perplexity | disabled — a *separate* external-server signal, not the bundled engine; returns ~1.0 for any text ([why](#http-model-runner-disabled)) |
| ❌ | paragraph coherence | disabled — premise measured and did not hold for narrative prose |

Third parties can add signals without forking, via [`PLUGINS_DIR`](#plugins).

**Calibration:** every threshold was measured, not assumed — on ~1,200-word excerpts, so the tools are tuned for [chapter-length text](#input-length-calibrated-for-chapter-length-text). The perplexity anchors rest on 25 published novelists.

**Known limits, measured rather than suspected:**

- **Frontier-model prose is not detectable.** A Claude Opus 5 chapter scores 19 — a `likely-human` verdict on AI text. Small and mid-size open models are caught easily; capable ones are not. See [What it can and cannot catch](#what-it-can-and-cannot-catch).
- **Perplexity partly measures prose style, not authorship** — plain modern writing scores AI-like regardless of who wrote it.
- **The engine is Windows x64 only.** Elsewhere the other signals work unchanged.

Treat every result as a starting point for human review, never as a verdict.

## Installation

### Prerequisites: Node.js

Install Node.js (LTS) from [nodejs.org](https://nodejs.org/), or via your platform's package manager. Verify with `node --version` and `npm --version`.

### From npm (recommended)

```bash
npm install -g human-vs-ai-mcp-server
```

On Windows x64 this also installs `human-vs-ai-mcp-server-win32-x64`, the prebuilt llama.cpp engine, as an optional dependency — roughly 24 MB, no Go toolchain or compiler needed. Elsewhere npm skips it and the eight stylometric signals work as normal.

**To update, reinstall rather than update:**

```bash
npm uninstall -g human-vs-ai-mcp-server
npm install -g human-vs-ai-mcp-server
```

This matters. `npm update -g` (and `npm install -g …@latest` over an existing copy) has been observed to bump the main package while **failing to install the matching engine package** — it removes the old one and never adds the new one. Because optional dependencies and the engine client both fail open, nothing errors: the tool keeps working with the perplexity signal silently missing. A clean reinstall installs both correctly.

To check which engine you have, if any:

```bash
node -e "console.log(require('human-vs-ai-mcp-server-win32-x64/package.json').version)"
```

### From source

```bash
git clone https://github.com/dmongrel/human-vs-ai-mcp-server.git
cd human-vs-ai-mcp-server
npm install
npm run build
```

`npm install` pulls the published engine package here too, so a clone gets a working engine without building it. To work on the native helper itself, run `npm run build:native` (needs Go and PowerShell) and point `LLAMA_ENGINE_HELPER_PATH` at `packages/win32-x64/llama-engine-helper.exe` to override the installed one.

---

## Usage

Add a configuration block to your MCP client's config file (e.g., `claude_desktop_config.json` or `.mcp.json`). See [example-mcp.json](./example-mcp.json) for the npm-install, local-build, engine, model-runner and plugin entries side by side — keep only the entry you need.

**From a global npm install:**

```json
{
  "mcpServers": {
    "human-vs-ai-mcp-server": {
      "command": "human-vs-ai-mcp-server",
      "args": []
    }
  }
}
```

**From a local build:**

```json
{
  "mcpServers": {
    "human-vs-ai-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/human-vs-ai-mcp-server/dist/index.js"]
    }
  }
}
```

### Enabling the perplexity signal

Either entry above gives you the eight stylometric signals. The ninth — teacher-forced perplexity against the bundled engine — needs one more thing: a `.gguf` model, which you supply. Add an `env` block:

```json
{
  "mcpServers": {
    "human-vs-ai-mcp-server": {
      "command": "human-vs-ai-mcp-server",
      "args": [],
      "env": {
        "LLAMA_ENGINE_MODEL_PATH": "F:/models/Qwen2.5-1.5B-Instruct.Q4_K_M.gguf",
        "LLAMA_ENGINE_CTX_SIZE": "512",
        "LLAMA_ENGINE_TIMEOUT_MS": "900000"
      }
    }
  }
}
```

`LLAMA_ENGINE_MODEL_PATH` is the only required variable — the helper binary resolves from the installed platform package on its own, so there is **no path to the engine to configure**. The other two are worth setting anyway:

- **`LLAMA_ENGINE_CTX_SIZE: 512`** — the anchors were measured at this chunk size. Changing it changes the numbers.
- **`LLAMA_ENGINE_TIMEOUT_MS: 900000`** — the 60 s default is not enough for chapter-length text on CPU; a ~1,200-word chapter takes roughly 20 s, and a whole manuscript far longer. On expiry you get a partial result flagged as such rather than a failure.

Use the same model the anchors were calibrated against (`Qwen2.5-1.5B-Instruct.Q4_K_M`) unless you intend to re-measure — perplexity values do not transfer between models. See [Bundled engine perplexity](#bundled-engine-perplexity) for what that signal can and cannot detect.

---

## Tools

See [TOOLS.md](./TOOLS.md) for the maintained tool list with input/output shapes. Summary:

- **`detect_ai_usage`** — estimate the likelihood that text was AI-generated, with a per-signal explanation.
- **`humanize_text`** — get actionable recommendations for making AI-leaning text read more naturally human.
- **`get_context`** — fetch detailed usage documentation for any tool on demand, so the tools' own descriptions can stay short.

Every analysis tool accepts input either as text passed directly (e.g. from an AI source over stdio) or via a local `filePath`, and can return its report inline over stdio or write it to a local file via `reportPath` (e.g. `reportPath: "DETECT-AI.md"`).

### Input length: calibrated for chapter-length text

Every threshold in the tool — the verdict bands, the readability anchors, the perplexity anchors — was measured on **~1,200-word excerpts**. Analyze roughly a chapter at a time (500–3,000 words) for the most reliable result.

Longer input is accepted and returns a result, but treat it as a rough screen rather than a measurement, for three reasons:

- **Lexical diversity is a type-token ratio**, which falls mechanically as a document grows. A 60,000-word manuscript scores lower than a 1,200-word excerpt from the same author, purely because it is longer.
- **Readability uniformity** compares variance across paragraphs. Across two thousand paragraphs that variance saturates, and the signal flattens to 0 regardless of authorship.
- **The engine may not finish.** Perplexity scoring runs at roughly 90 tokens/second on CPU, so a full manuscript takes ~15 minutes. Whatever `LLAMA_ENGINE_TIMEOUT_MS` allows is what gets scored; the rest of the document is covered by stylometry alone, and the report says so.

Analysing a whole book is therefore best done chapter by chapter, which also tells you *which* chapter is the problem — something a single document-level score cannot.

---

## Plugins

`detect_ai_usage`'s scoring is a weighted combination of independent signals ("detectors"), each an isolated module implementing a shared `Detector` interface (`src/lib/detectors/types.ts`):

```ts
interface Detector {
  id: string;
  name: string;
  enabled: boolean;
  weight(type: "default" | "creative" | "strategic"): number;
  run(ctx: DetectorContext): DetectorRunResult | null | Promise<DetectorRunResult | null>;
}
```

The built-in signals live under `src/lib/detectors/` and are registered in `src/lib/detectors/index.ts` — adding or removing a built-in signal touches only that directory:

| File | Signal |
|---|---|
| `burstiness.ts` | Sentence-length variance (CoV) |
| `lexicalDiversity.ts` | Rolling type-token ratio |
| `aiPhrase.ts` | Known LLM stock-phrase frequency |
| `readabilityUniformity.ts` | Flesch Reading Ease variance across paragraphs |
| `markdownInProse.ts` | Bullets/headers/bold left in plain prose |
| `emDash.ts` | Em dash ("—") frequency |
| `ngramRepetition.ts` | Trigram (3-word sequence) diversity |
| `paragraphCoherence.ts` | Adjacent-paragraph content-word cosine similarity |
| `modelPerplexity.ts` | Real perplexity via a local model runner — **disabled by default**, see [below](#http-model-runner-disabled) |

Every one of these is a normal consumer of the same `Detector` interface described above — there's no special-cased "built-in" path a plugin can't also take.

**Third-party plugins**, for anyone who wants to add a detector without forking the project: set the `PLUGINS_DIR` environment variable (in your MCP client config's `env` block) to a directory of plain **CommonJS `.js` files** — not TypeScript; this package ships compiled `commonjs` output and doesn't bundle a TypeScript compiler to compile plugins at runtime, and adding one would violate the project's minimal-dependencies convention. Each file should export a `Detector`-shaped object as `module.exports.detector`, `module.exports.default`, or `module.exports` itself:

```js
// my-detector.js
module.exports.detector = {
  id: "my-custom-signal",
  name: "my custom signal",
  enabled: true,
  weight: (type) => 0.1,
  run: (ctx) => {
    // ctx: { text, sentences, paragraphs, words, lowerText, type }
    return { name: "my custom signal", score: 0.5, detail: "explain the score here" };
  },
};
```

`PLUGINS_DIR` is unset by default, so nothing changes unless you opt in. The directory is scanned fresh on every `detect_ai_usage` call, so you can add/edit plugin files without restarting the server. Loading fails open per file: a missing directory yields no plugins; a file that throws, doesn't export a valid `Detector`, or whose `id` collides with an existing detector is skipped with a warning on stderr (never stdout, since this is an MCP server using stdio for the protocol) rather than crashing the server.

**Trust note**: plugin code runs in-process with full Node.js privileges, exactly like any other code this server loads. Only point `PLUGINS_DIR` at a directory of files you trust — there is no sandboxing.

```json
{
  "mcpServers": {
    "human-vs-ai-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/human-vs-ai-mcp-server/dist/index.js"],
      "env": { "PLUGINS_DIR": "/absolute/path/to/your/plugins" }
    }
  }
}
```

---

## HTTP model runner (disabled)

> **This is not the LLM signal this tool uses, and it is switched off.** The perplexity signal this project runs is [Bundled engine perplexity](#bundled-engine-perplexity) — a llama.cpp engine shipped inside the package, running in-process. The section below is about a *different* approach: scoring over HTTP against an external server. Both "run a model", which makes them easy to mix up. This one is disabled and setting `MODEL_RUNNER_URL` will not turn it on.

An optional **detection signal** — a perplexity check over HTTP against a local, OpenAI-compatible model runner such as [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/). **It's implemented but disabled** (`enabled: false` in `src/lib/detectors/modelPerplexity.ts`) after investigation found it unreliable. The client code (`src/lib/modelRunner.ts`) is kept as groundwork in case a better technique or runner support emerges later. With the signal disabled the tools behave exactly as described above, with zero network calls — this section documents the investigation, not a usable feature.

It was later switched on briefly and re-measured, which **confirmed the original finding rather than overturning it**: against a live LM Studio instance it does reach the runner and return a perplexity, but that perplexity was **1.0 for a real chapter** — the bias in plain sight. Logprobs are read off the model's *own reproduction* of the text at temperature 0, where greedy decoding always picks its own argmax token, so the scored tokens are near-certain by construction and the result barely depends on the input. It went back to disabled.

### What was tried

The "obvious" approach — `POST /v1/completions` with `echo: true, logprobs: 1`, reading the input text's own token logprobs straight back — was tested against real LM Studio and Ollama instances and found non-functional on both: their OpenAI-compat `/v1/completions` implementations accept the `logprobs` parameter but never populate it in the response, regardless of value. `/v1/chat/completions` *does* return real logprobs on both runners, but only for tokens the model generates itself (no `echo` support).

As a workaround, a **verbatim-echo** technique was implemented: ask the model to repeat each text chunk back exactly via `/v1/chat/completions`, and read logprobs off its own reproduction, with a Levenshtein-based similarity check (≥90% match required) discarding any chunk where the reproduction diverges too far. This technique does work mechanically — verified end-to-end against real LM Studio and Ollama instances with several models producing exact-match reproductions and real logprobs:

| Model / Runner | Result |
|---|---|
| `meta-llama-3-8b-instruct` (LM Studio) | Works — exact match, real logprobs, no reasoning overhead (~9s per ~500-word chunk) |
| `ai-detection-gutenberg-human-formatted-ai-v1-sft-qwen-3b-dpo` (LM Studio) | Works, faster (~5s per ~500-word chunk), exact match |
| `llama3.1:8b` (Ollama) | Works, exact match, real logprobs — but ~52s for the same ~500-word chunk on this hardware |
| `qwen2.5-0.5b-instruct` | Fails — doesn't reliably follow verbatim-repetition instructions; output diverges from input |
| `google/gemma-4-12b-qat`, `qwen3.6-35b-a3b-mtp` | Fail — both route through an internal reasoning/"thinking" step that consumes the token budget before any real content is emitted |

### Why it's disabled anyway

Two separate problems, found through this testing, rule the technique out as currently designed:

1. **Structural validity problem.** The similarity check requires the model to decode at `temperature: 0` (greedy) to reliably reproduce the text verbatim. But greedy decoding, by definition, always picks the model's own argmax (highest-probability) token at each step — so *any* text a model successfully reproduces this way will show near-zero perplexity almost by construction, regardless of whether the original text was actually predictable. Testing on three different chapters of varied human-written prose all returned the identical result (`perplexity 1.0`, same overall score) despite very different content — confirming the signal doesn't discriminate between inputs at all; it just reflects "the model confidently reproduced its own greedy output," which it does for nearly anything coherent.
2. **Impractically slow.** Generation-bound scoring (the model must produce roughly as much output as it reads) took 5-9 seconds per ~500-word chunk on LM Studio and ~52 seconds on Ollama in testing — full coverage of a real manuscript would take minutes to tens of minutes, or blow through any reasonable timeout with larger chunk sizes (see `MODEL_RUNNER_CONTEXT_TOKENS` below — a bigger context budget means fewer *but larger* chunks, which can make per-chunk latency worse rather than better on slow runners).

Neither problem is fixable by picking a better model or runner — they're inherent to the verbatim-echo technique itself. Direct `/v1/completions echo+logprobs` (the approach that would avoid both problems) remains non-functional against every runner tested so far.

### If you want to pick this back up

The plumbing is intact — env vars, chunking, timeout handling, similarity verification, `modelRunner.test.ts` — set these in your MCP client config's `env` block to exercise it (see the `human-vs-ai-mcp-server-with-model-runner` entry in [example-mcp.json](./example-mcp.json)), then flip `enabled` to `true` in `src/lib/detectors/modelPerplexity.ts`:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MODEL_RUNNER_URL` | yes | — | Base URL of your local model runner, e.g. `http://localhost:1234`. |
| `MODEL_RUNNER_MODEL` | no | first model returned by `GET /v1/models` | Pin a specific loaded model by name. |
| `MODEL_RUNNER_TIMEOUT_MS` | no | `60000` | Overall time budget for scoring a document. |
| `MODEL_RUNNER_CONTEXT_TOKENS` | no | conservative internal default | Size chunks against the model's actual context window. |

Other directions worth exploring instead, not yet tried here: llama.cpp's native server (the engine underneath both LM Studio and Ollama) has a documented `n_probs` parameter and ships a dedicated `llama-perplexity` CLI tool built for proper teacher-forced perplexity scoring — untested whether its HTTP server exposes prompt-token (not just generated-token) logprobs. vLLM is also known for complete OpenAI-compat logprobs+echo support but is heavier to set up. Note: Anthropic's API does not expose token logprobs at all, so Claude isn't an option here regardless of approach.

---

## Bundled engine perplexity

> **This is the perplexity signal this project uses, and it is enabled.** It ships with the package on Windows x64 and needs only a `.gguf` model path. It runs a model locally, in-process — do not confuse it with [HTTP model runner](#http-model-runner-disabled), a separate and disabled signal that talks to an external server.

A second, independent perplexity signal — this one measuring perplexity properly. Where the model-runner path above asks a chat model to echo text back and reads logprobs off its own generation (which greedy decoding makes meaningless), this path does **teacher-forced** scoring: the actual text is fed through the model and the model's probability for each *real* next token is read directly. No generation step, so none of the structural bias. This is the same technique llama.cpp's own `llama-perplexity` CLI uses.

**This signal is enabled**, unlike the model-runner one above — but it only does anything when `LLAMA_ENGINE_MODEL_PATH` points at a `.gguf` model. Unconfigured, it returns immediately, spawns no subprocess, and is simply absent from the report. Its anchors were fitted to 25 published novelists, and perplexity values are model-specific and don't transfer between models, so the anchors in `src/lib/detectors/llamaEnginePerplexity.ts` are only meaningful against the model they were measured with. Treat the signal as corroborating evidence rather than a verdict.

### How it works

A small Go helper (`native/llama-engine/`, shipped prebuilt) loads llama.cpp's engine (`llama.dll`) directly via [purego](https://github.com/ebitengine/purego) — no cgo, no HTTP server, no separate installation. It runs as a one-shot subprocess: the server spawns it, writes one JSON request to its stdin, reads one JSON response from its stdout, and it exits. Nothing is left running.

The engine ships inside the package (as an `optionalDependency` installed only on matching platforms). **The model does not** — you supply your own `.gguf` file. GGUF is required; llama.cpp cannot read safetensors, and converting a model yourself is out of scope here. Community GGUF quantizations exist on Hugging Face for most popular models.

Unlike the model-runner path, this signal demonstrably discriminates. Scored against `Qwen2.5-1.5B-Instruct.Q4_K_M`, a famous Dickens opening returns a perplexity of 1.7, LLM-flavoured boilerplate 11.3, idiosyncratic human prose 46.9, and random word salad 4016 — roughly three orders of magnitude of spread.

The anchors have been refitted twice as the human sample widened, and each time the human distribution proved broader than the sample before it showed. They now rest on **25 distinct published novelists** — mid-book excerpts from Project Gutenberg, Austen through Fitzgerald — which measured **15.7–38.7**, about twice the spread implied by the earlier handful of samples. Anchors are 6 (AI-like) and 30 (human-like). Full measurements and caveats are in [`docs/superpowers/notes/2026-07-25-llama-engine-calibration.md`](./docs/superpowers/notes/2026-07-25-llama-engine-calibration.md).

Sampling mid-book is deliberate. Famous openings are partly memorized by the scoring model and read ~10 perplexity points low (Austen's opening 12.4 versus 23.6 mid-book), so any corpus built from first pages would be badly skewed.

### What it can and cannot catch

Detection difficulty scales with the model that wrote the text, and the gap is large enough to matter more than any threshold choice. Three AI chapters of the same genre and length, scored against `Qwen2.5-1.5B-Instruct.Q4_K_M`:

| Author | Perplexity | Overall score | Verdict |
|---|---|---|---|
| llama-3-8b | 5.8 | 38 | uncertain |
| qwen3-14b | 7.2 | 32 | uncertain |
| Claude Opus 5 | 21.5 | **19** | **likely-human** |
| human authors (n=25) | 15.7-38.7 | not measured | not measured |
| human chapters (n=12) | 19.6-28.6 | 6-22 | likely-human / uncertain |

The 25-author corpus was scored for perplexity only, so it has no overall-score column; the overall range comes from the 12 contemporary chapters, which were measured across all signals.

Small and mid-size open models are three to four times more predictable than any human writing measured, saturating the signal. Frontier output sits **inside** the human range, and no threshold separates it.

Note what the last row of that table means in practice: **an AI-written chapter from a frontier model is reported as `likely-human`.** That is not a bug to tune away. Its perplexity of 21.5 sits in the middle of the 25-author human range, so any threshold that catches it also condemns a large share of real novelists — and false positives on human prose are the costlier error here. Read a low score as "shows none of the tells these heuristics look for", never as "written by a human".

The 25-author corpus sharpened this. The signal only separates text below roughly 13 perplexity; above that, AI and human measurements interleave outright. Sherwood Anderson measures 15.71 and an AI-written excerpt measures 15.81 — they receive the same score, because on this measurement they are the same. Anchors tight enough to flag that excerpt also flagged seven of the 25 novelists, so the anchors gave way instead.

**And the signal is partly measuring prose style, not authorship.** Ranked by perplexity, the corpus sorts by ornateness: plain modern declarative writing at the bottom (Anderson, Christie), ornate Victorian subordination at the top (Melville 38.7, Hardy 36.9, James 35.2). A plain contemporary stylist scores AI-like regardless of who wrote the text. Recalibration cannot fix that — it is what the measurement is.

The comparison also disproves the obvious confound: qwen3-14b shares its lineage with the Qwen scorer and still scored *higher* (less predictable) than llama-3-8b, so the signal is not measuring shared tokenizer or training family. One chapter per author, one genre, one prompt — and the Claude sample was written with knowledge of what these detectors measure.

### Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `LLAMA_ENGINE_MODEL_PATH` | yes | — | Absolute path to a `.gguf` model file. Unset means the detector does nothing, at zero cost. |
| `LLAMA_ENGINE_CTX_SIZE` | no | `2048` | Token window the text is split into. Larger windows score more context per pass but cost more memory and time. |
| `LLAMA_ENGINE_TIMEOUT_MS` | no | `60000` | Overall time budget. On expiry the helper returns whatever chunks completed rather than failing. |
| `LLAMA_ENGINE_HELPER_PATH` | no | resolved from the platform package | Development override pointing at a locally built helper binary. |

Setting `LLAMA_ENGINE_MODEL_PATH` is sufficient to activate the signal — the detector is enabled in code.

### Publishing

Two npm packages ship together: `human-vs-ai-mcp-server` (TypeScript, ~130 kB) and
`human-vs-ai-mcp-server-win32-x64` (the prebuilt engine, ~24 MB), pinned to each other at an exact
version. The platform package **must publish first** — the root pins it exactly, and because
optional dependencies fail open, publishing out of order gives users an install that succeeds and
silently has no perplexity signal.

The native binaries are gitignored build output, so a fresh clone has none of them. Publishing
that clone would produce a platform package containing only `package.json` and `README.md`, which
also installs cleanly and silently does nothing. `npm run check:native` guards against exactly
this (missing or empty binaries, no CPU backends staged, version drift from the pin) and runs both
as a release step and as the platform package's own `prepublishOnly`.

| command | does |
|---|---|
| `npm run check:native` | verify the platform package is publishable |
| `npm run release:dry` | full ordered dry run, publishes nothing |
| `npm run release` | build TS + native, check, publish platform, then publish root |

Pushing a `v*` tag runs the same sequence in CI as two ordered jobs — the platform package builds
on `windows-latest` (it needs Go and PowerShell), the root publishes on `ubuntu-latest` only after
it succeeds.

### Platform support

Windows x64 only for now. On any other platform the optional dependency isn't installed and the detector stays silent. See [`native/llama-engine/PLATFORMS.md`](./native/llama-engine/PLATFORMS.md) for what adding a platform involves — it is more than a recompile.

### Turning it on

1. Build the native helper: `npm run build:native` (needs Go 1.26+ and PowerShell; downloads the pinned llama.cpp release).
2. Point `LLAMA_ENGINE_MODEL_PATH` at a `.gguf` model. That is the only variable an installed copy needs — the helper resolves from the platform package automatically. `LLAMA_ENGINE_HELPER_PATH` is only for pointing at a locally built helper when working from a clone.
3. Keep `LLAMA_ENGINE_CTX_SIZE` at 512 if you're using the shipped anchors. They were measured at that chunk size, and changing it changes the numbers.

**If you point it at a different model, re-measure.** Score a corpus of known-human and known-AI
prose - ideally 15-20 human samples across distinct authors and genres, plus AI text from several
models - and replace `PERPLEXITY_AI_LIKE_ANCHOR`/`PERPLEXITY_HUMAN_LIKE_ANCHOR` in
`src/lib/detectors/llamaEnginePerplexity.ts` with what you measure, recording which model they
came from. The helper's JSON contract makes scoring a directory of files a short script.

### Cost

Roughly 19 seconds per 1,500 tokens on CPU with a 1.5B model, plus about a second of model load
per call - the helper is spawned fresh each time. That is fine for a chapter and impractical for
a whole novel; `LLAMA_ENGINE_TIMEOUT_MS` bounds it, and on expiry the helper returns whatever
chunks finished rather than failing.

---

## Testing

```bash
npm test
```

Runs the `detect_ai_usage` heuristic test suite (`src/lib/*.test.ts`) using Node's built-in test runner — no test framework dependency. `examples/` holds a few longer creative-writing fixtures for manually exercising the tools against realistic text.

---

## Design principles

- **Dependencies kept minimal.** Only `@modelcontextprotocol/sdk` (protocol implementation) and `zod` (input schema validation) are runtime dependencies. Small routines — tokenization, syllable counting, statistics — are hand-written rather than pulled in from third-party packages.
- **Explainable over opaque.** Every score is a weighted combination of named, inspectable signals, not a black-box model output.
- **Extensible by design.** Each detection signal is an isolated module implementing a shared `Detector` interface (`src/lib/detectors/`), and each humanization recommendation is an isolated check; adding a new one doesn't require touching the others. Third parties can add detection signals without forking the project at all — see [Plugins](#plugins).
