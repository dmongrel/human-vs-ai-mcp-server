import assert from "node:assert/strict";
import { test } from "node:test";

import { detectAiUsage, formatDetectionReport, type DetectionReport } from "./detectAiUsage.js";

function findDetector(report: DetectionReport, name: string) {
  const detector = report.detectors.find((d) => d.name === name);
  assert.ok(detector, `expected a detector named "${name}"`);
  return detector!;
}

const AI_STUFFED_TEXT = `
In today's fast-paced world, it's important to note that we must delve into the tapestry of possibilities. Furthermore, this seamless and robust approach will leverage cutting-edge solutions. Moreover, it boasts a myriad of benefits for everyone involved. In conclusion, this is truly a game-changer for the industry.

Additionally, on the other hand, we should foster a holistic mindset. Overall, this plethora of options underscores a testament to innovation. Let's dive in and unlock the potential of this streamlined, seamless system.

- First bullet point about the topic
- Second bullet point about the topic
- Third bullet point about the topic

## A Heading About The Topic

**Bold claim** about the topic that stands as a testament to progress.
`;

const HUMAN_TEXT = `
My grandmother used to keep a jar of buttons on the windowsill. Some were huge, carved from bone; others no bigger than a lentil. She never explained why she kept them. I asked her once, when I was maybe nine, and she just shrugged and said, "You never know."

That shrug stuck with me longer than most advice I've gotten since. There's something to be said for holding onto things without a plan for them. My apartment now has three drawers I can't fully explain. A cracked teacup. Half a deck of cards from a hotel in Reno. A single glove.

I don't think it's hoarding, exactly. It's more like leaving a door unlocked somewhere in your life, just in case a version of yourself you don't recognize yet needs to walk back in and grab something.
`;

test("AI-stuffed text scores higher than varied human text", () => {
  const aiReport = detectAiUsage(AI_STUFFED_TEXT);
  const humanReport = detectAiUsage(HUMAN_TEXT);
  assert.ok(
    aiReport.overallScore > humanReport.overallScore,
    `expected AI text score (${aiReport.overallScore}) > human text score (${humanReport.overallScore})`
  );
});

test("AI-stuffed text is not classified likely-human", () => {
  const report = detectAiUsage(AI_STUFFED_TEXT);
  assert.notEqual(report.verdict, "likely-human");
});

test("overall score is within 0-100 and matches verdict bands", () => {
  for (const text of [AI_STUFFED_TEXT, HUMAN_TEXT, "Short text."]) {
    const report = detectAiUsage(text);
    assert.ok(report.overallScore >= 0 && report.overallScore <= 100);
    if (report.overallScore < 35) assert.equal(report.verdict, "likely-human");
    else if (report.overallScore > 65) assert.equal(report.verdict, "likely-ai-generated");
    else assert.equal(report.verdict, "uncertain");
  }
});

test("returns all five named detectors with weights that sum to 1", () => {
  const report = detectAiUsage(HUMAN_TEXT);
  const names = report.detectors.map((d) => d.name).sort();
  assert.deepEqual(names, [
    "AI stock-phrase usage",
    "markdown-in-prose artifacts",
    "readability uniformity",
    "sentence-length burstiness",
    "lexical diversity",
  ].sort());
  const totalWeight = report.detectors.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(totalWeight - 1) < 1e-9, `weights should sum to 1, got ${totalWeight}`);
});

test("every detector score is within 0-1", () => {
  const report = detectAiUsage(AI_STUFFED_TEXT);
  for (const d of report.detectors) {
    assert.ok(d.score >= 0 && d.score <= 1, `${d.name} score out of range: ${d.score}`);
  }
});

test("AI stock-phrase detector picks up known phrases and scores high", () => {
  const report = detectAiUsage(AI_STUFFED_TEXT);
  const detector = findDetector(report, "AI stock-phrase usage");
  assert.ok(detector.score > 0.5, `expected high stock-phrase score, got ${detector.score}`);
  assert.match(detector.detail, /delve into/);
});

test("AI stock-phrase detector reports no hits for clean text", () => {
  const report = detectAiUsage(HUMAN_TEXT);
  const detector = findDetector(report, "AI stock-phrase usage");
  assert.equal(detector.score, 0);
  assert.match(detector.detail, /No known LLM stock phrases detected/);
});

test("markdown-in-prose detector flags bullets, headers, and bold", () => {
  const report = detectAiUsage(AI_STUFFED_TEXT);
  const detector = findDetector(report, "markdown-in-prose artifacts");
  assert.ok(detector.score > 0, "expected markdown artifacts to be detected");
});

test("markdown-in-prose detector finds nothing in plain prose", () => {
  const report = detectAiUsage(HUMAN_TEXT);
  const detector = findDetector(report, "markdown-in-prose artifacts");
  assert.equal(detector.score, 0);
});

test("burstiness detector is neutral (0.5) for too-short input", () => {
  const report = detectAiUsage("One sentence. Two sentences.");
  const detector = findDetector(report, "sentence-length burstiness");
  assert.equal(detector.score, 0.5);
});

test("lexical diversity detector is neutral (0.5) for short input", () => {
  const report = detectAiUsage("Just a handful of words here.");
  const detector = findDetector(report, "lexical diversity");
  assert.equal(detector.score, 0.5);
});

test("word and sentence counts are reported", () => {
  const report = detectAiUsage("This is one sentence. This is another sentence.");
  assert.equal(report.sentenceCount, 2);
  assert.ok(report.wordCount > 0);
});

test("empty text does not throw and yields a low-confidence report", () => {
  const report = detectAiUsage("");
  assert.equal(report.wordCount, 0);
  assert.equal(report.sentenceCount, 0);
  assert.ok(report.overallScore >= 0 && report.overallScore <= 100);
});

test("formatDetectionReport includes score, verdict, and all detector names", () => {
  const report = detectAiUsage(HUMAN_TEXT);
  const formatted = formatDetectionReport(report);
  assert.match(formatted, new RegExp(`${report.overallScore}/100 \\(${report.verdict}\\)`));
  for (const d of report.detectors) {
    assert.ok(formatted.includes(d.name), `formatted report missing detector "${d.name}"`);
  }
  assert.match(formatted, /Caveat:/);
});
