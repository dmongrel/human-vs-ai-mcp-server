// Detailed usage docs, kept out of tool `description` fields so those stay
// short. Call the `get_context` tool with a topic to retrieve this content
// at runtime. Keep this in sync with TOOLS.md.

import { formatDetectorWeightsTable } from "./lib/detectAiUsage.js";

export const CONTEXT: Record<string, string> = {
  overview: `human-vs-ai-mcp-server exposes tools to (1) estimate whether a piece of text was AI-generated, and (2) get recommendations for making AI-leaning text read more naturally human.

Available tools: detect_ai_usage, humanize_text, get_context.

Input: every analysis tool accepts text one of two ways — pass it directly via 'text', or point at a local file via 'filePath'. Exactly one must be given.

Output: results are returned inline over stdio by default. Pass 'reportPath' to instead write the formatted report to a local file (directories are created as needed) and get back a short confirmation message.

Both detect_ai_usage and humanize_text also accept an optional 'type': "creative" (novels/creative writing) or "strategic" (business documents, presentations, marketing materials). If you called detect_ai_usage with a type, pass the same type to humanize_text so its recommendations use a consistent ruleset.

Both tools also accept an optional 'ignoreMd' boolean: if true, literal '*', '_', and '#' characters are stripped before analysis, so legitimate use of those characters (e.g. chapter headers, emphasis) isn't flagged as an AI markdown artifact. '-' bullet lines are unaffected. Pass the same ignoreMd value to both tools when calling them on the same text.

Both tools also accept an optional 'weights' object to override specific detector weights for that one call, keyed by detector id -- e.g. { "llama-engine-perplexity": 0.5 }. This does not change any file on disk; it only affects the current call. See { "topic": "detect_ai_usage" } for the full table of detector ids and their default weight per ruleset.

Call get_context with { "topic": "detect_ai_usage" } or { "topic": "humanize_text" } for details on each tool's scoring methodology and output shape.`,

  detect_ai_usage: `detect_ai_usage estimates the likelihood a text was AI-generated using explainable stylometric heuristics — it is NOT a trained classifier and should not be treated as a verdict.

Signals used (each is its own file under src/lib/detectors/, implementing the shared Detector interface — see src/lib/detectors/types.ts):
- Sentence-length burstiness: human writing varies sentence length more than typical LLM output (cf. Gehrmann et al., "GLTR", 2019; Mitchell et al., "DetectGPT", 2023).
- Lexical diversity: a rolling type-token ratio (simplified MATTR); AI text tends toward a narrower, more predictable vocabulary.
- AI stock-phrase usage: frequency of phrases commonly overused by LLMs ("delve into", "it's important to note", "in conclusion", etc.), compiled from public AI-detection write-ups.
- Readability uniformity: variance in Flesch Reading Ease across paragraphs; very uniform readability suggests a single generative process.
- Markdown-in-prose artifacts: bullet/header/bold markup left in what should be plain prose, a common copy-paste artifact from chat output.
- Em dash overuse: frequency of dashes used as a pause marker, a widely reported LLM stylistic tic (notably ChatGPT). Counts the em dash "—" and horizontal bar "―" anywhere, the en dash "–" and figure dash "‒" only when flanked by spaces, and the ASCII "--" only between spaces or between word characters. The guards matter: unspaced en/figure dashes are ordinary number-range typography ("1914–18"), "--flag" is a command-line option, and "---" is a markdown rule — none of those are stylistic tics. Models differ in which character they favour, so counting only "—" misses the tell entirely on some of them.
- N-gram repetition: diversity of 3-word sequences (trigrams); repeated trigrams are a known generation artifact (cf. Holtzman et al., "The Curious Case of Neural Text Degeneration", 2020).
- Paragraph coherence (CURRENTLY DISABLED): cosine similarity between adjacent paragraphs' content-word vectors. The premise — that AI text stays more tightly on-topic — was measured and does not hold for narrative prose, so the signal is switched off rather than reporting a number that means nothing.

Each signal contributes a weighted 0-1 AI-likelihood score; the weighted average becomes an overall 0-100 score with a verdict band: likely-human (<20), uncertain (20-45), likely-ai-generated (>45). Those bands are calibrated against measured scores: human narrative prose lands at 6-22, AI narrative prose at 19-38 depending on which model wrote it, and AI text stuffed with stock phrases and markdown at ~50. Note what those overlapping ranges mean: AI prose reads as 'uncertain' at best, and frontier-model prose reads as 'likely-human'. On current evidence that is the honest answer, not a threshold to tighten -- tightening it would report real novelists as machine-written.

WHAT THIS CAN AND CANNOT CATCH -- read this before reporting a low score as 'human'. Detection difficulty scales with the model that wrote the text. Measured on three AI chapters of matched genre and length: llama-3-8b scored 38 overall, qwen3-14b 32, and Claude Opus 5 only 19 -- which is a 'likely-human' verdict on genuinely AI-written text. Report that honestly if asked: the tool cannot distinguish frontier-model prose from human prose, and a 'likely-human' result is not evidence of human authorship. Small and mid-size open models are caught easily; frontier output is not distinguishable from human prose by these signals, and no threshold change fixes that. A low score means 'shows none of the tells these heuristics look for', NOT 'written by a human'. Report it that way.

The perplexity signal has a second limitation worth stating when reporting its number. Measured across 25 distinct published novelists, human perplexity ranges 15.7-38.7, and that range is ordered by prose style rather than by authorship: plain modern declarative writing sits at the bottom (Sherwood Anderson 15.7, Agatha Christie 17.1) and ornate Victorian subordination at the top (Melville 38.7, Hardy 36.9). AI measurements interleave with the low end -- an AI excerpt at 15.81 is scored identically to Anderson at 15.71. So a plain, unadorned contemporary style will pull this signal toward 'AI-like' on its own. Do not report a high perplexity score as evidence about authorship when the text is simply written plainly.

Readability uniformity has a related, capability-dependent limitation. Measured across 12 human chapters (variance 13.4-42.0) against 7 AI chapters spanning three models and two genres (variance 10.4-25.1): less capable or single-genre AI generation stays uniform and scores 58-97 on this signal, but two chapters written by varying genre (one hard SF, one space fantasy) scored 0 outright -- their variance sat above the human median. A capable, varied-register writer defeats this signal completely, the same way frontier models defeat perplexity. Do not treat a low readability-uniformity score as evidence of human authorship any more than a low perplexity score is.

INPUT LENGTH — this matters for how much to trust the number. Every threshold above was calibrated on ~1,200-word excerpts, so the tool is tuned for chapter-length text (roughly 500-3,000 words). Longer input is accepted and returns a result, but treat it as a rough screen: lexical diversity is a type-token ratio that falls mechanically as a document grows, readability variance saturates across very many paragraphs, and the optional perplexity engine may run out of its time budget before covering the whole text (the report says so when that happens). To analyze a book, run it a chapter at a time — that is both more accurate and tells you which chapter is the problem.

Input: { text? , filePath? , reportPath? , type? , ignoreMd? , weights? } — exactly one of text/filePath required; the rest optional. reportPath writes the report to a file instead of returning it inline (e.g. "DETECT-AI.md").

'type' selects a ruleset ("creative" or "strategic") that reweights the signals and adjusts markdown/em-dash saturation thresholds for that genre — see the "Rulesets" section below. Omit it for genre-agnostic default weights.

'weights' overrides one or more detector weights for this call only, keyed by detector id (e.g. { "readability-uniformity": 0.1 }). Applied after 'type' selects the ruleset's defaults, so it lets a caller start from a known baseline and adjust just the signals they want to change. An id that does not match any active detector is ignored, not rejected -- this lets a caller pass overrides for a plugin detector that may or may not be loaded. A negative weight throws. This never changes the server's actual defaults; it is scoped to the single call.

'ignoreMd' strips literal '*', '_', and '#' characters before analysis, neutralizing the markdown-in-prose signal's header and bold-run counts (but not '-' bullet lines) — useful for manuscripts that legitimately use those characters for chapter headers or emphasis.

Output: a formatted report opening with a legend (which end of the 0-100 scale is human vs AI, plus the verdict bands), then the overall score, verdict, the ruleset used, whether markdown was ignored, and a full breakdown of each signal's score and supporting detail, so the caller can see *why* the score landed where it did and disagree with individual signals.

This module is intentionally extensible: each detector is an isolated file implementing the Detector interface, registered in src/lib/detectors/index.ts. Adding a new built-in signal means adding one file and one array entry — no changes needed elsewhere. (There are two model-perplexity signals. The bundled llama.cpp-engine one does proper teacher-forced scoring and is enabled, though it only contributes when LLAMA_ENGINE_MODEL_PATH points at a .gguf model, and its thresholds are calibrated against one specific model on a small sample — treat it as corroborating evidence, not a verdict. The other one talks to an external model runner over HTTP (MODEL_RUNNER_URL) and is DISABLED -- setting that variable does not activate it, and it never appears in a report. Both signals 'run a model', which makes them easy to confuse: the bundled engine is the one this project uses. The HTTP one was measured and returns ~1.0 for essentially any text, because it reads logprobs off the model's own greedy reproduction instead of scoring the real tokens. The paragraph-coherence signal is also disabled: measurement showed its premise (AI staying more tightly on-topic) does not hold for narrative prose, so it discriminated in neither direction. See README.md's "Bundled engine perplexity" and "HTTP model runner (disabled)" sections.) Third parties can also add signals without forking the project at all, by dropping plugin files in a directory pointed to by the PLUGINS_DIR environment variable — see README.md's "Plugins" section.

Rulesets: each detector file owns its own per-genre weight (and, where relevant, its own calibration thresholds), keyed by "default" | "creative" | "strategic":
- creative: assumes fiction/narrative prose. Sentence-length and readability variance are expected (burstiness and readability weights raised); markdown and em dashes are strongly out of place (markdown saturates fast; em dashes are tolerated more since they're a legitimate stylistic device, but still weighted).
- strategic: assumes business documents, presentations, or marketing copy. Structured markdown (bullets/headers) is a normal genre convention, so its weight and saturation threshold are relaxed; punchy, uniform sentences are normal (burstiness weight lowered); AI stock-phrase frequency is weighted heaviest, since business buzzwords overlap heavily with known LLM tells.

The exact weight table (below this text) is generated live from each detector's own weight() function every time this topic is requested, never hand-copied, so it cannot drift from the values actually applied and reflects any plugin detector currently loaded from PLUGINS_DIR. Use the id column as the key for the 'weights' override parameter above.`,

  humanize_text: `humanize_text reuses detect_ai_usage's signals to produce concrete, actionable recommendations for making text read more naturally human. It does not rewrite the text — the caller decides how to apply each suggestion.

Recommendation categories currently implemented (see src/lib/humanizeText.ts):
- Overused AI stock phrases, with the specific phrases and counts found.
- Uniform sentence length, when sentence-length variation is unusually low.
- Uniform readability across paragraphs, when Flesch Reading Ease barely varies paragraph to paragraph.
- Chat-style markdown left in prose (bullets/headers) when the text otherwise reads as prose.
- Overused em dashes, suggesting each "—" be replaced with a space-hyphen-space ( - ) or the sentence restructured.
- Excessive hedging language ("it's worth noting", "arguably", etc.).

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
  // Computed here, at call time, rather than baked into the CONTEXT template
  // literals above: those are built once when this module first loads, so an
  // interpolation inside one would freeze at server-start values. Plugin
  // detectors are scanned fresh from PLUGINS_DIR on every getDetectors() call
  // specifically so they can be added without a restart -- baking the table
  // in statically would silently exclude any plugin added after boot.
  const body = key === "detect_ai_usage" ? `${CONTEXT[key]}\n\n${formatDetectorWeightsTable()}` : CONTEXT[key];
  return _updateNotice ? `${_updateNotice}${body}` : body;
}
