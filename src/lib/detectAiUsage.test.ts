import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

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

test("AI-stuffed text scores higher than varied human text", async () => {
  const aiReport = await detectAiUsage(AI_STUFFED_TEXT);
  const humanReport = await detectAiUsage(HUMAN_TEXT);
  assert.ok(
    aiReport.overallScore > humanReport.overallScore,
    `expected AI text score (${aiReport.overallScore}) > human text score (${humanReport.overallScore})`
  );
});

test("AI-stuffed text is not classified likely-human", async () => {
  const report = await detectAiUsage(AI_STUFFED_TEXT);
  assert.notEqual(report.verdict, "likely-human");
});

test("overall score is within 0-100 and matches verdict bands", async () => {
  for (const text of [AI_STUFFED_TEXT, HUMAN_TEXT, "Short text."]) {
    const report = await detectAiUsage(text);
    assert.ok(report.overallScore >= 0 && report.overallScore <= 100);
    if (report.overallScore < 35) assert.equal(report.verdict, "likely-human");
    else if (report.overallScore > 65) assert.equal(report.verdict, "likely-ai-generated");
    else assert.equal(report.verdict, "uncertain");
  }
});

test("returns all six named detectors with weights that sum to 1 when MODEL_RUNNER_URL is unset", async () => {
  const report = await detectAiUsage(HUMAN_TEXT);
  const names = report.detectors.map((d) => d.name).sort();
  assert.deepEqual(names, [
    "AI stock-phrase usage",
    "markdown-in-prose artifacts",
    "readability uniformity",
    "sentence-length burstiness",
    "lexical diversity",
    "em dash overuse",
  ].sort());
  const totalWeight = report.detectors.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(totalWeight - 1) < 1e-9, `weights should sum to 1, got ${totalWeight}`);
});

test("em dash detector scores high for heavy em dash use and reports no hits for clean text", async () => {
  const heavy = await detectAiUsage("This is a sentence — with an em dash — and another — right here — for emphasis — repeatedly.");
  const heavyDetector = findDetector(heavy, "em dash overuse");
  assert.ok(heavyDetector.score > 0.5, `expected high em-dash score, got ${heavyDetector.score}`);
  assert.match(heavyDetector.detail, /em dashes/);

  const clean = await detectAiUsage(HUMAN_TEXT);
  const cleanDetector = findDetector(clean, "em dash overuse");
  assert.equal(cleanDetector.score, 0);
  assert.match(cleanDetector.detail, /No em dashes detected/);
});

test("report echoes back the type used, defaulting to 'default'", async () => {
  assert.equal((await detectAiUsage(HUMAN_TEXT)).type, "default");
  assert.equal((await detectAiUsage(HUMAN_TEXT, "creative")).type, "creative");
  assert.equal((await detectAiUsage(HUMAN_TEXT, "strategic")).type, "strategic");
});

test("all three rulesets produce weights that sum to 1", async () => {
  for (const type of [undefined, "creative", "strategic"] as const) {
    const report = await detectAiUsage(HUMAN_TEXT, type);
    const totalWeight = report.detectors.reduce((a, d) => a + d.weight, 0);
    assert.ok(Math.abs(totalWeight - 1) < 1e-9, `${type ?? "default"} weights should sum to 1, got ${totalWeight}`);
  }
});

test("strategic ruleset is more tolerant of markdown/bullets than default", async () => {
  // Low bullet density (2 of 20 lines) so neither profile saturates at 1.0,
  // letting the saturation-threshold difference actually show up.
  const prose = Array(18).fill("This is an ordinary prose line with no markup at all.");
  const bulletLines = ["- A bullet point about the plan.", "- Another bullet point here."];
  const mixedText = [...prose, ...bulletLines].join("\n");
  const defaultReport = await detectAiUsage(mixedText);
  const strategicReport = await detectAiUsage(mixedText, "strategic");
  const defaultMarkdown = findDetector(defaultReport, "markdown-in-prose artifacts");
  const strategicMarkdown = findDetector(strategicReport, "markdown-in-prose artifacts");
  assert.ok(
    strategicMarkdown.score < defaultMarkdown.score,
    `expected strategic markdown score (${strategicMarkdown.score}) < default (${defaultMarkdown.score})`
  );
});

test("creative ruleset is more tolerant of em dashes than default", async () => {
  // ~10 em dashes per 1000 words: past default's saturation point (8) but
  // below creative's (16), so the two profiles actually diverge.
  const dashSentence = "One point — tied to another idea.";
  const filler = "This is an ordinary filler sentence with no dashes at all. ";
  const emDashText = (dashSentence + " " + filler.repeat(6)).trim();
  const defaultReport = await detectAiUsage(emDashText);
  const creativeReport = await detectAiUsage(emDashText, "creative");
  const defaultEmDash = findDetector(defaultReport, "em dash overuse");
  const creativeEmDash = findDetector(creativeReport, "em dash overuse");
  assert.ok(
    creativeEmDash.score < defaultEmDash.score,
    `expected creative em-dash score (${creativeEmDash.score}) < default (${defaultEmDash.score})`
  );
});

test("strategic ruleset weights AI stock phrases more heavily than default", async () => {
  const defaultReport = await detectAiUsage(AI_STUFFED_TEXT);
  const strategicReport = await detectAiUsage(AI_STUFFED_TEXT, "strategic");
  const defaultPhrase = findDetector(defaultReport, "AI stock-phrase usage");
  const strategicPhrase = findDetector(strategicReport, "AI stock-phrase usage");
  assert.ok(strategicPhrase.weight > defaultPhrase.weight);
});

test("formatDetectionReport includes the ruleset used", async () => {
  const report = await detectAiUsage(HUMAN_TEXT, "creative");
  const formatted = formatDetectionReport(report);
  assert.match(formatted, /Ruleset: creative/);
});

test("ignoreMd strips '*', '_', and '#' before analysis, neutralizing headers and bold runs", async () => {
  const markdownText = Array(10).fill("## A Heading\n\n**Bold claim** about the ordinary topic here today.").join("\n\n");
  const withMarkdown = await detectAiUsage(markdownText);
  const ignored = await detectAiUsage(markdownText, undefined, true);
  const markdownDetector = findDetector(withMarkdown, "markdown-in-prose artifacts");
  const ignoredDetector = findDetector(ignored, "markdown-in-prose artifacts");
  assert.ok(markdownDetector.score > 0, "expected markdown artifacts to be detected without ignoreMd");
  assert.equal(ignoredDetector.score, 0, "expected markdown score to be 0 with ignoreMd");
  assert.match(ignoredDetector.detail, /0 header lines, 0 bold runs/);
});

test("ignoreMd does not affect '-' bullet lines", async () => {
  const bulletText = Array(10).fill("- A bullet point about the ordinary topic here today.").join("\n");
  const ignored = await detectAiUsage(bulletText, undefined, true);
  const detector = findDetector(ignored, "markdown-in-prose artifacts");
  assert.match(detector.detail, /10 bullet lines/);
});

test("report echoes back ignoreMd, defaulting to false", async () => {
  assert.equal((await detectAiUsage(HUMAN_TEXT)).ignoreMd, false);
  assert.equal((await detectAiUsage(HUMAN_TEXT, undefined, true)).ignoreMd, true);
});

test("formatDetectionReport includes whether markdown was ignored", async () => {
  const formatted = formatDetectionReport(await detectAiUsage(HUMAN_TEXT, undefined, true));
  assert.match(formatted, /Markdown ignored \(\*, _, #\): yes/);
});

test("every detector score is within 0-1", async () => {
  const report = await detectAiUsage(AI_STUFFED_TEXT);
  for (const d of report.detectors) {
    assert.ok(d.score >= 0 && d.score <= 1, `${d.name} score out of range: ${d.score}`);
  }
});

test("AI stock-phrase detector picks up known phrases and scores high", async () => {
  const report = await detectAiUsage(AI_STUFFED_TEXT);
  const detector = findDetector(report, "AI stock-phrase usage");
  assert.ok(detector.score > 0.5, `expected high stock-phrase score, got ${detector.score}`);
  assert.match(detector.detail, /delve into/);
});

test("AI stock-phrase detector reports no hits for clean text", async () => {
  const report = await detectAiUsage(HUMAN_TEXT);
  const detector = findDetector(report, "AI stock-phrase usage");
  assert.equal(detector.score, 0);
  assert.match(detector.detail, /No known LLM stock phrases detected/);
});

test("markdown-in-prose detector flags bullets, headers, and bold", async () => {
  const report = await detectAiUsage(AI_STUFFED_TEXT);
  const detector = findDetector(report, "markdown-in-prose artifacts");
  assert.ok(detector.score > 0, "expected markdown artifacts to be detected");
});

test("markdown-in-prose detector finds nothing in plain prose", async () => {
  const report = await detectAiUsage(HUMAN_TEXT);
  const detector = findDetector(report, "markdown-in-prose artifacts");
  assert.equal(detector.score, 0);
});

test("burstiness detector is neutral (0.5) for too-short input", async () => {
  const report = await detectAiUsage("One sentence. Two sentences.");
  const detector = findDetector(report, "sentence-length burstiness");
  assert.equal(detector.score, 0.5);
});

test("lexical diversity detector is neutral (0.5) for short input", async () => {
  const report = await detectAiUsage("Just a handful of words here.");
  const detector = findDetector(report, "lexical diversity");
  assert.equal(detector.score, 0.5);
});

test("word and sentence counts are reported", async () => {
  const report = await detectAiUsage("This is one sentence. This is another sentence.");
  assert.equal(report.sentenceCount, 2);
  assert.ok(report.wordCount > 0);
});

test("empty text does not throw and yields a low-confidence report", async () => {
  const report = await detectAiUsage("");
  assert.equal(report.wordCount, 0);
  assert.equal(report.sentenceCount, 0);
  assert.ok(report.overallScore >= 0 && report.overallScore <= 100);
});

test("formatDetectionReport includes score, verdict, and all detector names", async () => {
  const report = await detectAiUsage(HUMAN_TEXT);
  const formatted = formatDetectionReport(report);
  assert.match(formatted, new RegExp(`${report.overallScore}/100 \\(${report.verdict}\\)`));
  for (const d of report.detectors) {
    assert.ok(formatted.includes(d.name), `formatted report missing detector "${d.name}"`);
  }
  assert.match(formatted, /Caveat:/);
});

// --- Optional model-runner perplexity detector (7th signal) ---
// Stubs globalThis.fetch directly (same approach as modelRunner.test.ts)
// rather than mocking the modelRunner module, since detectAiUsage's
// modelPerplexityDetector calls scorePerplexity(), which itself reads
// process.env/fetch — no need to mock the module boundary.

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

test("model-runner perplexity detector is included and weighted when configured and available", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/v1/models")) return jsonResponse({ data: [{ id: "test-model" }] });
    return jsonResponse({ choices: [{ logprobs: { token_logprobs: [null, -3, -3, -3] } }] });
  }) as typeof fetch;

  const report = await detectAiUsage(HUMAN_TEXT);
  const detector = findDetector(report, "model-runner perplexity");
  assert.ok(detector.weight > 0);
  assert.match(detector.detail, /Perplexity/);
  assert.equal(report.detectors.length, 7);
  // Raw weights sum to 1.15 (not 1.0) with the 7th detector active — the
  // overall score's weighted-average math normalizes by the actual total,
  // so this is expected, not a bug. See the WEIGHT_PROFILES comment.
  const totalWeight = report.detectors.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(totalWeight - 1.15) < 1e-9, `expected total weight 1.15 with 7 detectors, got ${totalWeight}`);
  assert.ok(report.overallScore >= 0 && report.overallScore <= 100);
});

test("model-runner perplexity detector is cleanly omitted when the runner is configured but unreachable", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  const report = await detectAiUsage(HUMAN_TEXT);
  assert.equal(report.detectors.find((d) => d.name === "model-runner perplexity"), undefined);
  assert.equal(report.detectors.length, 6);
  const totalWeight = report.detectors.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(totalWeight - 1) < 1e-9);
});
