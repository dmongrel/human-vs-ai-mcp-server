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
//
// Each detector is intentionally isolated so new signals can be added
// without touching the others — see `detectors` array below.

import { AI_TELL_PHRASES, countAiTellPhrases } from "./aiPhrases.js";
import { clamp, countSyllables, mean, splitParagraphs, splitSentences, stdev, tokenizeWords } from "./text.js";

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
  wordCount: number;
  sentenceCount: number;
  detectors: DetectorResult[];
  caveat: string;
}

function burstinessDetector(sentences: string[]): DetectorResult {
  if (sentences.length < 4) {
    return { name: "sentence-length burstiness", weight: 0.25, score: 0.5, detail: "Not enough sentences to measure variance reliably." };
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
    weight: 0.25,
    score,
    detail: `Mean sentence length ${m.toFixed(1)} words, stdev ${sd.toFixed(1)} (coefficient of variation ${coefficientOfVariation.toFixed(2)}). Low variation suggests uniform, AI-typical pacing.`,
  };
}

function lexicalDiversityDetector(words: string[]): DetectorResult {
  if (words.length < 50) {
    return { name: "lexical diversity", weight: 0.2, score: 0.5, detail: "Text too short for a reliable type-token ratio." };
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
    weight: 0.2,
    score,
    detail: `Average type-token ratio (50-word windows): ${avgTtr.toFixed(2)}. Lower diversity suggests more predictable, AI-typical word choice.`,
  };
}

function aiPhraseDetector(lowerText: string, totalWords: number): DetectorResult {
  const hits = countAiTellPhrases(lowerText);
  const totalHits = hits.reduce((a, h) => a + h.count, 0);
  const per1000 = totalWords > 0 ? (totalHits / totalWords) * 1000 : 0;
  // 0 hits/1000 words -> 0 score; ~6+/1000 -> saturate near 1.
  const score = clamp(per1000 / 6);
  const topHits = hits
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((h) => `"${h.phrase}" x${h.count}`)
    .join(", ");
  return {
    name: "AI stock-phrase usage",
    weight: 0.25,
    score,
    detail: totalHits > 0
      ? `${totalHits} hits (${per1000.toFixed(1)} per 1000 words) from a list of ${AI_TELL_PHRASES.length} known LLM stock phrases: ${topHits}.`
      : "No known LLM stock phrases detected.",
  };
}

function readabilityUniformityDetector(paragraphs: string[]): DetectorResult {
  if (paragraphs.length < 3) {
    return { name: "readability uniformity", weight: 0.15, score: 0.5, detail: "Not enough paragraphs to compare readability across the text." };
  }
  const scores = paragraphs.map(fleschReadingEase).filter((s) => Number.isFinite(s));
  if (scores.length < 3) {
    return { name: "readability uniformity", weight: 0.15, score: 0.5, detail: "Not enough scorable paragraphs." };
  }
  const sd = stdev(scores);
  // Human writing tends to drift in register paragraph to paragraph
  // (stdev often 10+); very uniform readability (stdev < ~6) is an AI tell.
  const score = clamp(1 - sd / 15);
  return {
    name: "readability uniformity",
    weight: 0.15,
    score,
    detail: `Flesch Reading Ease stdev across ${scores.length} paragraphs: ${sd.toFixed(1)}. Very uniform scores suggest a single generative process.`,
  };
}

function markdownInProseDetector(text: string): DetectorResult {
  const bulletLines = (text.match(/^\s*[-*•]\s+/gm) ?? []).length;
  const headerLines = (text.match(/^\s{0,3}#{1,6}\s+/gm) ?? []).length;
  const boldRuns = (text.match(/\*\*[^*]+\*\*/g) ?? []).length;
  const totalLines = Math.max(1, text.split(/\n/).length);
  const density = (bulletLines + headerLines + boldRuns) / totalLines;
  const score = clamp(density / 0.25);
  return {
    name: "markdown-in-prose artifacts",
    weight: 0.15,
    score,
    detail: `${bulletLines} bullet lines, ${headerLines} header lines, ${boldRuns} bold runs across ${totalLines} lines. Chat-style markdown left in prose is a common copy-paste artifact.`,
  };
}

function fleschReadingEase(text: string): number {
  const sentences = splitSentences(text);
  const words = tokenizeWords(text);
  if (sentences.length === 0 || words.length === 0) return NaN;
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const wordsPerSentence = words.length / sentences.length;
  const syllablesPerWord = syllables / words.length;
  return 206.835 - 1.015 * wordsPerSentence - 84.6 * syllablesPerWord;
}

export function detectAiUsage(text: string): DetectionReport {
  const trimmed = text.trim();
  const sentences = splitSentences(trimmed);
  const paragraphs = splitParagraphs(trimmed);
  const words = tokenizeWords(trimmed);
  const lowerText = trimmed.toLowerCase();

  const detectors: DetectorResult[] = [
    burstinessDetector(sentences),
    lexicalDiversityDetector(words),
    aiPhraseDetector(lowerText, words.length),
    readabilityUniformityDetector(paragraphs),
    markdownInProseDetector(trimmed),
  ];

  const totalWeight = detectors.reduce((a, d) => a + d.weight, 0);
  const weightedScore = detectors.reduce((a, d) => a + d.score * d.weight, 0) / totalWeight;
  const overallScore = Math.round(clamp(weightedScore) * 100);

  const verdict: DetectionReport["verdict"] =
    overallScore < 35 ? "likely-human" : overallScore > 65 ? "likely-ai-generated" : "uncertain";

  return {
    overallScore,
    verdict,
    wordCount: words.length,
    sentenceCount: sentences.length,
    detectors,
    caveat:
      "This is a heuristic, explainable estimate based on stylometric signals (sentence-length burstiness, lexical diversity, known LLM stock phrases, readability uniformity, markdown artifacts). It is not a trained classifier and can be wrong in both directions — treat it as a starting point for human review, not a verdict.",
  };
}

export function formatDetectionReport(report: DetectionReport): string {
  const lines: string[] = [];
  lines.push(`AI Usage Detection Report`);
  lines.push(`==========================`);
  lines.push(`Overall AI-likelihood score: ${report.overallScore}/100 (${report.verdict})`);
  lines.push(`Word count: ${report.wordCount}, Sentence count: ${report.sentenceCount}`);
  lines.push(``);
  lines.push(`Signal breakdown:`);
  for (const d of report.detectors) {
    lines.push(`- [${Math.round(d.score * 100)}/100, weight ${d.weight}] ${d.name}`);
    lines.push(`    ${d.detail}`);
  }
  lines.push(``);
  lines.push(`Caveat: ${report.caveat}`);
  return lines.join("\n");
}
