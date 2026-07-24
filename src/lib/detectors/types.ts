// Shared contract for detection signals. Each signal (built-in or a
// third-party plugin loaded from PLUGINS_DIR, see loadPlugins.ts) implements
// this Detector interface and is combined by detectAiUsage.ts via weighted
// average. Adding a signal means adding one file + one line in index.ts;
// removing one means deleting both.

export type DocumentType = "creative" | "strategic";

export interface DetectorResult {
  name: string;
  weight: number;
  score: number; // 0 = human-like, 1 = AI-like
  detail: string;
}

/** What a detector's run() returns — weight is attached by the orchestrator via Detector.weight(), not by the detector itself. */
export type DetectorRunResult = Omit<DetectorResult, "weight">;

export interface DetectorContext {
  /** Working text: trimmed, and with markdown markup stripped first if ignoreMd was set. */
  text: string;
  sentences: string[];
  paragraphs: string[];
  words: string[];
  lowerText: string;
  type: DocumentType | "default";
}

export interface Detector {
  /** Stable, unique identifier. Plugins colliding with a core id are skipped. */
  id: string;
  /** Human-readable name shown in reports as DetectorResult.name. */
  name: string;
  /** If false, the detector is skipped entirely (e.g. the disabled model-runner signal). */
  enabled: boolean;
  /** Weight for a given ruleset; called once per run and attached to the result. */
  weight(type: DocumentType | "default"): number;
  /** Return null to omit this signal from the report (e.g. not enough text, or an unreachable optional backend). */
  run(ctx: DetectorContext): DetectorRunResult | null | Promise<DetectorRunResult | null>;
}
