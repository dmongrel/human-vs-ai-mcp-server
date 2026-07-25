// Bundled-engine perplexity: CURRENTLY DISABLED (enabled: false below), but
// for a different reason than ../modelPerplexity.ts. That one is disabled
// because its technique is structurally broken; this one is disabled only
// because its perplexity -> score mapping has not been calibrated against real
// human and AI text yet. The measurement itself is sound — teacher-forced
// scoring through libllama, exactly what llama.cpp's own llama-perplexity CLI
// does, with no generation step and therefore no greedy-decoding bias.
//
// To enable it you need: (1) empirical anchors from running the helper over a
// corpus of known-human and known-AI prose with the model you intend to ship
// against, replacing the provisional constants below, and (2) a documented
// note in README.md recording which model those anchors came from — the
// numbers are model-specific and don't transfer.

import { getEngineModelPath, scorePerplexityViaEngine } from "../llamaEngine.js";
import { clamp } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.15,
  creative: 0.15,
  strategic: 0.15,
};

// PROVISIONAL, UNVALIDATED anchors. Perplexity is model-specific: a 1.5B model
// reports much higher numbers than a 70B one on identical text, so these are
// starting points to be replaced by measurement, not defaults to trust. Low
// perplexity means the text was predictable to the model (AI-typical); high
// means it surprised the model (human-typical). Interpolation is in log space
// because perplexity is exponential in cross-entropy — the perceptual distance
// from 5 to 10 is the same as from 10 to 20, not from 10 to 15.
const PERPLEXITY_AI_LIKE_ANCHOR = 6;
const PERPLEXITY_HUMAN_LIKE_ANCHOR = 40;

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
  enabled: false,
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
      detail: `Teacher-forced perplexity ${perplexity.toFixed(1)} against the bundled llama.cpp engine${modelNote}${coverageNote}. Lower perplexity (the text was more predictable to the model) suggests AI generation. Absolute values are model-specific — this signal's calibration is provisional.`,
    };
  },
};
