// Paragraph coherence: CURRENTLY DISABLED (enabled: false below).
//
// The premise — human writing digresses paragraph to paragraph while text
// generated in one pass stays unusually tightly on-topic — is not borne out by
// measurement on narrative prose. Adjacent-paragraph content-word cosine
// similarity does not separate human from AI text at any paragraph-length
// filter, and if anything trends the wrong way:
//
//   filter        AI                     human
//   unfiltered    0.056, 0.057, 0.014    0.068, 0.060, 0.054
//   >= 30 words   0.058, 0.067, 0.069    0.079, 0.062, 0.067
//   >= 60 words   0.047, 0.086, 0.098    0.105, 0.082, 0.122
//
// Every observed value also sits far below AI_LIKE_SIMILARITY (0.35), so the
// detector reported ~0 for everything regardless. The anchors were deliberately
// not retuned to the observed range: with no separation in the underlying
// statistic, spreading the output across 0-1 would amplify noise into a
// confident wrong signal.
//
// The implementation is kept, and still behaves correctly on its stated premise
// (paragraphs with heavy vocabulary overlap do score high — see the tests), in
// case the premise holds for genres this corpus doesn't cover: expository or
// technical writing has longer, more topically-anchored paragraphs and may well
// behave differently. Re-enabling means measuring on that genre first. See
// docs/superpowers/notes/2026-07-25-llama-engine-calibration.md.

import { clamp, tokenizeWords } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.1,
  creative: 0.1,
  strategic: 0.1,
};

const MIN_MEASURABLE_PARAGRAPHS = 3;

// Cosine similarity between two very short paragraphs is not a measurement of
// topic drift — a one-word line of dialogue shares no content words with
// anything, so it contributes a similarity of ~0 regardless of what the text
// is about. In narrative prose those lines are the majority, and including
// them dragged the average toward zero for every document. Same threshold and
// same reasoning as readabilityUniformity.ts.
const MIN_PARAGRAPH_WORDS = 20;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "so", "because", "as", "of", "to", "in", "on",
  "at", "for", "with", "without", "by", "from", "up", "down", "out", "about", "into", "over", "after",
  "before", "between", "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did",
  "have", "has", "had", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "this", "that", "these", "those", "there", "here", "not",
  "no", "nor", "too", "very", "just", "can", "will", "would", "should", "could", "may", "might", "must", "shall",
]);

function contentWordFrequency(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const w of tokenizeWords(text)) {
    if (STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return freq;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [word, countA] of a) {
    normA += countA * countA;
    const countB = b.get(word);
    if (countB) dot += countA * countB;
  }
  for (const countB of b.values()) normB += countB * countB;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Reasonable starting anchors, not empirically calibrated: human prose tends
// to drift topic-to-topic between paragraphs (low shared-vocabulary
// overlap); AI text tends to stay unusually on-topic.
const HUMAN_LIKE_SIMILARITY = 0.05;
const AI_LIKE_SIMILARITY = 0.35;

export const paragraphCoherenceDetector: Detector = {
  id: "paragraph-coherence",
  name: "paragraph coherence",
  enabled: false,
  weight: (type) => WEIGHT[type],
  run: (ctx) => {
    const measurable = ctx.paragraphs.filter((p) => p.split(/\s+/).filter(Boolean).length >= MIN_PARAGRAPH_WORDS);
    // Omit the signal rather than reporting a number we did not measure. A
    // fallback score here is not neutral: the orchestrator's weighted average
    // has no concept of "unknown", so any value we return is asserted with
    // this detector's full weight behind it.
    if (measurable.length < MIN_MEASURABLE_PARAGRAPHS) return null;

    const vectors = measurable.map(contentWordFrequency);
    const similarities: number[] = [];
    for (let i = 0; i + 1 < vectors.length; i++) {
      similarities.push(cosineSimilarity(vectors[i], vectors[i + 1]));
    }
    const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
    const score = clamp((avgSimilarity - HUMAN_LIKE_SIMILARITY) / (AI_LIKE_SIMILARITY - HUMAN_LIKE_SIMILARITY));
    const skipped = ctx.paragraphs.length - measurable.length;
    const skippedNote = skipped > 0 ? ` (${skipped} paragraph${skipped === 1 ? "" : "s"} too short to compare)` : "";
    return {
      name: "paragraph coherence",
      score,
      detail: `Average adjacent-paragraph content-word similarity: ${avgSimilarity.toFixed(2)} across ${measurable.length} paragraphs${skippedNote}. Unusually high similarity (staying tightly on-topic) suggests AI generation; natural digression suggests a human author.`,
    };
  },
};
