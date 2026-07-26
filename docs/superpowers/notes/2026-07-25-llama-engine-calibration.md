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

## Note on a bug this exercise caught

The first calibration run reported exactly 511 scored tokens for every ~1,500-token sample. Cause:
`DecodeChunk` did not clear the KV cache between chunks, so every chunk after the first failed
with "failed to initialize batch" and was silently skipped — the helper returned `ok: true` with a
perplexity computed from the document's first 512 tokens only. Fixed by calling
`llama_memory_clear` at the top of `DecodeChunk`, with `TestEngineScoresEveryChunk` as a
regression guard. The pre-fix numbers differed materially (one human sample read 35.60 on its
first chunk alone versus 27.33 across the full text), so any measurement taken before that fix
should be discarded.
