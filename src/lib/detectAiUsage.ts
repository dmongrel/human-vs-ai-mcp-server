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

export async function detectAiUsage(text: string, type?: DocumentType, ignoreMd?: boolean): Promise<DetectionReport> {
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
        return raw ? { ...raw, weight: d.weight(ctx.type) } : null;
      })
  );
  const detectors = results.filter((r): r is DetectorResult => r !== null);

  const totalWeight = detectors.reduce((a, d) => a + d.weight, 0);
  const weightedScore = totalWeight > 0 ? detectors.reduce((a, d) => a + d.score * d.weight, 0) / totalWeight : 0;
  const overallScore = Math.round(clamp(weightedScore) * 100);

  const verdict: DetectionReport["verdict"] =
    overallScore < 35 ? "likely-human" : overallScore > 65 ? "likely-ai-generated" : "uncertain";

  return {
    overallScore,
    verdict,
    type: ctx.type,
    ignoreMd: ignoreMd ?? false,
    wordCount: ctx.words.length,
    sentenceCount: ctx.sentences.length,
    detectors,
    caveat:
      "This is a heuristic, explainable estimate based on multiple independent signals (see the per-detector breakdown below), optionally including third-party plugin signals and an opt-in real perplexity check against a local model. It is not a trained classifier and can be wrong in both directions — treat it as a starting point for human review, not a verdict.",
  };
}

export function formatDetectionReport(report: DetectionReport): string {
  const lines: string[] = [];
  lines.push(`AI Usage Detection Report`);
  lines.push(`==========================`);
  lines.push(`Overall AI-likelihood score: ${report.overallScore}/100 (${report.verdict}) — 0 = reads as entirely human-written, 100 = reads as entirely AI-generated.`);
  lines.push(`Ruleset: ${report.type}${report.type === "default" ? " (no type specified)" : ""}`);
  lines.push(`Markdown ignored (*, _, #): ${report.ignoreMd ? "yes" : "no"}`);
  lines.push(`Word count: ${report.wordCount}, Sentence count: ${report.sentenceCount}`);
  lines.push(``);
  lines.push(`Signal breakdown (each signal scored 0-100: 0 = strongly human-like on that signal, 100 = strongly AI-like on that signal):`);
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
