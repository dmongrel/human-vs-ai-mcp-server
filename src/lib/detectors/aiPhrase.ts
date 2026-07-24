// Overused LLM stock phrases ("delve into", "it's important to note", etc.),
// compiled from public AI-detection write-ups — see ../aiPhrases.ts.

import { AI_TELL_PHRASES, countAiTellPhrases } from "../aiPhrases.js";
import { clamp } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.2,
  creative: 0.15,
  strategic: 0.4, // buzzword-heavy AI phrasing is the strongest tell in this genre
};

export const aiPhraseDetector: Detector = {
  id: "ai-phrase",
  name: "AI stock-phrase usage",
  enabled: true,
  weight: (type) => WEIGHT[type],
  run: (ctx) => {
    const hits = countAiTellPhrases(ctx.lowerText);
    const totalHits = hits.reduce((a, h) => a + h.count, 0);
    const totalWords = ctx.words.length;
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
      score,
      detail: totalHits > 0
        ? `${totalHits} hits (${per1000.toFixed(1)} per 1000 words) from a list of ${AI_TELL_PHRASES.length} known LLM stock phrases:\n${topHits}`
        : "No known LLM stock phrases detected.",
    };
  },
};
