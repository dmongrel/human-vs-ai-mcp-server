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
- [Model runner (optional)](#model-runner-optional)
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

## Model runner (optional)

Both tools support an optional **7th detection signal** — a real perplexity check against a language model, rather than a stylometric proxy for one — by calling out to a local, OpenAI-compatible model runner such as [LM Studio](https://lmstudio.ai/) or [Ollama](https://ollama.com/). This is entirely opt-in and **localhost-only**: with nothing configured, the tools behave exactly as described above, with zero network calls.

To enable it, set these environment variables in your MCP client config (see the `human-vs-ai-mcp-server-with-model-runner` entry in [example-mcp.json](./example-mcp.json)):

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MODEL_RUNNER_URL` | yes (to activate) | — | Base URL of your local model runner, e.g. `http://localhost:1234`. Unset ⇒ signal is skipped entirely. |
| `MODEL_RUNNER_MODEL` | no | first model returned by `GET /v1/models` | Pin a specific loaded model by name, instead of relying on the runner's model-listing order — useful when several models are loaded at once. |
| `MODEL_RUNNER_TIMEOUT_MS` | no | `60000` | Overall time budget for scoring a document. Generation-based scoring (see below) is slow — this default assumes consumer hardware. |
| `MODEL_RUNNER_CONTEXT_TOKENS` | no | conservative internal default | Set to the loaded model's actual context window (e.g. `32000`) to size chunks more efficiently — fewer, larger requests instead of many small ones. Optional: the default is safe on virtually any model's context, just less efficient on large-context ones. |

### How scoring works

The whole document is scored (not sampled), split into sequential chunks sized to fit the model's context window, with results averaged across chunks. If the runner is unreachable, times out, or the model's response isn't trustworthy enough to use (see below), the signal is silently omitted and the other six signals carry the score, unaffected — this never blocks or fails a tool call.

**Technique — verbatim-echo, not direct `echo`:** the "obvious" approach — `POST /v1/completions` with `echo: true, logprobs: 1`, reading the input text's own token logprobs straight back — was tested against a real LM Studio instance and found non-functional there: `/v1/completions` accepts the `logprobs` parameter but always returns `logprobs: null`, regardless of value or `max_tokens`. `/v1/chat/completions` *does* return real logprobs, but only for tokens the model generates itself (no `echo` support). So instead: the model is asked to repeat each chunk back verbatim via `/v1/chat/completions`, and logprobs are read off its own reproduction. A similarity check (Levenshtein-based, ≥90% match required) verifies the reproduction is trustworthy before using it — a bad or diverging echo is simply discarded per-chunk, never used to compute a misleading score.

This means the model matters more than it would for a direct echo approach. Verified against a real LM Studio instance across several models:

| Model | Result |
|---|---|
| `meta-llama-3-8b-instruct` | Works — exact match, real logprobs, no reasoning overhead (~9s per ~500-word chunk) |
| `ai-detection-gutenberg-human-formatted-ai-v1-sft-qwen-3b-dpo` | Works, faster (~5s per ~500-word chunk), exact match |
| `qwen2.5-0.5b-instruct` | Fails — doesn't reliably follow verbatim-repetition instructions; output diverges from input |
| `google/gemma-4-12b-qat`, `qwen3.6-35b-a3b-mtp` | Fail — both route through an internal reasoning/"thinking" step that consumes the token budget before any real content is emitted |

**Practical guidance:** use a capable instruct model that isn't a "thinking"/reasoning model by default. Small models may not follow the literal-repetition instruction reliably; reasoning models burn the budget on internal chain-of-thought before producing usable output. If your runner/model doesn't work well, the signal fails open safely either way — you just won't get the 7th signal.

Because this technique is generation-bound (the model must produce roughly as much output as it reads), it's meaningfully slower than a true single-pass echo would be — full coverage of a long manuscript can take longer than the default timeout allows, in which case the report transparently shows partial chunk coverage rather than failing.

Net effect: this signal currently fails open (silently omitted) against LM Studio as commonly configured. It's expected to work against runners whose OpenAI-compat layer implements `echo`+`logprobs` on `/v1/completions` correctly (Ollama has not yet been verified here) — if you hit this, it's a runner limitation, not a bug in this tool.

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
