#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getContext } from "./context.js";
import { detectAiUsage, formatDetectionReport } from "./lib/detectAiUsage.js";
import { humanizeText, formatHumanizeReport } from "./lib/humanizeText.js";
import { deliverOutput, resolveInputText } from "./lib/io.js";

const server = new McpServer({
  name: "human-vs-ai-mcp-server",
  version: "1.0.0",
});

const textSourceSchema = {
  text: z.string().optional().describe("Text to analyze, passed directly."),
  filePath: z.string().optional().describe("Local path to a file containing the text to analyze."),
  reportPath: z.string().optional().describe("If set, write the report to this local file instead of returning it inline."),
  type: z
    .enum(["creative", "strategic"])
    .optional()
    .describe("Ruleset to apply: 'creative' for novels/creative writing, 'strategic' for business documents, presentations, or marketing materials. Omit for a genre-agnostic default."),
  ignoreMd: z
    .boolean()
    .optional()
    .describe("If true, ignore markdown markup ('*', '_', and '#' characters only) before analysis, so legitimate use of those characters (e.g. chapter headers) isn't flagged as an AI artifact."),
};

function requireOneSource(input: { text?: string; filePath?: string }) {
  if (!input.text && !input.filePath) {
    throw new Error("Provide either 'text' or 'filePath'.");
  }
  if (input.text && input.filePath) {
    throw new Error("Provide only one of 'text' or 'filePath', not both.");
  }
}

server.registerTool(
  "detect_ai_usage",
  {
    title: "Detect AI Usage",
    description: "Estimate the likelihood that text was AI-generated, using explainable stylometric heuristics. Call get_context({ topic: 'detect_ai_usage' }) for methodology details.",
    inputSchema: textSourceSchema,
  },
  async ({ text, filePath, reportPath, type, ignoreMd }) => {
    requireOneSource({ text, filePath });
    const input = await resolveInputText({ text, filePath });
    const report = detectAiUsage(input, type, ignoreMd);
    const output = await deliverOutput(formatDetectionReport(report), reportPath);
    return { content: [{ type: "text", text: output }] };
  }
);

server.registerTool(
  "humanize_text",
  {
    title: "Humanize Text",
    description: "Get actionable recommendations for making AI-leaning text read more naturally human. Call get_context({ topic: 'humanize_text' }) for details.",
    inputSchema: textSourceSchema,
  },
  async ({ text, filePath, reportPath, type, ignoreMd }) => {
    requireOneSource({ text, filePath });
    const input = await resolveInputText({ text, filePath });
    const report = humanizeText(input, type, ignoreMd);
    const output = await deliverOutput(formatHumanizeReport(report), reportPath);
    return { content: [{ type: "text", text: output }] };
  }
);

server.registerTool(
  "get_context",
  {
    title: "Get Tool Context",
    description: "Get detailed usage documentation for this server's tools (kept out of the short tool descriptions to save context).",
    inputSchema: {
      topic: z
        .enum(["overview", "detect_ai_usage", "humanize_text", "get_context"])
        .optional()
        .describe("Which topic to get documentation for. Defaults to 'overview'."),
    },
  },
  async ({ topic }) => {
    return { content: [{ type: "text", text: getContext(topic) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting server:", error);
  process.exit(1);
});
