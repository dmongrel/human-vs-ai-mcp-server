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
| `MODEL_RUNNER_TIMEOUT_MS` | no | `20000` | Overall time budget for scoring a document. Consumer-hardware-friendly default — raise it on slower machines. |

The model is auto-detected via the runner's `GET /v1/models` (whichever model is loaded is used — no model-name config needed). A small, fast model is all this needs: **Qwen2.5-0.5B-Instruct** is recommended (available in both LM Studio's and Ollama's catalogs); GPT-2 (124M) — the model GLTR itself used for this exact purpose — works as an even lighter fallback.

The whole document is scored (not sampled), split into sequential chunks to fit the model's context window, with results averaged across chunks. If the runner is unreachable, times out, or doesn't support the `echo`+`logprobs` completions shape this relies on, the signal is silently omitted and the other six signals carry the score, unaffected — this never blocks or fails a tool call.

**Known compatibility gap — LM Studio:** as of testing, LM Studio's `/v1/completions` endpoint accepts the `logprobs` parameter but always returns `logprobs: null` in the response, regardless of value. Its `/v1/chat/completions` endpoint does return real logprobs, but only for tokens the model generates itself — it has no `echo` support for scoring existing input text. Net effect: this signal currently fails open (silently omitted) against LM Studio. It's expected to work against runners whose OpenAI-compat layer implements `echo`+`logprobs` on `/v1/completions` correctly (Ollama has not yet been verified here) — if you hit this, it's a runner limitation, not a bug in this tool.

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
