# llama-engine perplexity: calibration measurements

**Date**: 2026-07-25
**Status**: measured; anchors applied (16 / 28); detector enabled; weight 0.30. See the follow-up sections at the end for later changes to `readabilityUniformity`, `paragraphCoherence` and the verdict bands.

## Setup

| | |
|---|---|
| Model | `Qwen2.5-1.5B-Instruct.Q4_K_M.gguf` (Q4_K_M quantization, 1.5B params) |
| Engine | llama.cpp `b10107`, Windows CPU build, via `packages/win32-x64/llama-engine-helper.exe` |
| Context size | 512 tokens per chunk, non-overlapping |
| Sample size | 3 human, 3 AI, ~1,200 words / ~1,500 scored tokens each |
| Scoring tool | `~/.claude/scripts/llama-engine-score.js` |

**Human samples**: 1,200-word excerpts taken from 40% into each of the three `examples/*.md`
manuscripts (past any opening scaffolding). Contemporary/YA fantasy prose with heavy dialogue.

**AI samples**: three passages written by Claude Opus 5 in a single session, deliberately
matched to the human samples in genre, register, length and dialogue density, and written
*without* any attempt to humanize or evade detection. Written straight is the relevant case —
a detector that only catches deliberately un-disguised AI text is still the baseline worth
measuring first.

## Results

| Group | Sample | Perplexity | Tokens scored | Wall clock |
|---|---|---|---|---|
| human | The Magic Girl Whom Everyone Hated | 25.10 | 1551 | 18.8s |
| human | The Magic Hower | 27.33 | 1513 | 18.4s |
| human | The Unmaking | 24.07 | 1534 | 19.0s |
| ai | duel scene | 19.33 | 1488 | 18.0s |
| ai | council scene | 17.66 | 1515 | 18.2s |
| ai | aftermath scene | 15.81 | 1397 | 17.0s |

| Group | n | mean | min | max |
|---|---|---|---|---|
| human | 3 | **25.50** | 24.07 | 27.33 |
| ai | 3 | **17.60** | 15.81 | 19.33 |

## Does it discriminate?

**Yes, on this sample.** The groups separate completely: the highest AI perplexity (19.33) sits
below the lowest human perplexity (24.07), with a gap of 4.74 and no overlap. Group means differ
by 45%.

This is the property the HTTP verbatim-echo path failed outright — that one returned an
*identical* value for three differently-worded human chapters. A wider spot-check across text
types spans three orders of magnitude with the same model: a famous Dickens opening 1.7,
LLM-flavoured boilerplate 11.3, idiosyncratic human prose 46.9, random word salad 4016.

## What this does not establish

- **n=3 per group.** Enough to show the signal is not degenerate. Nowhere near enough to place a
  threshold with any confidence, and far too few to say anything about variance.
- **One author per group.** All three human samples come from the same corpus and plausibly the
  same writer; all three AI samples were written by one model in one session. Between-author
  variation is completely unmeasured and could easily exceed the human/AI gap.
- **One model, one quantization.** Perplexity values are model-specific and do not transfer.
  Anchors derived here are meaningless against any other `.gguf`.
- **Un-disguised AI text only.** Text that has been deliberately humanized, or produced by a
  model tuned to be less predictable, is untested.
- **Genre-bound.** All six samples are dialogue-heavy contemporary fantasy prose. Technical
  writing, journalism and academic prose are all untested and would very likely need different
  anchors — which is an argument for per-`DocumentType` anchors that this data cannot yet
  support.

## Anchors

The detector originally shipped provisional, pre-measurement anchors of
`PERPLEXITY_AI_LIKE_ANCHOR = 6` / `PERPLEXITY_HUMAN_LIKE_ANCHOR = 40`. Against the measurements
above those were directionally correct but badly compressed: AI text mapped to ~0.43 and human
text to ~0.24, so both groups landed below the 0.5 midpoint and the signal contributed far less
separation than it actually has.

Anchors of **16 (AI-like) / 28 (human-like)** fit this data, putting the observed boundary near
the middle of the range. **These have been applied**, on instruction, as a better-than-nothing
working estimate — the previous values were not merely imprecise but actively compressed the
signal. The caveat stands regardless: with n=3 per group and a single author on each side,
anchors fitted this tightly to six data points may encode the sample rather than the phenomenon.
`llamaEnginePerplexity.test.ts` pins the intent (measured AI range above 0.5, human range below),
so drift fails loudly.

## Recommendation

The technique is validated; the threshold is a working estimate from six samples. The detector was subsequently **enabled** on instruction, at weight 0.30. The work below still stands as what would turn that working estimate into a calibrated one:

In rough order of value per effort:

1. **More human authors.** 15-20 samples from clearly distinct writers, ideally across genres.
   This is the single biggest gap — it establishes whether the human distribution is tight
   enough for a fixed threshold to mean anything.
2. **More AI sources.** Samples from several different models, not just one, plus a set of
   deliberately humanized AI text to find where the signal degrades.
3. **Then fit anchors** to the measured distributions, record the model they came from in
   `llamaEnginePerplexity.ts`, and re-run the full set.
4. **Consider per-`DocumentType` anchors** if the genre spread turns out to matter, following the
   pattern the other detectors already use for their weight tables.

## Follow-up: readability uniformity, and a fixture bug that hid it

The first version of the human excerpts was extracted with `" ".join(words[...])`, which
flattened every sample to a **single paragraph with no newlines**. Both paragraph-based detectors
(`readabilityUniformity`, `paragraphCoherence`) hit their "not enough paragraphs" guard and
returned their 0.5 fallback for all three human samples — which looked exactly like the
detectors scoring human prose at 50 and AI prose at ~0, i.e. backwards. They were not. They were
correctly reporting that they could not measure anything. Any per-signal comparison made against
those flattened fixtures is void.

Re-extracted with paragraph structure preserved (24-39 paragraphs per sample), two real findings
emerged:

**`readabilityUniformity` was measuring paragraph length, not register drift.** Flesch Reading
Ease is a ratio of words-per-sentence and syllables-per-word; on a one-word line of dialogue
("Mm.") both terms are meaningless, and narrative prose is mostly such lines. Unfiltered, the
stdev landed at 20-29 for human and AI text alike and the score saturated at 0 for everything.
Filtering to paragraphs of >= 20 words recovers a clean split:

| | AI | human | gap |
|---|---|---|---|
| Flesch stdev, unfiltered | 20.8, 28.6, 23.8 | 26.1, 24.8, 22.5 | none (overlapping) |
| Flesch stdev, >= 20 words | 8.6, 13.4, 11.3 | 21.1, 21.2, 21.3 | **+7.7** |

20 words was the shortest threshold preserving separation, and the gap is widest at 20-25.
Anchors set to 10 (uniform/AI) and 22 (varied/human). After the fix this is the *strongest*
signal in the set on this corpus: human 7.0, AI 87.0.

**`paragraphCoherence` does not discriminate on narrative prose.** Its premise is that AI text
stays more tightly on-topic. Adjacent-paragraph cosine similarity does not bear that out here, at
any paragraph-length filter:

| filter | AI | human |
|---|---|---|
| unfiltered | 0.056, 0.057, 0.014 | 0.068, 0.060, 0.054 |
| >= 30 words | 0.058, 0.067, 0.069 | 0.079, 0.062, 0.067 |
| >= 60 words | 0.047, 0.086, 0.098 | 0.105, 0.082, 0.122 |

Fully overlapping, and if anything human prose scores *higher* — the opposite of the premise. All
observed values sit far below the detector's `AI_LIKE_SIMILARITY` anchor of 0.35, so it reports
~0 for everything. Its anchors were deliberately **not** retuned: with no separation in the
underlying statistic, spreading the output across 0-1 would amplify noise into a confident wrong
signal. The detector still behaves correctly on its stated premise (synthetic paragraphs with
heavy vocabulary overlap do score high) — the premise just doesn't hold for this genre.
Recommend disabling or down-weighting it pending evidence from other genres.

Both detectors also had a shared defect, fixed: they returned **0.5 when they could not measure
anything**. The orchestrator's weighted average has no concept of "unknown", so 0.5 is not
neutral — it asserts "50/100 AI-likelihood" with the detector's full weight. They now return
`null`, which the contract already supports for exactly this case.

### Aggregate effect

| | human | AI | gap |
|---|---|---|---|
| before | 5.7 | 18.0 | 12.3 |
| after readability fix | 6.7 | 30.0 | **23.3** |
| after disabling coherence | 6-8 | 29-35 | **21** |

## Follow-up: verdict bands

`paragraphCoherence` was subsequently disabled (`enabled: false`) on the evidence above, and the
verdict bands were recalibrated against three measured reference points:

| text | score |
|---|---|
| human narrative prose | 6, 7, 8 |
| AI narrative prose, well-written and style-matched | 29, 30, 35 |
| AI text stuffed with stock phrases, markdown and uniform register | 50 |

The previous bands (`<35` likely-human, `>65` likely-ai-generated) predated any measurement and
were wrong in both directions:

- **35 sat above the entire AI range**, so genuinely AI-written prose was reported as
  "likely-human" — the worst failure mode this tool has.
- **65 was effectively unreachable.** Burstiness, lexical diversity and em dash all return 0 even
  for deliberately AI-stuffed text, capping real documents near 50. Nothing was ever going to be
  called "likely-ai-generated".

New bands: **likely-human <20, uncertain 20-45, likely-ai-generated >45.** Human samples clear the
lower bound by 12 points and the stuffed-AI sample clears the upper bound. Well-written AI
narrative prose lands in "uncertain" by design — on this evidence that is the honest answer, and
not a threshold to tune away. Tightening further would start producing false positives on human
prose, which is the more costly error for this tool.

## Follow-up: three AI authors, and what perplexity actually measures

Three AI-written chapters of the same brief (radio telescope, remote desert, unexplained
signal, ~1,200 words, dialogue-heavy), scored against the same 12 human chapters.

| author | perplexity | ppl score | readability | dash | overall |
|---|---|---|---|---|---|
| llama-3-8b-instruct | **5.7** | 100 | 72 | 76 | 35/100 |
| qwen3-14b | **7.2** | 100 | 67 | 36 | 32/100 |
| Claude Opus 5 | **21.2** | 42 | 71 | 10 | 21/100 |
| human chapters (n=12) | 19.6-28.6 | 11-50 | 11-50 | 0 | 6-22/100 |

**The family confound is not real.** The worry was that scoring with Qwen2.5-1.5B would
flatter text written by another Qwen model, making perplexity a lineage detector rather than
an AI detector. It went the other way: qwen3-14b scored 7.2 against llama-3-8b's 5.7, so the
same-family model was measurably *less* predictable to the scorer. Whatever perplexity is
tracking, it is not shared tokenizer or training lineage.

**Detection difficulty scales with model capability, and the gap is enormous.** Two locally
runnable open models land at 5.7-7.2 — three to four times more predictable than any human
chapter, saturating the signal with room to spare. Claude Opus 5 lands at 21.2, inside the
human range of 19.6-28.6. On the strongest signal this tool has, a frontier model is
indistinguishable from human prose while an 8B model is trivially caught.

That is the finding that matters for how the tool is described. It is a reliable detector of
small and mid-size open models, and close to useless against frontier output. The anchors
cannot fix this: no threshold separates 21.2 from a human range that spans 19.6 to 28.6.

**Stylistic tells are per-model and do not generalize.** Each author had a different
punctuation habit: llama-3-8b used spaced en dashes (76/100), qwen3-14b used real em dashes
(36/100), Claude used almost none (10/100). A dash heuristic tuned on ChatGPT-era output
caught none of llama-3-8b's until the variant table was added. Expect the same fragility
from every fingerprint-style signal.

**Readability uniformity was the one consistent signal**, scoring 67-72 across all three AI
chapters regardless of author, against 11-50 for human chapters. It is weaker than perplexity
against small models but, unlike perplexity, it did not collapse against Opus 5 — it still
read 71 there while perplexity read 42.

**Caveats.** One chapter per author, one genre, one prompt. The llama-3-8b sample was
assembled from two generations (it stopped at 614 words) and so contains a seam. The Claude
sample was written in-session by an author with full knowledge of what these detectors
measure, which plausibly depresses its score; the qwen3-14b and llama-3-8b samples have no
such contamination and are the cleaner data points.

## Follow-up: perplexity anchors loosened for chapter-level text

The original anchors (16 / 28) were fitted to 1,200-word excerpts taken from mid-manuscript,
where the groups separated cleanly. Testing whole chapters broke that picture.

| sample | n | perplexity |
|---|---|---|
| human, 1,200-word excerpts | 3 | 24.1-27.3 |
| **human, whole chapters** | **12** | **19.6-28.6** |
| AI, 1,200-word excerpts | 3 | 15.8-19.3 |
| **AI, whole chapter** | **1** | **21.2** |

The human chapter range runs 4.5 points lower than the excerpt range, and an AI-written
chapter landed at 21.2 — inside it. **The two populations overlap at chapter level.** The
tight anchors were scoring 3 of 12 real human chapters above 0.5, i.e. calling a human
author's chapter machine-written, which is the expensive direction to be wrong in.

Widened to **12 / 32**, chosen by testing candidates against all 16 measurements:

| anchors | human chapters | AI samples | human chapters >50 |
|---|---|---|---|
| 16 / 28 (before) | 0-64, mean 36 | 50-100, mean 75 | **3 of 12** |
| **12 / 32 (chosen)** | 11-50, mean 34 | 42-72, mean 56 | **0 of 12** |
| 10 / 36 | 18-47, mean 35 | 41-64, mean 52 | 0 of 12 |

12/32 removes the false positives while keeping the widest gap between group means (22
points). 10/36 removes them too but compresses the AI end for no gain. The cost of
loosening is a less decisive signal — AI text now scores ~56 rather than ~75 — which is
the honest reflection of a measurement whose populations overlap.

**Why the excerpt calibration was misleading.** The excerpts were drawn from 40% into each
manuscript, mid-scene. Whole chapters include openings and closings, which are more
patterned prose, pulling perplexity down. Calibrating on excerpts and deploying on chapters
was a sampling mismatch, and it is the same class of error as calibrating on 1,200 words
and deploying on whole books.

**Standing caveat, now larger.** Four AI samples against twelve human chapters, two human
authors, one genre, one model. One of the four AI samples was written by Claude during this
session with full knowledge of what the detectors measure, which makes it a weak test of
naive LLM output. The outstanding work remains what it was: AI chapters from several
models, written without knowledge of this tool.

## Follow-up: readability uniformity's measurement floor

Chapter-level testing of a fourth manuscript showed short chapters scoring as more
"uniform" (more AI-like) than long ones from the same book. Two causes, measured across
153 chapters of all four manuscripts by sliding a window of K consecutive scorable
paragraphs and comparing the estimate to the ~20-paragraph samples the anchors were
calibrated on:

**1. `stdev` used the population form (divide by n).** Every caller measures a *sample* and
infers spread from it, so the sample form (n-1) is the correct estimator. The population
form understates spread, and understates it most on the smallest samples — exactly the
short-chapter case:

| K paragraphs | population (÷n) | sample (÷n-1) |
|---|---|---|
| 5 | 86% of the K=20 value | **94%** |
| 8 | 93% | **97%** |
| 10 | 95% | **98%** |
| 12 | 97% | **99%** |

Fixed in `text.ts`. This also affects `burstiness`, which takes a stdev over sentence
lengths, but chapters have 50+ sentences where the correction is under 1%.

**2. The floor was 3 paragraphs.** A stdev over three points is a number, not a
measurement. Raised to **8**, where residual bias drops under ~3% (roughly 5 points of the
0-100 score) while still scoring 96% of real chapters. Coverage falls off steeply above
that — a floor of 10 silences 16% of chapters and 12 silences 26%, for about one further
point of accuracy.

**Effect on the six sampled chapters** — every stdev rose slightly and every readability
score fell, but no verdict changed:

| | ch01 | ch02 | ch03 | ch04 | ch05 | ch06 |
|---|---|---|---|---|---|---|
| stdev | 13.5→14.0 | 18.2→18.8 | 14.4→14.9 | 12.7→13.3 | 19.5→19.9 | 13.2→13.6 |
| readability | 71→67 | 31→27 | 64→59 | 77→73 | 21→17 | 74→70 |
| overall | 16→15 | 4→4 | 20→20 | 21→20 | 9→8 | 12→11 |

**A correction to the reasoning that started this.** An earlier read of six chapters found
a 0.905 correlation between paragraph count and stdev and concluded the signal was
"tracking chapter length, not authorship". The window analysis does not support that
strength of claim: between 13 and 20 paragraphs the bias is only ~3%, about 4 score
points, nowhere near enough to explain ch04 at 77 against ch05 at 21. Those chapter-to-
chapter differences are mostly real. The length effect is genuine but small, and n=6 was
too few to separate it from actual variation in the writing.

**Caveat on the method.** Sliding windows cross chapter boundaries, so they span more
register change than a real chapter does and slightly overstate the stdev a chapter
"should" show. It is the right instrument for measuring how the *estimator* behaves with
sample size, which is what the floor depends on, but it is not a clean reference for what
any individual chapter ought to score.

## Decision: document-level, calibrated for chapter-length input

A per-chunk scoring mode was designed — split input into 1,200-word chunks, score each fully,
roll up by word-weighted mean — and then **deliberately not built**. The tools stay
document-level.

The tension this leaves open, recorded so it isn't rediscovered later: every constant in the
repo was measured on ~1,200-word excerpts, and two signals are length-sensitive.

- **Lexical diversity** is a type-token ratio. It falls mechanically as a document grows, so a
  60,000-word manuscript scores lower than a 1,200-word excerpt by the same author purely
  because it is longer.
- **Readability uniformity** compares Flesch variance across paragraphs. Across ~2,000
  paragraphs that variance saturates and the signal flattens toward 0 regardless of authorship.

Both were observed flat-lining at 0 on the full manuscripts in the benchmark run, while
scoring normally on 1,200-word excerpts from the same books.

Two ways to resolve it were considered:

1. Re-measure every constant at document length — requires manuscript-length AI text to compare
   against, which is a substantially bigger sourcing problem than the 1,200-word passages used
   here.
2. Leave the constants alone and document the tool as tuned for chapter-length text.

**(2) was chosen.** The scope limit is now stated in README.md ("Input length"), TOOLS.md,
`src/context.ts` (so the `get_context` tool reports it to callers), and CLAUDE.md. Guidance is
to analyze a book a chapter at a time — which is also more useful, since it identifies *which*
chapter is anomalous rather than averaging it away.

## Note on a bug this exercise caught

The first calibration run reported exactly 511 scored tokens for every ~1,500-token sample. Cause:
`DecodeChunk` did not clear the KV cache between chunks, so every chunk after the first failed
with "failed to initialize batch" and was silently skipped — the helper returned `ok: true` with a
perplexity computed from the document's first 512 tokens only. Fixed by calling
`llama_memory_clear` at the top of `DecodeChunk`, with `TestEngineScoresEveryChunk` as a
regression guard. The pre-fix numbers differed materially (one human sample read 35.60 on its
first chunk alone versus 27.33 across the full text), so any measurement taken before that fix
should be discarded.

## Follow-up: widening the human corpus to 25 authors

The largest recorded gap ("15-20 samples from clearly distinct writers") is now closed. Corpus:
mid-book excerpts of ~1,200 words from 25 published novelists on Project Gutenberg, extracted
with `~/.claude/scripts/gutenberg-excerpt.js`, all originally written in English (translations
were excluded — they measure the translator's prose, not the author's).

### First: is Gutenberg usable at all?

A prior spot-check had a famous Dickens passage at perplexity 1.7, which would make any
public-domain corpus worthless: memorized text scores as maximally AI. Tested directly by
scoring each book's famous opening against a mid-book passage.

| author | famous opening | mid-book |
|---|---|---|
| Dickens | 13.89 | 22.40 |
| Austen | 12.41 | 23.55 |
| Melville | 31.66 | 32.31 |

Memorization is real but far weaker across 1,200 words than for a single hyper-quoted sentence:
openings run ~10 points low, mid-book passages land in the normal human range. **Rule adopted:
sample mid-book, never openings.** The 1.7 figure was a single famous sentence, not a chapter.

### The corpus

| ppl | author | ppl | author |
|---|---|---|---|
| 15.71 | Anderson | 24.98 | C. Brontë |
| 17.07 | Christie | 25.28 | Chopin |
| 19.25 | Wharton | 25.87 | Stevenson |
| 19.51 | Doyle | 27.03 | Montgomery |
| 19.98 | Wilde | 29.17 | Fitzgerald |
| 20.65 | Shelley | 30.32 | E. Brontë |
| 21.05 | Cather | 30.75 | Eliot |
| 22.11 | Austen | 31.25 | Conrad |
| 22.32 | Twain | 31.26 | Dickens |
| 24.29 | Collins | 35.18 | James |
| 24.40 | London | 36.87 | Hardy |
| 24.53 | Wells | 38.74 | Melville |
| 24.78 | Stoker | | |

**n=25, range 15.71-38.74, mean 25.69, median 24.78.** Against the previous estimate of 19.6-28.6
from effectively one writer, between-author variation is about twice as wide as assumed. This is
the parameter the earlier rounds flagged as completely unmeasured, and it was underestimated.

### Consequence: the 12/32 anchors were producing false positives

12/32 put the 0.5 crossover at 19.6. Seven of these 25 real novelists fell below it — Anderson
scored 73/100 and Christie 64/100 on a signal weighted 0.30. Per the verdict-band decision above,
false positives on human prose are this tool's more costly error, so the anchors moved.

**Refitted to 6/30**, crossover 13.4, below the human floor of 15.71. No author now exceeds 0.40.

| text | ppl | old (12/32) | new (6/30) |
|---|---|---|---|
| llama-3-8b | 5.7 | 100 | 100 |
| qwen3-14b | 7.2 | 100 | 89 |
| Anderson (human) | 15.71 | 73 | 40 |
| Christie (human) | 17.07 | 64 | 35 |
| Claude Opus 5 | 21.2 | 42 | 22 |
| Melville (human) | 38.74 | 0 | 0 |

### What this costs, and what it reveals

The signal now only separates models below ~13 perplexity. Everything above that is inside the
human range and stays there:

- Earlier AI excerpts measured 15.81, 17.66, 19.33. Anderson is 15.71, Christie 17.07, Wharton
  19.25. **They interleave.** Anderson scores 40 and the 15.81 AI excerpt scores 40 — the same
  number. No anchor pair separates these populations, because on this measurement they are not
  separate. The test `the signal does not claim to separate text inside the overlap zone` pins
  this as a known limitation rather than hiding it.
- Claude Opus 5 drops from 42 to 22. Frontier sensitivity is essentially gone. That is not a
  regression introduced by the refit — 21.2 was always inside the human range, and the old
  anchors only appeared to catch it by also catching seven novelists.

**What perplexity is actually measuring.** The ranking is ordered by prose style, not by
authorship. The floor is plain modern declarative writing (Anderson 1919, Christie 1920); the
ceiling is ornate Victorian subordination (Melville, Hardy, James, Dickens). A plain contemporary
human stylist will score AI-like on this signal no matter who wrote the text. This is the sharpest
limitation found so far and it is not fixable by recalibration — it is what the measurement is.

### Remaining caveats

Gutenberg is entirely pre-1930, so era is confounded with style throughout; the 12 contemporary
chapters (19.6-28.6) are the only modern human data and they sit inside the Gutenberg range.
Still one scoring model, one language, one excerpt per author.
