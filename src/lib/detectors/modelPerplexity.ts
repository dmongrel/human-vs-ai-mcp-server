// Model-runner perplexity: ENABLED, but opt-in and inert unless
// MODEL_RUNNER_URL is set. See ../modelRunner.ts's module comment and
// README.md's "Model runner" section for the full investigation.
//
// READ THIS BEFORE TRUSTING ITS NUMBER. The signal is mechanically
// functional -- it reaches a local runner, gets real logprobs back, and
// returns a perplexity -- but its scoring technique is known to be
// structurally biased, and being enabled does not change that:
//
//   (a) It reads logprobs off the model's own reproduction of the text.
//       Reproduction runs at temperature 0, where greedy decoding always
//       picks the model's argmax token, so the tokens it scores are
//       near-certain by construction. Perplexity therefore collapses toward
//       zero for any text the model reproduces successfully, largely
//       independent of what the text actually says. Three differently-worded
//       human chapters returned effectively identical values in testing.
//   (b) It is slow against every runner tested, since it requires generating
//       the whole text back.
//
// It is enabled because it works and is opt-in, not because the number is
// sound. ../llamaEnginePerplexity.ts does teacher-forced scoring with no
// generation step and is the perplexity signal to rely on. Treat this one's
// output as diagnostic, and keep its weight low.

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
  enabled: true,
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
