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

**Output**: overall 0-100 AI-likelihood score, a verdict (`likely-human` / `uncertain` / `likely-ai-generated`), the ruleset used, and a per-signal breakdown (score, weight, explanation).

**Signals** (see `src/lib/detectAiUsage.ts`): sentence-length burstiness, lexical diversity (rolling type-token ratio), AI stock-phrase frequency, readability uniformity across paragraphs, markdown-in-prose artifacts, em dash overuse. Each is an isolated function — add a new signal by adding one function and one entry in the `detectors` array.

**Rulesets**: `type` selects a `WEIGHT_PROFILE` in `src/lib/detectAiUsage.ts` that reweights the six signals and adjusts two saturation thresholds (markdown density, em dashes per 1000 words):
- `creative` — expects sentence/readability variance and near-zero markdown or em-dash use (both are strongly out of place in fiction); leans on burstiness, lexical diversity, and readability.
- `strategic` — expects structured markdown (bullets/headers) and punchy, uniform sentences as normal genre convention; leans heavily on AI stock-phrase frequency (business buzzwords are the strongest tell).
- omitted — the original genre-agnostic weights.

## `humanize_text`

Get actionable recommendations for making AI-leaning text read more naturally human. Reuses `detect_ai_usage`'s signals; does not rewrite text itself.

**Input**: same shape as `detect_ai_usage` (`text` / `filePath`, plus optional `reportPath` and `type`). If you called `detect_ai_usage` with a `type`, pass the same `type` to `humanize_text` for consistent recommendations.

**Output**: current AI-likelihood score, the ruleset used, plus a list of `{ issue, suggestion, evidence }` recommendations (overused AI stock phrases, uniform sentence length, uniform readability across paragraphs, markdown left in prose, overused em dashes, excessive hedging). See `src/lib/humanizeText.ts`.

**Rulesets**: `type` selects a `HUMANIZE_PROFILE` in `src/lib/humanizeText.ts` mirroring the detector's intent — e.g. `strategic` skips the markdown-in-prose recommendation entirely (bullets are expected in business docs) and requires less sentence-length variance before flagging uniformity; `creative` tolerates more em dashes and readability drift before flagging.

## `get_context`

Return detailed usage documentation for a tool, kept separate from the short `description` fields to save context budget in the calling model's tool list.

**Input**: `{ topic? }` — one of `overview` (default), `detect_ai_usage`, `humanize_text`, `get_context`.

**Output**: markdown documentation string. Source of truth is `src/context.ts`.

---

## Status

- [x] `detect_ai_usage` — heuristic scoring implemented; open for new detectors (e.g. real perplexity via a local model, n-gram repetition analysis).
- [x] `humanize_text` — heuristic recommendations implemented; open for new recommendation categories.
- [x] `get_context` — implemented.
- [x] `type` ruleset option (`creative` / `strategic`) on both `detect_ai_usage` and `humanize_text`.
- [x] Automated tests for the `detect_ai_usage` heuristics, `humanize_text` recommendations, and the `type` rulesets (`src/lib/*.test.ts`, run via `npm test`).
- [x] Repo published to GitHub ([dmongrel/human-vs-ai-mcp-server](https://github.com/dmongrel/human-vs-ai-mcp-server)); npm publish still pending (see CLAUDE.md Conventions).
- [ ] Additional detectors backed by a local/offline model (no external API calls planned — see README).
