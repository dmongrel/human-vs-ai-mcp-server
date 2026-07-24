import assert from "node:assert/strict";
import { test } from "node:test";

import { humanizeText, formatHumanizeReport, type HumanizeReport } from "./humanizeText.js";

function findRecommendation(report: HumanizeReport, issue: string) {
  return report.recommendations.find((r) => r.issue === issue);
}

test("flags overused AI stock phrases with the specific matches", () => {
  const report = humanizeText("It's important to note that we should delve into this. Let's delve into it further.");
  const rec = findRecommendation(report, "Overused AI stock phrases");
  assert.ok(rec, "expected a stock-phrase recommendation");
  assert.match(rec!.evidence, /delve into/);
  assert.match(rec!.evidence, /it's important to note/);
});

test("flags uniform sentence length when variation is low", () => {
  const text = "The cat sat there. The dog ran fast. A bird flew high. Fish swim deep. Ants march on. Bees buzz loud.";
  const report = humanizeText(text);
  const rec = findRecommendation(report, "Uniform sentence length");
  assert.ok(rec, "expected a uniform-sentence-length recommendation");
});

test("does not flag sentence length when variation is high", () => {
  const text = "Go. This is a considerably longer sentence with many more words in it than the first one. Wait. Here is another long, winding sentence full of clauses and commas, meandering on for quite a while.";
  const report = humanizeText(text);
  assert.equal(findRecommendation(report, "Uniform sentence length"), undefined);
});

test("flags chat-style markdown left in prose", () => {
  const text = "Here is some prose.\n\n- First point\n- Second point\n\n## A Heading\n\nMore prose follows here.";
  const report = humanizeText(text);
  const rec = findRecommendation(report, "Chat-style markdown left in prose");
  assert.ok(rec, "expected a markdown recommendation");
  assert.match(rec!.evidence, /2 bullet lines/);
  assert.match(rec!.evidence, /1 header lines/);
});

test("flags excessive hedging language", () => {
  const text = "It's worth noting that this could work. Arguably, it should be noted that results vary. To some extent, one might argue otherwise.";
  const report = humanizeText(text);
  const rec = findRecommendation(report, "Excessive hedging language");
  assert.ok(rec, "expected a hedging recommendation");
});

test("flags uniform readability across paragraphs", () => {
  const paragraph = "The cat sat on the mat. The dog ran in the yard. A bird flew over the house. The sun was warm today.";
  const text = Array(4).fill(paragraph).join("\n\n");
  const report = humanizeText(text);
  const rec = findRecommendation(report, "Uniform readability across paragraphs");
  assert.ok(rec, "expected a readability-uniformity recommendation");
  assert.match(rec!.evidence, /Flesch Reading Ease stdev/);
});

test("does not flag readability uniformity with too few paragraphs", () => {
  const report = humanizeText("Just one paragraph here. It has a couple of sentences.");
  assert.equal(findRecommendation(report, "Uniform readability across paragraphs"), undefined);
});

test("does not flag readability uniformity when paragraphs vary in register", () => {
  const text = [
    "Go.",
    "This is a substantially longer and more syntactically elaborate paragraph, replete with subordinate clauses, unusual vocabulary, and a meandering, circuitous structure that resists easy comprehension.",
    "Cats nap. Dogs bark. Birds sing.",
  ].join("\n\n");
  const report = humanizeText(text);
  assert.equal(findRecommendation(report, "Uniform readability across paragraphs"), undefined);
});

test("falls back to a single 'no patterns detected' recommendation on clean varied text", () => {
  const text = "My grandmother kept a jar of buttons. Some were huge; others tiny. I never learned why. That mystery still visits me sometimes, uninvited, on ordinary afternoons.";
  const report = humanizeText(text);
  assert.equal(report.recommendations.length, 1);
  assert.equal(report.recommendations[0].issue, "No strong AI-style patterns detected");
});

test("aiLikelihoodScore matches detectAiUsage's overall score", () => {
  const text = "In today's fast-paced world, it's important to note that we must delve into the tapestry of possibilities.";
  const report = humanizeText(text);
  assert.ok(report.aiLikelihoodScore >= 0 && report.aiLikelihoodScore <= 100);
});

test("formatHumanizeReport includes the score and every recommendation", () => {
  const report = humanizeText("Let's delve into this seamless, robust plan.");
  const formatted = formatHumanizeReport(report);
  assert.match(formatted, new RegExp(`${report.aiLikelihoodScore}/100`));
  for (const r of report.recommendations) {
    assert.ok(formatted.includes(r.issue));
    assert.ok(formatted.includes(r.suggestion));
    assert.ok(formatted.includes(r.evidence));
  }
});
