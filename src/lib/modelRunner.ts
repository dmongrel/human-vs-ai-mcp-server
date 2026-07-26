// Optional client for a local, OpenAI-compatible model runner (LM Studio,
// Ollama, etc.), used to compute a real perplexity signal for
// detectAiUsage's 7th detector. Entirely opt-in: activated only when
// MODEL_RUNNER_URL is set. Follows the same fail-open convention as
// checkUpdate.ts — any network/parse/shape error collapses to `null` rather
// than throwing, so the rest of the tool works exactly as before when the
// runner is unset, unreachable, or doesn't support the calls we need.
//
// Technique: verbatim-echo via /v1/chat/completions. The "obvious" approach
// (POST /v1/completions with echo:true, logprobs:1, reading the input
// text's own token logprobs back) was tested against a real LM Studio
// instance and found non-functional there — /v1/completions accepted the
// logprobs parameter but always returned logprobs: null, regardless of
// value or max_tokens. /v1/chat/completions does return real logprobs, but
// only for tokens the model generates itself (chat completions have no
// echo mode). So instead: ask the model to repeat the input text back
// verbatim, and read logprobs off its own reproduction. This only works
// with a model that (a) reliably follows literal-repetition instructions
// and (b) isn't a "thinking"/reasoning model that burns the token budget on
// internal reasoning before any real output — verified against
// meta-llama-3-8b-instruct (exact match, real logprobs, no reasoning
// overhead); qwen2.5-0.5b-instruct failed (a) and both
// google/gemma-4-12b-qat and qwen3.6-35b-a3b-mtp failed (b) on the same
// instance. The similarity check below is what makes this safe regardless
// of which model ends up configured — a bad reproduction is simply
// discarded (fails open per-chunk), never used to compute a misleading
// score.

const DEFAULT_TIMEOUT_MS = 60_000; // generation-based scoring is slow; consumer-hardware-friendly default
// Conservative chars-per-token approximation (no tokenizer available) used
// to size chunks so they fit comfortably within small local models' context
// windows. Deliberately cautious — better to under-fill a chunk than risk
// truncation by the runner. Kept modest since the verbatim-echo technique
// is generation-bound (slow), not just a single forward pass.
const CHARS_PER_TOKEN_ESTIMATE = 3.2;
// Used when MODEL_RUNNER_CONTEXT_TOKENS is unset — safe for virtually any
// modern local model's context window, just not efficient for large ones.
const DEFAULT_CHUNK_TOKEN_BUDGET = 500;
const SYSTEM_PROMPT_OVERHEAD_TOKENS = 100; // rough reserve for the system prompt + message-role overhead
const MAX_CHUNK_TOKEN_BUDGET = 4000; // cap even on very large context windows, to keep individual request latency reasonable

const VERBATIM_ECHO_SYSTEM_PROMPT =
  "You are a verbatim text-repetition tool. When given text, output it back exactly as given, character for character, with no additions, omissions, commentary, quotation marks, or formatting changes. Output nothing except the repeated text.";

// Below this similarity ratio, the model's reproduction is considered too
// unfaithful to trust its logprobs for — the chunk is discarded rather than
// used (fail open per-chunk, not a hard failure of the whole document).
const MIN_SIMILARITY_RATIO = 0.9;

export function getModelRunnerUrl(): string | null {
  const url = process.env.MODEL_RUNNER_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

// Optional override so a specific loaded model can be targeted without
// relying on /v1/models' ordering — useful when a runner has several
// models loaded at once and you want to switch which one is used for
// testing without changing what's loaded/active in the runner itself.
function getModelRunnerModelOverride(): string | null {
  const model = process.env.MODEL_RUNNER_MODEL?.trim();
  return model ? model : null;
}

function getTimeoutMs(): number {
  const raw = process.env.MODEL_RUNNER_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

// Optional: if the loaded model's context window is known, size chunks to
// use it efficiently (fewer, larger chunks -> fewer requests and less
// exposure to per-chunk instruction-following variance) rather than falling
// back to the conservative default, which is safe for any model but
// wasteful on larger-context ones. Not required for correctness.
function getChunkTokenBudget(): number {
  const raw = process.env.MODEL_RUNNER_CONTEXT_TOKENS?.trim();
  const contextTokens = raw ? Number(raw) : NaN;
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return DEFAULT_CHUNK_TOKEN_BUDGET;
  // The chunk (as input) and its verbatim echo (as output, ~1.3x the input
  // per the generation buffer in scoreChunk) both count against the same
  // context window, alongside the system prompt.
  const usable = contextTokens - SYSTEM_PROMPT_OVERHEAD_TOKENS;
  const budget = Math.floor(usable / 2.3);
  return Math.max(100, Math.min(budget, MAX_CHUNK_TOKEN_BUDGET));
}

export async function listModels(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`);
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = data.data?.map((m) => m.id).filter(Boolean);
    return ids && ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

function chunkText(text: string): string[] {
  const charBudget = Math.floor(getChunkTokenBudget() * CHARS_PER_TOKEN_ESTIMATE);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += charBudget) {
    const chunk = text.slice(i, i + charBudget).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

// Hand-rolled Levenshtein distance (no tokenizer/diff dependency needed —
// chunks are small enough that O(n*m) is negligible). Used only to verify
// the model's verbatim-echo reproduction is close enough to trust.
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

interface ChatLogprobsResponse {
  choices?: {
    message?: { content?: string };
    logprobs?: { content?: { logprob: number }[] };
  }[];
}

async function scoreChunk(baseUrl: string, model: string, chunk: string, timeoutMs: number): Promise<number[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const estimatedTokens = Math.ceil(chunk.length / CHARS_PER_TOKEN_ESTIMATE);
    // Safety cap only — actual generation is bounded by the chunk's own
    // size regardless of MODEL_RUNNER_CONTEXT_TOKENS (see MAX_CHUNK_TOKEN_BUDGET).
    const maxTokens = Math.min(Math.ceil(estimatedTokens * 1.3) + 50, 8000);
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: VERBATIM_ECHO_SYSTEM_PROMPT },
          { role: "user", content: chunk },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        logprobs: true,
        top_logprobs: 1,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ChatLogprobsResponse;
    const choice = data.choices?.[0];
    const echoed = choice?.message?.content;
    const logprobEntries = choice?.logprobs?.content;
    if (!echoed || !logprobEntries || logprobEntries.length === 0) return null;

    if (similarityRatio(echoed.trim(), chunk.trim()) < MIN_SIMILARITY_RATIO) return null;

    const values = logprobEntries.map((e) => e.logprob).filter((v) => typeof v === "number");
    return values.length > 0 ? values : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface PerplexityResult {
  perplexity: number;
  chunksScored: number;
  chunksTotal: number;
  /**
   * Whether the time budget actually ran out. A chunk can go unscored for two
   * unrelated reasons — the deadline passed, or the model's reproduction was
   * rejected/errored — and reporting the second as the first is misleading
   * (it looks like a slow runner when it is really a model that cannot echo
   * the text back). Callers should distinguish the two.
   */
  timedOut: boolean;
}

/**
 * Score perplexity for the full text against whatever model is loaded on
 * the configured model runner (or MODEL_RUNNER_MODEL, if set). Chunks
 * sequentially to respect context-window limits — sized conservatively by
 * default, or larger/fewer if MODEL_RUNNER_CONTEXT_TOKENS is set to the
 * loaded model's actual context size — covering the entire document (not a
 * sample) subject to an overall time budget. Once the budget is exceeded,
 * stops issuing further chunk requests and averages whatever completed.
 * Returns null if the runner is unconfigured, unreachable, or its
 * reproduction of the text isn't trustworthy enough to score (see
 * MIN_SIMILARITY_RATIO).
 */
export async function scorePerplexity(text: string, opts?: { timeoutMs?: number }): Promise<PerplexityResult | null> {
  const baseUrl = getModelRunnerUrl();
  if (!baseUrl) return null;

  const model = getModelRunnerModelOverride() ?? (await listModels(baseUrl))?.[0];
  if (!model) return null;

  const chunks = chunkText(text);
  if (chunks.length === 0) return null;

  const totalBudgetMs = opts?.timeoutMs ?? getTimeoutMs();
  const deadline = Date.now() + totalBudgetMs;

  const collectedLogprobs: number[] = [];
  let chunksScored = 0;
  let timedOut = false;

  for (const chunk of chunks) {
    if (Date.now() >= deadline) {
      timedOut = true;
      break;
    }
    const remaining = deadline - Date.now();
    const logprobs = await scoreChunk(baseUrl, model, chunk, remaining);
    if (logprobs) {
      collectedLogprobs.push(...logprobs);
      chunksScored += 1;
    }
  }

  if (collectedLogprobs.length === 0) return null;

  const meanLogprob = collectedLogprobs.reduce((a, b) => a + b, 0) / collectedLogprobs.length;
  const perplexity = Math.exp(-meanLogprob);

  return { perplexity, chunksScored, chunksTotal: chunks.length, timedOut };
}
