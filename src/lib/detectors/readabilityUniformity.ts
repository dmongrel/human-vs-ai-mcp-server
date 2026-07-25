// Readability uniformity: per-paragraph Flesch Reading Ease scores that
// barely vary suggest a single generative process rather than a human
// author's natural drift in register.
//
// Only paragraphs of at least MIN_PARAGRAPH_WORDS are measured. Flesch is a
// ratio of words-per-sentence and syllables-per-word, and on very short text
// both terms are dominated by whichever few words happen to be present — a
// one-word line of dialogue ("Mm.") scores wildly, and a handful of them will
// swamp the stdev of an otherwise uniform document. In narrative prose, which
// is mostly short dialogue lines, this made the signal unmeasurable: stdev
// landed at 20-29 for human and AI text alike, saturating the score at 0 for
// everything. Filtering to substantial paragraphs recovers the separation
// (measured: AI 8.6-13.4, human 21.1-21.3 on the calibration corpus).

import { clamp, fleschReadingEase, stdev } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.15,
  creative: 0.2,
  strategic: 0.15,
};

// Below this, a paragraph's Flesch score is noise rather than a measurement.
// Chosen as the shortest threshold that preserved a clean human/AI split on
// the calibration corpus; the gap is widest at 20-25 words.
const MIN_PARAGRAPH_WORDS = 20;
const MIN_MEASURABLE_PARAGRAPHS = 3;

// Flesch stdev anchors, measured against the calibration corpus (see
// docs/superpowers/notes/2026-07-25-llama-engine-calibration.md for the corpus
// itself). Same caveat as every calibrated constant here: a small sample of
// one genre, so treat the score as indicative rather than precise.
const UNIFORM_STDEV = 10; // AI-typical: register barely moves
const VARIED_STDEV = 22; // human-typical: register drifts paragraph to paragraph

export const readabilityUniformityDetector: Detector = {
  id: "readability-uniformity",
  name: "readability uniformity",
  enabled: true,
  weight: (type) => WEIGHT[type],
  run: (ctx) => {
    const measurable = ctx.paragraphs.filter((p) => p.split(/\s+/).filter(Boolean).length >= MIN_PARAGRAPH_WORDS);
    const scores = measurable.map(fleschReadingEase).filter((s) => Number.isFinite(s));
    // Omit the signal rather than reporting a number we did not measure. A
    // fallback score here is not neutral: the orchestrator's weighted average
    // has no concept of "unknown", so any value we return is asserted with
    // this detector's full weight behind it.
    if (scores.length < MIN_MEASURABLE_PARAGRAPHS) return null;

    const sd = stdev(scores);
    const score = clamp((VARIED_STDEV - sd) / (VARIED_STDEV - UNIFORM_STDEV));
    const skipped = ctx.paragraphs.length - measurable.length;
    const skippedNote = skipped > 0 ? ` (${skipped} paragraph${skipped === 1 ? "" : "s"} too short to score reliably)` : "";
    return {
      name: "readability uniformity",
      score,
      detail: `Flesch Reading Ease stdev across ${scores.length} paragraphs: ${sd.toFixed(1)}${skippedNote}. Very uniform scores suggest a single generative process.`,
    };
  },
};
