// Humanization recommendations, built on the same signals as
// detectAiUsage.ts so the two tools stay consistent with each other.
// This produces actionable suggestions, not a rewritten text — rewriting is
// left to the caller (human or AI) since it requires judgment this heuristic
// layer doesn't have.

import { countAiTellPhrases } from "./aiPhrases.js";
import { detectAiUsage, fleschReadingEase } from "./detectAiUsage.js";
import { mean, splitParagraphs, splitSentences, stdev, tokenizeWords } from "./text.js";

export interface HumanizeRecommendation {
  issue: string;
  suggestion: string;
  evidence: string;
}

export interface HumanizeReport {
  aiLikelihoodScore: number;
  recommendations: HumanizeRecommendation[];
}

export function humanizeText(text: string): HumanizeReport {
  const detection = detectAiUsage(text);
  const sentences = splitSentences(text);
  const lowerText = text.toLowerCase();
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
    if (cov < 0.35) {
      recommendations.push({
        issue: "Uniform sentence length",
        suggestion: "Vary sentence length deliberately — mix short, punchy sentences with longer, more complex ones.",
        evidence: `Mean length ${m.toFixed(1)} words with low variation (coefficient of variation ${cov.toFixed(2)}).`,
      });
    }
  }

  const markdownBullets = (text.match(/^\s*[-*•]\s+/gm) ?? []).length;
  const markdownHeaders = (text.match(/^\s{0,3}#{1,6}\s+/gm) ?? []).length;
  if (markdownBullets + markdownHeaders > 0 && sentences.length > 0) {
    recommendations.push({
      issue: "Chat-style markdown left in prose",
      suggestion: "If this text is meant to read as prose (an email, essay, article), convert bullet lists and headers into flowing sentences and paragraphs.",
      evidence: `${markdownBullets} bullet lines and ${markdownHeaders} header lines detected.`,
    });
  }

  const paragraphs = splitParagraphs(text);
  if (paragraphs.length >= 3) {
    const readabilityScores = paragraphs.map(fleschReadingEase).filter((s) => Number.isFinite(s));
    if (readabilityScores.length >= 3) {
      const sd = stdev(readabilityScores);
      if (sd < 6) {
        recommendations.push({
          issue: "Uniform readability across paragraphs",
          suggestion: "Let sentence complexity and word choice drift naturally between paragraphs instead of holding a single, even register throughout.",
          evidence: `Flesch Reading Ease stdev across ${readabilityScores.length} paragraphs: ${sd.toFixed(1)} (very uniform).`,
        });
      }
    }
  }

  const hedgeMatches = lowerText.match(/\b(it's worth noting|it should be noted|one might argue|arguably|in many ways|to some extent)\b/g) ?? [];
  if (hedgeMatches.length >= 2) {
    recommendations.push({
      issue: "Excessive hedging language",
      suggestion: "Commit to direct statements where you have the evidence to do so; reserve hedges for genuine uncertainty.",
      evidence: `${hedgeMatches.length} hedging phrases found.`,
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      issue: "No strong AI-style patterns detected",
      suggestion: "Text already reads with varied structure and natural phrasing; no changes recommended from these heuristics.",
      evidence: `Overall AI-likelihood score: ${detection.overallScore}/100.`,
    });
  }

  return { aiLikelihoodScore: detection.overallScore, recommendations };
}

export function formatHumanizeReport(report: HumanizeReport): string {
  const lines: string[] = [];
  lines.push(`Humanization Recommendations`);
  lines.push(`=============================`);
  lines.push(`Current AI-likelihood score: ${report.aiLikelihoodScore}/100`);
  lines.push(``);
  for (const r of report.recommendations) {
    lines.push(`- ${r.issue}`);
    lines.push(`    Suggestion: ${r.suggestion}`);
    lines.push(`    Evidence: ${r.evidence}`);
  }
  return lines.join("\n");
}
