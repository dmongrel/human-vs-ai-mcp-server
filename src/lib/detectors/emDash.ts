// Em dash overuse: frequency of the "—" character, a widely reported
// stylistic tic of LLM output (notably ChatGPT) as a default
// parenthetical/pause marker.
//
// Models differ in which character they reach for, but the tic is identical:
// a dash standing in for a comma, colon or full stop. A locally generated
// llama-3-8b chapter used en dashes exclusively, at 12 per 1000 words — enough
// to saturate the default threshold — and this detector reported nothing at
// all while it only knew about "—". So all the common substitutes count.
//
// Two of them need guarding, because the same character has an innocent job:
//
//   – ‒  also mark closed ranges ("1914–18", "pages 40–65"). Counted only when
//        flanked by spaces, which the range form never is.
//   --   also appears as a command-line flag ("--verbose") and, tripled, as a
//        markdown horizontal rule ("---"). Counted only between spaces or
//        between word characters, neither of which those forms match.
//
// Deliberately not included: U+2E3A and U+2E3B (two- and three-em dashes),
// which are typographically unambiguous but vanishingly rare in model output.

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

const DASH_VARIANTS: { label: string; pattern: RegExp }[] = [
  { label: "em dash", pattern: /—/g }, // U+2014 — only ever a dash
  { label: "horizontal bar", pattern: /―/g }, // U+2015 — only ever a dash
  { label: "spaced en dash", pattern: /(?<= )–(?= )/g }, // U+2013, guarded against ranges
  { label: "spaced figure dash", pattern: /(?<= )‒(?= )/g }, // U+2012, guarded against ranges
  // ASCII substitute. " -- " or "word--word", but not "--flag" and not "---".
  { label: "double hyphen", pattern: /(?<= )--(?= )|(?<=\w)--(?=\w)/g },
];

export const emDashDetector: Detector = {
  id: "em-dash",
  name: "em dash overuse",
  enabled: true,
  weight: (type) => WEIGHT[type],
  run: (ctx) => {
    const counts = DASH_VARIANTS.map((v) => ({ label: v.label, n: (ctx.text.match(v.pattern) ?? []).length })).filter((c) => c.n > 0);
    const dashCount = counts.reduce((a, c) => a + c.n, 0);
    const totalWords = ctx.words.length;
    const per1000 = totalWords > 0 ? (dashCount / totalWords) * 1000 : 0;
    const score = clamp(per1000 / PER_1000_SATURATION[ctx.type]);
    // Name the variants when it isn't simply em dashes, so a reader can see
    // which character the text actually leans on.
    const breakdown = counts.length > 1 || (counts[0] && counts[0].label !== "em dash") ? ` (${counts.map((c) => `${c.n} ${c.label}`).join(", ")})` : "";
    return {
      name: "em dash overuse",
      score,
      detail: dashCount > 0
        ? `${dashCount} dashes${breakdown} (${per1000.toFixed(1)} per 1000 words). Heavy em dash use is a commonly reported LLM stylistic tell; the other dash characters are the same tic written differently.`
        : "No em or en dashes detected.",
    };
  },
};
