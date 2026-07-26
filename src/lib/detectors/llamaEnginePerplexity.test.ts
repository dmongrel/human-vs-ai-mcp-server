import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { CORE_DETECTORS } from "./index.js";
import { llamaEnginePerplexityDetector, perplexityToScore } from "./llamaEnginePerplexity.js";
import type { DetectorContext, DocumentType } from "./types.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.LLAMA_ENGINE_MODEL_PATH;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function context(text: string): DetectorContext {
  return {
    text,
    sentences: [text],
    paragraphs: [text],
    words: text.split(/\s+/),
    lowerText: text.toLowerCase(),
    type: "default",
  };
}

test("the detector is enabled", () => {
  assert.equal(llamaEnginePerplexityDetector.enabled, true);
});

test("the detector is registered exactly once in CORE_DETECTORS", () => {
  const matches = CORE_DETECTORS.filter((d) => d.id === "llama-engine-perplexity");
  assert.equal(matches.length, 1);
});

test("the detector's id does not collide with the HTTP model-runner detector", () => {
  const ids = CORE_DETECTORS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, "detector ids must be unique");
  assert.ok(ids.includes("model-runner-perplexity"), "the HTTP model-runner detector must remain registered");
});

test("the HTTP model-runner detector is still disabled", () => {
  const httpDetector = CORE_DETECTORS.find((d) => d.id === "model-runner-perplexity");
  assert.ok(httpDetector);
  assert.equal(httpDetector!.enabled, false);
});

test("the detector has a weight for every ruleset", () => {
  for (const type of ["default", "creative", "strategic"] as (DocumentType | "default")[]) {
    const weight = llamaEnginePerplexityDetector.weight(type);
    assert.ok(weight > 0 && weight <= 1, `unexpected weight ${weight} for ${type}`);
  }
});

test("perplexityToScore reports low perplexity as AI-like", () => {
  assert.ok(perplexityToScore(2) > 0.9, "very predictable text should score near 1");
});

test("perplexityToScore reports high perplexity as human-like", () => {
  assert.ok(perplexityToScore(500) < 0.1, "very surprising text should score near 0");
});

test("perplexityToScore decreases strictly between the anchors", () => {
  // Inside the anchor range the mapping must discriminate; outside it the
  // score saturates at 1 and 0 by design, so strictness only holds here.
  // These values sit between the measured AI and human anchors (6 / 30).
  const scores = [17, 19, 21, 24, 27].map(perplexityToScore);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] < scores[i - 1], `expected a lower score at index ${i}: ${scores.join(", ")}`);
  }
});

test("perplexityToScore never increases with perplexity, including outside the anchors", () => {
  const scores = [1, 3, 6, 12, 24, 48, 500].map(perplexityToScore);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] <= scores[i - 1], `score rose at index ${i}: ${scores.join(", ")}`);
  }
});

// Every perplexity measured against Qwen2.5-1.5B-Instruct.Q4_K_M — see
// docs/superpowers/notes/2026-07-25-llama-engine-calibration.md.
const MEASURED_HUMAN_CHAPTERS = [24.1, 28.6, 20.9, 21.7, 24.2, 27.0, 23.0, 21.8, 21.9, 20.2, 19.6, 24.5];

// Mid-book excerpts from 25 distinct published novelists. This is the widest
// human sample taken and the one the anchors are fitted to; Anderson's 15.71
// is the floor the AI-like anchor has to sit below.
const MEASURED_HUMAN_AUTHORS = [
  15.71, 17.07, 19.25, 19.51, 19.98, 20.65, 21.05, 22.11, 22.32, 24.29, 24.4, 24.53, 24.78,
  24.98, 25.28, 25.87, 27.03, 29.17, 30.32, 30.75, 31.25, 31.26, 35.18, 36.87, 38.74,
];

// Locally-runnable open models, the only group this signal reliably catches.
const MEASURED_LOCAL_MODEL_AI = [5.7, 7.2];

test("no measured human text is scored as AI-leaning", () => {
  // The failure this guards against is the expensive one: calling a real
  // author's prose machine-written. This is why the anchors moved to 6/30 —
  // at 12/32 seven of the 25 novelists tripped this, Anderson at 0.73.
  for (const ppl of [...MEASURED_HUMAN_CHAPTERS, ...MEASURED_HUMAN_AUTHORS]) {
    assert.ok(perplexityToScore(ppl) <= 0.5, `human perplexity ${ppl} scored ${perplexityToScore(ppl)}`);
  }
});

test("locally-runnable model output still scores as AI-leaning", () => {
  for (const ppl of MEASURED_LOCAL_MODEL_AI) {
    assert.ok(perplexityToScore(ppl) > 0.5, `AI perplexity ${ppl} scored ${perplexityToScore(ppl)}`);
  }
});

test("the signal does not claim to separate text inside the overlap zone", () => {
  // Deliberately asserts the limitation rather than papering over it. These
  // are measured AI perplexities (three excerpts at 15.8-19.3 and Claude Opus
  // 5 at 21.2) that fall inside the human author range of 15.7-38.7 — they
  // interleave with Anderson 15.71, Christie 17.07 and Wharton 19.25. Any
  // anchor pair that flagged these would flag those novelists too. If a future
  // change makes this test fail, the human corpus above is being mis-scored.
  for (const ppl of [15.81, 17.66, 19.33, 21.2]) {
    assert.ok(perplexityToScore(ppl) <= 0.5, `overlap-zone perplexity ${ppl} scored ${perplexityToScore(ppl)}`);
  }
});

test("the local-model and human groups stay meaningfully apart on average", () => {
  // A comparison of means, not of ranges: the groups overlap, so any test
  // asserting clean separation would encode a claim the data does not support.
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const humanMean = mean(MEASURED_HUMAN_AUTHORS.map(perplexityToScore));
  const aiMean = mean(MEASURED_LOCAL_MODEL_AI.map(perplexityToScore));
  assert.ok(aiMean - humanMean > 0.5, `expected a clear gap in means, got AI ${aiMean.toFixed(2)} vs human ${humanMean.toFixed(2)}`);
});

test("perplexityToScore stays within 0..1", () => {
  for (const ppl of [0.5, 1, 10, 1000, 1e6]) {
    const score = perplexityToScore(ppl);
    assert.ok(score >= 0 && score <= 1, `score ${score} out of range for perplexity ${ppl}`);
  }
});

test("perplexityToScore rejects nonsensical perplexities rather than throwing", () => {
  for (const ppl of [0, -1, NaN, Infinity]) {
    assert.equal(perplexityToScore(ppl), 0, `expected 0 for ${ppl}`);
  }
});

test("run returns null when LLAMA_ENGINE_MODEL_PATH is unset", async () => {
  const result = await llamaEnginePerplexityDetector.run(context("Some text to score."));
  assert.equal(result, null);
});
