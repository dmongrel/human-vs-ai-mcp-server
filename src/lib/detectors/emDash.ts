// Em dash overuse: frequency of the "—" character, a widely reported
// stylistic tic of LLM output (notably ChatGPT) as a default
// parenthetical/pause marker.
//
// Also counts the en dash "–" (U+2013), but only when flanked by spaces. Some
// models reach for " – " where others reach for "—", and the tell is the same:
// a dash standing in for a comma, colon or full stop. A locally generated
// llama-3-8b chapter used en dashes exclusively, at 12 per 1000 words — enough
// to saturate the default threshold — and this detector reported nothing at
// all until the space-flanked case was added.
//
// The space requirement is what keeps ordinary typography out of it: an en
// dash's other job is closed number and date ranges ("1914–18", "pages 40–65"),
// which are written without surrounding spaces and are not a stylistic tic.

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
    // Space-flanked only: " – " is a pause marker, "1914–18" is a range.
    const enDashCount = (ctx.text.match(/(?<= )–(?= )/g) ?? []).length;
    const dashCount = emDashCount + enDashCount;
    const totalWords = ctx.words.length;
    const per1000 = totalWords > 0 ? (dashCount / totalWords) * 1000 : 0;
    const score = clamp(per1000 / PER_1000_SATURATION[ctx.type]);
    const breakdown = enDashCount > 0 ? ` (${emDashCount} em dash, ${enDashCount} spaced en dash)` : "";
    return {
      name: "em dash overuse",
      score,
      detail: dashCount > 0
        ? `${dashCount} dashes${breakdown} (${per1000.toFixed(1)} per 1000 words). Heavy em dash use is a commonly reported LLM stylistic tell; a spaced en dash is the same tic with a different character.`
        : "No em or en dashes detected.",
    };
  },
};
