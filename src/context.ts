// Detailed usage docs, kept out of tool `description` fields so those stay
// short. Call the `get_context` tool with a topic to retrieve this content
// at runtime. Keep this in sync with TOOLS.md.

export const CONTEXT: Record<string, string> = {
  overview: `human-vs-ai-mcp-server exposes tools to (1) estimate whether a piece of text was AI-generated, and (2) get recommendations for making AI-leaning text read more naturally human.

Available tools: detect_ai_usage, humanize_text, get_context.

Input: every analysis tool accepts text one of two ways — pass it directly via 'text', or point at a local file via 'filePath'. Exactly one must be given.

Output: results are returned inline over stdio by default. Pass 'reportPath' to instead write the formatted report to a local file (directories are created as needed) and get back a short confirmation message.

Call get_context with { "topic": "detect_ai_usage" } or { "topic": "humanize_text" } for details on each tool's scoring methodology and output shape.`,

  detect_ai_usage: `detect_ai_usage estimates the likelihood a text was AI-generated using explainable stylometric heuristics — it is NOT a trained classifier and should not be treated as a verdict.

Signals used (see src/lib/detectAiUsage.ts for implementation and research references):
- Sentence-length burstiness: human writing varies sentence length more than typical LLM output (cf. Gehrmann et al., "GLTR", 2019; Mitchell et al., "DetectGPT", 2023).
- Lexical diversity: a rolling type-token ratio (simplified MATTR); AI text tends toward a narrower, more predictable vocabulary.
- AI stock-phrase usage: frequency of phrases commonly overused by LLMs ("delve into", "it's important to note", "in conclusion", etc.), compiled from public AI-detection write-ups.
- Readability uniformity: variance in Flesch Reading Ease across paragraphs; very uniform readability suggests a single generative process.
- Markdown-in-prose artifacts: bullet/header/bold markup left in what should be plain prose, a common copy-paste artifact from chat output.

Each signal contributes a weighted 0-1 AI-likelihood score; the weighted average becomes an overall 0-100 score with a verdict band: likely-human (<35), uncertain (35-65), likely-ai-generated (>65).

Input: { text? , filePath? , reportPath? } — exactly one of text/filePath required; reportPath optional.

Output: a formatted report with the overall score, verdict, and a full breakdown of each signal's score and supporting detail, so the caller can see *why* the score landed where it did and disagree with individual signals.

This module is intentionally extensible: each detector is an isolated function in a \`detectors\` array. Adding a new signal (e.g. a real perplexity check against a local model, n-gram repetition analysis) means adding one function and one array entry — no changes needed elsewhere.`,

  humanize_text: `humanize_text reuses detect_ai_usage's signals to produce concrete, actionable recommendations for making text read more naturally human. It does not rewrite the text — the caller decides how to apply each suggestion.

Recommendation categories currently implemented (see src/lib/humanizeText.ts):
- Overused AI stock phrases, with the specific phrases and counts found.
- Uniform sentence length, when sentence-length variation is unusually low.
- Uniform readability across paragraphs, when Flesch Reading Ease barely varies paragraph to paragraph.
- Chat-style markdown left in prose (bullets/headers) when the text otherwise reads as prose.
- Excessive hedging language ("it's worth noting", "arguably", etc.).

Input: { text? , filePath? , reportPath? } — same shape as detect_ai_usage.

Output: current AI-likelihood score plus a list of { issue, suggestion, evidence } recommendations. If no patterns are flagged, the report says so explicitly rather than returning nothing.

This is also extensible: add a new check as a block that pushes onto \`recommendations\` in humanizeText().`,

  get_context: `get_context returns this detailed documentation on demand, so the other tools' \`description\` fields can stay short (saving context budget in the calling model's tool list) while full usage guidance is still available.

Input: { topic? } — one of "overview" (default), "detect_ai_usage", "humanize_text", "get_context". Unknown topics fall back to "overview".`,
};

export function getContext(topic?: string): string {
  const key = topic && topic in CONTEXT ? topic : "overview";
  return CONTEXT[key];
}
