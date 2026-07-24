// Markdown-in-prose: headers/bullets/bold markup embedded in what should be
// plain prose, a common artifact of copy-pasted chat output.

import { clamp } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.15,
  creative: 0.15,
  strategic: 0.05, // bullets/headers are an expected genre convention
};

// Markdown line-density that saturates the score at 1.0. Higher = more tolerant.
const DENSITY_SATURATION: Record<"default" | DocumentType, number> = {
  default: 0.25,
  creative: 0.1, // fiction should have virtually no markdown
  strategic: 1.0,
};

export const markdownInProseDetector: Detector = {
  id: "markdown-in-prose",
  name: "markdown-in-prose artifacts",
  enabled: true,
  weight: (type) => WEIGHT[type],
  run: (ctx) => {
    const text = ctx.text;
    const bulletLines = (text.match(/^\s*[-*•]\s+/gm) ?? []).length;
    const headerLines = (text.match(/^\s{0,3}#{1,6}\s+/gm) ?? []).length;
    const boldRuns = (text.match(/\*\*[^*]+\*\*/g) ?? []).length;
    const totalLines = Math.max(1, text.split(/\n/).length);
    const density = (bulletLines + headerLines + boldRuns) / totalLines;
    const score = clamp(density / DENSITY_SATURATION[ctx.type]);
    return {
      name: "markdown-in-prose artifacts",
      score,
      detail: `${bulletLines} bullet lines, ${headerLines} header lines, ${boldRuns} bold runs across ${totalLines} lines. Chat-style markdown left in prose is a common copy-paste artifact.`,
    };
  },
};
