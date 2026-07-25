// Paragraph coherence: cosine similarity between adjacent paragraphs'
// content-word (stopword-filtered) frequency vectors. Human writing tends to
// digress or shift focus paragraph to paragraph; text generated in one pass
// tends to stay unusually tightly on-topic throughout.

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
  enabled: true,
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
