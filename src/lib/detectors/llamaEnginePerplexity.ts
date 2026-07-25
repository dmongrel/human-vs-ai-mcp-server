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

// Anchors measured against **Qwen2.5-1.5B-Instruct.Q4_K_M** on 2026-07-25 —
// see docs/superpowers/notes/2026-07-25-llama-engine-calibration.md. On that
// sample, AI prose scored 15.81-19.33 and human prose 24.07-27.33, with no
// overlap; these anchors bracket that boundary.
//
// Treat them as a working estimate, not a settled threshold. They come from
// n=3 per group with a single author on each side, all of it dialogue-heavy
// contemporary fantasy — enough to show the signal separates, not enough to
// know how wide either distribution really is. They are also specific to that
// model and quantization: a 70B model reports much lower perplexity on
// identical text, so these numbers do not transfer. Re-measure before changing
// the model this detector runs against.
//
// Low perplexity means the text was predictable to the model (AI-typical);
// high means it surprised the model (human-typical). Interpolation is in log
// space because perplexity is exponential in cross-entropy — the perceptual
// distance from 5 to 10 is the same as from 10 to 20, not from 10 to 15.
const PERPLEXITY_AI_LIKE_ANCHOR = 16;
const PERPLEXITY_HUMAN_LIKE_ANCHOR = 28;

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
