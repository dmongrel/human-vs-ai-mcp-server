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
- [Testing](#testing)
- [Design principles](#design-principles)

---

## Status

This project is published to npm as [`human-vs-ai-mcp-server`](https://www.npmjs.com/package/human-vs-ai-mcp-server).

## Installation

### Prerequisites: Node.js

Install Node.js (LTS) from [nodejs.org](https://nodejs.org/), or via your platform's package manager. Verify with `node --version` and `npm --version`.

### From npm (recommended)

```bash
npm install -g human-vs-ai-mcp-server
```

To update later: `npm update -g human-vs-ai-mcp-server`

### From source

```bash
git clone https://github.com/dmongrel/human-vs-ai-mcp-server.git
cd human-vs-ai-mcp-server
npm install
npm run build
```

---

## Usage

Add a configuration block to your MCP client's config file (e.g., `claude_desktop_config.json` or `.mcp.json`). See [example-mcp.json](./example-mcp.json) for the global npm install and local-build entries side by side — keep only the entry you need.

**From a global npm install (recommended):**

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

---

## Tools

See [TOOLS.md](./TOOLS.md) for the maintained tool list with input/output shapes. Summary:

- **`detect_ai_usage`** — estimate the likelihood that text was AI-generated, with a per-signal explanation.
- **`humanize_text`** — get actionable recommendations for making AI-leaning text read more naturally human.
- **`get_context`** — fetch detailed usage documentation for any tool on demand, so the tools' own descriptions can stay short.

Every analysis tool accepts input either as text passed directly (e.g. from an AI source over stdio) or via a local `filePath`, and can return its report inline over stdio or write it to a local file via `reportPath`.

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
