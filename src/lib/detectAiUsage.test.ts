import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { detectAiUsage, formatDetectionReport, type DetectionReport } from "./detectAiUsage.js";
import { CORE_DETECTORS } from "./detectors/index.js";
import { paragraphCoherenceDetector } from "./detectors/paragraphCoherence.js";
import type { DetectorContext } from "./detectors/types.js";

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

The jar itself was ordinary. Thick glass, a dented tin lid that never quite sat straight, and a paper label soaked off decades before I was born, leaving a pale rectangle where the glue had been.

She died in February, which felt like cheating, because February is already the worst month and now it had this too. We cleared the house over a long weekend and argued about almost everything in it.

Nobody wanted the jar. That is not the same as nobody caring about it. My aunt picked it up twice and put it down twice, and on the second time she said something about the lid, and then she went and sat in the car for a while.

So it came home with me, and it lived on a shelf for two years doing nothing at all, which I have decided is a legitimate thing for an object to do.

Last spring a button came off my coat and I went to the jar without thinking, the way you reach for a light switch in a dark room you grew up in. It took me a long time to find one that matched, and when I did it was not a match at all, not really, just close enough that nobody but me would notice.

I sewed it on anyway. I have thought about that a great deal since, and I still cannot decide whether it means anything, or whether I have simply inherited her habit of keeping what I cannot use.
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
    if (report.overallScore < 20) assert.equal(report.verdict, "likely-human");
    else if (report.overallScore > 45) assert.equal(report.verdict, "likely-ai-generated");
    else assert.equal(report.verdict, "uncertain");
  }
});

test("returns all seven active named detectors (model-runner perplexity and paragraph coherence stay disabled)", async () => {
  const report = await detectAiUsage(HUMAN_TEXT);
  const names = report.detectors.map((d) => d.name).sort();
  assert.deepEqual(names, [
    "AI stock-phrase usage",
    "markdown-in-prose artifacts",
    "readability uniformity",
    "sentence-length burstiness",
    "lexical diversity",
    "em dash overuse",
    "n-gram repetition",
  ].sort());
  const totalWeight = report.detectors.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(totalWeight - 1.1) < 1e-9, `weights should sum to 1.1, got ${totalWeight}`);
});

test("em dash detector scores high for heavy em dash use and reports no hits for clean text", async () => {
  const heavy = await detectAiUsage("This is a sentence — with an em dash — and another — right here — for emphasis — repeatedly.");
  const heavyDetector = findDetector(heavy, "em dash overuse");
  assert.ok(heavyDetector.score > 0.5, `expected high em-dash score, got ${heavyDetector.score}`);
  assert.match(heavyDetector.detail, /dashes/);

  const clean = await detectAiUsage(HUMAN_TEXT);
  const cleanDetector = findDetector(clean, "em dash overuse");
  assert.equal(cleanDetector.score, 0);
  assert.match(cleanDetector.detail, /No em or en dashes detected/);
});

test("em dash detector counts whitespace-flanked en dashes as the same tell", async () => {
  // A local llama-3-8b chapter used en dashes (U+2013) throughout instead of
  // em dashes, at 12 per 1000 words, and the detector reported nothing.
  const text = "This is a sentence – with an en dash – and another – right here – for emphasis – repeatedly.";
  const detector = findDetector(await detectAiUsage(text), "em dash overuse");
  assert.ok(detector.score > 0.5, `expected en dashes to register, got ${detector.score}`);
  assert.match(detector.detail, /en dash/);
});

test("em dash detector ignores en dashes used as number ranges", async () => {
  // "1914–18" is ordinary typography, not a parenthetical pause, so it must
  // not be counted. Only a whitespace-flanked en dash stands in for an em dash.
  const text = "The war ran 1914–18 and the survey covered pages 40–65 across the 2019–2020 period, which the team documented carefully in a report nobody read.";
  const detector = findDetector(await detectAiUsage(text), "em dash overuse");
  assert.equal(detector.score, 0);
  assert.match(detector.detail, /No em or en dashes detected/);
});

test("em dash detector counts em and en dashes together", async () => {
  const text = "One clause — then another – and a third — closing it out here with enough words to make a sentence.";
  const detector = findDetector(await detectAiUsage(text), "em dash overuse");
  assert.match(detector.detail, /3 dashes/);
});

test("report echoes back the type used, defaulting to 'default'", async () => {
  assert.equal((await detectAiUsage(HUMAN_TEXT)).type, "default");
  assert.equal((await detectAiUsage(HUMAN_TEXT, "creative")).type, "creative");
  assert.equal((await detectAiUsage(HUMAN_TEXT, "strategic")).type, "strategic");
});

test("all three rulesets produce weights that sum to 1.1", async () => {
  for (const type of [undefined, "creative", "strategic"] as const) {
    const report = await detectAiUsage(HUMAN_TEXT, type);
    const totalWeight = report.detectors.reduce((a, d) => a + d.weight, 0);
    assert.ok(Math.abs(totalWeight - 1.1) < 1e-9, `${type ?? "default"} weights should sum to 1.1, got ${totalWeight}`);
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

test("formatDetectionReport prints a legend giving the direction of the scale", async () => {
  const formatted = formatDetectionReport(await detectAiUsage(HUMAN_TEXT));
  assert.match(formatted, /Legend/);
  assert.match(formatted, /closer to human-written/i);
  assert.match(formatted, /closer to AI-generated/i);
});

test("the legend's bands match the verdict thresholds actually applied", async () => {
  const formatted = formatDetectionReport(await detectAiUsage(HUMAN_TEXT));
  // Bands are rendered from the same constants the verdict uses, so a
  // threshold change can't leave the legend lying to the reader.
  assert.match(formatted, /0-19\s+likely-human/);
  assert.match(formatted, /20-45\s+uncertain/);
  assert.match(formatted, /46-100\s+likely-ai-generated/);
});

test("the signal breakdown restates which direction is more AI-like", async () => {
  const formatted = formatDetectionReport(await detectAiUsage(HUMAN_TEXT));
  assert.match(formatted, /Signal breakdown[^\n]*higher = more AI-like/i);
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

test("model-runner perplexity detector stays disabled even when the runner is configured and would succeed", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  let fetchCalled = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalled = true;
    if (String(url).includes("/v1/models")) return jsonResponse({ data: [{ id: "test-model" }] });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const chunk = body.messages?.[1]?.content ?? "";
    return jsonResponse({
      choices: [{ message: { content: chunk }, logprobs: { content: [{ logprob: -3 }, { logprob: -3 }, { logprob: -3 }] } }],
    });
  }) as typeof fetch;

  const report = await detectAiUsage(HUMAN_TEXT);
  // Disabled via the modelPerplexityDetector's `enabled: false` — see
  // src/lib/detectors/modelPerplexity.ts. Found unreliable in practice
  // (structural bias + impractically slow against every runner/model
  // tested); kept off, not removed, in case a fix is found later.
  assert.equal(report.detectors.find((d) => d.name === "model-runner perplexity"), undefined);
  assert.equal(report.detectors.length, 7);
  assert.equal(fetchCalled, false, "expected no network call to be attempted while the signal is disabled");
  const totalWeight = report.detectors.reduce((a, d) => a + d.weight, 0);
  assert.ok(Math.abs(totalWeight - 1.1) < 1e-9);
});

// --- N-gram repetition detector ---

test("n-gram repetition detector scores high for repetitive trigrams and reports the repeated phrase", async () => {
  const repetitive = "We will move forward together. We will move forward together. We will move forward together and we will move forward together, because moving forward together is what we do, we will move forward together always. Every single day we will move forward together, and every single night we will move forward together, no matter what happens we will move forward together as one unified team with one unified purpose and one unified vision for the future ahead.";
  const report = await detectAiUsage(repetitive);
  const detector = findDetector(report, "n-gram repetition");
  assert.ok(detector.score > 0.5, `expected high repetition score, got ${detector.score}`);
  assert.match(detector.detail, /move forward together/);
});

test("n-gram repetition detector scores low for varied human text", async () => {
  const report = await detectAiUsage(HUMAN_TEXT + " " + HUMAN_TEXT.split(" ").reverse().join(" "));
  const detector = findDetector(report, "n-gram repetition");
  assert.ok(detector.score < 0.5, `expected low repetition score for varied text, got ${detector.score}`);
});

test("n-gram repetition detector is neutral (0.5) for too-short input", async () => {
  const report = await detectAiUsage("Just a few short words here, not much text.");
  const detector = findDetector(report, "n-gram repetition");
  assert.equal(detector.score, 0.5);
});

// --- Paragraph coherence detector ---
//
// Disabled (see the file's header comment: its premise does not hold for
// narrative prose). Exercised directly rather than through detectAiUsage,
// which filters on `enabled`, so the implementation stays covered while it is
// switched off.

function coherenceContext(text: string): DetectorContext {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return { text, sentences: [text], paragraphs, words: text.split(/\s+/), lowerText: text.toLowerCase(), type: "default" };
}

test("paragraph coherence detector is registered but disabled", () => {
  const detector = CORE_DETECTORS.find((d) => d.id === "paragraph-coherence");
  assert.ok(detector, "expected the detector to remain registered");
  assert.equal(detector!.enabled, false);
});

test("paragraph coherence is absent from a report while disabled", async () => {
  const report = await detectAiUsage(HUMAN_TEXT);
  assert.equal(report.detectors.find((d) => d.name === "paragraph coherence"), undefined);
});

test("paragraph coherence detector scores high when adjacent paragraphs share heavy vocabulary overlap", async () => {
  const paragraph = "The quarterly revenue growth strategy focuses on quarterly revenue growth across every market segment we serve. Quarterly revenue growth remains the primary quarterly revenue growth metric this year.";
  const result = await paragraphCoherenceDetector.run(coherenceContext(Array(4).fill(paragraph).join("\n\n")));
  assert.ok(result, "expected a result for four measurable paragraphs");
  assert.ok(result!.score > 0.5, `expected high coherence score for repeated-topic paragraphs, got ${result!.score}`);
});

test("paragraph coherence detector scores low when paragraphs digress topically", async () => {
  const result = await paragraphCoherenceDetector.run(coherenceContext(HUMAN_TEXT.trim()));
  assert.ok(result, "expected a result for three measurable paragraphs");
  assert.ok(result!.score < 0.5, `expected low coherence score for digressive human text, got ${result!.score}`);
});

test("paragraph coherence detector is omitted with too few measurable paragraphs", async () => {
  const result = await paragraphCoherenceDetector.run(coherenceContext("Just one short paragraph here with no others to compare against."));
  assert.equal(result, null, "a signal that could not be measured must be omitted, not reported as 0.5");
});

// --- Readability uniformity detector ---

// Two ~32-word paragraphs with identical structure, so their Flesch scores
// match almost exactly. Interleaved with the one-word dialogue lines that
// dominate real narrative prose.
const UNIFORM_PARAGRAPH_A =
  "The system processes each request in the order it arrives and returns a result to the caller without any delay. The handler checks the input before it moves on to the next stage.";
const UNIFORM_PARAGRAPH_B =
  "The service handles every message in the order it appears and sends a response to the client without any pause. The worker reads the record before it hands off to the final step.";

test("readability uniformity ignores short dialogue lines that would otherwise swamp the measurement", async () => {
  // Eight near-identical paragraphs, enough to clear the measurement floor,
  // interleaved with the one-word dialogue lines that dominate real narrative
  // prose. Flesch is unstable below ~20 words: a one-word line scores wildly,
  // and including it makes uniform prose look varied.
  const pair = [UNIFORM_PARAGRAPH_A, UNIFORM_PARAGRAPH_B];
  const blocks: string[] = [];
  for (let i = 0; i < 8; i++) blocks.push(pair[i % 2], i % 2 === 0 ? '"Yes."' : '"Mm."');
  const report = await detectAiUsage(blocks.join("\n\n"));
  const detector = findDetector(report, "readability uniformity");
  assert.ok(detector.score > 0.8, `expected near-identical paragraphs to read as uniform, got ${detector.score}`);
  assert.match(detector.detail, /too short to score reliably/);
});

test("readability uniformity is omitted when too few paragraphs are long enough to measure", async () => {
  const text = [UNIFORM_PARAGRAPH_A, '"Yes."', '"No."', "Short line here.", UNIFORM_PARAGRAPH_B].join("\n\n");
  const report = await detectAiUsage(text);
  assert.equal(
    report.detectors.find((d) => d.name === "readability uniformity"),
    undefined,
    "two measurable paragraphs is not enough to report a stdev"
  );
});

test("readability uniformity still separates varied prose from uniform prose", async () => {
  // Both samples clear the 8-paragraph floor, so the only thing that differs
  // between them is how much the register moves.
  const varied = [
    "Rain. Then nothing at all, for a long while, and then rain again, harder this time, the kind that gets into your shoes and stays there.",
    "The epistemological ramifications of this position, insofar as they bear upon the antecedent question of referential opacity, remain substantially underdetermined by the available evidence.",
    "She counted the change twice. Sixty cents. Not enough for the bus, and too far to walk before dark, so she sat down on the kerb to think about it.",
    "Notwithstanding the foregoing, the counterparty shall indemnify and hold harmless each affiliated entity against any liability arising howsoever from the aforementioned contingencies.",
    "He ate the sandwich. It was a bad sandwich. He ate it anyway because it was there and because he had paid for it, which felt at the time like reason enough.",
    "Consideration of the thermodynamic constraints imposed upon such a configuration necessitates a corresponding reevaluation of the assumptions underpinning the initial calculation.",
    "The dog knew. Dogs always know. It stood in the hallway with its ears back and would not come when she called it, not once, not even for the good treats.",
    "Insofar as any generalization may be ventured, the observed phenomena appear consistent with a mechanism whose particulars remain, for the present, imperfectly characterized.",
  ].join("\n\n");
  const uniformBlocks: string[] = [];
  for (let i = 0; i < 8; i++) uniformBlocks.push(i % 2 === 0 ? UNIFORM_PARAGRAPH_A : UNIFORM_PARAGRAPH_B);
  const uniform = uniformBlocks.join("\n\n");

  const variedScore = findDetector(await detectAiUsage(varied), "readability uniformity").score;
  const uniformScore = findDetector(await detectAiUsage(uniform), "readability uniformity").score;
  assert.ok(uniformScore > variedScore + 0.3, `expected a clear gap, got uniform ${uniformScore} vs varied ${variedScore}`);
});
