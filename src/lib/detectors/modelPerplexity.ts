// Model-runner perplexity: CURRENTLY DISABLED (enabled: false below). See
// ../modelRunner.ts's module comment and README.md's "Model runner
// (currently disabled)" section for the full investigation. Investigated as
// a real perplexity check against a local model runner (LM Studio, Ollama),
// but found unreliable in practice: (a) the verbatim-echo technique it
// relies on is structurally biased toward near-zero perplexity for any text
// the model successfully reproduces at temperature 0 (greedy decoding always
// picks its own argmax token), regardless of the text's actual content, and
// (b) it was impractically slow against every runner/model tested. The
// client code is kept as groundwork in case a better scoring technique or
// runner support emerges later. Do not flip `enabled` to true without
// reading the README section first.

import { scorePerplexity } from "../modelRunner.js";
import { clamp } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.15,
  creative: 0.15,
  strategic: 0.15,
};

// Approximate perplexity -> AI-likelihood anchors: low perplexity means the
// text was highly predictable to the model (AI-typical); high perplexity
// means it was surprising (human-typical). Reasonable starting points, not
// empirically calibrated per model.
const PERPLEXITY_AI_LIKE_ANCHOR = 8;
const PERPLEXITY_HUMAN_LIKE_ANCHOR = 40;

export const modelPerplexityDetector: Detector = {
  id: "model-runner-perplexity",
  name: "model-runner perplexity",
  enabled: false,
  weight: (type) => WEIGHT[type],
  run: async (ctx) => {
    const result = await scorePerplexity(ctx.text);
    if (!result) return null;
    const { perplexity, chunksScored, chunksTotal } = result;
    const score = clamp(1 - (perplexity - PERPLEXITY_AI_LIKE_ANCHOR) / (PERPLEXITY_HUMAN_LIKE_ANCHOR - PERPLEXITY_AI_LIKE_ANCHOR));
    const coverageNote = chunksScored < chunksTotal
      ? ` (partial coverage: ${chunksScored}/${chunksTotal} chunks scored before the time budget was reached)`
      : ` (${chunksScored}/${chunksTotal} chunks scored)`;
    return {
      name: "model-runner perplexity",
      score,
      detail: `Perplexity ${perplexity.toFixed(1)} against the configured local model${coverageNote}. Lower perplexity (text was more predictable to the model) suggests AI generation; this is approximate and depends heavily on which model is loaded.`,
    };
  },
};
