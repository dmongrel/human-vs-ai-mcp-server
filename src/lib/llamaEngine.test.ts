import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { _internals, getEngineModelPath, scorePerplexityViaEngine } from "./llamaEngine.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_SPAWN = _internals.spawn;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.LLAMA_ENGINE_MODEL_PATH;
  delete process.env.LLAMA_ENGINE_CTX_SIZE;
  delete process.env.LLAMA_ENGINE_TIMEOUT_MS;
  delete process.env.LLAMA_ENGINE_HELPER_PATH;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _internals.spawn = ORIGINAL_SPAWN;
});

// Configure a model path and a helper path so the client gets as far as
// spawning; individual tests then control what the fake helper does.
function configure(): void {
  process.env.LLAMA_ENGINE_MODEL_PATH = "F:\\models\\m.gguf";
  process.env.LLAMA_ENGINE_HELPER_PATH = "C:\\fake\\llama-engine-helper.exe";
}

// A fake child process that emits the given stdout text, then exits with the
// given code. Captures whatever was written to stdin for assertions.
function stubSpawn(stdout: string, exitCode = 0): { stdinChunks: string[] } {
  const stdinChunks: string[] = [];
  _internals.spawn = ((): unknown => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdin = new PassThrough();
    stdin.on("data", (c: Buffer) => stdinChunks.push(c.toString()));
    child.stdin = stdin;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      (child.stdout as PassThrough).end(stdout);
      (child.stderr as PassThrough).end("");
      setImmediate(() => child.emit("close", exitCode));
    });
    return child;
  }) as typeof _internals.spawn;
  return { stdinChunks };
}

const OK_RESPONSE = JSON.stringify({
  ok: true,
  perplexity: 14.2,
  tokensEvaluated: 1843,
  chunks: [{ tokens: 512, perplexity: 13.8 }],
  modelName: "qwen2.5-1.5b-instruct",
  timedOut: false,
});

test("getEngineModelPath returns null when LLAMA_ENGINE_MODEL_PATH is unset", () => {
  assert.equal(getEngineModelPath(), null);
});

test("getEngineModelPath trims surrounding whitespace", () => {
  process.env.LLAMA_ENGINE_MODEL_PATH = "  F:\\models\\m.gguf  ";
  assert.equal(getEngineModelPath(), "F:\\models\\m.gguf");
});

test("scorePerplexityViaEngine returns null without spawning when the model path is unset", async () => {
  let spawned = false;
  _internals.spawn = (() => {
    spawned = true;
    throw new Error("should not spawn");
  }) as typeof _internals.spawn;

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
  assert.equal(spawned, false, "expected no subprocess when the model path is unset");
});

test("scorePerplexityViaEngine parses a successful response", async () => {
  configure();
  stubSpawn(OK_RESPONSE);

  const result = await scorePerplexityViaEngine("Some text to score.");
  assert.ok(result, "expected a parsed result");
  assert.equal(result!.perplexity, 14.2);
  assert.equal(result!.tokensEvaluated, 1843);
  assert.equal(result!.modelName, "qwen2.5-1.5b-instruct");
  assert.equal(result!.timedOut, false);
  assert.deepEqual(result!.chunks, [{ tokens: 512, perplexity: 13.8 }]);
});

test("scorePerplexityViaEngine sends the request as JSON on stdin", async () => {
  configure();
  process.env.LLAMA_ENGINE_CTX_SIZE = "4096";
  const { stdinChunks } = stubSpawn(OK_RESPONSE);

  await scorePerplexityViaEngine("Some text to score.", { timeoutMs: 1234 });
  const sent = JSON.parse(stdinChunks.join(""));
  assert.equal(sent.modelPath, "F:\\models\\m.gguf");
  assert.equal(sent.text, "Some text to score.");
  assert.equal(sent.ctxSize, 4096);
  assert.equal(sent.timeoutMs, 1234);
});

test("an invalid LLAMA_ENGINE_CTX_SIZE falls back to the default", async () => {
  configure();
  process.env.LLAMA_ENGINE_CTX_SIZE = "not-a-number";
  const { stdinChunks } = stubSpawn(OK_RESPONSE);

  await scorePerplexityViaEngine("Some text to score.");
  const sent = JSON.parse(stdinChunks.join(""));
  assert.equal(sent.ctxSize, 2048);
});

test("scorePerplexityViaEngine returns null on an ok:false response", async () => {
  configure();
  stubSpawn(JSON.stringify({ ok: false, error: "model load failed" }), 1);

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
});

test("scorePerplexityViaEngine returns null on malformed stdout", async () => {
  configure();
  stubSpawn("not json at all");

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
});

test("scorePerplexityViaEngine ignores stray stdout lines before the response", async () => {
  configure();
  stubSpawn(`a stray backend log line\n${OK_RESPONSE}\n`);

  const result = await scorePerplexityViaEngine("Some text.");
  assert.ok(result, "expected the trailing JSON line to be parsed");
  assert.equal(result!.perplexity, 14.2);
});

test("scorePerplexityViaEngine returns null when the response shape is wrong", async () => {
  configure();
  stubSpawn(JSON.stringify({ ok: true, perplexity: "not a number" }));

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
});

test("scorePerplexityViaEngine returns null on a non-finite perplexity", async () => {
  configure();
  stubSpawn(JSON.stringify({ ok: true, perplexity: null, tokensEvaluated: 10 }));

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
});

test("scorePerplexityViaEngine returns null when the helper cannot be spawned", async () => {
  configure();
  _internals.spawn = ((): unknown => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => child.emit("error", new Error("ENOENT")));
    return child;
  }) as typeof _internals.spawn;

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
});

test("scorePerplexityViaEngine returns null and kills the helper when it exceeds the timeout", async () => {
  configure();
  let killed = false;
  _internals.spawn = ((): unknown => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough(); // never ends
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      setImmediate(() => child.emit("close", 1));
      return true;
    };
    return child;
  }) as typeof _internals.spawn;

  const result = await scorePerplexityViaEngine("Some text.", { timeoutMs: 50 });
  assert.equal(result, null);
  assert.equal(killed, true, "expected the helper to be killed once the budget elapsed");
});

test("scorePerplexityViaEngine returns null when no platform package is installed", async () => {
  process.env.LLAMA_ENGINE_MODEL_PATH = "F:\\models\\m.gguf";
  // No LLAMA_ENGINE_HELPER_PATH, and no platform package is published yet, so
  // resolution must fail closed rather than throwing.
  let spawned = false;
  _internals.spawn = (() => {
    spawned = true;
    throw new Error("should not spawn");
  }) as typeof _internals.spawn;

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
  assert.equal(spawned, false, "expected no spawn attempt when the helper cannot be resolved");
});
