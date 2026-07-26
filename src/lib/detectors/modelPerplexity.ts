// HTTP model-runner perplexity: DISABLED (enabled: false below).
//
// NOT the bundled engine. This talks to an *external* OpenAI-compatible
// server (LM Studio, Ollama) over HTTP. The perplexity signal this project
// actually uses is ../llamaEnginePerplexity.ts, which runs a llama.cpp
// engine bundled with the package and does teacher-forced scoring. Both
// "run a model", so they are easy to confuse — this is the one that is off.
//
// It was briefly enabled and measured, which confirmed the original finding
// rather than overturning it: it does reach a runner and return a number,
// but that number is ~1.0 for essentially any text. Logprobs are read off
// the model's own reproduction of the input, generated at temperature 0
// where greedy decoding always picks its own argmax token — so the scored
// tokens are near-certain by construction and the result barely depends on
// what the text says. A real chapter measured 1.0; three differently-worded
// human chapters returned effectively identical values. It is also slow,
// since it must generate the entire text back.
//
// Not a calibration problem — it is the technique. The client code
// (../modelRunner.ts) stays as groundwork in case a runner ever exposes
// prompt-token logprobs directly, which would remove the generation step
// and the bias with it. Do not flip this to true expecting a usable signal.

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
    const { perplexity, chunksScored, chunksTotal, timedOut } = result;
    const score = clamp(1 - (perplexity - PERPLEXITY_AI_LIKE_ANCHOR) / (PERPLEXITY_HUMAN_LIKE_ANCHOR - PERPLEXITY_AI_LIKE_ANCHOR));
    // Name the actual cause. Chunks go unscored either because the clock ran
    // out or because the model's reproduction was rejected, and those call for
    // opposite responses from the user — raise the timeout, versus load a
    // model capable of echoing the text back.
    const skipped = chunksTotal - chunksScored;
    const coverageNote = skipped === 0
      ? ` (${chunksScored}/${chunksTotal} chunks scored)`
      : timedOut
        ? ` (partial coverage: ${chunksScored}/${chunksTotal} chunks scored before MODEL_RUNNER_TIMEOUT_MS was reached — raise it to cover the whole text)`
        : ` (partial coverage: ${chunksScored}/${chunksTotal} chunks scored; ${skipped} discarded because the model's reproduction diverged from the input or the request failed — a larger or more capable model echoes text back more reliably)`;
    return {
      name: "model-runner perplexity",
      score,
      detail: `Perplexity ${perplexity.toFixed(1)} against the configured local model${coverageNote}. Lower perplexity (text was more predictable to the model) suggests AI generation; this is approximate and depends heavily on which model is loaded.`,
    };
  },
};
