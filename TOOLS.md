# Tools

Kept in sync with `src/index.ts` and `src/context.ts`. Tool `description` fields are intentionally short — call `get_context` for full detail.

## `detect_ai_usage`

Estimate the likelihood that text was AI-generated, using explainable stylometric heuristics (not a trained classifier).

**Input**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | one of `text`/`filePath` | Text to analyze, passed directly. |
| `filePath` | string | one of `text`/`filePath` | Local path to a file containing the text to analyze. |
| `reportPath` | string | no | If set, write the report to this local file instead of returning it inline. |
| `type` | `"creative"` \| `"strategic"` | no | Ruleset to apply — `creative` for novels/creative writing, `strategic` for business documents, presentations, or marketing materials. Omit for a genre-agnostic default. |
| `ignoreMd` | boolean | no | If true, strips literal `*`, `_`, and `#` characters before analysis, so legitimate use of those characters (e.g. chapter headers, emphasis) isn't flagged as an AI markdown artifact. `-` bullet lines are unaffected. |

**Output**: overall 0-100 AI-likelihood score, a verdict (`likely-human` / `uncertain` / `likely-ai-generated`), the ruleset used, whether markdown was ignored, and a per-signal breakdown (score, weight, explanation).

**Signals** (each an isolated file under `src/lib/detectors/`, implementing the shared `Detector` interface — see `src/lib/detectors/types.ts`): sentence-length burstiness, lexical diversity (rolling type-token ratio), AI stock-phrase frequency, readability uniformity across paragraphs, markdown-in-prose artifacts, em dash overuse, n-gram (trigram) repetition, paragraph coherence (adjacent-paragraph content-word similarity). A 9th signal — a real perplexity check against a local model via `MODEL_RUNNER_URL` — is implemented but **currently disabled** (`enabled: false` in `src/lib/detectors/modelPerplexity.ts`); see [Model runner (currently disabled)](./README.md#model-runner-currently-disabled) in the README for why. Add a new built-in signal by adding one file under `src/lib/detectors/` and one entry in `src/lib/detectors/index.ts`. Third parties can add signals without forking the project via `PLUGINS_DIR` — see [Plugins](./README.md#plugins) in the README. Note: `detectAiUsage` is `async` (it awaits each detector, including the optional model-runner one, even though that call is currently a no-op); `humanize_text` and the tool handlers in `src/index.ts` await it accordingly.

**Rulesets**: `type` selects each detector's own per-genre weight (and, where relevant, its own calibration thresholds like markdown density or em dashes per 1000 words — no more shared weight table, each detector owns its config). The model-runner signal, when active, gets a flat additive 15% weight in every profile (the other weights are unchanged, so the total exceeds 1.0 in that case — the score's weighted-average math normalizes correctly either way):
- `creative` — expects sentence/readability variance and near-zero markdown or em-dash use (both are strongly out of place in fiction); leans on burstiness, lexical diversity, and readability.
- `strategic` — expects structured markdown (bullets/headers) and punchy, uniform sentences as normal genre convention; leans heavily on AI stock-phrase frequency (business buzzwords are the strongest tell).
- omitted — the original genre-agnostic weights.

## `humanize_text`

Get actionable recommendations for making AI-leaning text read more naturally human. Reuses `detect_ai_usage`'s signals; does not rewrite text itself.

**Input**: same shape as `detect_ai_usage` (`text` / `filePath`, plus optional `reportPath`, `type`, and `ignoreMd`). If you called `detect_ai_usage` with a `type` (and/or `ignoreMd`), pass the same values to `humanize_text` for consistent recommendations.

**Output**: current AI-likelihood score, the ruleset used, whether markdown was ignored, plus a list of `{ issue, suggestion, evidence }` recommendations (overused AI stock phrases, uniform sentence length, uniform readability across paragraphs, markdown left in prose, overused em dashes, excessive hedging, and — when `MODEL_RUNNER_URL` is configured — text that scored unusually predictable to the local model). See `src/lib/humanizeText.ts`. Note: reads the model-perplexity result off `detectAiUsage`'s already-computed `detectors` array rather than calling the model runner a second time.

**Rulesets**: `type` selects a `HUMANIZE_PROFILE` in `src/lib/humanizeText.ts` mirroring the detector's intent — e.g. `strategic` skips the markdown-in-prose recommendation entirely (bullets are expected in business docs) and requires less sentence-length variance before flagging uniformity; `creative` tolerates more em dashes and readability drift before flagging.

## `get_context`

Return detailed usage documentation for a tool, kept separate from the short `description` fields to save context budget in the calling model's tool list.

**Input**: `{ topic? }` — one of `overview` (default), `detect_ai_usage`, `humanize_text`, `get_context`.

**Output**: markdown documentation string. Source of truth is `src/context.ts`.

---

## Status

- [x] `detect_ai_usage` — heuristic scoring implemented via a pluggable `Detector` registry (`src/lib/detectors/`); open for new detectors.
- [x] `humanize_text` — heuristic recommendations implemented; open for new recommendation categories.
- [x] `get_context` — implemented.
- [x] `type` ruleset option (`creative` / `strategic`) on both `detect_ai_usage` and `humanize_text`.
- [x] `ignoreMd` option on both tools to exclude `*`/`_`/`#` markup from analysis.
- [x] Pluggable detector architecture: each signal is an isolated file implementing the `Detector` interface (`src/lib/detectors/types.ts`), registered in `src/lib/detectors/index.ts`. Adding/removing a signal touches only that directory.
- [x] External plugin loading via `PLUGINS_DIR`: third parties can drop plain CommonJS `.js` files exporting a `Detector` into a directory and have them auto-discovered at runtime, without forking the project. Opt-in (unset by default), fails open per file. See `src/lib/detectors/loadPlugins.ts` and README's "Plugins" section.
- [x] N-gram repetition detector (trigram diversity) and paragraph coherence detector (adjacent-paragraph content-word cosine similarity) added as new built-in signals.
- [x] Optional model-runner-perplexity detector (real perplexity check against a local model runner) implemented, investigated, and **disabled by default** — mechanically works (verbatim-echo via `/v1/chat/completions`, verified end-to-end on real LM Studio and Ollama instances with several models) but found structurally biased toward near-zero perplexity for any successfully-reproduced text regardless of content, plus impractically slow on every runner tested. See README's "Model runner (currently disabled)" section for the full investigation. See `src/lib/modelRunner.ts` and `enabled` in `src/lib/detectors/modelPerplexity.ts`.
- [x] Automated tests for the `detect_ai_usage` heuristics, `humanize_text` recommendations, the `type` rulesets, `ignoreMd`, the model-runner detector, and the plugin loader (`src/lib/**/*.test.ts`, run via `npm test`; model-runner network calls are stubbed in tests, never real).
- [x] Repo published to GitHub ([dmongrel/human-vs-ai-mcp-server](https://github.com/dmongrel/human-vs-ai-mcp-server)); npm publish still pending (see CLAUDE.md Conventions).
