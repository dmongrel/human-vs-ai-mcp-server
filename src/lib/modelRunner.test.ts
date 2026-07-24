import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { getModelRunnerUrl, listModels, scorePerplexity } from "./modelRunner.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MODEL_RUNNER_URL;
  delete process.env.MODEL_RUNNER_TIMEOUT_MS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as Response;
}

test("getModelRunnerUrl returns null when unset", () => {
  assert.equal(getModelRunnerUrl(), null);
});

test("getModelRunnerUrl trims whitespace and trailing slashes", () => {
  process.env.MODEL_RUNNER_URL = "  http://localhost:1234/  ";
  assert.equal(getModelRunnerUrl(), "http://localhost:1234");
});

test("listModels returns null on non-ok response", async () => {
  globalThis.fetch = (async () => jsonResponse({}, false)) as typeof fetch;
  assert.equal(await listModels("http://localhost:1234"), null);
});

test("listModels returns null on network error", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  assert.equal(await listModels("http://localhost:1234"), null);
});

test("listModels returns null on malformed JSON shape", async () => {
  globalThis.fetch = (async () => jsonResponse({ unexpected: true })) as typeof fetch;
  assert.equal(await listModels("http://localhost:1234"), null);
});

test("listModels returns model ids on success", async () => {
  globalThis.fetch = (async () => jsonResponse({ data: [{ id: "qwen2.5-0.5b-instruct" }] })) as typeof fetch;
  assert.deepEqual(await listModels("http://localhost:1234"), ["qwen2.5-0.5b-instruct"]);
});

test("scorePerplexity returns null when MODEL_RUNNER_URL is unset", async () => {
  assert.equal(await scorePerplexity("Some text."), null);
});

test("scorePerplexity returns null when listModels fails", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  globalThis.fetch = (async () => jsonResponse({}, false)) as typeof fetch;
  assert.equal(await scorePerplexity("Some text."), null);
});

test("scorePerplexity returns null when logprobs are missing from the response", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  let call = 0;
  globalThis.fetch = (async (url: string) => {
    call += 1;
    if (String(url).includes("/v1/models")) {
      return jsonResponse({ data: [{ id: "test-model" }] });
    }
    return jsonResponse({ choices: [{ text: "" }] }); // no logprobs field
  }) as typeof fetch;
  assert.equal(await scorePerplexity("Some text."), null);
  assert.ok(call >= 2);
});

test("scorePerplexity computes perplexity from averaged logprobs across chunks", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/v1/models")) {
      return jsonResponse({ data: [{ id: "test-model" }] });
    }
    // Constant logprob per token so the expected perplexity is exp(2).
    return jsonResponse({
      choices: [{ logprobs: { token_logprobs: [null, -2, -2, -2] } }],
    });
  }) as typeof fetch;

  const result = await scorePerplexity("A short text that fits in a single chunk.");
  assert.ok(result, "expected a non-null perplexity result");
  assert.ok(Math.abs(result!.perplexity - Math.exp(2)) < 1e-6);
  assert.equal(result!.chunksScored, 1);
  assert.equal(result!.chunksTotal, 1);
});

test("scorePerplexity respects the timeout budget and stops issuing further chunk requests", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  const longText = "word ".repeat(20000); // large enough to require multiple chunks
  let completionCalls = 0;

  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/v1/models")) {
      return jsonResponse({ data: [{ id: "test-model" }] });
    }
    completionCalls += 1;
    // Simulate a slow model runner.
    await new Promise((resolve) => setTimeout(resolve, 30));
    return jsonResponse({ choices: [{ logprobs: { token_logprobs: [null, -1, -1] } }] });
  }) as typeof fetch;

  const result = await scorePerplexity(longText, { timeoutMs: 35 });
  assert.ok(result, "expected a partial result rather than null");
  assert.ok(result!.chunksScored < result!.chunksTotal, "expected the timeout to cut the run short");
  assert.ok(completionCalls < result!.chunksTotal, "expected fewer completion calls than total chunks due to timeout");
});
