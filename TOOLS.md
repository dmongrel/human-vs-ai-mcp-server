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

**Output**: overall 0-100 AI-likelihood score, a verdict (`likely-human` / `uncertain` / `likely-ai-generated`), and a per-signal breakdown (score, weight, explanation).

**Signals** (see `src/lib/detectAiUsage.ts`): sentence-length burstiness, lexical diversity (rolling type-token ratio), AI stock-phrase frequency, readability uniformity across paragraphs, markdown-in-prose artifacts. Each is an isolated function — add a new signal by adding one function and one entry in the `detectors` array.

## `humanize_text`

Get actionable recommendations for making AI-leaning text read more naturally human. Reuses `detect_ai_usage`'s signals; does not rewrite text itself.

**Input**: same shape as `detect_ai_usage` (`text` / `filePath`, plus optional `reportPath`).

**Output**: current AI-likelihood score plus a list of `{ issue, suggestion, evidence }` recommendations (overused AI stock phrases, uniform sentence length, markdown left in prose, excessive hedging). See `src/lib/humanizeText.ts`.

## `get_context`

Return detailed usage documentation for a tool, kept separate from the short `description` fields to save context budget in the calling model's tool list.

**Input**: `{ topic? }` — one of `overview` (default), `detect_ai_usage`, `humanize_text`, `get_context`.

**Output**: markdown documentation string. Source of truth is `src/context.ts`.

---

## Status

- [x] `detect_ai_usage` — heuristic scoring implemented; open for new detectors (e.g. real perplexity via a local model, n-gram repetition analysis).
- [x] `humanize_text` — heuristic recommendations implemented; open for new recommendation categories.
- [x] `get_context` — implemented.
- [x] Automated tests for the `detect_ai_usage` heuristics (`src/lib/*.test.ts`, run via `npm test`).
- [ ] Automated tests for `humanize_text`.
- [ ] Additional detectors backed by a local/offline model (no external API calls planned — see README).
