// Humanization recommendations, built on the same signals as
// detectAiUsage.ts so the two tools stay consistent with each other.
// This produces actionable suggestions, not a rewritten text — rewriting is
// left to the caller (human or AI) since it requires judgment this heuristic
// layer doesn't have.

import { countAiTellPhrases } from "./aiPhrases.js";
import { detectAiUsage, fleschReadingEase, type DocumentType } from "./detectAiUsage.js";
import { mean, splitParagraphs, splitSentences, stdev, stripMarkdownMarkup, tokenizeWords } from "./text.js";

export interface HumanizeRecommendation {
  issue: string;
  suggestion: string;
  evidence: string;
}

export interface HumanizeReport {
  aiLikelihoodScore: number;
  type: DocumentType | "default";
  ignoreMd: boolean;
  recommendations: HumanizeRecommendation[];
}

// Thresholds mirror the intent of detectAiUsage's WEIGHT_PROFILES: "creative"
// (fiction/narrative) expects more variance and near-zero markdown/em-dash
// use, so it flags those more readily; "strategic" (business/marketing docs)
// treats structured markdown and uniform, punchy sentences as normal genre
// conventions, so it's more lenient on those and stricter on AI stock
// phrases (business buzzwords are the strongest tell in that genre).
interface HumanizeProfile {
  sentenceCovThreshold: number;
  readabilityStdevThreshold: number;
  flagMarkdown: boolean;
  emDashPer1000Threshold: number;
  hedgeCountThreshold: number;
}

const HUMANIZE_PROFILES: Record<"default" | DocumentType, HumanizeProfile> = {
  default: { sentenceCovThreshold: 0.35, readabilityStdevThreshold: 6, flagMarkdown: true, emDashPer1000Threshold: 0, hedgeCountThreshold: 2 },
  creative: { sentenceCovThreshold: 0.45, readabilityStdevThreshold: 10, flagMarkdown: true, emDashPer1000Threshold: 6, hedgeCountThreshold: 4 },
  strategic: { sentenceCovThreshold: 0.2, readabilityStdevThreshold: 3, flagMarkdown: false, emDashPer1000Threshold: 0, hedgeCountThreshold: 2 },
};

export async function humanizeText(text: string, type?: DocumentType, ignoreMd?: boolean): Promise<HumanizeReport> {
  const workingText = ignoreMd ? stripMarkdownMarkup(text) : text;
  const detection = await detectAiUsage(workingText, type);
  const profile = HUMANIZE_PROFILES[type ?? "default"];
  const sentences = splitSentences(workingText);
  const words = tokenizeWords(workingText);
  const lowerText = workingText.toLowerCase();
  const recommendations: HumanizeRecommendation[] = [];

  const phraseHits = countAiTellPhrases(lowerText);
  if (phraseHits.length > 0) {
    const list = phraseHits
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((h) => `"${h.phrase}" (x${h.count})`)
      .join(", ");
    recommendations.push({
      issue: "Overused AI stock phrases",
      suggestion: "Replace these with plainer, more specific language rooted in the actual content rather than generic transitions.",
      evidence: `Found: ${list}`,
    });
  }

  const lengths = sentences.map((s) => tokenizeWords(s).length).filter((n) => n > 0);
  if (lengths.length >= 4) {
    const m = mean(lengths);
    const sd = stdev(lengths);
    const cov = m > 0 ? sd / m : 0;
    if (cov < profile.sentenceCovThreshold) {
      recommendations.push({
        issue: "Uniform sentence length",
        suggestion: "Vary sentence length deliberately — mix short, punchy sentences with longer, more complex ones.",
        evidence: `Mean length ${m.toFixed(1)} words with low variation (coefficient of variation ${cov.toFixed(2)}).`,
      });
    }
  }

  const markdownBullets = (workingText.match(/^\s*[-*•]\s+/gm) ?? []).length;
  const markdownHeaders = (workingText.match(/^\s{0,3}#{1,6}\s+/gm) ?? []).length;
  if (profile.flagMarkdown && markdownBullets + markdownHeaders > 0 && sentences.length > 0) {
    recommendations.push({
      issue: "Chat-style markdown left in prose",
      suggestion: "If this text is meant to read as prose (an email, essay, article), convert bullet lists and headers into flowing sentences and paragraphs.",
      evidence: `${markdownBullets} bullet lines and ${markdownHeaders} header lines detected.`,
    });
  }

  const paragraphs = splitParagraphs(workingText);
  if (paragraphs.length >= 3) {
    const readabilityScores = paragraphs.map(fleschReadingEase).filter((s) => Number.isFinite(s));
    if (readabilityScores.length >= 3) {
      const sd = stdev(readabilityScores);
      if (sd < profile.readabilityStdevThreshold) {
        recommendations.push({
          issue: "Uniform readability across paragraphs",
          suggestion: "Let sentence complexity and word choice drift naturally between paragraphs instead of holding a single, even register throughout.",
          evidence: `Flesch Reading Ease stdev across ${readabilityScores.length} paragraphs: ${sd.toFixed(1)} (very uniform).`,
        });
      }
    }
  }

  const emDashCount = (workingText.match(/—/g) ?? []).length;
  const emDashPer1000 = words.length > 0 ? (emDashCount / words.length) * 1000 : 0;
  if (emDashCount > 0 && emDashPer1000 > profile.emDashPer1000Threshold) {
    recommendations.push({
      issue: "Overused em dashes",
      suggestion: "Replace each em dash (—) with a space, hyphen, space ( - ) or restructure the sentence; heavy em dash use is a well-known LLM stylistic tell.",
      evidence: `${emDashCount} em dash${emDashCount === 1 ? "" : "es"} found (${emDashPer1000.toFixed(1)} per 1000 words).`,
    });
  }

  const hedgeMatches = lowerText.match(/\b(it's worth noting|it should be noted|one might argue|arguably|in many ways|to some extent)\b/g) ?? [];
  if (hedgeMatches.length >= profile.hedgeCountThreshold) {
    recommendations.push({
      issue: "Excessive hedging language",
      suggestion: "Commit to direct statements where you have the evidence to do so; reserve hedges for genuine uncertainty.",
      evidence: `${hedgeMatches.length} hedging phrases found.`,
    });
  }

  // Reads the already-computed model-runner perplexity signal off
  // `detection.detectors` rather than calling scorePerplexity() again —
  // unlike the other checks above (recomputed independently here for
  // simplicity), this one is a network call and must not be duplicated.
  const modelPerplexity = detection.detectors.find((d) => d.name === "model-runner perplexity");
  if (modelPerplexity && modelPerplexity.score > 0.65) {
    recommendations.push({
      issue: "Text is unusually predictable to the configured local model",
      suggestion: "Introduce more varied or surprising phrasing — the model found this text's word choices unusually easy to predict, which tends to correlate with AI generation.",
      evidence: modelPerplexity.detail,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      issue: "No strong AI-style patterns detected",
      suggestion: "Text already reads with varied structure and natural phrasing; no changes recommended from these heuristics.",
      evidence: `Overall AI-likelihood score: ${detection.overallScore}/100.`,
    });
  }

  return { aiLikelihoodScore: detection.overallScore, type: type ?? "default", ignoreMd: ignoreMd ?? false, recommendations };
}

export function formatHumanizeReport(report: HumanizeReport): string {
  const lines: string[] = [];
  lines.push(`Humanization Recommendations`);
  lines.push(`=============================`);
  lines.push(`Current AI-likelihood score: ${report.aiLikelihoodScore}/100`);
  lines.push(`Ruleset: ${report.type}${report.type === "default" ? " (no type specified)" : ""}`);
  lines.push(`Markdown ignored (*, _, #): ${report.ignoreMd ? "yes" : "no"}`);
  lines.push(``);
  for (const r of report.recommendations) {
    lines.push(`- ${r.issue}`);
    lines.push(`    Suggestion: ${r.suggestion}`);
    lines.push(`    Evidence: ${r.evidence}`);
  }
  return lines.join("\n");
}
