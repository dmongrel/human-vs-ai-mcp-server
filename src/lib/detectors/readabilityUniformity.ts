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

// A stdev over three paragraphs is a number, not a measurement. Measured
// across 153 chapters of four manuscripts, the estimate converges slowly with
// paragraph count: relative to the ~20-paragraph samples the anchors below were
// calibrated on, a window of 5 paragraphs reads 94% and 8 reads 97% (sample
// stdev — the population form was far worse, which is why text.ts now applies
// Bessel's correction). 8 is where the residual bias drops under ~3%, roughly 5
// points of the 0-100 score, while still scoring 96% of real chapters; raising
// it to 10 or 12 buys about one further point of accuracy but silences 16% and
// 26% of chapters respectively. Below the floor the signal is omitted, not
// guessed at.
const MIN_MEASURABLE_PARAGRAPHS = 8;

// Flesch stdev anchors, measured against the calibration corpus (see
// docs/superpowers/notes/2026-07-25-llama-engine-calibration.md).
//
// KNOWN OVERLAP, AND IT IS CAPABILITY-DEPENDENT — do not "fix" this by moving
// the anchors. Measured across 12 human chapters from four manuscripts (stdev
// 13.4-42.0, score mean 20.8) against 7 AI chapters spanning three models and
// two genres (stdev 10.4-25.1, score mean 52.1). Group means still separate,
// but the AI group is bimodal: llama-3-8b, qwen3-14b and a single-genre,
// single-prompt Opus sample score 58-97, while two Sonnet 5 chapters (one
// hard SF, one space fantasy) score 0 outright — their readability variance
// (23.6, 25.1) sits *above* the human median of 22. A capable model that
// varies register the way a human paragraph-to-paragraph does defeats this
// signal completely. An earlier three-sample AI set, all one prompt in one
// genre, clustered tightly at 13.3-13.9 and looked like a clean separate
// population; that was a same-prompt artifact, not a property of AI prose,
// and widening the sample by model and genre erased it.
//
// Retuning does not help: on the earlier, narrower data, lowering VARIED to
// 18 cut the worst human score but cut AI detection by the same motion,
// narrowing the group-mean gap rather than widening it. With capable models
// now scoring above the human median, no anchor pair fixes this — the signal
// structurally cannot see prose from a model that varies its own register.
//
// This signal's weight (0.2 in `creative`, second only to perplexity) predates
// this measurement and has not been revisited against it — see the
// calibration note for the open question of whether it should come down.
//
// Note the floor above was also suspected and cleared: the correlation between
// measurable-paragraph count and score is +0.31, weakly *positive*, so short
// chapters are not what inflates this.
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
