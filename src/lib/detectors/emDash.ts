// Em dash overuse: frequency of the "—" character, a widely reported
// stylistic tic of LLM output (notably ChatGPT) as a default
// parenthetical/pause marker.

import { clamp } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.15,
  creative: 0.05,
  strategic: 0.15,
};

// Em dashes per 1000 words that saturates the score at 1.0. Higher = more tolerant.
const PER_1000_SATURATION: Record<"default" | DocumentType, number> = {
  default: 8,
  creative: 16, // em dashes are a legitimate stylistic device in prose
  strategic: 6, // business prose rarely uses em dashes stylistically
};

export const emDashDetector: Detector = {
  id: "em-dash",
  name: "em dash overuse",
  enabled: true,
  weight: (type) => WEIGHT[type],
  run: (ctx) => {
    const emDashCount = (ctx.text.match(/—/g) ?? []).length;
    const totalWords = ctx.words.length;
    const per1000 = totalWords > 0 ? (emDashCount / totalWords) * 1000 : 0;
    const score = clamp(per1000 / PER_1000_SATURATION[ctx.type]);
    return {
      name: "em dash overuse",
      score,
      detail: emDashCount > 0
        ? `${emDashCount} em dashes (${per1000.toFixed(1)} per 1000 words). Heavy em dash use is a commonly reported LLM stylistic tell.`
        : "No em dashes detected.",
    };
  },
};
