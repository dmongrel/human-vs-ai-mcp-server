import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { humanizeText, formatHumanizeReport, type HumanizeReport } from "./humanizeText.js";

function findRecommendation(report: HumanizeReport, issue: string) {
  return report.recommendations.find((r) => r.issue === issue);
}

test("flags overused AI stock phrases with the specific matches", async () => {
  const report = await humanizeText("It's important to note that we should delve into this. Let's delve into it further.");
  const rec = findRecommendation(report, "Overused AI stock phrases");
  assert.ok(rec, "expected a stock-phrase recommendation");
  assert.match(rec!.evidence, /delve into/);
  assert.match(rec!.evidence, /it's important to note/);
});

test("flags uniform sentence length when variation is low", async () => {
  const text = "The cat sat there. The dog ran fast. A bird flew high. Fish swim deep. Ants march on. Bees buzz loud.";
  const report = await humanizeText(text);
  const rec = findRecommendation(report, "Uniform sentence length");
  assert.ok(rec, "expected a uniform-sentence-length recommendation");
});

test("does not flag sentence length when variation is high", async () => {
  const text = "Go. This is a considerably longer sentence with many more words in it than the first one. Wait. Here is another long, winding sentence full of clauses and commas, meandering on for quite a while.";
  const report = await humanizeText(text);
  assert.equal(findRecommendation(report, "Uniform sentence length"), undefined);
});

test("flags chat-style markdown left in prose", async () => {
  const text = "Here is some prose.\n\n- First point\n- Second point\n\n## A Heading\n\nMore prose follows here.";
  const report = await humanizeText(text);
  const rec = findRecommendation(report, "Chat-style markdown left in prose");
  assert.ok(rec, "expected a markdown recommendation");
  assert.match(rec!.evidence, /2 bullet lines/);
  assert.match(rec!.evidence, /1 header lines/);
});

test("flags overused em dashes with the space-hyphen-space suggestion", async () => {
  const report = await humanizeText("This is one point — and this is another — tied together.");
  const rec = findRecommendation(report, "Overused em dashes");
  assert.ok(rec, "expected an em-dash recommendation");
  assert.match(rec!.suggestion, / - /);
  assert.match(rec!.evidence, /2 em dashes/);
});

test("does not flag em dashes when none are present", async () => {
  const report = await humanizeText("This sentence has no dashes of any kind in it at all.");
  assert.equal(findRecommendation(report, "Overused em dashes"), undefined);
});

test("flags excessive hedging language", async () => {
  const text = "It's worth noting that this could work. Arguably, it should be noted that results vary. To some extent, one might argue otherwise.";
  const report = await humanizeText(text);
  const rec = findRecommendation(report, "Excessive hedging language");
  assert.ok(rec, "expected a hedging recommendation");
});

test("flags uniform readability across paragraphs", async () => {
  const paragraph = "The cat sat on the mat. The dog ran in the yard. A bird flew over the house. The sun was warm today.";
  const text = Array(4).fill(paragraph).join("\n\n");
  const report = await humanizeText(text);
  const rec = findRecommendation(report, "Uniform readability across paragraphs");
  assert.ok(rec, "expected a readability-uniformity recommendation");
  assert.match(rec!.evidence, /Flesch Reading Ease stdev/);
});

test("does not flag readability uniformity with too few paragraphs", async () => {
  const report = await humanizeText("Just one paragraph here. It has a couple of sentences.");
  assert.equal(findRecommendation(report, "Uniform readability across paragraphs"), undefined);
});

test("does not flag readability uniformity when paragraphs vary in register", async () => {
  const text = [
    "Go.",
    "This is a substantially longer and more syntactically elaborate paragraph, replete with subordinate clauses, unusual vocabulary, and a meandering, circuitous structure that resists easy comprehension.",
    "Cats nap. Dogs bark. Birds sing.",
  ].join("\n\n");
  const report = await humanizeText(text);
  assert.equal(findRecommendation(report, "Uniform readability across paragraphs"), undefined);
});

test("falls back to a single 'no patterns detected' recommendation on clean varied text", async () => {
  const text = "My grandmother kept a jar of buttons. Some were huge; others tiny. I never learned why. That mystery still visits me sometimes, uninvited, on ordinary afternoons.";
  const report = await humanizeText(text);
  assert.equal(report.recommendations.length, 1);
  assert.equal(report.recommendations[0].issue, "No strong AI-style patterns detected");
});

test("aiLikelihoodScore matches detectAiUsage's overall score", async () => {
  const text = "In today's fast-paced world, it's important to note that we must delve into the tapestry of possibilities.";
  const report = await humanizeText(text);
  assert.ok(report.aiLikelihoodScore >= 0 && report.aiLikelihoodScore <= 100);
});

test("report echoes back the type used, defaulting to 'default'", async () => {
  assert.equal((await humanizeText("Some plain text here.")).type, "default");
  assert.equal((await humanizeText("Some plain text here.", "creative")).type, "creative");
  assert.equal((await humanizeText("Some plain text here.", "strategic")).type, "strategic");
});

test("strategic ruleset does not flag markdown left in prose", async () => {
  const text = "Here is some prose.\n\n- First point\n- Second point\n\n## A Heading\n\nMore prose follows here.";
  const report = await humanizeText(text, "strategic");
  assert.equal(findRecommendation(report, "Chat-style markdown left in prose"), undefined);
});

test("creative ruleset is more tolerant of a single, infrequent em dash than default", async () => {
  const dashSentence = "This is one point — tied to another idea nearby.";
  const filler = "The quick brown fox jumps over the lazy dog again and without much variation. ";
  const text = dashSentence + " " + filler.repeat(15); // dilutes em-dash frequency below the creative threshold
  const defaultReport = await humanizeText(text);
  const creativeReport = await humanizeText(text, "creative");
  assert.ok(findRecommendation(defaultReport, "Overused em dashes"), "expected default to flag the em dash");
  assert.equal(findRecommendation(creativeReport, "Overused em dashes"), undefined);
});

test("strategic ruleset requires less sentence-length variance to avoid the uniformity flag", async () => {
  const text = "The team met early today. Plan looks solid. Results continue to look quite good. Next steps stay clear. Budget stays fine. Timelines currently hold up well.";
  const defaultReport = await humanizeText(text);
  const strategicReport = await humanizeText(text, "strategic");
  assert.ok(findRecommendation(defaultReport, "Uniform sentence length"), "expected default to flag uniform sentences");
  assert.equal(findRecommendation(strategicReport, "Uniform sentence length"), undefined);
});

test("formatHumanizeReport includes the ruleset used", async () => {
  const report = await humanizeText("Some plain text here.", "strategic");
  const formatted = formatHumanizeReport(report);
  assert.match(formatted, /Ruleset: strategic/);
});

test("ignoreMd suppresses the markdown recommendation for '*', '_', and '#' but not '-' bullets", async () => {
  const headerText = "Here is some prose.\n\n## A Heading\n\n**Bold claim** follows here.";
  const withMarkdown = await humanizeText(headerText);
  const ignored = await humanizeText(headerText, undefined, true);
  assert.ok(findRecommendation(withMarkdown, "Chat-style markdown left in prose"));
  assert.equal(findRecommendation(ignored, "Chat-style markdown left in prose"), undefined);

  const bulletText = "Here is some prose.\n\n- First point\n- Second point\n\nMore prose follows here.";
  const bulletIgnored = await humanizeText(bulletText, undefined, true);
  assert.ok(findRecommendation(bulletIgnored, "Chat-style markdown left in prose"), "expected '-' bullets to still be flagged");
});

test("report echoes back ignoreMd, defaulting to false", async () => {
  assert.equal((await humanizeText("Some plain text here.")).ignoreMd, false);
  assert.equal((await humanizeText("Some plain text here.", undefined, true)).ignoreMd, true);
});

test("formatHumanizeReport includes whether markdown was ignored", async () => {
  const formatted = formatHumanizeReport(await humanizeText("Some plain text here.", undefined, true));
  assert.match(formatted, /Markdown ignored \(\*, _, #\): yes/);
});

test("formatHumanizeReport includes the score and every recommendation", async () => {
  const report = await humanizeText("Let's delve into this seamless, robust plan.");
  const formatted = formatHumanizeReport(report);
  assert.match(formatted, new RegExp(`${report.aiLikelihoodScore}/100`));
  for (const r of report.recommendations) {
    assert.ok(formatted.includes(r.issue));
    assert.ok(formatted.includes(r.suggestion));
    assert.ok(formatted.includes(r.evidence));
  }
});

// --- Optional model-runner perplexity recommendation ---

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MODEL_RUNNER_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

test("model-perplexity recommendation stays disabled even when the runner is configured and would succeed", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  let fetchCalled = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalled = true;
    if (String(url).includes("/v1/models")) return jsonResponse({ data: [{ id: "test-model" }] });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const chunk = body.messages?.[1]?.content ?? "";
    // Very low (near-zero) negative logprobs -> would be low perplexity -> high AI-likelihood score, if enabled.
    return jsonResponse({
      choices: [{ message: { content: chunk }, logprobs: { content: [{ logprob: -0.1 }, { logprob: -0.1 }, { logprob: -0.1 }] } }],
    });
  }) as typeof fetch;

  const report = await humanizeText("Some ordinary text to analyze for this test.");
  // Disabled — see MODEL_PERPLEXITY_SIGNAL_ENABLED in detectAiUsage.ts.
  assert.equal(findRecommendation(report, "Text is unusually predictable to the configured local model"), undefined);
  assert.equal(fetchCalled, false, "expected no network call to be attempted while the signal is disabled");
});
