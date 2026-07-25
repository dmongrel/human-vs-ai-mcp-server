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

test("the detector ships disabled until it is calibrated", () => {
  assert.equal(llamaEnginePerplexityDetector.enabled, false);
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
  // These values sit between the measured AI and human anchors (16 / 28).
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

test("the measured AI and human ranges land on opposite sides of the midpoint", () => {
  // Observed on 2026-07-25 against Qwen2.5-1.5B-Instruct.Q4_K_M — see
  // docs/superpowers/notes/2026-07-25-llama-engine-calibration.md. This is what
  // the anchors exist to achieve, so it should fail loudly if they drift.
  for (const ppl of [15.81, 17.66, 19.33]) {
    assert.ok(perplexityToScore(ppl) > 0.5, `AI-range perplexity ${ppl} scored ${perplexityToScore(ppl)}`);
  }
  for (const ppl of [24.07, 25.1, 27.33]) {
    assert.ok(perplexityToScore(ppl) < 0.5, `human-range perplexity ${ppl} scored ${perplexityToScore(ppl)}`);
  }
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
