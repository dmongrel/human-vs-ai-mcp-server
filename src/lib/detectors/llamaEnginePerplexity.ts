// Bundled-engine perplexity: ENABLED, unlike ../modelPerplexity.ts beside it.
// That one is disabled because its technique is structurally broken (greedy
// decoding makes its score independent of the input). This one measures
// properly — teacher-forced scoring through libllama, exactly what llama.cpp's
// own llama-perplexity CLI does, with no generation step and therefore no
// decoding bias.
//
// Being enabled costs nothing when unconfigured: run() returns null
// immediately unless LLAMA_ENGINE_MODEL_PATH is set, so no subprocess is
// spawned and the signal is simply absent from the report.
//
// Calibration caveat, worth knowing before trusting a score: the anchors below
// were fitted to a deliberately small sample (see the constants). They
// separate the measured groups cleanly, but they are one model's numbers from
// one genre, and they do not transfer to a different .gguf. Treat this signal
// as corroborating evidence rather than a verdict, and re-measure before
// pointing LLAMA_ENGINE_MODEL_PATH at a different model.

import { getEngineModelPath, scorePerplexityViaEngine } from "../llamaEngine.js";
import { clamp } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

// The heaviest signal in the set (the stylometric detectors top out at 0.25).
// It earns that: it is the only signal whose discrimination has actually been
// measured rather than assumed, and it measures something the others can only
// proxy for — how predictable the text was to a language model, rather than
// surface statistics that correlate with that. On the calibration pair it was
// one of only two signals pointing the right way; four of the stylometric ones
// pointed the wrong way.
//
// Not differentiated by ruleset, unlike most detectors' weight tables, because
// there is no per-genre data to differentiate on — the whole calibration
// sample is dialogue-heavy fantasy prose. Split these once there is a reason
// to.
const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.3,
  creative: 0.3,
  strategic: 0.3,
};

// Anchors measured against **Qwen2.5-1.5B-Instruct.Q4_K_M** — see
// docs/superpowers/notes/2026-07-25-llama-engine-calibration.md.
//
// These have been refitted twice as the human sample widened, and each time
// the human distribution turned out broader than the sample before it showed:
// 16/28 (3 excerpts, one author), then 12/32 (12 chapters, two manuscripts),
// now 6/30 against **25 distinct published novelists** — mid-book excerpts
// from Project Gutenberg, spanning Austen to Fitzgerald.
//
// That corpus measured **15.7-38.7**, roughly twice the spread the earlier
// samples implied. The 12/32 anchors put the 0.5 crossover at 19.6, which
// scored 7 of those 25 real novelists as AI-leaning — Sherwood Anderson at
// 73/100 and Agatha Christie at 64/100. Calling a published human author
// machine-written is the costly error for this tool, so the anchors give way.
//
// 6/30 puts the crossover at 13.4, below the lowest human measurement. No
// author in the corpus now exceeds 0.40.
//
// What that costs, stated plainly: this signal now only separates models
// whose perplexity falls below ~13. Two local models (llama-3-8b at 5.7,
// qwen3-14b at 7.2) score 100 and 89. Claude Opus 5 measured 21.2 — squarely
// inside the human range — and now scores 22, indistinguishable from a human
// author. Earlier AI excerpts measured 15.8-19.3, which interleaves with
// Anderson (15.7), Christie (17.1) and Wharton (19.3). No anchor choice
// separates those populations, because on this measurement they are not
// separate.
//
// The ranking also shows what perplexity is really tracking: the bottom is
// plain, modern, declarative prose (Anderson 1919, Christie 1920) and the top
// is ornate Victorian subordination (Melville 38.7, Hardy 36.9, James 35.2).
// Prose style drives this signal at least as much as authorship, so plain
// contemporary human writing scores AI-like no matter who wrote it.
//
// Still one model and one language. Perplexity does not transfer between
// models — re-measure before pointing this detector at a different .gguf.
//
// Low perplexity means the text was predictable to the model (AI-typical);
// high means it surprised the model (human-typical). Interpolation is in log
// space because perplexity is exponential in cross-entropy — the perceptual
// distance from 5 to 10 is the same as from 10 to 20, not from 10 to 15.
const PERPLEXITY_AI_LIKE_ANCHOR = 6;
const PERPLEXITY_HUMAN_LIKE_ANCHOR = 30;

/** Map a raw perplexity to a 0 (human-like) .. 1 (AI-like) detector score. Exported for testing. */
export function perplexityToScore(perplexity: number): number {
  if (!Number.isFinite(perplexity) || perplexity <= 0) return 0;
  const lo = Math.log(PERPLEXITY_AI_LIKE_ANCHOR);
  const hi = Math.log(PERPLEXITY_HUMAN_LIKE_ANCHOR);
  return clamp(1 - (Math.log(perplexity) - lo) / (hi - lo));
}

export const llamaEnginePerplexityDetector: Detector = {
  id: "llama-engine-perplexity",
  name: "llama-engine perplexity",
  enabled: true,
  weight: (type) => WEIGHT[type],
  run: async (ctx) => {
    // Cheap guard: skip the spawn entirely when nothing is configured.
    if (!getEngineModelPath()) return null;

    const result = await scorePerplexityViaEngine(ctx.text);
    if (!result) return null;

    const { perplexity, tokensEvaluated, modelName, timedOut } = result;
    const coverageNote = timedOut
      ? ` (partial coverage: ${tokensEvaluated} tokens scored before the time budget was reached)`
      : ` (${tokensEvaluated} tokens scored)`;
    const modelNote = modelName ? ` using ${modelName}` : "";
    return {
      name: "llama-engine perplexity",
      score: perplexityToScore(perplexity),
      detail: `Teacher-forced perplexity ${perplexity.toFixed(1)} against the bundled llama.cpp engine${modelNote}${coverageNote}. Lower perplexity (the text was more predictable to the model) suggests AI generation. Absolute values are model-specific, and this signal's thresholds were calibrated against a 1.5B model on a small sample — treat it as corroborating evidence, not a verdict.`,
    };
  },
};
