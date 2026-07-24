// Lexical diversity (type-token ratio over a rolling window, i.e. a
// simplified MATTR): LLM output frequently reuses a narrower vocabulary
// relative to text length than human writing.

import { clamp, mean } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.15,
  creative: 0.2,
  strategic: 0.15,
};

const WINDOW_SIZE = 50;

export const lexicalDiversityDetector: Detector = {
  id: "lexical-diversity",
  name: "lexical diversity",
  enabled: true,
  weight: (type) => WEIGHT[type],
  run: (ctx) => {
    if (ctx.words.length < 50) {
      return { name: "lexical diversity", score: 0.5, detail: "Text too short for a reliable type-token ratio." };
    }
    const ratios: number[] = [];
    for (let i = 0; i + WINDOW_SIZE <= ctx.words.length; i += WINDOW_SIZE) {
      const window = ctx.words.slice(i, i + WINDOW_SIZE);
      ratios.push(new Set(window).size / WINDOW_SIZE);
    }
    const avgTtr = mean(ratios);
    // Typical human MATTR-50 sits ~0.68-0.78; LLM output often runs lower,
    // ~0.55-0.68, due to more predictable word choice.
    const score = clamp((0.72 - avgTtr) / 0.2);
    return {
      name: "lexical diversity",
      score,
      detail: `Average type-token ratio (50-word windows): ${avgTtr.toFixed(2)}. Lower diversity suggests more predictable, AI-typical word choice.`,
    };
  },
};
