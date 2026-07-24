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

const MIN_PARAGRAPHS = 3;

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
    if (ctx.paragraphs.length < MIN_PARAGRAPHS) {
      return { name: "paragraph coherence", score: 0.5, detail: "Not enough paragraphs to measure topic drift reliably." };
    }
    const vectors = ctx.paragraphs.map(contentWordFrequency);
    const similarities: number[] = [];
    for (let i = 0; i + 1 < vectors.length; i++) {
      similarities.push(cosineSimilarity(vectors[i], vectors[i + 1]));
    }
    const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
    const score = clamp((avgSimilarity - HUMAN_LIKE_SIMILARITY) / (AI_LIKE_SIMILARITY - HUMAN_LIKE_SIMILARITY));
    return {
      name: "paragraph coherence",
      score,
      detail: `Average adjacent-paragraph content-word similarity: ${avgSimilarity.toFixed(2)} across ${ctx.paragraphs.length} paragraphs. Unusually high similarity (staying tightly on-topic) suggests AI generation; natural digression suggests a human author.`,
    };
  },
};
