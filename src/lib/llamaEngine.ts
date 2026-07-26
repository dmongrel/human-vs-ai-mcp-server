// Client for the bundled llama.cpp-engine perplexity helper — the second,
// independent model-perplexity path alongside the (disabled) HTTP-based
// modelRunner.ts. Where that one asks a chat model to echo text back and reads
// logprobs off its own generation, this one does real teacher-forced scoring:
// the helper feeds the actual tokens through libllama and reads the model's
// probability for each real next token. No generation step, so none of the
// greedy-decoding bias that made the HTTP technique non-discriminating (see
// README.md's "HTTP model runner (disabled)").
//
// The helper is a one-shot subprocess: spawned per call, one JSON request on
// stdin, one JSON response on stdout, gone. No daemon, no port, nothing left
// running if this server dies.
//
// Entirely opt-in — activated only when LLAMA_ENGINE_MODEL_PATH is set — and
// fails open exactly like modelRunner.ts and checkUpdate.ts: any spawn,
// exit-code, parse, or shape error collapses to `null` rather than throwing.

import * as childProcess from "node:child_process";
import { dirname, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000; // matches MODEL_RUNNER_TIMEOUT_MS's default
const DEFAULT_CTX_SIZE = 2048; // safe for essentially any modern local model

/**
 * Indirection point for spawning, so tests can substitute a fake child process.
 * modelRunner.test.ts can stub `globalThis.fetch` directly, but node:child_process
 * exports its members as getters, which cannot be reassigned. Not public API.
 */
export const _internals = { spawn: childProcess.spawn };

/** Absolute path to the .gguf model to score against; unset disables the whole path. */
export function getEngineModelPath(): string | null {
  const path = process.env.LLAMA_ENGINE_MODEL_PATH?.trim();
  return path ? path : null;
}

function getCtxSize(): number {
  const raw = process.env.LLAMA_ENGINE_CTX_SIZE?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CTX_SIZE;
}

function getTimeoutMs(): number {
  const raw = process.env.LLAMA_ENGINE_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Locate the prebuilt helper. LLAMA_ENGINE_HELPER_PATH wins if set (used for
 * local development against a freshly built binary, before anything is
 * published); otherwise resolve the platform package, which npm only installs
 * on a matching os/cpu. Resolving via its package.json rather than the exe
 * directly keeps this working regardless of the package's `exports` map, and
 * means future platform packages need no changes here.
 */
function resolveHelperPath(): string | null {
  const override = process.env.LLAMA_ENGINE_HELPER_PATH?.trim();
  if (override) return override;

  const pkg = `human-vs-ai-mcp-server-${process.platform}-${process.arch}`;
  try {
    const manifest = require.resolve(`${pkg}/package.json`);
    const binary = process.platform === "win32" ? "llama-engine-helper.exe" : "llama-engine-helper";
    return join(dirname(manifest), binary);
  } catch {
    return null; // platform not supported, or the optional dependency wasn't installed
  }
}

export interface EngineChunkResult {
  tokens: number;
  perplexity: number;
}

export interface EnginePerplexityResult {
  perplexity: number;
  tokensEvaluated: number;
  chunks: EngineChunkResult[];
  modelName: string;
  timedOut: boolean;
}

interface HelperResponse {
  ok?: boolean;
  error?: string;
  perplexity?: unknown;
  tokensEvaluated?: unknown;
  chunks?: unknown;
  modelName?: unknown;
  timedOut?: unknown;
}

/**
 * Parse the helper's stdout. The response is the last non-empty line: a
 * backend or driver could in principle print to stdout before we get there,
 * and one stray line must not invalidate an otherwise good run.
 */
function parseResponse(stdout: string): EnginePerplexityResult | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return null;

  let data: HelperResponse;
  try {
    data = JSON.parse(last) as HelperResponse;
  } catch {
    return null;
  }

  if (data.ok !== true) return null;
  if (typeof data.perplexity !== "number" || !Number.isFinite(data.perplexity)) return null;
  if (typeof data.tokensEvaluated !== "number") return null;

  const chunks = Array.isArray(data.chunks)
    ? data.chunks.filter(
        (c): c is EngineChunkResult =>
          !!c && typeof (c as EngineChunkResult).tokens === "number" && typeof (c as EngineChunkResult).perplexity === "number"
      )
    : [];

  return {
    perplexity: data.perplexity,
    tokensEvaluated: data.tokensEvaluated,
    chunks,
    modelName: typeof data.modelName === "string" ? data.modelName : "",
    timedOut: data.timedOut === true,
  };
}

/**
 * Score the full text's teacher-forced perplexity against the model at
 * LLAMA_ENGINE_MODEL_PATH, via the bundled helper. Returns null when the
 * model path is unset, the helper is missing or unspawnable, the run exceeds
 * its time budget, or the response is malformed — never throws.
 */
export function scorePerplexityViaEngine(text: string, opts?: { timeoutMs?: number }): Promise<EnginePerplexityResult | null> {
  const modelPath = getEngineModelPath();
  if (!modelPath) return Promise.resolve(null);

  const helperPath = resolveHelperPath();
  if (!helperPath) return Promise.resolve(null);

  const timeoutMs = opts?.timeoutMs ?? getTimeoutMs();
  const request = JSON.stringify({ modelPath, text, ctxSize: getCtxSize(), timeoutMs });

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: EnginePerplexityResult | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    let child: childProcess.ChildProcess;
    try {
      child = _internals.spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolve(null);
    }

    // The helper enforces its own budget between chunks; this is the outer
    // guard for the case where it wedges inside a single decode.
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs + 5_000);

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      // Never stdout — that's the MCP protocol channel for this process.
      console.error(`[llama-engine] ${chunk.toString().trimEnd()}`);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? parseResponse(stdout) : null));

    child.stdin?.on("error", () => finish(null));
    child.stdin?.end(request);
  });
}
