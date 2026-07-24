import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { getModelRunnerUrl, listModels, scorePerplexity } from "./modelRunner.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.MODEL_RUNNER_URL;
  delete process.env.MODEL_RUNNER_TIMEOUT_MS;
  delete process.env.MODEL_RUNNER_MODEL;
  delete process.env.MODEL_RUNNER_CONTEXT_TOKENS;
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

// Reads the chunk (user message content) out of a mocked
// /v1/chat/completions request body, so the mock can echo it back exactly
// and pass the client's similarity-verification check.
function chunkFromRequestBody(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body ?? "{}"));
  return body.messages?.[1]?.content ?? "";
}

// A perfect-echo mock response with a constant logprob per token.
function echoResponse(chunk: string, logprob: number, tokenCount = 3): unknown {
  return {
    choices: [
      {
        message: { content: chunk },
        logprobs: { content: Array.from({ length: tokenCount }, () => ({ logprob })) },
      },
    ],
  };
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

test("scorePerplexity uses MODEL_RUNNER_MODEL override without calling listModels", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  process.env.MODEL_RUNNER_MODEL = "my-preferred-model";
  let modelsCalled = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/v1/models")) {
      modelsCalled = true;
      return jsonResponse({}, false);
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    assert.equal(body.model, "my-preferred-model");
    const chunk = chunkFromRequestBody(init);
    return jsonResponse(echoResponse(chunk, -2));
  }) as typeof fetch;

  const result = await scorePerplexity("Some short text to score.");
  assert.ok(result, "expected a result using the overridden model");
  assert.equal(modelsCalled, false, "expected listModels to be skipped when MODEL_RUNNER_MODEL is set");
});

test("scorePerplexity returns null when logprobs are missing from the response", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  let call = 0;
  globalThis.fetch = (async (url: string) => {
    call += 1;
    if (String(url).includes("/v1/models")) {
      return jsonResponse({ data: [{ id: "test-model" }] });
    }
    return jsonResponse({ choices: [{ message: { content: "" } }] }); // no logprobs field
  }) as typeof fetch;
  assert.equal(await scorePerplexity("Some text."), null);
  assert.ok(call >= 2);
});

test("scorePerplexity returns null when the model's reproduction doesn't match the input closely enough", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/v1/models")) {
      return jsonResponse({ data: [{ id: "test-model" }] });
    }
    // Completely unrelated content -> fails the similarity check.
    return jsonResponse(echoResponse("Something entirely different and unrelated to the input.", -1));
  }) as typeof fetch;

  const result = await scorePerplexity("This is the original text that should be echoed back verbatim by the model.");
  assert.equal(result, null);
});

test("scorePerplexity computes perplexity from averaged logprobs across chunks", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/v1/models")) {
      return jsonResponse({ data: [{ id: "test-model" }] });
    }
    const chunk = chunkFromRequestBody(init);
    // Constant logprob per token so the expected perplexity is exp(2).
    return jsonResponse(echoResponse(chunk, -2));
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

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/v1/models")) {
      return jsonResponse({ data: [{ id: "test-model" }] });
    }
    completionCalls += 1;
    // Simulate a slow model runner.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const chunk = chunkFromRequestBody(init);
    return jsonResponse(echoResponse(chunk, -1));
  }) as typeof fetch;

  const result = await scorePerplexity(longText, { timeoutMs: 35 });
  assert.ok(result, "expected a partial result rather than null");
  assert.ok(result!.chunksScored < result!.chunksTotal, "expected the timeout to cut the run short");
  assert.ok(completionCalls < result!.chunksTotal, "expected fewer completion calls than total chunks due to timeout");
});

test("MODEL_RUNNER_CONTEXT_TOKENS produces fewer, larger chunks than the default budget", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  const longText = "word ".repeat(3000); // ~15000 chars: enough for a clear default-vs-32k-context comparison

  async function countChunks(): Promise<number> {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("/v1/models")) return jsonResponse({ data: [{ id: "test-model" }] });
      const chunk = chunkFromRequestBody(init);
      return jsonResponse(echoResponse(chunk, -1));
    }) as typeof fetch;
    const result = await scorePerplexity(longText, { timeoutMs: 60_000 });
    assert.ok(result, "expected a full result");
    return result!.chunksTotal;
  }

  delete process.env.MODEL_RUNNER_CONTEXT_TOKENS;
  const defaultChunks = await countChunks();

  process.env.MODEL_RUNNER_CONTEXT_TOKENS = "32000";
  const largeContextChunks = await countChunks();

  assert.ok(
    largeContextChunks < defaultChunks,
    `expected fewer chunks with a 32k context budget (${largeContextChunks}) than the default (${defaultChunks})`
  );
});

test("an invalid MODEL_RUNNER_CONTEXT_TOKENS falls back to the default chunk budget", async () => {
  process.env.MODEL_RUNNER_URL = "http://localhost:1234";
  process.env.MODEL_RUNNER_CONTEXT_TOKENS = "not-a-number";
  const longText = "word ".repeat(3000);

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/v1/models")) return jsonResponse({ data: [{ id: "test-model" }] });
    const chunk = chunkFromRequestBody(init);
    return jsonResponse(echoResponse(chunk, -1));
  }) as typeof fetch;

  const withInvalid = await scorePerplexity(longText, { timeoutMs: 60_000 });
  delete process.env.MODEL_RUNNER_CONTEXT_TOKENS;
  const withDefault = await scorePerplexity(longText, { timeoutMs: 60_000 });

  assert.equal(withInvalid!.chunksTotal, withDefault!.chunksTotal);
});
