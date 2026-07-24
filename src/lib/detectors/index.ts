// Registry of detection signals. Adding a signal means adding one file plus
// one line in CORE_DETECTORS; removing one means deleting both. See
// ./types.ts for the Detector contract and ./loadPlugins.ts for the
// external, third-party plugin mechanism (PLUGINS_DIR).

import { aiPhraseDetector } from "./aiPhrase.js";
import { burstinessDetector } from "./burstiness.js";
import { emDashDetector } from "./emDash.js";
import { lexicalDiversityDetector } from "./lexicalDiversity.js";
import { loadPlugins } from "./loadPlugins.js";
import { markdownInProseDetector } from "./markdownInProse.js";
import { modelPerplexityDetector } from "./modelPerplexity.js";
import { ngramRepetitionDetector } from "./ngramRepetition.js";
import { paragraphCoherenceDetector } from "./paragraphCoherence.js";
import { readabilityUniformityDetector } from "./readabilityUniformity.js";
import type { Detector } from "./types.js";

export const CORE_DETECTORS: Detector[] = [
  burstinessDetector,
  lexicalDiversityDetector,
  aiPhraseDetector,
  readabilityUniformityDetector,
  markdownInProseDetector,
  emDashDetector,
  modelPerplexityDetector,
  ngramRepetitionDetector,
  paragraphCoherenceDetector,
];

/** Core detectors plus any valid external plugins found in PLUGINS_DIR (unset -> none). Re-scans the directory on every call. */
export function getDetectors(): Detector[] {
  const plugins = loadPlugins(CORE_DETECTORS.map((d) => d.id));
  return [...CORE_DETECTORS, ...plugins];
}

export type { Detector, DetectorContext, DetectorResult, DetectorRunResult, DocumentType } from "./types.js";
