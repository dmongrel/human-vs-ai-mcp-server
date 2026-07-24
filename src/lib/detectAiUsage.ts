// Heuristic AI-text detection.
//
// This is NOT a trained classifier — it is a transparent, explainable set of
// stylometric signals drawn from published detection research:
//
//   - Burstiness (sentence-length variance): human writing mixes short and
//     long sentences; LLM output tends toward more uniform sentence length.
//     See Gehrmann, Strobelt & Rush, "GLTR: Statistical Detection and
//     Visualization of Generated Text" (2019); burstiness/perplexity framing
//     also used by Mitchell et al., "DetectGPT" (2023).
//   - Lexical diversity (type-token ratio over a rolling window, i.e. a
//     simplified MATTR): LLM output frequently reuses a narrower vocabulary
//     relative to text length than human writing.
//   - Overused LLM stock phrases ("delve into", "it's important to note",
//     etc.), compiled from public AI-detection write-ups — see aiPhrases.ts.
//   - Readability uniformity: per-paragraph Flesch Reading Ease scores that
//     barely vary suggest a single generative process rather than a human
//     author's natural drift in register.
//   - Markdown-in-prose: headers/bullets/bold markup embedded in what should
//     be plain prose, a common artifact of copy-pasted chat output.
//   - Em dash overuse: frequency of the "—" character, a widely reported
//     stylistic tic of LLM output (notably ChatGPT) as a default
//     parenthetical/pause marker.
//   - Model-runner perplexity (optional): a real perplexity check against
//     whatever model is loaded on a local, OpenAI-compatible model runner
//     (LM Studio, Ollama, etc.) — the actual GLTR/DetectGPT-style signal,
//     rather than a stylometric proxy for it. Only active when
//     MODEL_RUNNER_URL is configured; silently omitted otherwise. See
//     modelRunner.ts.
//
// Each detector is intentionally isolated so new signals can be added
// without touching the others — see `detectors` array below.

import { AI_TELL_PHRASES, countAiTellPhrases } from "./aiPhrases.js";
import { scorePerplexity } from "./modelRunner.js";
import { clamp, countSyllables, mean, splitParagraphs, splitSentences, stdev, stripMarkdownMarkup, tokenizeWords } from "./text.js";

export type DocumentType = "creative" | "strategic";

export interface DetectorResult {
  name: string;
  weight: number;
  /** 0 = strongly human-like signal, 1 = strongly AI-like signal */
  score: number;
  detail: string;
}

export interface DetectionReport {
  overallScore: number; // 0-100, likelihood of AI generation
  verdict: "likely-human" | "uncertain" | "likely-ai-generated";
  type: DocumentType | "default";
  ignoreMd: boolean;
  wordCount: number;
  sentenceCount: number;
  detectors: DetectorResult[];
  caveat: string;
}

// Per-signal weights and tunable thresholds, keyed by document type. The
// "default" profile (no type given) is genre-agnostic. "creative" assumes
// prose meant to read as fiction/narrative, where sentence-length and
// readability variance are expected and markdown/em-dash artifacts are
// strongly out of place. "strategic" assumes business documents,
// presentations, or marketing copy, where structured markdown (bullets,
// headers) is a normal genre convention and buzzword-heavy AI stock phrases
// are the strongest signal.
interface WeightProfile {
  burstiness: number;
  lexicalDiversity: number;
  aiPhrase: number;
  readability: number;
  markdown: number;
  emDash: number;
  /** Weight for the optional model-runner perplexity signal, when active. */
  modelPerplexity: number;
  /** Markdown line-density that saturates the markdown score at 1.0. Higher = more tolerant. */
  markdownDensitySaturation: number;
  /** Em dashes per 1000 words that saturates the em-dash score at 1.0. Higher = more tolerant. */
  emDashPer1000Saturation: number;
}

// modelPerplexity is a flat, additive 15% weight in every profile. The
// original six weights are deliberately left unchanged (they still sum to
// 1.0 on their own, matching today's behavior when the model runner is
// unconfigured — the common case). When the 7th detector IS active, the raw
// weights sum to 1.15; that's fine because `totalWeight` normalization in
// detectAiUsage() already divides by the actual sum of active weights, so
// the overall score stays mathematically correct either way — model
// perplexity just ends up contributing ~13% of the blended score rather
// than exactly 15%. This is a reasonable default, not a genre-tuned or
// empirically calibrated split, same as every other weight/threshold in
// this table. Worth revisiting once there's real-world data on how the
// signal behaves per genre.
const WEIGHT_PROFILES: Record<"default" | DocumentType, WeightProfile> = {
  default: {
    burstiness: 0.2,
    lexicalDiversity: 0.15,
    aiPhrase: 0.2,
    readability: 0.15,
    markdown: 0.15,
    emDash: 0.15,
    modelPerplexity: 0.15,
    markdownDensitySaturation: 0.25,
    emDashPer1000Saturation: 8,
  },
  creative: {
    burstiness: 0.25,
    lexicalDiversity: 0.2,
    aiPhrase: 0.15,
    readability: 0.2,
    markdown: 0.15,
    emDash: 0.05,
    modelPerplexity: 0.15,
    markdownDensitySaturation: 0.1, // fiction should have virtually no markdown
    emDashPer1000Saturation: 16, // em dashes are a legitimate stylistic device in prose
  },
  strategic: {
    burstiness: 0.1, // punchy, uniform sentences are normal in business writing
    lexicalDiversity: 0.15,
    aiPhrase: 0.4, // buzzword-heavy AI phrasing is the strongest tell in this genre
    readability: 0.15,
    markdown: 0.05, // bullets/headers are an expected genre convention
    emDash: 0.15,
    modelPerplexity: 0.15,
    markdownDensitySaturation: 1.0,
    emDashPer1000Saturation: 6, // business prose rarely uses em dashes stylistically
  },
};

function burstinessDetector(sentences: string[], profile: WeightProfile): DetectorResult {
  if (sentences.length < 4) {
    return { name: "sentence-length burstiness", weight: profile.burstiness, score: 0.5, detail: "Not enough sentences to measure variance reliably." };
  }
  const lengths = sentences.map((s) => tokenizeWords(s).length).filter((n) => n > 0);
  const m = mean(lengths);
  const sd = stdev(lengths);
  const coefficientOfVariation = m > 0 ? sd / m : 0;
  // Human prose typically has CoV well above ~0.4; uniform AI prose often
  // sits below ~0.35. Map CoV to an AI-likelihood score (lower CoV -> higher score).
  const score = clamp(1 - coefficientOfVariation / 0.6);
  return {
    name: "sentence-length burstiness",
    weight: profile.burstiness,
    score,
    detail: `Mean sentence length ${m.toFixed(1)} words, stdev ${sd.toFixed(1)} (coefficient of variation ${coefficientOfVariation.toFixed(2)}). Low variation suggests uniform, AI-typical pacing.`,
  };
}

function lexicalDiversityDetector(words: string[], profile: WeightProfile): DetectorResult {
  if (words.length < 50) {
    return { name: "lexical diversity", weight: profile.lexicalDiversity, score: 0.5, detail: "Text too short for a reliable type-token ratio." };
  }
  const windowSize = 50;
  const ratios: number[] = [];
  for (let i = 0; i + windowSize <= words.length; i += windowSize) {
    const window = words.slice(i, i + windowSize);
    ratios.push(new Set(window).size / windowSize);
  }
  const avgTtr = mean(ratios);
  // Typical human MATTR-50 sits ~0.68-0.78; LLM output often runs lower,
  // ~0.55-0.68, due to more predictable word choice.
  const score = clamp((0.72 - avgTtr) / 0.2);
  return {
    name: "lexical diversity",
    weight: profile.lexicalDiversity,
    score,
    detail: `Average type-token ratio (50-word windows): ${avgTtr.toFixed(2)}. Lower diversity suggests more predictable, AI-typical word choice.`,
  };
}

function aiPhraseDetector(lowerText: string, totalWords: number, profile: WeightProfile): DetectorResult {
  const hits = countAiTellPhrases(lowerText);
  const totalHits = hits.reduce((a, h) => a + h.count, 0);
  const per1000 = totalWords > 0 ? (totalHits / totalWords) * 1000 : 0;
  // 0 hits/1000 words -> 0 score; ~6+/1000 -> saturate near 1.
  const score = clamp(per1000 / 6);
  const topHits = hits
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((h) => `- "${h.phrase}" x${h.count}`)
    .join("\n");
  return {
    name: "AI stock-phrase usage",
    weight: profile.aiPhrase,
    score,
    detail: totalHits > 0
      ? `${totalHits} hits (${per1000.toFixed(1)} per 1000 words) from a list of ${AI_TELL_PHRASES.length} known LLM stock phrases:\n${topHits}`
      : "No known LLM stock phrases detected.",
  };
}

function readabilityUniformityDetector(paragraphs: string[], profile: WeightProfile): DetectorResult {
  if (paragraphs.length < 3) {
    return { name: "readability uniformity", weight: profile.readability, score: 0.5, detail: "Not enough paragraphs to compare readability across the text." };
  }
  const scores = paragraphs.map(fleschReadingEase).filter((s) => Number.isFinite(s));
  if (scores.length < 3) {
    return { name: "readability uniformity", weight: profile.readability, score: 0.5, detail: "Not enough scorable paragraphs." };
  }
  const sd = stdev(scores);
  // Human writing tends to drift in register paragraph to paragraph
  // (stdev often 10+); very uniform readability (stdev < ~6) is an AI tell.
  const score = clamp(1 - sd / 15);
  return {
    name: "readability uniformity",
    weight: profile.readability,
    score,
    detail: `Flesch Reading Ease stdev across ${scores.length} paragraphs: ${sd.toFixed(1)}. Very uniform scores suggest a single generative process.`,
  };
}

function markdownInProseDetector(text: string, profile: WeightProfile): DetectorResult {
  const bulletLines = (text.match(/^\s*[-*•]\s+/gm) ?? []).length;
  const headerLines = (text.match(/^\s{0,3}#{1,6}\s+/gm) ?? []).length;
  const boldRuns = (text.match(/\*\*[^*]+\*\*/g) ?? []).length;
  const totalLines = Math.max(1, text.split(/\n/).length);
  const density = (bulletLines + headerLines + boldRuns) / totalLines;
  const score = clamp(density / profile.markdownDensitySaturation);
  return {
    name: "markdown-in-prose artifacts",
    weight: profile.markdown,
    score,
    detail: `${bulletLines} bullet lines, ${headerLines} header lines, ${boldRuns} bold runs across ${totalLines} lines. Chat-style markdown left in prose is a common copy-paste artifact.`,
  };
}

function emDashDetector(text: string, totalWords: number, profile: WeightProfile): DetectorResult {
  const emDashCount = (text.match(/—/g) ?? []).length;
  const per1000 = totalWords > 0 ? (emDashCount / totalWords) * 1000 : 0;
  // Human prose uses em dashes sparingly (often 0-2 per 1000 words); LLM
  // output — ChatGPT in particular — is widely reported to overuse the
  // em dash as a default parenthetical/pause marker.
  const score = clamp(per1000 / profile.emDashPer1000Saturation);
  return {
    name: "em dash overuse",
    weight: profile.emDash,
    score,
    detail: emDashCount > 0
      ? `${emDashCount} em dashes (${per1000.toFixed(1)} per 1000 words). Heavy em dash use is a commonly reported LLM stylistic tell.`
      : "No em dashes detected.",
  };
}

// Approximate perplexity -> AI-likelihood anchors: low perplexity means the
// text was highly predictable to the model (AI-typical); high perplexity
// means it was surprising (human-typical). These bounds are a reasonable
// starting point, not empirically calibrated per model — like the rest of
// this file's thresholds, they're explainable defaults meant to be tuned
// with real-world data over time.
const PERPLEXITY_AI_LIKE_ANCHOR = 8;
const PERPLEXITY_HUMAN_LIKE_ANCHOR = 40;

async function modelPerplexityDetector(text: string, profile: WeightProfile): Promise<DetectorResult | null> {
  const result = await scorePerplexity(text);
  if (!result) return null;
  const { perplexity, chunksScored, chunksTotal } = result;
  const score = clamp(1 - (perplexity - PERPLEXITY_AI_LIKE_ANCHOR) / (PERPLEXITY_HUMAN_LIKE_ANCHOR - PERPLEXITY_AI_LIKE_ANCHOR));
  const coverageNote = chunksScored < chunksTotal
    ? ` (partial coverage: ${chunksScored}/${chunksTotal} chunks scored before the time budget was reached)`
    : ` (${chunksScored}/${chunksTotal} chunks scored)`;
  return {
    name: "model-runner perplexity",
    weight: profile.modelPerplexity,
    score,
    detail: `Perplexity ${perplexity.toFixed(1)} against the configured local model${coverageNote}. Lower perplexity (text was more predictable to the model) suggests AI generation; this is approximate and depends heavily on which model is loaded.`,
  };
}

export function fleschReadingEase(text: string): number {
  const sentences = splitSentences(text);
  const words = tokenizeWords(text);
  if (sentences.length === 0 || words.length === 0) return NaN;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const wordsPerSentence = words.length / sentences.length;
  const syllablesPerWord = syllables / words.length;
  return 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
}

export async function detectAiUsage(text: string, type?: DocumentType, ignoreMd?: boolean): Promise<DetectionReport> {
  const workingText = ignoreMd ? stripMarkdownMarkup(text) : text;
  const trimmed = workingText.trim();
  const sentences = splitSentences(trimmed);
  const paragraphs = splitParagraphs(trimmed);
  const words = tokenizeWords(trimmed);
  const lowerText = trimmed.toLowerCase();
  const profile = WEIGHT_PROFILES[type ?? "default"];

  const detectors: DetectorResult[] = [
    burstinessDetector(sentences, profile),
    lexicalDiversityDetector(words, profile),
    aiPhraseDetector(lowerText, words.length, profile),
    readabilityUniformityDetector(paragraphs, profile),
    markdownInProseDetector(trimmed, profile),
    emDashDetector(trimmed, words.length, profile),
  ];

  const modelPerplexity = await modelPerplexityDetector(trimmed, profile);
  if (modelPerplexity) detectors.push(modelPerplexity);

  const totalWeight = detectors.reduce((a, d) => a + d.weight, 0);
  const weightedScore = detectors.reduce((a, d) => a + d.score * d.weight, 0) / totalWeight;
  const overallScore = Math.round(clamp(weightedScore) * 100);

  const verdict: DetectionReport["verdict"] =
    overallScore < 35 ? "likely-human" : overallScore > 65 ? "likely-ai-generated" : "uncertain";

  return {
    overallScore,
    verdict,
    type: type ?? "default",
    ignoreMd: ignoreMd ?? false,
    wordCount: words.length,
    sentenceCount: sentences.length,
    detectors,
    caveat:
      "This is a heuristic, explainable estimate based on stylometric signals (sentence-length burstiness, lexical diversity, known LLM stock phrases, readability uniformity, markdown artifacts, em dash overuse), plus an optional real perplexity check against a local model when MODEL_RUNNER_URL is configured. It is not a trained classifier and can be wrong in both directions — treat it as a starting point for human review, not a verdict.",
  };
}

export function formatDetectionReport(report: DetectionReport): string {
  const lines: string[] = [];
  lines.push(`AI Usage Detection Report`);
  lines.push(`==========================`);
  lines.push(`Overall AI-likelihood score: ${report.overallScore}/100 (${report.verdict}) — 0 = reads as entirely human-written, 100 = reads as entirely AI-generated.`);
  lines.push(`Ruleset: ${report.type}${report.type === "default" ? " (no type specified)" : ""}`);
  lines.push(`Markdown ignored (*, _, #): ${report.ignoreMd ? "yes" : "no"}`);
  lines.push(`Word count: ${report.wordCount}, Sentence count: ${report.sentenceCount}`);
  lines.push(``);
  lines.push(`Signal breakdown (each signal scored 0-100: 0 = strongly human-like on that signal, 100 = strongly AI-like on that signal):`);
  for (const d of report.detectors) {
    lines.push(`- [${Math.round(d.score * 100)}/100, weight ${d.weight}] ${d.name}`);
    for (const detailLine of d.detail.split("\n")) {
      lines.push(`    ${detailLine}`);
    }
  }
  lines.push(``);
  lines.push(`Caveat: ${report.caveat}`);
  return lines.join("\n");
}
