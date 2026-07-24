// Sentence-length burstiness: human writing mixes short and long sentences;
// LLM output tends toward more uniform sentence length. See Gehrmann,
// Strobelt & Rush, "GLTR" (2019); also used by Mitchell et al., "DetectGPT" (2023).

import { clamp, mean, stdev, tokenizeWords } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.2,
  creative: 0.25,
  strategic: 0.1, // punchy, uniform sentences are normal in business writing
};

export const burstinessDetector: Detector = {
  id: "burstiness",
  name: "sentence-length burstiness",
  enabled: true,
  weight: (type) => WEIGHT[type],
  run: (ctx) => {
    if (ctx.sentences.length < 4) {
      return { name: "sentence-length burstiness", score: 0.5, detail: "Not enough sentences to measure variance reliably." };
    }
    const lengths = ctx.sentences.map((s) => tokenizeWords(s).length).filter((n) => n > 0);
    const m = mean(lengths);
    const sd = stdev(lengths);
    const coefficientOfVariation = m > 0 ? sd / m : 0;
    // Human prose typically has CoV well above ~0.4; uniform AI prose often
    // sits below ~0.35. Map CoV to an AI-likelihood score (lower CoV -> higher score).
    const score = clamp(1 - coefficientOfVariation / 0.6);
    return {
      name: "sentence-length burstiness",
      score,
      detail: `Mean sentence length ${m.toFixed(1)} words, stdev ${sd.toFixed(1)} (coefficient of variation ${coefficientOfVariation.toFixed(2)}). Low variation suggests uniform, AI-typical pacing.`,
    };
  },
};
