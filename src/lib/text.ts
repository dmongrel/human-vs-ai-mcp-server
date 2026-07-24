// Shared text utilities used by the detection and humanization heuristics.

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Strips literal '*', '_', and '#' markup characters (bold/italic emphasis,
// whether written as *asterisks* or _underscores_, and ATX headers) so
// callers can opt out of the markdown-in-prose signal for text that
// legitimately uses those characters (e.g. chapter headers in a
// manuscript). Deliberately narrow in scope — bullet lines using '-' are
// left untouched.
export function stripMarkdownMarkup(text: string): string {
  return text.replace(/[*_#]/g, "");
}

export function tokenizeWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((w) => w.length > 0);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

// Heuristic syllable counter (vowel-group counting with common English
// adjustments). Good enough for readability estimates; not linguistically
// exact.
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}
