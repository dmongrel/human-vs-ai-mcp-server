// Heuristic AI-text detection — orchestrator only.
//
// This is NOT a trained classifier — it is a transparent, explainable
// combination of independent stylometric/statistical signals, each
// implemented as its own file under ./detectors/ per the shared Detector
// interface (see ./detectors/types.ts) and combined here via weighted
// average into a 0-100 score. Adding or removing a signal means touching
// only ./detectors/ (one file + one line in ./detectors/index.ts) — nothing
// in this file needs to change. Third parties can also contribute detectors
// without forking the project at all, via PLUGINS_DIR — see
// ./detectors/loadPlugins.ts.
//
// See each file under ./detectors/ for that signal's research references
// and tuning notes.

import { getDetectors } from "./detectors/index.js";
import type { DetectorContext, DetectorResult } from "./detectors/types.js";
import { clamp, splitParagraphs, splitSentences, stripMarkdownMarkup, tokenizeWords } from "./text.js";

export type { DocumentType } from "./detectors/types.js";
import type { DocumentType } from "./detectors/types.js";

// Verdict bands, calibrated against measured scores rather than assumed ones
// (see docs/superpowers/notes/2026-07-25-llama-engine-calibration.md):
//
//   human narrative prose                                            6-22
//   AI narrative prose                                              19-38
//   AI text stuffed with stock phrases, markdown and uniform register   50
//
// Those first two ranges overlap, and that overlap is real rather than a
// calibration failure — see the note. The strongest signal (engine perplexity)
// cannot separate frontier-model output from human prose, so an AI chapter
// from a capable model lands at 19 and is reported "likely-human". Tightening
// the lower band to catch it would report measured human novelists as
// machine-written, which is the costlier error here.
//
// The previous bands (<35 / >65) predated any measurement and were wrong in
// both directions. 35 sat *above* the AI range, so genuinely AI-written prose
// was reported as "likely-human" — the worst possible failure for this tool.
// 65 was effectively unreachable: several signals (burstiness, lexical
// diversity, em dash) return 0 even for deliberately AI-stuffed text, which
// caps real documents near 50, so nothing was ever going to be called
// "likely-ai-generated".
//
// These are drawn from a small single-genre corpus. Well-written AI prose
// lands in "uncertain" by design — on this evidence that is the honest answer,
// not a threshold to tune away.
const LIKELY_HUMAN_BELOW = 20;
const LIKELY_AI_ABOVE = 45;

export interface DetectionReport {
  overallScore: number; // 0-100, likelihood of AI generation
  verdict: "likely-human" | "uncertain" | "likely-ai-generated";
  type: DocumentType | "default";
  ignoreMd: boolean;
  wordCount: number;
  sentenceCount: number;
  detectors: DetectorResult[];
  caveat: string;
}

/**
 * Per-call weight overrides, keyed by detector `id` (see each detector's
 * `id` field, or `listDetectorWeights()`/`formatDetectorWeightsTable()`
 * below for the full list with their ruleset defaults). A key not matching
 * any active detector is ignored rather than rejected, so a caller can pass
 * overrides for a plugin that may or may not be loaded. The per-detector,
 * per-ruleset WEIGHT tables hardcoded in each detector file remain the
 * defaults — this only overrides them for the current call, so tuning a
 * weight never requires a rebuild.
 */
export type WeightOverrides = Record<string, number>;

export async function detectAiUsage(
  text: string,
  type?: DocumentType,
  ignoreMd?: boolean,
  weightOverrides?: WeightOverrides
): Promise<DetectionReport> {
  for (const [id, weight] of Object.entries(weightOverrides ?? {})) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`Invalid weight override for detector "${id}": ${weight}. Weights must be a non-negative number.`);
    }
  }

  const workingText = ignoreMd ? stripMarkdownMarkup(text) : text;
  const trimmed = workingText.trim();
  const ctx: DetectorContext = {
    text: trimmed,
    sentences: splitSentences(trimmed),
    paragraphs: splitParagraphs(trimmed),
    words: tokenizeWords(trimmed),
    lowerText: trimmed.toLowerCase(),
    type: type ?? "default",
  };

  const results = await Promise.all(
    getDetectors()
      .filter((d) => d.enabled)
      .map(async (d) => {
        const raw = await d.run(ctx);
        if (!raw) return null;
        const override = weightOverrides?.[d.id];
        return { ...raw, weight: override ?? d.weight(ctx.type) };
      })
  );
  const detectors = results.filter((r): r is DetectorResult => r !== null);

  const totalWeight = detectors.reduce((a, d) => a + d.weight, 0);
  const weightedScore = totalWeight > 0 ? detectors.reduce((a, d) => a + d.score * d.weight, 0) / totalWeight : 0;
  const overallScore = Math.round(clamp(weightedScore) * 100);

  const verdict: DetectionReport["verdict"] =
    overallScore < LIKELY_HUMAN_BELOW ? "likely-human" : overallScore > LIKELY_AI_ABOVE ? "likely-ai-generated" : "uncertain";

  return {
    overallScore,
    verdict,
    type: ctx.type,
    ignoreMd: ignoreMd ?? false,
    wordCount: ctx.words.length,
    sentenceCount: ctx.sentences.length,
    detectors,
    caveat:
      "This is a heuristic, explainable estimate based on multiple independent signals (see the per-detector breakdown above), optionally including third-party plugin signals and, when a .gguf model is configured, teacher-forced perplexity against the bundled llama.cpp engine. It is not a trained classifier and can be wrong in both directions — treat it as a starting point for human review, not a verdict. A low score means the text shows none of the tells these signals look for, which is not the same as evidence it was written by a human: prose from a capable model scores inside the human range.",
  };
}

export function formatDetectionReport(report: DetectionReport): string {
  const lines: string[] = [];
  lines.push(`AI Usage Detection Report`);
  lines.push(`==========================`);
  lines.push(``);
  // Rendered from the verdict constants rather than written out by hand, so
  // changing a threshold can't leave the legend describing bands the tool no
  // longer applies.
  lines.push(`Legend — every score below uses one 0-100 scale, in the same direction:`);
  lines.push(`  0-${LIKELY_HUMAN_BELOW - 1}`.padEnd(10) + `likely-human         ← lower = closer to human-written`);
  lines.push(`  ${LIKELY_HUMAN_BELOW}-${LIKELY_AI_ABOVE}`.padEnd(10) + `uncertain`);
  lines.push(`  ${LIKELY_AI_ABOVE + 1}-100`.padEnd(10) + `likely-ai-generated  ← higher = closer to AI-generated`);
  lines.push(``);
  lines.push(`Overall AI-likelihood score: ${report.overallScore}/100 (${report.verdict})`);
  lines.push(`Ruleset: ${report.type}${report.type === "default" ? " (no type specified)" : ""}`);
  lines.push(`Markdown ignored (*, _, #): ${report.ignoreMd ? "yes" : "no"}`);
  lines.push(`Word count: ${report.wordCount}, Sentence count: ${report.sentenceCount}`);
  lines.push(``);
  lines.push(`Signal breakdown (same 0-100 scale: higher = more AI-like on that signal, lower = more human-like):`);
  for (const d of report.detectors) {
    lines.push(`- [${Math.round(d.score * 100)}/100, weight ${d.weight}] ${d.name}`);
    for (const detailLine of d.detail.split("\n")) {
      lines.push(`    ${detailLine}`);
    }
  }
  lines.push(``);
  lines.push(`Caveat: ${report.caveat}`);
  return lines.join("\n");
}

export interface DetectorWeightRow {
  id: string;
  name: string;
  default: number;
  creative: number;
  strategic: number;
}

/**
 * Every active detector's id, name, and default weight per ruleset — read
 * live from each detector's own `weight()` function, never hand-copied, so
 * this can't drift from the actual WEIGHT tables the way a hardcoded list in
 * documentation could. Used to render the table get_context shows, and to
 * tell a caller what detector ids are valid keys for a weight override.
 * Disabled detectors (paragraph coherence, the HTTP model runner) are
 * omitted, since they never contribute a weight to a real report.
 */
export function listDetectorWeights(): DetectorWeightRow[] {
  return getDetectors()
    .filter((d) => d.enabled)
    .map((d) => ({
      id: d.id,
      name: d.name,
      default: d.weight("default"),
      creative: d.weight("creative"),
      strategic: d.weight("strategic"),
    }));
}

export function formatDetectorWeightsTable(): string {
  const rows = listDetectorWeights();
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  const lines = [
    "Default weight per ruleset, by detector id (override any of these for one call via the 'weights' parameter):",
    ...rows.map((r) => `  ${r.id.padEnd(idWidth)}  default ${r.default}  creative ${r.creative}  strategic ${r.strategic}  (${r.name})`),
  ];
  return lines.join("\n");
}
