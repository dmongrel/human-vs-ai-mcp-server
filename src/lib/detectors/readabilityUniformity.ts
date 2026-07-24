// Readability uniformity: per-paragraph Flesch Reading Ease scores that
// barely vary suggest a single generative process rather than a human
// author's natural drift in register.

import { clamp, fleschReadingEase, stdev } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.15,
  creative: 0.2,
  strategic: 0.15,
};

export const readabilityUniformityDetector: Detector = {
  id: "readability-uniformity",
  name: "readability uniformity",
  enabled: true,
  weight: (type) => WEIGHT[type],
  run: (ctx) => {
    if (ctx.paragraphs.length < 3) {
      return { name: "readability uniformity", score: 0.5, detail: "Not enough paragraphs to compare readability across the text." };
    }
    const scores = ctx.paragraphs.map(fleschReadingEase).filter((s) => Number.isFinite(s));
    if (scores.length < 3) {
      return { name: "readability uniformity", score: 0.5, detail: "Not enough scorable paragraphs." };
    }
    const sd = stdev(scores);
    // Human writing tends to drift in register paragraph to paragraph
    // (stdev often 10+); very uniform readability (stdev < ~6) is an AI tell.
    const score = clamp(1 - sd / 15);
    return {
      name: "readability uniformity",
      score,
      detail: `Flesch Reading Ease stdev across ${scores.length} paragraphs: ${sd.toFixed(1)}. Very uniform scores suggest a single generative process.`,
    };
  },
};
