// Stock phrases and words disproportionately overused by LLM output, compiled
// from community/academic write-ups on detectable "AI tells"
// (e.g. Gehrmann et al. "GLTR", and widely reported ChatGPT-overused-word
// lists such as Originality.ai's and GPTZero's public analyses). None of
// these are proof of AI authorship on their own — they are signal, not fact.
export const AI_TELL_PHRASES: readonly string[] = [
  "delve into",
  "delving into",
  "boasts",
  "tapestry",
  "in today's fast-paced world",
  "in today's digital age",
  "it's important to note",
  "it's important to remember",
  "it is important to note",
  "navigating the complexities",
  "unlock the potential",
  "unleash the power",
  "let's dive in",
  "in conclusion",
  "in summary",
  "overall,",
  "furthermore,",
  "moreover,",
  "additionally,",
  "on the other hand,",
  "as an ai language model",
  "as an ai model",
  "certainly!",
  "i hope this helps",
  "feel free to",
  "dive into",
  "landscape of",
  "realm of",
  "testament to",
  "underscores",
  "foster a",
  "seamless",
  "seamlessly",
  "robust",
  "leverage",
  "leveraging",
  "cutting-edge",
  "game-changer",
  "game changing",
  "holistic",
  "myriad of",
  "plethora of",
  "elevate",
  "streamline",
  "streamlining",
  "in essence",
  "at its core",
  "when it comes to",
  "not only... but also",
  "plays a pivotal role",
  "plays a crucial role",
  "stands as a",
  "serves as a",
] as const;

export function countAiTellPhrases(lowerText: string): { phrase: string; count: number }[] {
  const hits: { phrase: string; count: number }[] = [];
  for (const phrase of AI_TELL_PHRASES) {
    if (phrase.includes("...")) continue; // pattern placeholder, not literal
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = lowerText.match(new RegExp(escaped, "g"));
    if (matches && matches.length > 0) {
      hits.push({ phrase, count: matches.length });
    }
  }
  return hits;
}
