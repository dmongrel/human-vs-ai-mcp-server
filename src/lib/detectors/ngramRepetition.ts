// N-gram repetition: trigram (3-word sequence) diversity across the text.
// Natural prose rarely repeats the same 3-word sequence; generative models
// sometimes fall into repeating stock constructions, especially in longer
// output. See Holtzman et al., "The Curious Case of Neural Text
// Degeneration" (2020), on repetition as a generation artifact.

import { clamp } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.1,
  creative: 0.1,
  strategic: 0.1,
};

const N = 3;
const MIN_WORDS = 60; // below this, trigram counts are too small to be meaningful

// Reasonable starting anchors, not empirically calibrated (same convention
// as the rest of this codebase's thresholds): natural prose rarely repeats
// 3-word sequences; AI text sometimes does, especially in longer generations.
const HUMAN_LIKE_DIVERSITY = 0.95; // at/above this trigram-diversity ratio -> human-like (score 0)
const AI_LIKE_DIVERSITY = 0.75; // at/below this -> AI-like (score 1)

function trigrams(words: string[]): string[] {
  const grams: string[] = [];
  for (let i = 0; i + N <= words.length; i++) grams.push(words.slice(i, i + N).join(" "));
  return grams;
}

export const ngramRepetitionDetector: Detector = {
  id: "ngram-repetition",
  name: "n-gram repetition",
  enabled: true,
  weight: (type) => WEIGHT[type],
  run: (ctx) => {
    if (ctx.words.length < MIN_WORDS) {
      return { name: "n-gram repetition", score: 0.5, detail: "Not enough words for reliable trigram statistics." };
    }
    const grams = trigrams(ctx.words);
    const counts = new Map<string, number>();
    for (const g of grams) counts.set(g, (counts.get(g) ?? 0) + 1);
    const diversityRatio = counts.size / grams.length;
    const score = clamp((HUMAN_LIKE_DIVERSITY - diversityRatio) / (HUMAN_LIKE_DIVERSITY - AI_LIKE_DIVERSITY));
    const repeated = [...counts.entries()]
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const detail = repeated.length > 0
      ? `Trigram diversity ${diversityRatio.toFixed(2)} (${counts.size}/${grams.length} unique). Most repeated: ${repeated.map(([g, c]) => `"${g}" x${c}`).join(", ")}. Lower diversity suggests repetitive, AI-typical phrase construction.`
      : `Trigram diversity ${diversityRatio.toFixed(2)} (${counts.size}/${grams.length} unique). No repeated trigrams found.`;
    return { name: "n-gram repetition", score, detail };
  },
};
