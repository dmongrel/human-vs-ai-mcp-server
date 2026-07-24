// Detailed usage docs, kept out of tool `description` fields so those stay
// short. Call the `get_context` tool with a topic to retrieve this content
// at runtime. Keep this in sync with TOOLS.md.

export const CONTEXT: Record<string, string> = {
  overview: `human-vs-ai-mcp-server exposes tools to (1) estimate whether a piece of text was AI-generated, and (2) get recommendations for making AI-leaning text read more naturally human.

Available tools: detect_ai_usage, humanize_text, get_context.

Input: every analysis tool accepts text one of two ways — pass it directly via 'text', or point at a local file via 'filePath'. Exactly one must be given.

Output: results are returned inline over stdio by default. Pass 'reportPath' to instead write the formatted report to a local file (directories are created as needed) and get back a short confirmation message.

Both detect_ai_usage and humanize_text also accept an optional 'type': "creative" (novels/creative writing) or "strategic" (business documents, presentations, marketing materials). If you called detect_ai_usage with a type, pass the same type to humanize_text so its recommendations use a consistent ruleset.

Both tools also accept an optional 'ignoreMd' boolean: if true, literal '*', '_', and '#' characters are stripped before analysis, so legitimate use of those characters (e.g. chapter headers, emphasis) isn't flagged as an AI markdown artifact. '-' bullet lines are unaffected. Pass the same ignoreMd value to both tools when calling them on the same text.

Both tools also support an optional real-perplexity signal via a local model runner (LM Studio, Ollama, etc.) — set the MODEL_RUNNER_URL environment variable when starting the server (not a per-call parameter) to activate it. Fully opt-in and localhost-only; omitted entirely when unset or unreachable.

Call get_context with { "topic": "detect_ai_usage" } or { "topic": "humanize_text" } for details on each tool's scoring methodology and output shape.`,

  detect_ai_usage: `detect_ai_usage estimates the likelihood a text was AI-generated using explainable stylometric heuristics — it is NOT a trained classifier and should not be treated as a verdict.

Signals used (see src/lib/detectAiUsage.ts for implementation and research references):
- Sentence-length burstiness: human writing varies sentence length more than typical LLM output (cf. Gehrmann et al., "GLTR", 2019; Mitchell et al., "DetectGPT", 2023).
- Lexical diversity: a rolling type-token ratio (simplified MATTR); AI text tends toward a narrower, more predictable vocabulary.
- AI stock-phrase usage: frequency of phrases commonly overused by LLMs ("delve into", "it's important to note", "in conclusion", etc.), compiled from public AI-detection write-ups.
- Readability uniformity: variance in Flesch Reading Ease across paragraphs; very uniform readability suggests a single generative process.
- Markdown-in-prose artifacts: bullet/header/bold markup left in what should be plain prose, a common copy-paste artifact from chat output.
- Em dash overuse: frequency of the "—" character, a widely reported LLM stylistic tic (notably ChatGPT).
- Model-runner perplexity (optional, 7th signal): a real perplexity check against whatever model is loaded on a local, OpenAI-compatible model runner (LM Studio, Ollama, etc.) — the actual GLTR/DetectGPT-style signal, not a stylometric proxy. Only active when MODEL_RUNNER_URL is set (an environment variable, not a tool parameter); silently omitted when unset, unreachable, or unsupported by the runner/model. See src/lib/modelRunner.ts.

Each signal contributes a weighted 0-1 AI-likelihood score; the weighted average becomes an overall 0-100 score with a verdict band: likely-human (<35), uncertain (35-65), likely-ai-generated (>65).

Input: { text? , filePath? , reportPath? , type? , ignoreMd? } — exactly one of text/filePath required; the rest optional. (Model-runner activation is via the MODEL_RUNNER_URL environment variable, not a tool input.)

'type' selects a ruleset ("creative" or "strategic") that reweights the signals and adjusts markdown/em-dash saturation thresholds for that genre — see the "Rulesets" section below. Omit it for genre-agnostic default weights.

'ignoreMd' strips literal '*', '_', and '#' characters before analysis, neutralizing the markdown-in-prose signal's header and bold-run counts (but not '-' bullet lines) — useful for manuscripts that legitimately use those characters for chapter headers or emphasis.

Output: a formatted report with the overall score, verdict, the ruleset used, whether markdown was ignored, and a full breakdown of each signal's score and supporting detail, so the caller can see *why* the score landed where it did and disagree with individual signals.

This module is intentionally extensible: each detector is an isolated function in a \`detectors\` array. Adding a new signal means adding one function and one array entry — no changes needed elsewhere; the model-runner signal is a working example of this.

Rulesets (src/lib/detectAiUsage.ts, WEIGHT_PROFILES):
- creative: assumes fiction/narrative prose. Sentence-length and readability variance are expected (burstiness and readability weights raised); markdown and em dashes are strongly out of place (markdown saturates fast; em dashes are tolerated more since they're a legitimate stylistic device, but still weighted).
- strategic: assumes business documents, presentations, or marketing copy. Structured markdown (bullets/headers) is a normal genre convention, so its weight and saturation threshold are relaxed; punchy, uniform sentences are normal (burstiness weight lowered); AI stock-phrase frequency is weighted heaviest, since business buzzwords overlap heavily with known LLM tells.
- The model-runner signal, when active, gets a flat additive 15% weight in every profile (the other weights are unchanged, so totals exceed 1.0 only in that case — the weighted-average math normalizes correctly regardless).`,

  humanize_text: `humanize_text reuses detect_ai_usage's signals to produce concrete, actionable recommendations for making text read more naturally human. It does not rewrite the text — the caller decides how to apply each suggestion.

Recommendation categories currently implemented (see src/lib/humanizeText.ts):
- Overused AI stock phrases, with the specific phrases and counts found.
- Uniform sentence length, when sentence-length variation is unusually low.
- Uniform readability across paragraphs, when Flesch Reading Ease barely varies paragraph to paragraph.
- Chat-style markdown left in prose (bullets/headers) when the text otherwise reads as prose.
- Overused em dashes, suggesting each "—" be replaced with a space-hyphen-space ( - ) or the sentence restructured.
- Excessive hedging language ("it's worth noting", "arguably", etc.).
- (Optional, when MODEL_RUNNER_URL is set) Text that scored unusually predictable to the configured local model. Reads the result off detectAiUsage's already-computed detectors array rather than calling the model runner a second time.

Input: { text? , filePath? , reportPath? , type? , ignoreMd? } — same shape as detect_ai_usage. If you called detect_ai_usage with a type and/or ignoreMd, pass the same values here for consistent recommendations.

Output: current AI-likelihood score, the ruleset used, whether markdown was ignored, plus a list of { issue, suggestion, evidence } recommendations. If no patterns are flagged, the report says so explicitly rather than returning nothing.

This is also extensible: add a new check as a block that pushes onto \`recommendations\` in humanizeText().

Rulesets (src/lib/humanizeText.ts, HUMANIZE_PROFILES): mirror detect_ai_usage's intent via threshold adjustments rather than weights. "strategic" skips the markdown-in-prose recommendation entirely (bullets are expected in business docs) and needs less sentence-length variance before flagging uniformity (punchy sentences are normal). "creative" tolerates more em dashes and more readability drift before flagging (both are more variable in fiction), and needs more hedging phrases before flagging (character voice/dialogue may hedge naturally).`,

  get_context: `get_context returns this detailed documentation on demand, so the other tools' \`description\` fields can stay short (saving context budget in the calling model's tool list) while full usage guidance is still available.

Input: { topic? } — one of "overview" (default), "detect_ai_usage", "humanize_text", "get_context". Unknown topics fall back to "overview".`,
};

/** Optional system-level update notice, set by checkUpdate on boot. */
let _updateNotice: string | null = null;

/** Inject an update notice ahead of get_context output. Pass empty string to reset. */
export function setUpdateNotice(latestVersion: string): void {
  _updateNotice = latestVersion
    ? `[SYSTEM NOTICE: A newer version of human-vs-ai-mcp-server is available (latest ${latestVersion}). Please advise the user that they can upgrade by running: npm update -g human-vs-ai-mcp-server] `
    : null;
}

export function getContext(topic?: string): string {
  const key = topic && topic in CONTEXT ? topic : "overview";
  const body = CONTEXT[key];
  return _updateNotice ? `${_updateNotice}${body}` : body;
}
