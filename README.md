# Human vs AI MCP Server

## Description

**`human-vs-ai-mcp-server`** is a Model Context Protocol (MCP) server that gives AI agents tools to reason about AI-authored text: estimating whether a piece of text was AI-generated, and getting concrete recommendations for making AI-leaning text read more naturally human.

Detection and recommendations are built on explainable, dependency-free stylometric heuristics (sentence-length burstiness, lexical diversity, known LLM stock phrases, readability uniformity, markdown-in-prose artifacts) rather than an opaque trained classifier — every score comes with the reasoning behind it. See [TOOLS.md](./TOOLS.md) for the full tool list and [`get_context`](./TOOLS.md#get_context) for in-depth methodology notes.

Written in TypeScript, it runs on Node.js using the stdio transport protocol, making it suitable for integration with any MCP-compatible client such as Claude Desktop or Claude Code.

---

## Table of Contents

- [Status](#status)
- [Installation](#installation)
- [Usage](#usage)
- [Tools](#tools)
- [Model runner (currently disabled)](#model-runner-currently-disabled)
- [Testing](#testing)
- [Design principles](#design-principles)

---

## Status

This project is under active development and **not yet published to npm** (no version has been tagged/released — that's intentional until the tool set is considered stable). Clone and build it locally for now; npm registry support is already wired up in `package.json` for when that day comes.

## Installation

### Prerequisites: Node.js

Install Node.js (LTS) from [nodejs.org](https://nodejs.org/), or via your platform's package manager. Verify with `node --version` and `npm --version`.

### From source (current)

```bash
git clone https://github.com/dmongrel/human-vs-ai-mcp-server.git
cd human-vs-ai-mcp-server
npm install
npm run build
```

### From npm (once published)

```bash
npm install -g human-vs-ai-mcp-server
```

To update later: `npm update -g human-vs-ai-mcp-server`

---

## Usage

Add a configuration block to your MCP client's config file (e.g., `claude_desktop_config.json` or `.mcp.json`). See [example-mcp.json](./example-mcp.json) for the local-build and global npm install entries side by side — keep only the entry you need.

**From a local build (current):**

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

**From a global npm install (once published):**

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

---

## Tools

See [TOOLS.md](./TOOLS.md) for the maintained tool list with input/output shapes. Summary:

- **`detect_ai_usage`** — estimate the likelihood that text was AI-generated, with a per-signal explanation.
- **`humanize_text`** — get actionable recommendations for making AI-leaning text read more naturally human.
- **`get_context`** — fetch detailed usage documentation for any tool on demand, so the tools' own descriptions can stay short.

Every analysis tool accepts input either as text passed directly (e.g. from an AI source over stdio) or via a local `filePath`, and can return its report inline over stdio or write it to a local file via `reportPath`.

---

## Model runner (currently disabled)

An optional **7th detection signal** — a real perplexity check against a language model, rather than a stylometric proxy for one — was investigated, using a local, OpenAI-compatible model runner such as [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/). **It's implemented but disabled by default** (`MODEL_PERPLEXITY_SIGNAL_ENABLED = false` in `src/lib/detectAiUsage.ts`) after investigation found it unreliable in practice. The client code (`src/lib/modelRunner.ts`) is kept as groundwork in case a better technique or runner support emerges later. With the signal disabled, the tools behave exactly as described above, with zero network calls — this section is documentation of the investigation, not a currently-usable feature.

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

The plumbing is intact — env vars, chunking, timeout handling, similarity verification, `modelRunner.test.ts` — set these in your MCP client config's `env` block to exercise it (see the `human-vs-ai-mcp-server-with-model-runner` entry in [example-mcp.json](./example-mcp.json)), then flip `MODEL_PERPLEXITY_SIGNAL_ENABLED` to `true` in `src/lib/detectAiUsage.ts`:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MODEL_RUNNER_URL` | yes | — | Base URL of your local model runner, e.g. `http://localhost:1234`. |
| `MODEL_RUNNER_MODEL` | no | first model returned by `GET /v1/models` | Pin a specific loaded model by name. |
| `MODEL_RUNNER_TIMEOUT_MS` | no | `60000` | Overall time budget for scoring a document. |
| `MODEL_RUNNER_CONTEXT_TOKENS` | no | conservative internal default | Size chunks against the model's actual context window. |

Other directions worth exploring instead, not yet tried here: llama.cpp's native server (the engine underneath both LM Studio and Ollama) has a documented `n_probs` parameter and ships a dedicated `llama-perplexity` CLI tool built for proper teacher-forced perplexity scoring — untested whether its HTTP server exposes prompt-token (not just generated-token) logprobs. vLLM is also known for complete OpenAI-compat logprobs+echo support but is heavier to set up. Note: Anthropic's API does not expose token logprobs at all, so Claude isn't an option here regardless of approach.

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
- **Extensible by design.** Each detection signal and each humanization recommendation is an isolated function; adding a new one doesn't require touching the others.
