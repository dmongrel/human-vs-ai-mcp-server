// Optional client for a local, OpenAI-compatible model runner (LM Studio,
// Ollama, etc.), used to compute a real perplexity signal for
// detectAiUsage's 7th detector. Entirely opt-in: activated only when
// MODEL_RUNNER_URL is set. Follows the same fail-open convention as
// checkUpdate.ts — any network/parse/shape error collapses to `null` rather
// than throwing, so the rest of the tool works exactly as before when the
// runner is unset, unreachable, or doesn't support the calls we need.

const DEFAULT_TIMEOUT_MS = 20_000;
// Conservative chars-per-token approximation (no tokenizer available) used
// to size chunks so they fit comfortably within small local models' context
// windows. Deliberately cautious — better to under-fill a chunk than risk
// truncation by the runner.
const CHARS_PER_TOKEN_ESTIMATE = 3.2;
const CHUNK_TOKEN_BUDGET = 1500;
const CHUNK_CHAR_BUDGET = Math.floor(CHUNK_TOKEN_BUDGET * CHARS_PER_TOKEN_ESTIMATE);

export function getModelRunnerUrl(): string | null {
  const url = process.env.MODEL_RUNNER_URL?.trim();
  return url ? url.replace(/\/+$/, "") : null;
}

function getTimeoutMs(): number {
  const raw = process.env.MODEL_RUNNER_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
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
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHAR_BUDGET) {
    const chunk = text.slice(i, i + CHUNK_CHAR_BUDGET).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

interface CompletionLogprobsResponse {
  choices?: {
    logprobs?: {
      token_logprobs?: (number | null)[];
    };
  }[];
}

async function scoreChunk(baseUrl: string, model: string, chunk: string, timeoutMs: number): Promise<number[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // max_tokens must be >=1 — some runners (e.g. LM Studio) reject 0, even
    // though we only want the echoed prompt's logprobs, not a generation.
    // The one generated token this produces is dropped below.
    const res = await fetch(`${baseUrl}/v1/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: chunk, max_tokens: 1, echo: true, logprobs: 1 }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as CompletionLogprobsResponse;
    const tokenLogprobs = data.choices?.[0]?.logprobs?.token_logprobs;
    if (!tokenLogprobs) return null;
    // The echo convention returns a leading `null` for the first token (no
    // preceding context to condition on) — filtering non-numbers drops it.
    // The trailing entry is the one generated token from max_tokens:1, not
    // part of the input text — drop it too.
    const values = tokenLogprobs.filter((v): v is number => typeof v === "number").slice(0, -1);
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
}

/**
 * Score perplexity for the full text against whatever model is loaded on
 * the configured model runner. Chunks sequentially to respect context-window
 * limits, covering the entire document (not a sample) subject to an overall
 * time budget — once the budget is exceeded, stops issuing further chunk
 * requests and averages whatever completed. Returns null if the runner is
 * unconfigured, unreachable, or doesn't support the echo+logprobs shape this
 * relies on.
 */
export async function scorePerplexity(text: string, opts?: { timeoutMs?: number }): Promise<PerplexityResult | null> {
  const baseUrl = getModelRunnerUrl();
  if (!baseUrl) return null;

  const models = await listModels(baseUrl);
  if (!models) return null;
  const model = models[0];

  const chunks = chunkText(text);
  if (chunks.length === 0) return null;

  const totalBudgetMs = opts?.timeoutMs ?? getTimeoutMs();
  const perChunkTimeoutMs = Math.min(totalBudgetMs, DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + totalBudgetMs;

  const collectedLogprobs: number[] = [];
  let chunksScored = 0;

  for (const chunk of chunks) {
    if (Date.now() >= deadline) break;
    const remaining = deadline - Date.now();
    const logprobs = await scoreChunk(baseUrl, model, chunk, Math.min(perChunkTimeoutMs, remaining));
    if (logprobs) {
      collectedLogprobs.push(...logprobs);
      chunksScored += 1;
    }
  }

  if (collectedLogprobs.length === 0) return null;

  const meanLogprob = collectedLogprobs.reduce((a, b) => a + b, 0) / collectedLogprobs.length;
  const perplexity = Math.exp(-meanLogprob);

  return { perplexity, chunksScored, chunksTotal: chunks.length };
}
