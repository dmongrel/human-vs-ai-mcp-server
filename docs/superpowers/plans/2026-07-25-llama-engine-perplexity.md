# Bundled llama.cpp-engine perplexity detector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, independent model-perplexity detector to `detect_ai_usage` that computes real teacher-forced perplexity by spawning a bundled Go helper which drives llama.cpp's `libllama` directly via purego — no HTTP server, no generation step.

**Architecture:** Node (`src/lib/llamaEngine.ts`) spawns `llama-engine-helper.exe` one-shot per call, writes one JSON request on stdin, reads one JSON response from stdout, fails open to `null`. The Go helper (`native/llama-engine/`) loads `llama.dll` at runtime through purego (no cgo), tokenizes the text, splits it into non-overlapping context-sized chunks, runs one `llama_decode` per chunk with logits requested at every position, and log-softmaxes each position's logits against the *actual* next token. The helper ships as a prebuilt binary in an npm platform package (`human-vs-ai-mcp-server-win32-x64`) alongside the llama.cpp DLLs; the `.gguf` model is a separate user-supplied download.

**Tech Stack:** TypeScript (CommonJS, `node:test`), Go 1.26 (`github.com/ebitengine/purego`), llama.cpp prebuilt Windows CPU binaries (pinned release `b10107`), npm `optionalDependencies` platform-package pattern.

**Source spec:** `docs/superpowers/specs/2026-07-25-llama-engine-perplexity-design.md` — read it before starting.

## Global Constraints

- **Windows x64 only** in this pass. macOS arm64/x64, Linux x64, Windows ARM64 are a documentation deliverable (`native/llama-engine/PLATFORMS.md`), not built.
- **No `TOKEN` substring in any env var name** (secret scanners flag it). Hence `LLAMA_ENGINE_CTX_SIZE`, never `..._CONTEXT_TOKENS`.
- **Runtime npm dependencies stay at exactly two**: `@modelcontextprotocol/sdk` and `zod`. The new platform package goes in `optionalDependencies` and is first-party. Go module dependencies are *not* npm dependencies and are not covered by this constraint.
- **Every detector fails open** — return `null`, never throw. Reference implementations: `src/lib/checkUpdate.ts`, `src/lib/modelRunner.ts`.
- **Never write to stdout from the Node process** — stdout is the MCP stdio protocol channel. Warnings go to `console.error`.
- **The new detector ships `enabled: false`** until empirically calibrated. Do **not** flip `enabled` on the existing `src/lib/detectors/modelPerplexity.ts` — it stays disabled and stays in the tree (explicit user decision: keep the HTTP path as a fallback).
- **Do not delete or modify `src/lib/modelRunner.ts` or `src/lib/detectors/modelPerplexity.ts`.** The new code is strictly additive and lives in sibling files.
- Tests use Node's built-in `node:test`/`node:assert`, stub `spawn`/`fetch` rather than touching anything real, and run via `npm test` (which uses an explicit glob — `node --test "dist-test/**/*.test.js"` — because directory mode hangs on Windows).
- `TOOLS.md` and `src/context.ts` are updated **together** whenever tool behavior changes.
- Do not run `npm publish` or tag a release. The project is deliberately unpublished.
- Do not create git PRs. Commit to `master` unless told otherwise.
- **Pinned llama.cpp release: `b10107`.** Windows CPU asset: `llama-b10107-bin-win-cpu-x64.zip`. Header of record: `https://raw.githubusercontent.com/ggml-org/llama.cpp/b10107/include/llama.h`.
- **Fixture model for manual verification:** `F:\models\Qwen2.5-1.5B-Instruct.Q4_K_M.gguf`.

## File Structure

| File | Responsibility |
|---|---|
| `native/llama-engine/go.mod` | Go module (`purego` only). |
| `native/llama-engine/main.go` | stdin→stdout JSON contract, orchestration, timeout budget. |
| `native/llama-engine/scoring.go` | Pure, model-free logic: chunk splitting, log-softmax, per-chunk perplexity, token-weighted average. Injectable logits source — no DLL needed to test. |
| `native/llama-engine/scoring_test.go` | `go test` for `scoring.go` against canned logits. |
| `native/llama-engine/llama.go` | purego binding to `llama.dll`: DLL load, symbol registration, ABI shims for struct-by-value, model/context lifecycle, tokenize, decode, logits. |
| `native/llama-engine/llama_test.go` | Real-model smoke test, skipped unless `LLAMA_ENGINE_TEST_MODEL` is set. |
| `native/llama-engine/build-win32-x64.ps1` | Downloads the pinned llama.cpp zip, cross-builds the helper, stages both into the platform package. |
| `native/llama-engine/PLATFORMS.md` | Future-platform guidance (documentation deliverable). |
| `packages/win32-x64/package.json` | Platform package manifest (`os`/`cpu` gated). |
| `packages/win32-x64/README.md` | "Don't install this directly" note. |
| `src/lib/llamaEngine.ts` | Node client: helper path resolution, spawn, JSON I/O, timeout, fail-open. |
| `src/lib/llamaEngine.test.ts` | Client tests with `spawn` stubbed. |
| `src/lib/detectors/llamaEnginePerplexity.ts` | The `Detector`: env gating, provisional perplexity→score mapping, `enabled: false`. |
| `src/lib/detectors/llamaEnginePerplexity.test.ts` | Detector tests. |
| `src/lib/detectors/index.ts` | One added import + one added `CORE_DETECTORS` entry. |
| `README.md`, `TOOLS.md`, `src/context.ts`, `CLAUDE.md`, `example-mcp.json` | Documentation, updated together. |

---

### Task 1: Go scaffold and purego ABI spike — ✅ DONE (commit `1e76391`)

**Outcome:** the ABI workaround holds. Default params read back at their documented values
(512 / 2048 / 512 / 1 / 0 / 0 / 4 / 4), confirming every offset; `llama_decode` returns full
151936-wide logit vectors at *every* position, not just the last. Two corrections were needed
and are already in `llama.go`:

- Plain `syscall.LoadLibrary` cannot resolve `llama.dll`'s own ggml dependencies. Loading via
  `LoadLibraryExW` with `LOAD_WITH_ALTERED_SEARCH_PATH` (absolute path required) fixes it.
- ggml's compute backends are separate DLLs (`ggml-cpu-*.dll`, one per CPU feature level)
  discovered by scanning the *running executable's* directory. That is right in the shipped
  layout and wrong anywhere else. `loadLib` now calls `ggml_backend_load_all_from_path`
  (exported from `ggml.dll`, not `ggml-base.dll`) with the resolved lib directory. Without it,
  model loading fails with a bare "model load failed".
- `LLAMA_ENGINE_LIB_DIR` was added as a dev/test override for that directory, since `go test`
  runs the test binary from a temp directory. It is not part of the shipped config surface and
  is not documented in the README.


**Why this is first:** everything else depends on one unproven assumption. purego **does not support passing or returning C structs by value on `windows/amd64`** ([purego README](https://github.com/ebitengine/purego) — Windows amd64 supports only `SyscallN`/`NewCallback`), and `llama_decode`, `llama_batch_init`, `llama_model_load_from_file`, `llama_init_from_model` and `llama_batch_free` all take or return structs by value. The workaround relies on the Microsoft x64 calling convention: a struct whose size is not 1, 2, 4, or 8 bytes is passed as *a pointer to a caller-allocated copy*, and a struct return of that size is written through a hidden first pointer argument. Every struct involved here is well over 8 bytes, so plain `uintptr` pointer arguments reproduce the ABI exactly. This task proves that empirically before any other code is written against it.

**Files:**
- Create: `native/llama-engine/go.mod`
- Create: `native/llama-engine/llama.go`
- Create: `native/llama-engine/llama_test.go`
- Create: `native/llama-engine/main.go` (temporary spike `main`, replaced in Task 3)

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 2 and 3):
  - `func Open(modelPath string, ctxSize int32) (*Engine, error)`
  - `func (e *Engine) Close()`
  - `func (e *Engine) ModelName() string`
  - `func (e *Engine) Tokenize(text string, addSpecial bool) ([]int32, error)`
  - `func (e *Engine) NVocab() int32`
  - `func (e *Engine) DecodeChunk(tokens []int32) (LogitsAt, error)` where `type LogitsAt func(pos int) []float32`

- [ ] **Step 1: Record the exact struct offsets from the pinned header**

Fetch `https://raw.githubusercontent.com/ggml-org/llama.cpp/b10107/include/llama.h` and read `struct llama_model_params`, `struct llama_context_params`, `struct llama_batch`. Do **not** trust the offsets written below without checking them against that file — llama.cpp reorders these structs between releases, which is exactly why the release is pinned.

Write the confirmed byte offsets into a comment block at the top of `native/llama-engine/llama.go`. Offsets expected for `b10107` (verify each):

```
llama_model_params:                     llama_context_params:
  0  devices            (ptr)             0  n_ctx           uint32
  8  tensor_buft_overrides (ptr)          4  n_batch         uint32
 16  n_gpu_layers       int32             8  n_ubatch        uint32
                                         12  n_seq_max       uint32
llama_batch (64 bytes, 8-byte aligned):  16  n_rs_seq        uint32
  0  n_tokens           int32            20  n_outputs_max   uint32
  8  token              *int32           24  n_threads       int32
 16  embd               *float32         28  n_threads_batch int32
 24  pos                *int32
 32  n_seq_id           *int32
 40  seq_id             **int32
 48  logits             *int8
```

- [ ] **Step 2: Create the Go module**

```bash
cd native/llama-engine
go mod init github.com/dmongrel/human-vs-ai-mcp-server/native/llama-engine
go get github.com/ebitengine/purego@latest
```

- [ ] **Step 3: Write the binding**

Create `native/llama-engine/llama.go`:

```go
// purego binding to llama.cpp's libllama (Windows x64, pinned release b10107).
//
// ABI NOTE: purego cannot pass or return C structs by value on windows/amd64.
// It doesn't have to. Under the Microsoft x64 calling convention a struct whose
// size is not 1/2/4/8 bytes is passed as a pointer to a caller-allocated copy,
// and returned through a hidden pointer passed as the *first* argument. Every
// struct here (llama_model_params, llama_context_params, llama_batch) is far
// larger than 8 bytes, so declaring those parameters as plain uintptr pointers
// reproduces the ABI exactly. This is why the llama.cpp release is pinned:
// field offsets below are read from that release's include/llama.h.
//
// <paste the verified offset table from Step 1 here>

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"

	"github.com/ebitengine/purego"
)

// Byte offsets into the params structs, from b10107's include/llama.h.
const (
	offModelNGpuLayers = 16

	offCtxNCtx         = 0
	offCtxNBatch       = 4
	offCtxNUbatch      = 8
	offCtxNSeqMax      = 12
	offCtxNOutputsMax  = 20
	offCtxNThreads     = 24
	offCtxNThreadsBtch = 28
)

// Params structs are read into an over-allocated, zeroed buffer: we only ever
// patch fields at known offsets near the front, so the exact total size never
// has to be known (and can grow between llama.cpp releases without breaking).
const paramsBufSize = 1024

// llamaBatch mirrors struct llama_batch. Only read/written through a pointer
// returned by llama_batch_init — never constructed on the Go side.
type llamaBatch struct {
	nTokens int32
	_       int32 // padding to 8-byte alignment
	token   *int32
	embd    *float32
	pos     *int32
	nSeqID  *int32
	seqID   **int32
	logits  *int8
}

var (
	llamaBackendInit          func()
	llamaBackendFree          func()
	llamaModelDefaultParams   func(out uintptr)
	llamaModelLoadFromFile    func(path string, params uintptr) uintptr
	llamaModelFree            func(model uintptr)
	llamaModelGetVocab        func(model uintptr) uintptr
	llamaModelDesc            func(model uintptr, buf *byte, bufSize uint64) int32
	llamaContextDefaultParams func(out uintptr)
	llamaInitFromModel        func(model uintptr, params uintptr) uintptr
	llamaFree                 func(ctx uintptr)
	llamaVocabNTokens         func(vocab uintptr) int32
	llamaTokenize             func(vocab uintptr, text string, textLen int32, tokens *int32, nTokensMax int32, addSpecial bool, parseSpecial bool) int32
	llamaBatchInit            func(out uintptr, nTokens int32, embd int32, nSeqMax int32)
	llamaBatchFree            func(batch uintptr)
	llamaDecode               func(ctx uintptr, batch uintptr) int32
	llamaGetLogitsIth         func(ctx uintptr, i int32) *float32
)

var libLoaded bool

// loadLib loads llama.dll from the helper executable's own directory. The
// dependent ggml*.dll files ship alongside it and resolve via Windows' normal
// search order (the application directory is searched first).
func loadLib() error {
	if libLoaded {
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locating executable: %w", err)
	}
	dll := filepath.Join(filepath.Dir(exe), "llama.dll")
	h, err := syscall.LoadLibrary(dll)
	if err != nil {
		return fmt.Errorf("loading %s: %w", dll, err)
	}
	lib := uintptr(h)

	purego.RegisterLibFunc(&llamaBackendInit, lib, "llama_backend_init")
	purego.RegisterLibFunc(&llamaBackendFree, lib, "llama_backend_free")
	purego.RegisterLibFunc(&llamaModelDefaultParams, lib, "llama_model_default_params")
	purego.RegisterLibFunc(&llamaModelLoadFromFile, lib, "llama_model_load_from_file")
	purego.RegisterLibFunc(&llamaModelFree, lib, "llama_model_free")
	purego.RegisterLibFunc(&llamaModelGetVocab, lib, "llama_model_get_vocab")
	purego.RegisterLibFunc(&llamaModelDesc, lib, "llama_model_desc")
	purego.RegisterLibFunc(&llamaContextDefaultParams, lib, "llama_context_default_params")
	purego.RegisterLibFunc(&llamaInitFromModel, lib, "llama_init_from_model")
	purego.RegisterLibFunc(&llamaFree, lib, "llama_free")
	purego.RegisterLibFunc(&llamaVocabNTokens, lib, "llama_vocab_n_tokens")
	purego.RegisterLibFunc(&llamaTokenize, lib, "llama_tokenize")
	purego.RegisterLibFunc(&llamaBatchInit, lib, "llama_batch_init")
	purego.RegisterLibFunc(&llamaBatchFree, lib, "llama_batch_free")
	purego.RegisterLibFunc(&llamaDecode, lib, "llama_decode")
	purego.RegisterLibFunc(&llamaGetLogitsIth, lib, "llama_get_logits_ith")

	llamaBackendInit()
	libLoaded = true
	return nil
}

// Engine owns a loaded model plus one context sized to ctxSize.
type Engine struct {
	model   uintptr
	ctx     uintptr
	vocab   uintptr
	ctxSize int32
}

// LogitsAt returns the raw logit vector the model produced at a position.
type LogitsAt func(pos int) []float32

func Open(modelPath string, ctxSize int32) (*Engine, error) {
	if err := loadLib(); err != nil {
		return nil, err
	}
	if _, err := os.Stat(modelPath); err != nil {
		return nil, fmt.Errorf("model not found: %s", modelPath)
	}

	mp := make([]byte, paramsBufSize)
	mpPtr := uintptr(unsafe.Pointer(&mp[0]))
	llamaModelDefaultParams(mpPtr)
	*(*int32)(unsafe.Pointer(&mp[offModelNGpuLayers])) = 0 // CPU-only build
	model := llamaModelLoadFromFile(modelPath, mpPtr)
	runtime.KeepAlive(mp)
	if model == 0 {
		return nil, errors.New("model load failed")
	}

	cp := make([]byte, paramsBufSize)
	cpPtr := uintptr(unsafe.Pointer(&cp[0]))
	llamaContextDefaultParams(cpPtr)
	// A chunk is decoded in a single batch with logits at every position, so
	// the batch/ubatch/output limits must all admit the full context.
	*(*uint32)(unsafe.Pointer(&cp[offCtxNCtx])) = uint32(ctxSize)
	*(*uint32)(unsafe.Pointer(&cp[offCtxNBatch])) = uint32(ctxSize)
	*(*uint32)(unsafe.Pointer(&cp[offCtxNUbatch])) = uint32(ctxSize)
	*(*uint32)(unsafe.Pointer(&cp[offCtxNSeqMax])) = 1
	*(*uint32)(unsafe.Pointer(&cp[offCtxNOutputsMax])) = uint32(ctxSize)
	ctx := llamaInitFromModel(model, cpPtr)
	runtime.KeepAlive(cp)
	if ctx == 0 {
		llamaModelFree(model)
		return nil, errors.New("context creation failed")
	}

	return &Engine{model: model, ctx: ctx, vocab: llamaModelGetVocab(model), ctxSize: ctxSize}, nil
}

func (e *Engine) Close() {
	if e.ctx != 0 {
		llamaFree(e.ctx)
		e.ctx = 0
	}
	if e.model != 0 {
		llamaModelFree(e.model)
		e.model = 0
	}
}

func (e *Engine) NVocab() int32 { return llamaVocabNTokens(e.vocab) }

func (e *Engine) ModelName() string {
	buf := make([]byte, 256)
	n := llamaModelDesc(e.model, &buf[0], uint64(len(buf)))
	if n <= 0 {
		return ""
	}
	if int(n) > len(buf) {
		n = int32(len(buf))
	}
	return string(buf[:n])
}

func (e *Engine) Tokenize(text string, addSpecial bool) ([]int32, error) {
	// Worst case is one token per byte, plus room for a BOS.
	out := make([]int32, len(text)+2)
	n := llamaTokenize(e.vocab, text, int32(len(text)), &out[0], int32(len(out)), addSpecial, false)
	if n < 0 {
		return nil, fmt.Errorf("tokenize failed (buffer too small, needed %d)", -n)
	}
	return out[:n], nil
}

// DecodeChunk teacher-forces the whole chunk in one llama_decode with logits
// requested at every position, and returns an accessor for those logits. The
// returned accessor is only valid until the next DecodeChunk call.
func (e *Engine) DecodeChunk(tokens []int32) (LogitsAt, error) {
	n := int32(len(tokens))
	if n == 0 {
		return nil, errors.New("empty chunk")
	}
	if n > e.ctxSize {
		return nil, fmt.Errorf("chunk of %d tokens exceeds context size %d", n, e.ctxSize)
	}

	var bb llamaBatch
	bbPtr := uintptr(unsafe.Pointer(&bb))
	llamaBatchInit(bbPtr, n, 0, 1)
	defer llamaBatchFree(bbPtr)

	tok := unsafe.Slice(bb.token, n)
	pos := unsafe.Slice(bb.pos, n)
	nSeq := unsafe.Slice(bb.nSeqID, n)
	seq := unsafe.Slice(bb.seqID, n)
	lg := unsafe.Slice(bb.logits, n)
	for i := int32(0); i < n; i++ {
		tok[i] = tokens[i]
		pos[i] = i
		nSeq[i] = 1
		*seq[i] = 0
		lg[i] = 1 // want logits at every position
	}
	bb.nTokens = n

	if rc := llamaDecode(e.ctx, bbPtr); rc != 0 {
		return nil, fmt.Errorf("llama_decode failed with code %d", rc)
	}

	nVocab := int(e.NVocab())
	return func(p int) []float32 {
		ptr := llamaGetLogitsIth(e.ctx, int32(p))
		if ptr == nil {
			return nil
		}
		return unsafe.Slice(ptr, nVocab)
	}, nil
}
```

- [ ] **Step 4: Write the temporary spike main**

Create `native/llama-engine/main.go` (this file is fully replaced in Task 3 — it exists now only to run the spike):

```go
package main

import (
	"fmt"
	"os"
	"unsafe"
)

func main() {
	if err := loadLib(); err != nil {
		fmt.Fprintln(os.Stderr, "load:", err)
		os.Exit(1)
	}

	// ABI sanity check: dump the first 32 bytes of default context params as
	// uint32s. If the offsets are right these must look like llama.cpp's
	// documented defaults (n_ctx 512, n_batch 2048, n_ubatch 512, n_seq_max 1,
	// n_threads = a plausible core count). Garbage here means the offset table
	// is wrong or the struct-return-pointer trick failed.
	cp := make([]byte, paramsBufSize)
	llamaContextDefaultParams(uintptr(unsafe.Pointer(&cp[0])))
	for i := 0; i < 32; i += 4 {
		fmt.Fprintf(os.Stderr, "ctx_params+%02d = %d\n", i, *(*uint32)(unsafe.Pointer(&cp[i])))
	}

	modelPath := os.Getenv("LLAMA_ENGINE_TEST_MODEL")
	if modelPath == "" {
		fmt.Fprintln(os.Stderr, "set LLAMA_ENGINE_TEST_MODEL to run the full spike")
		return
	}
	eng, err := Open(modelPath, 512)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open:", err)
		os.Exit(1)
	}
	defer eng.Close()

	fmt.Fprintln(os.Stderr, "model:", eng.ModelName(), "n_vocab:", eng.NVocab())
	toks, err := eng.Tokenize("The quick brown fox jumps over the lazy dog.", true)
	if err != nil {
		fmt.Fprintln(os.Stderr, "tokenize:", err)
		os.Exit(1)
	}
	fmt.Fprintln(os.Stderr, "tokens:", toks)

	at, err := eng.DecodeChunk(toks)
	if err != nil {
		fmt.Fprintln(os.Stderr, "decode:", err)
		os.Exit(1)
	}
	for _, p := range []int{0, len(toks) / 2, len(toks) - 1} {
		l := at(p)
		if l == nil {
			fmt.Fprintf(os.Stderr, "pos %d: NO LOGITS\n", p)
			continue
		}
		fmt.Fprintf(os.Stderr, "pos %d: %d logits, first three %v\n", p, len(l), l[:3])
	}
}
```

- [ ] **Step 5: Stage the DLLs and build the spike**

```bash
mkdir -p native/llama-engine/.local
curl -L -o native/llama-engine/.local/llama.zip \
  https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-win-cpu-x64.zip
cd native/llama-engine/.local && unzip -o llama.zip && cd ../../..
cd native/llama-engine && go build -o .local/llama-engine-helper.exe . && cd ../..
```

The zip's DLL layout varies by release — if `llama.dll` and the `ggml*.dll` files land in a subdirectory, copy them next to `.local/llama-engine-helper.exe`. Add `native/llama-engine/.local/` to `.gitignore` in this step; downloaded binaries are never committed.

- [ ] **Step 6: Run the spike and verify the ABI**

```bash
LLAMA_ENGINE_TEST_MODEL="F:\\models\\Qwen2.5-1.5B-Instruct.Q4_K_M.gguf" \
  native/llama-engine/.local/llama-engine-helper.exe
```

Expected on stderr: plausible default params (`ctx_params+00 = 512`, `+04 = 2048`, `+08 = 512`, `+12 = 1`), a model description string, a non-zero `n_vocab` (~151936 for Qwen2.5), a token list, and **logits at all three probed positions** — including position 0 and the midpoint, not just the last. `NO LOGITS` at a non-final position means the all-positions output request didn't take; re-check `offCtxNOutputsMax` against the pinned header before continuing.

**If the ABI trick fails outright** (crash, garbage params, model load returning 0 with valid inputs): stop and report rather than improvising. Documented fallbacks, in preference order — (1) `github.com/dianlight/gollama.cpp`, a purego binding that already solved this; (2) a small C shim DLL exporting pointer-taking wrappers, built once in the release pipeline. Both are architecture changes that need the user's call.

- [ ] **Step 7: Add the guarded smoke test**

Create `native/llama-engine/llama_test.go`:

```go
package main

import (
	"os"
	"testing"
)

// Requires a real .gguf; skipped in CI and in any checkout without one.
func TestEngineSmoke(t *testing.T) {
	modelPath := os.Getenv("LLAMA_ENGINE_TEST_MODEL")
	if modelPath == "" {
		t.Skip("LLAMA_ENGINE_TEST_MODEL not set")
	}
	eng, err := Open(modelPath, 512)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer eng.Close()

	if eng.NVocab() <= 0 {
		t.Fatalf("expected a positive vocab size, got %d", eng.NVocab())
	}
	toks, err := eng.Tokenize("The quick brown fox jumps over the lazy dog.", true)
	if err != nil {
		t.Fatalf("Tokenize: %v", err)
	}
	if len(toks) < 5 {
		t.Fatalf("expected several tokens, got %v", toks)
	}
	at, err := eng.DecodeChunk(toks)
	if err != nil {
		t.Fatalf("DecodeChunk: %v", err)
	}
	for _, p := range []int{0, len(toks) - 1} {
		if got := at(p); len(got) != int(eng.NVocab()) {
			t.Fatalf("position %d: expected %d logits, got %d", p, eng.NVocab(), len(got))
		}
	}
}
```

- [ ] **Step 8: Run the test**

```bash
cd native/llama-engine && go vet ./... && go test ./...
```
Expected: `ok` with `TestEngineSmoke` skipped. Then re-run with the env var set and confirm it passes:
```bash
cd native/llama-engine && LLAMA_ENGINE_TEST_MODEL="F:\\models\\Qwen2.5-1.5B-Instruct.Q4_K_M.gguf" go test -v ./...
```

- [ ] **Step 9: Commit**

```bash
git add native/llama-engine/go.mod native/llama-engine/go.sum native/llama-engine/llama.go native/llama-engine/llama_test.go native/llama-engine/main.go .gitignore
git commit -m "feat(native): purego binding to libllama with verified windows/amd64 struct ABI"
```

---

### Task 2: Pure scoring logic (TDD, no model required) — ✅ DONE (`3553c9e`)

**Files:**
- Create: `native/llama-engine/scoring.go`
- Test: `native/llama-engine/scoring_test.go`

**Interfaces:**
- Consumes: `LogitsAt` from Task 1.
- Produces (used by Task 3):
  - `func SplitChunks(tokens []int32, ctxSize int) [][]int32`
  - `func ChunkPerplexity(tokens []int32, at LogitsAt) (ppl float64, scored int, err error)`
  - `type ChunkResult struct { Tokens int; Perplexity float64 }`
  - `func WeightedPerplexity(chunks []ChunkResult) (float64, int)`

- [ ] **Step 1: Write the failing tests**

Create `native/llama-engine/scoring_test.go`:

```go
package main

import (
	"math"
	"testing"
)

func TestSplitChunksSplitsEvenlyAndKeepsRemainder(t *testing.T) {
	toks := make([]int32, 250)
	got := SplitChunks(toks, 100)
	if len(got) != 3 {
		t.Fatalf("expected 3 chunks, got %d", len(got))
	}
	if len(got[0]) != 100 || len(got[1]) != 100 || len(got[2]) != 50 {
		t.Fatalf("unexpected chunk sizes: %d/%d/%d", len(got[0]), len(got[1]), len(got[2]))
	}
}

func TestSplitChunksDropsUnscorableTail(t *testing.T) {
	// A trailing chunk of one token has no next token to predict, so it
	// contributes nothing and must not become a zero-token chunk downstream.
	toks := make([]int32, 101)
	got := SplitChunks(toks, 100)
	if len(got) != 1 {
		t.Fatalf("expected the 1-token tail to be dropped, got %d chunks", len(got))
	}
}

func TestChunkPerplexityIsExpOfNegativeMeanLogProb(t *testing.T) {
	// Two-way vocab. Logits [0, 0] => uniform => p(next) = 0.5 for either
	// token => mean log prob = ln(0.5) => perplexity = 2.
	tokens := []int32{0, 1, 0, 1}
	at := func(pos int) []float32 { return []float32{0, 0} }

	ppl, scored, err := ChunkPerplexity(tokens, at)
	if err != nil {
		t.Fatalf("ChunkPerplexity: %v", err)
	}
	if scored != 3 {
		t.Fatalf("expected 3 scored positions for 4 tokens, got %d", scored)
	}
	if math.Abs(ppl-2) > 1e-6 {
		t.Fatalf("expected perplexity 2, got %v", ppl)
	}
}

func TestChunkPerplexityRewardsConfidentCorrectPredictions(t *testing.T) {
	// Logits strongly favour token 1, and token 1 is always what comes next,
	// so perplexity must be far below the uniform baseline of 2.
	tokens := []int32{1, 1, 1, 1}
	at := func(pos int) []float32 { return []float32{0, 10} }

	ppl, _, err := ChunkPerplexity(tokens, at)
	if err != nil {
		t.Fatalf("ChunkPerplexity: %v", err)
	}
	if ppl >= 1.001 {
		t.Fatalf("expected near-1 perplexity for confident correct predictions, got %v", ppl)
	}
}

func TestChunkPerplexityErrorsWhenLogitsAreMissing(t *testing.T) {
	tokens := []int32{0, 1, 0}
	at := func(pos int) []float32 { return nil }
	if _, _, err := ChunkPerplexity(tokens, at); err == nil {
		t.Fatal("expected an error when no logits are available")
	}
}

func TestChunkPerplexityErrorsOnOutOfRangeToken(t *testing.T) {
	tokens := []int32{0, 7}
	at := func(pos int) []float32 { return []float32{0, 0} }
	if _, _, err := ChunkPerplexity(tokens, at); err == nil {
		t.Fatal("expected an error when a token id exceeds the logit vector")
	}
}

func TestWeightedPerplexityWeightsByTokenCount(t *testing.T) {
	// A 900-token chunk at ppl 10 and a 100-token chunk at ppl 100 must land
	// nearer 10 than a plain mean (55) would.
	chunks := []ChunkResult{{Tokens: 900, Perplexity: 10}, {Tokens: 100, Perplexity: 100}}
	got, total := WeightedPerplexity(chunks)
	if total != 1000 {
		t.Fatalf("expected 1000 total tokens, got %d", total)
	}
	// Averaging happens in log space: exp((900*ln10 + 100*ln100)/1000).
	want := math.Exp((900*math.Log(10) + 100*math.Log(100)) / 1000)
	if math.Abs(got-want) > 1e-6 {
		t.Fatalf("expected %v, got %v", want, got)
	}
}

func TestWeightedPerplexityHandlesNoChunks(t *testing.T) {
	got, total := WeightedPerplexity(nil)
	if total != 0 || got != 0 {
		t.Fatalf("expected zero values for no chunks, got %v/%d", got, total)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd native/llama-engine && go test ./...
```
Expected: FAIL — `undefined: SplitChunks`, `undefined: ChunkPerplexity`, `undefined: ChunkResult`, `undefined: WeightedPerplexity`.

- [ ] **Step 3: Write the implementation**

Create `native/llama-engine/scoring.go`:

```go
// Pure scoring logic: no libllama calls, so it is fully unit-testable against
// canned logits with no .gguf present. Mirrors the math in llama.cpp's own
// tools/perplexity/perplexity.cpp compute_logprobs().

package main

import (
	"errors"
	"fmt"
	"math"
)

// ChunkResult is one chunk's contribution to the document-level perplexity.
type ChunkResult struct {
	Tokens     int
	Perplexity float64
}

// SplitChunks cuts the token stream into non-overlapping context-sized chunks.
// No sliding window / stride: there's no generation step here to make the extra
// passes worthwhile. A trailing chunk of fewer than two tokens is dropped — a
// single token has no successor to predict and would score nothing.
func SplitChunks(tokens []int32, ctxSize int) [][]int32 {
	if ctxSize < 2 || len(tokens) < 2 {
		return nil
	}
	var chunks [][]int32
	for i := 0; i < len(tokens); i += ctxSize {
		end := i + ctxSize
		if end > len(tokens) {
			end = len(tokens)
		}
		if end-i < 2 {
			break
		}
		chunks = append(chunks, tokens[i:end])
	}
	return chunks
}

// ChunkPerplexity teacher-forces one chunk: at each position it log-softmaxes
// the model's logits and reads off the probability the model assigned to the
// token that actually came next. Returns exp(-mean log prob) and the number of
// scored positions (one fewer than the token count — the last token has no
// successor inside this chunk).
func ChunkPerplexity(tokens []int32, at LogitsAt) (float64, int, error) {
	if len(tokens) < 2 {
		return 0, 0, errors.New("chunk needs at least two tokens")
	}
	sumLogProb := 0.0
	scored := 0
	for i := 0; i < len(tokens)-1; i++ {
		logits := at(i)
		if len(logits) == 0 {
			return 0, 0, fmt.Errorf("no logits available at position %d", i)
		}
		next := int(tokens[i+1])
		if next < 0 || next >= len(logits) {
			return 0, 0, fmt.Errorf("token id %d out of range for %d logits", next, len(logits))
		}
		sumLogProb += logSoftmaxAt(logits, next)
		scored++
	}
	return math.Exp(-sumLogProb / float64(scored)), scored, nil
}

// logSoftmaxAt returns log(softmax(logits)[idx]), computed in the numerically
// stable max-subtracted form.
func logSoftmaxAt(logits []float32, idx int) float64 {
	maxLogit := float64(logits[0])
	for _, l := range logits[1:] {
		if float64(l) > maxLogit {
			maxLogit = float64(l)
		}
	}
	sumExp := 0.0
	for _, l := range logits {
		sumExp += math.Exp(float64(l) - maxLogit)
	}
	return float64(logits[idx]) - maxLogit - math.Log(sumExp)
}

// WeightedPerplexity combines chunk perplexities weighted by token count, in
// log space — which is where perplexity is additive. A plain mean would be
// wrong whenever chunk lengths differ, which they always do once a timeout
// truncates the run or the document doesn't divide evenly.
func WeightedPerplexity(chunks []ChunkResult) (float64, int) {
	totalTokens := 0
	weightedLogSum := 0.0
	for _, c := range chunks {
		if c.Tokens <= 0 {
			continue
		}
		totalTokens += c.Tokens
		weightedLogSum += float64(c.Tokens) * math.Log(c.Perplexity)
	}
	if totalTokens == 0 {
		return 0, 0
	}
	return math.Exp(weightedLogSum / float64(totalTokens)), totalTokens
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd native/llama-engine && go vet ./... && go test ./...
```
Expected: PASS (all `scoring_test.go` tests; `TestEngineSmoke` skipped).

- [ ] **Step 5: Commit**

```bash
git add native/llama-engine/scoring.go native/llama-engine/scoring_test.go
git commit -m "feat(native): teacher-forced perplexity scoring math with unit tests"
```

---

### Task 3: Helper JSON contract on stdin/stdout — ✅ DONE (`37823f7`)

**Files:**
- Modify: `native/llama-engine/main.go` (replace the Task 1 spike entirely)
- Create: `native/llama-engine/main_test.go`

**Interfaces:**
- Consumes: `Open`/`Close`/`ModelName`/`Tokenize`/`DecodeChunk` (Task 1); `SplitChunks`/`ChunkPerplexity`/`ChunkResult`/`WeightedPerplexity` (Task 2).
- Produces: the wire contract `src/lib/llamaEngine.ts` (Task 4) depends on —
  - Request: `{"modelPath": string, "text": string, "ctxSize": number, "timeoutMs": number}`
  - Success: `{"ok": true, "perplexity": number, "tokensEvaluated": number, "chunks": [{"tokens": number, "perplexity": number}], "modelName": string, "timedOut": boolean}`
  - Failure: `{"ok": false, "error": string}`, exit code 1.

- [ ] **Step 1: Write the failing tests**

Create `native/llama-engine/main_test.go`:

```go
package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseRequestAppliesDefaults(t *testing.T) {
	req, err := parseRequest(strings.NewReader(`{"modelPath":"m.gguf","text":"hello"}`))
	if err != nil {
		t.Fatalf("parseRequest: %v", err)
	}
	if req.CtxSize != defaultCtxSize {
		t.Fatalf("expected ctxSize to default to %d, got %d", defaultCtxSize, req.CtxSize)
	}
	if req.TimeoutMs != defaultTimeoutMs {
		t.Fatalf("expected timeoutMs to default to %d, got %d", defaultTimeoutMs, req.TimeoutMs)
	}
}

func TestParseRequestRejectsMissingModelPath(t *testing.T) {
	if _, err := parseRequest(strings.NewReader(`{"text":"hello"}`)); err == nil {
		t.Fatal("expected an error when modelPath is missing")
	}
}

func TestParseRequestRejectsEmptyText(t *testing.T) {
	if _, err := parseRequest(strings.NewReader(`{"modelPath":"m.gguf","text":"   "}`)); err == nil {
		t.Fatal("expected an error when text is blank")
	}
}

func TestParseRequestRejectsMalformedJSON(t *testing.T) {
	if _, err := parseRequest(strings.NewReader(`{not json`)); err == nil {
		t.Fatal("expected an error on malformed JSON")
	}
}

func TestErrorResponseSerialisesWithOkFalse(t *testing.T) {
	var out strings.Builder
	writeError(&out, "model load failed: file not found")

	var got map[string]any
	if err := json.Unmarshal([]byte(out.String()), &got); err != nil {
		t.Fatalf("error output was not valid JSON: %v (%q)", err, out.String())
	}
	if got["ok"] != false {
		t.Fatalf("expected ok:false, got %v", got["ok"])
	}
	if got["error"] != "model load failed: file not found" {
		t.Fatalf("unexpected error text: %v", got["error"])
	}
}

func TestErrorResponseIsSingleLine(t *testing.T) {
	// Node reads the last non-empty stdout line; multi-line JSON would break it.
	var out strings.Builder
	writeError(&out, "boom")
	if strings.Count(strings.TrimRight(out.String(), "\n"), "\n") != 0 {
		t.Fatalf("expected single-line JSON, got %q", out.String())
	}
}

func TestSuccessResponseSerialisesAllFields(t *testing.T) {
	var out strings.Builder
	writeSuccess(&out, response{
		OK:              true,
		Perplexity:      14.2,
		TokensEvaluated: 1843,
		Chunks:          []ChunkResult{{Tokens: 512, Perplexity: 13.8}},
		ModelName:       "qwen2.5-1.5b-instruct",
		TimedOut:        false,
	})

	var got map[string]any
	if err := json.Unmarshal([]byte(out.String()), &got); err != nil {
		t.Fatalf("output was not valid JSON: %v (%q)", err, out.String())
	}
	for _, key := range []string{"ok", "perplexity", "tokensEvaluated", "chunks", "modelName", "timedOut"} {
		if _, present := got[key]; !present {
			t.Fatalf("missing key %q in %v", key, got)
		}
	}
	chunks, isSlice := got["chunks"].([]any)
	if !isSlice || len(chunks) != 1 {
		t.Fatalf("expected one chunk entry, got %v", got["chunks"])
	}
	first, _ := chunks[0].(map[string]any)
	if _, present := first["tokens"]; !present {
		t.Fatalf("chunk entries must carry a tokens field, got %v", first)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd native/llama-engine && go test ./...
```
Expected: FAIL — `undefined: parseRequest`, `undefined: writeError`, `undefined: writeSuccess`, `undefined: response`, `undefined: defaultCtxSize`, `undefined: defaultTimeoutMs`.

- [ ] **Step 3: Write the implementation**

Replace `native/llama-engine/main.go` entirely with:

```go
// llama-engine-helper: one-shot teacher-forced perplexity scorer.
//
// Reads one JSON request from stdin, writes exactly one single-line JSON
// response to stdout, exits 0 on success and 1 on failure — with a JSON object
// on stdout either way, so the Node caller never has to parse bare stderr text
// to learn why something failed. All diagnostics go to stderr; stdout carries
// nothing but the response line.
//
// One process per scoring call. No daemon, no ports, no lifecycle management,
// nothing left running if the MCP server dies.

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

const (
	defaultCtxSize   = 2048
	defaultTimeoutMs = 60000
	maxCtxSize       = 32768
)

type request struct {
	ModelPath string `json:"modelPath"`
	Text      string `json:"text"`
	CtxSize   int    `json:"ctxSize"`
	TimeoutMs int    `json:"timeoutMs"`
}

type response struct {
	OK              bool          `json:"ok"`
	Perplexity      float64       `json:"perplexity"`
	TokensEvaluated int           `json:"tokensEvaluated"`
	Chunks          []ChunkResult `json:"chunks"`
	ModelName       string        `json:"modelName"`
	TimedOut        bool          `json:"timedOut"`
}

// ChunkResult's JSON field names are part of the wire contract.
// (Tags live here rather than in scoring.go to keep that file transport-free.)

func parseRequest(r io.Reader) (request, error) {
	var req request
	if err := json.NewDecoder(r).Decode(&req); err != nil {
		return req, fmt.Errorf("invalid JSON request: %w", err)
	}
	if strings.TrimSpace(req.ModelPath) == "" {
		return req, errors.New("modelPath is required")
	}
	if strings.TrimSpace(req.Text) == "" {
		return req, errors.New("text is required")
	}
	if req.CtxSize <= 0 {
		req.CtxSize = defaultCtxSize
	}
	if req.CtxSize > maxCtxSize {
		req.CtxSize = maxCtxSize
	}
	if req.TimeoutMs <= 0 {
		req.TimeoutMs = defaultTimeoutMs
	}
	return req, nil
}

func writeError(w io.Writer, msg string) {
	b, err := json.Marshal(map[string]any{"ok": false, "error": msg})
	if err != nil {
		fmt.Fprintf(w, `{"ok":false,"error":"failed to encode error"}`+"\n")
		return
	}
	fmt.Fprintf(w, "%s\n", b)
}

func writeSuccess(w io.Writer, resp response) {
	b, err := json.Marshal(resp)
	if err != nil {
		writeError(w, "failed to encode response")
		return
	}
	fmt.Fprintf(w, "%s\n", b)
}

func main() {
	req, err := parseRequest(os.Stdin)
	if err != nil {
		writeError(os.Stdout, err.Error())
		os.Exit(1)
	}
	resp, err := run(req)
	if err != nil {
		writeError(os.Stdout, err.Error())
		os.Exit(1)
	}
	writeSuccess(os.Stdout, resp)
}

func run(req request) (response, error) {
	deadline := time.Now().Add(time.Duration(req.TimeoutMs) * time.Millisecond)

	eng, err := Open(req.ModelPath, int32(req.CtxSize))
	if err != nil {
		return response{}, err
	}
	defer eng.Close()

	tokens, err := eng.Tokenize(req.Text, true)
	if err != nil {
		return response{}, err
	}
	chunks := SplitChunks(tokens, req.CtxSize)
	if len(chunks) == 0 {
		return response{}, errors.New("text too short to score")
	}

	// The time budget is checked between chunks, mirroring modelRunner.ts:
	// a slow run returns whatever completed rather than failing outright.
	var results []ChunkResult
	timedOut := false
	for _, chunk := range chunks {
		if time.Now().After(deadline) {
			timedOut = true
			break
		}
		at, err := eng.DecodeChunk(chunk)
		if err != nil {
			fmt.Fprintf(os.Stderr, "chunk skipped: %v\n", err)
			continue
		}
		ppl, scored, err := ChunkPerplexity(chunk, at)
		if err != nil {
			fmt.Fprintf(os.Stderr, "chunk skipped: %v\n", err)
			continue
		}
		results = append(results, ChunkResult{Tokens: scored, Perplexity: ppl})
	}
	if len(results) == 0 {
		return response{}, errors.New("no chunk could be scored")
	}

	perplexity, totalTokens := WeightedPerplexity(results)
	return response{
		OK:              true,
		Perplexity:      perplexity,
		TokensEvaluated: totalTokens,
		Chunks:          results,
		ModelName:       eng.ModelName(),
		TimedOut:        timedOut,
	}, nil
}
```

- [ ] **Step 4: Add the wire-contract JSON tags to `ChunkResult`**

In `native/llama-engine/scoring.go`, change the `ChunkResult` declaration to:

```go
type ChunkResult struct {
	Tokens     int     `json:"tokens"`
	Perplexity float64 `json:"perplexity"`
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd native/llama-engine && go vet ./... && go test ./...
```
Expected: PASS.

- [ ] **Step 6: Run the helper end-to-end against the fixture model**

```bash
cd native/llama-engine && go build -o .local/llama-engine-helper.exe . && cd ../..
echo '{"modelPath":"F:\\models\\Qwen2.5-1.5B-Instruct.Q4_K_M.gguf","text":"The quick brown fox jumps over the lazy dog. It was the best of times, it was the worst of times.","ctxSize":512,"timeoutMs":60000}' \
  | native/llama-engine/.local/llama-engine-helper.exe
```
Expected: one line of JSON on stdout with `"ok":true` and a **plausible, non-degenerate** perplexity — a small instruct model on ordinary English prose should land roughly in the 5-50 range. A perplexity of ~1.0 would mean the same structural bug that killed the HTTP path; anything at or below 1.05 must be investigated before continuing, not calibrated around.

- [ ] **Step 7: Commit**

```bash
git add native/llama-engine/main.go native/llama-engine/main_test.go native/llama-engine/scoring.go
git commit -m "feat(native): stdin/stdout JSON contract for the llama-engine helper"
```

---

### Task 4: Node client (`llamaEngine.ts`) — ✅ DONE (`ff4c65a`)

**Correction:** tests inject via an exported `_internals.spawn` rather than patching `node:child_process`. Builtin module members are getter-only in current Node and cannot be reassigned the way `globalThis.fetch` can.

**Files:**
- Create: `src/lib/llamaEngine.ts`
- Test: `src/lib/llamaEngine.test.ts`

**Interfaces:**
- Consumes: the Task 3 wire contract.
- Produces (used by Task 5):
  - `interface EnginePerplexityResult { perplexity: number; tokensEvaluated: number; chunks: { tokens: number; perplexity: number }[]; modelName: string; timedOut: boolean }`
  - `function getEngineModelPath(): string | null`
  - `function scorePerplexityViaEngine(text: string, opts?: { timeoutMs?: number }): Promise<EnginePerplexityResult | null>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/llamaEngine.test.ts`:

```typescript
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";

import { getEngineModelPath, scorePerplexityViaEngine } from "./llamaEngine.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_SPAWN = childProcess.spawn;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.LLAMA_ENGINE_MODEL_PATH;
  delete process.env.LLAMA_ENGINE_CTX_SIZE;
  delete process.env.LLAMA_ENGINE_TIMEOUT_MS;
  delete process.env.LLAMA_ENGINE_HELPER_PATH;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  (childProcess as { spawn: typeof childProcess.spawn }).spawn = ORIGINAL_SPAWN;
});

// A fake child process that emits the given stdout text, then exits with the
// given code. Captures whatever was written to stdin for assertions.
function stubSpawn(stdout: string, exitCode = 0): { stdinChunks: string[] } {
  const stdinChunks: string[] = [];
  (childProcess as { spawn: typeof childProcess.spawn }).spawn = ((): unknown => {
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
  }) as typeof childProcess.spawn;
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
  (childProcess as { spawn: typeof childProcess.spawn }).spawn = (() => {
    spawned = true;
    throw new Error("should not spawn");
  }) as typeof childProcess.spawn;

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
  assert.equal(spawned, false, "expected no subprocess when the model path is unset");
});

test("scorePerplexityViaEngine parses a successful response", async () => {
  process.env.LLAMA_ENGINE_MODEL_PATH = "F:\\models\\m.gguf";
  process.env.LLAMA_ENGINE_HELPER_PATH = "C:\\fake\\llama-engine-helper.exe";
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
  process.env.LLAMA_ENGINE_MODEL_PATH = "F:\\models\\m.gguf";
  process.env.LLAMA_ENGINE_HELPER_PATH = "C:\\fake\\llama-engine-helper.exe";
  process.env.LLAMA_ENGINE_CTX_SIZE = "4096";
  const { stdinChunks } = stubSpawn(OK_RESPONSE);

  await scorePerplexityViaEngine("Some text to score.", { timeoutMs: 1234 });
  const sent = JSON.parse(stdinChunks.join(""));
  assert.equal(sent.modelPath, "F:\\models\\m.gguf");
  assert.equal(sent.text, "Some text to score.");
  assert.equal(sent.ctxSize, 4096);
  assert.equal(sent.timeoutMs, 1234);
});

test("scorePerplexityViaEngine returns null on an ok:false response", async () => {
  process.env.LLAMA_ENGINE_MODEL_PATH = "F:\\models\\m.gguf";
  process.env.LLAMA_ENGINE_HELPER_PATH = "C:\\fake\\llama-engine-helper.exe";
  stubSpawn(JSON.stringify({ ok: false, error: "model load failed" }), 1);

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
});

test("scorePerplexityViaEngine returns null on malformed stdout", async () => {
  process.env.LLAMA_ENGINE_MODEL_PATH = "F:\\models\\m.gguf";
  process.env.LLAMA_ENGINE_HELPER_PATH = "C:\\fake\\llama-engine-helper.exe";
  stubSpawn("not json at all");

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
});

test("scorePerplexityViaEngine ignores stray stdout lines before the response", async () => {
  process.env.LLAMA_ENGINE_MODEL_PATH = "F:\\models\\m.gguf";
  process.env.LLAMA_ENGINE_HELPER_PATH = "C:\\fake\\llama-engine-helper.exe";
  stubSpawn(`a stray backend log line\n${OK_RESPONSE}\n`);

  const result = await scorePerplexityViaEngine("Some text.");
  assert.ok(result, "expected the trailing JSON line to be parsed");
  assert.equal(result!.perplexity, 14.2);
});

test("scorePerplexityViaEngine returns null when the response shape is wrong", async () => {
  process.env.LLAMA_ENGINE_MODEL_PATH = "F:\\models\\m.gguf";
  process.env.LLAMA_ENGINE_HELPER_PATH = "C:\\fake\\llama-engine-helper.exe";
  stubSpawn(JSON.stringify({ ok: true, perplexity: "not a number" }));

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
});

test("scorePerplexityViaEngine returns null when the helper cannot be spawned", async () => {
  process.env.LLAMA_ENGINE_MODEL_PATH = "F:\\models\\m.gguf";
  process.env.LLAMA_ENGINE_HELPER_PATH = "C:\\fake\\llama-engine-helper.exe";
  (childProcess as { spawn: typeof childProcess.spawn }).spawn = (() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => child.emit("error", new Error("ENOENT")));
    return child;
  }) as typeof childProcess.spawn;

  assert.equal(await scorePerplexityViaEngine("Some text."), null);
});

test("scorePerplexityViaEngine returns null and kills the helper when it exceeds the timeout", async () => {
  process.env.LLAMA_ENGINE_MODEL_PATH = "F:\\models\\m.gguf";
  process.env.LLAMA_ENGINE_HELPER_PATH = "C:\\fake\\llama-engine-helper.exe";
  let killed = false;
  (childProcess as { spawn: typeof childProcess.spawn }).spawn = (() => {
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
  }) as typeof childProcess.spawn;

  const result = await scorePerplexityViaEngine("Some text.", { timeoutMs: 50 });
  assert.equal(result, null);
  assert.equal(killed, true, "expected the helper to be killed once the budget elapsed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```
Expected: FAIL — `pretest` (`tsc -p tsconfig.test.json`) errors with "Cannot find module './llamaEngine.js'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/llamaEngine.ts`:

```typescript
// Client for the bundled llama.cpp-engine perplexity helper — the second,
// independent model-perplexity path alongside the (disabled) HTTP-based
// modelRunner.ts. Where that one asks a chat model to echo text back and reads
// logprobs off its own generation, this one does real teacher-forced scoring:
// the helper feeds the actual tokens through libllama and reads the model's
// probability for each real next token. No generation step, so none of the
// greedy-decoding bias that made the HTTP technique non-discriminating (see
// README.md's "Model runner (currently disabled)").
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
 * means future platform packages need no changes here beyond this list.
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
    const finish = (value: EnginePerplexityResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child: childProcess.ChildProcess;
    try {
      child = childProcess.spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return resolve(null);
    }

    // The helper enforces its own budget between chunks; this is the outer
    // guard for the case where it wedges inside a single decode.
    const timer = setTimeout(() => {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test
```
Expected: PASS, including all `llamaEngine.test.js` cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llamaEngine.ts src/lib/llamaEngine.test.ts
git commit -m "feat: Node client for the bundled llama-engine perplexity helper"
```

---

### Task 5: The detector — ✅ DONE (`07efd49`)

**Files:**
- Create: `src/lib/detectors/llamaEnginePerplexity.ts`
- Modify: `src/lib/detectors/index.ts`
- Test: `src/lib/detectors/llamaEnginePerplexity.test.ts`

**Interfaces:**
- Consumes: `scorePerplexityViaEngine`, `EnginePerplexityResult` (Task 4); `Detector`, `DocumentType` from `./types.js`; `clamp` from `../text.js`.
- Produces: `export const llamaEnginePerplexityDetector: Detector` with `id: "llama-engine-perplexity"` and `name: "llama-engine perplexity"`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/detectors/llamaEnginePerplexity.test.ts`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";

import { CORE_DETECTORS } from "./index.js";
import { llamaEnginePerplexityDetector, perplexityToScore } from "./llamaEnginePerplexity.js";
import type { DocumentType } from "./types.js";

test("the detector ships disabled until it is calibrated", () => {
  assert.equal(llamaEnginePerplexityDetector.enabled, false);
});

test("the detector is registered exactly once in CORE_DETECTORS", () => {
  const matches = CORE_DETECTORS.filter((d) => d.id === "llama-engine-perplexity");
  assert.equal(matches.length, 1);
});

test("the detector's id does not collide with the HTTP model-runner detector", () => {
  const ids = CORE_DETECTORS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, "detector ids must be unique");
  assert.ok(ids.includes("model-runner-perplexity"), "the HTTP model-runner detector must remain registered");
});

test("the detector has a weight for every ruleset", () => {
  for (const type of ["default", "creative", "strategic"] as (DocumentType | "default")[]) {
    const weight = llamaEnginePerplexityDetector.weight(type);
    assert.ok(weight > 0 && weight <= 1, `unexpected weight ${weight} for ${type}`);
  }
});

test("perplexityToScore reports low perplexity as AI-like", () => {
  assert.ok(perplexityToScore(2) > 0.9, "very predictable text should score near 1");
});

test("perplexityToScore reports high perplexity as human-like", () => {
  assert.ok(perplexityToScore(500) < 0.1, "very surprising text should score near 0");
});

test("perplexityToScore is monotonically decreasing in perplexity", () => {
  const scores = [3, 6, 12, 24, 48].map(perplexityToScore);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] < scores[i - 1], `expected a lower score at index ${i}: ${scores.join(", ")}`);
  }
});

test("perplexityToScore stays within 0..1", () => {
  for (const ppl of [0.5, 1, 10, 1000, 1e6]) {
    const score = perplexityToScore(ppl);
    assert.ok(score >= 0 && score <= 1, `score ${score} out of range for perplexity ${ppl}`);
  }
});

test("run returns null when LLAMA_ENGINE_MODEL_PATH is unset", async () => {
  delete process.env.LLAMA_ENGINE_MODEL_PATH;
  const result = await llamaEnginePerplexityDetector.run({
    text: "Some text to score.",
    sentences: ["Some text to score."],
    paragraphs: ["Some text to score."],
    words: ["Some", "text", "to", "score"],
    lowerText: "some text to score.",
    type: "default",
  });
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test
```
Expected: FAIL — "Cannot find module './llamaEnginePerplexity.js'".

- [ ] **Step 3: Write the detector**

Create `src/lib/detectors/llamaEnginePerplexity.ts`:

```typescript
// Bundled-engine perplexity: CURRENTLY DISABLED (enabled: false below), but
// for a different reason than ../modelPerplexity.ts. That one is disabled
// because its technique is structurally broken; this one is disabled only
// because its perplexity -> score mapping has not been calibrated against real
// human and AI text yet. The measurement itself is sound — teacher-forced
// scoring through libllama, exactly what llama.cpp's own llama-perplexity CLI
// does, with no generation step and therefore no greedy-decoding bias.
//
// To enable it you need: (1) empirical anchors from running the helper over a
// corpus of known-human and known-AI prose with the model you intend to ship
// against, replacing the provisional constants below, and (2) a documented
// note in README.md recording which model those anchors came from — the
// numbers are model-specific and don't transfer.

import { scorePerplexityViaEngine, getEngineModelPath } from "../llamaEngine.js";
import { clamp } from "../text.js";
import type { Detector, DocumentType } from "./types.js";

const WEIGHT: Record<"default" | DocumentType, number> = {
  default: 0.15,
  creative: 0.15,
  strategic: 0.15,
};

// PROVISIONAL, UNVALIDATED anchors. Perplexity is model-specific: a 1.5B model
// reports much higher numbers than a 70B one on identical text, so these are
// starting points to be replaced by measurement, not defaults to trust. Low
// perplexity means the text was predictable to the model (AI-typical); high
// means it surprised the model (human-typical). Interpolation is in log space
// because perplexity is exponential in cross-entropy — the perceptual distance
// from 5 to 10 is the same as from 10 to 20, not from 10 to 15.
const PERPLEXITY_AI_LIKE_ANCHOR = 6;
const PERPLEXITY_HUMAN_LIKE_ANCHOR = 40;

/** Map a raw perplexity to a 0 (human-like) .. 1 (AI-like) detector score. Exported for testing. */
export function perplexityToScore(perplexity: number): number {
  if (!Number.isFinite(perplexity) || perplexity <= 0) return 0;
  const lo = Math.log(PERPLEXITY_AI_LIKE_ANCHOR);
  const hi = Math.log(PERPLEXITY_HUMAN_LIKE_ANCHOR);
  return clamp(1 - (Math.log(perplexity) - lo) / (hi - lo));
}

export const llamaEnginePerplexityDetector: Detector = {
  id: "llama-engine-perplexity",
  name: "llama-engine perplexity",
  enabled: false,
  weight: (type) => WEIGHT[type],
  run: async (ctx) => {
    // Cheap guard: skip the spawn entirely when nothing is configured.
    if (!getEngineModelPath()) return null;

    const result = await scorePerplexityViaEngine(ctx.text);
    if (!result) return null;

    const { perplexity, tokensEvaluated, modelName, timedOut } = result;
    const coverageNote = timedOut
      ? ` (partial coverage: ${tokensEvaluated} tokens scored before the time budget was reached)`
      : ` (${tokensEvaluated} tokens scored)`;
    const modelNote = modelName ? ` using ${modelName}` : "";
    return {
      name: "llama-engine perplexity",
      score: perplexityToScore(perplexity),
      detail: `Teacher-forced perplexity ${perplexity.toFixed(1)} against the bundled llama.cpp engine${modelNote}${coverageNote}. Lower perplexity (the text was more predictable to the model) suggests AI generation. Absolute values are model-specific — this signal's calibration is provisional.`,
    };
  },
};
```

- [ ] **Step 4: Register the detector**

In `src/lib/detectors/index.ts`, add the import in alphabetical position among the existing imports:

```typescript
import { llamaEnginePerplexityDetector } from "./llamaEnginePerplexity.js";
```

and add the entry to `CORE_DETECTORS`, immediately after `modelPerplexityDetector`:

```typescript
  modelPerplexityDetector,
  llamaEnginePerplexityDetector,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test
```
Expected: PASS. Existing `detectAiUsage.test.js` and `humanizeText.test.js` must still pass unchanged — the new detector is `enabled: false`, so the orchestrator filters it out before `run()` and no behavior changes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/detectors/llamaEnginePerplexity.ts src/lib/detectors/llamaEnginePerplexity.test.ts src/lib/detectors/index.ts
git commit -m "feat: add the (disabled) llama-engine perplexity detector"
```

---

### Task 6: Platform package and build script — ✅ DONE (`b196e81`)

**Files:**
- Create: `packages/win32-x64/package.json`
- Create: `packages/win32-x64/README.md`
- Create: `packages/win32-x64/.gitignore`
- Create: `native/llama-engine/build-win32-x64.ps1`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `resolveHelperPath()`'s expectation (Task 4) that `require.resolve("human-vs-ai-mcp-server-win32-x64/package.json")` resolves, with `llama-engine-helper.exe` as a sibling of that manifest.
- Produces: `npm run build:native` — stages `llama-engine-helper.exe` plus the llama.cpp DLLs into `packages/win32-x64/`.

- [ ] **Step 1: Create the platform package manifest**

Create `packages/win32-x64/package.json`. The version must match the main package's `version` exactly (`0.0.1` today) and move in lockstep with it forever after:

```json
{
  "name": "human-vs-ai-mcp-server-win32-x64",
  "version": "0.0.1",
  "description": "Prebuilt llama.cpp perplexity helper for human-vs-ai-mcp-server (Windows x64). Not intended for direct installation.",
  "os": ["win32"],
  "cpu": ["x64"],
  "files": [
    "llama-engine-helper.exe",
    "*.dll",
    "README.md"
  ],
  "exports": {
    "./package.json": "./package.json"
  },
  "license": "MIT",
  "private": false
}
```

- [ ] **Step 2: Document what the package is**

Create `packages/win32-x64/README.md`:

```markdown
# human-vs-ai-mcp-server-win32-x64

Prebuilt binaries for [`human-vs-ai-mcp-server`](https://github.com/dmongrel/human-vs-ai-mcp-server)'s
optional bundled-engine perplexity detector. **Don't install this directly** — it's an
`optionalDependency` of the main package, installed automatically on Windows x64 and skipped
everywhere else.

Contents:

- `llama-engine-helper.exe` — a one-shot teacher-forced perplexity scorer (Go, source in the
  main repo at `native/llama-engine/`).
- `llama.dll`, `ggml*.dll` — [llama.cpp](https://github.com/ggml-org/llama.cpp) CPU build,
  release `b10107`, MIT licensed.

No model is bundled. The `.gguf` model file is a separate download, supplied by the user via
`LLAMA_ENGINE_MODEL_PATH`.
```

- [ ] **Step 3: Keep built artifacts out of git**

Create `packages/win32-x64/.gitignore` — the manifest and README are committed, the binaries are build output:

```gitignore
*.exe
*.dll
```

Append to the repo-root `.gitignore` (create the file if it doesn't exist):

```gitignore
native/llama-engine/.local/
```

- [ ] **Step 4: Write the build script**

Create `native/llama-engine/build-win32-x64.ps1`:

```powershell
# Builds llama-engine-helper.exe and stages it, plus the pinned llama.cpp CPU
# runtime DLLs, into packages/win32-x64/ for publishing.
# Requires: Go 1.26+, PowerShell 5.1+. Run from the repo root via `npm run build:native`.
# Written 2026-07-25.

$ErrorActionPreference = "Stop"

# The llama.cpp release is pinned deliberately: native/llama-engine/llama.go
# depends on struct field offsets from this exact release's include/llama.h.
# Bumping it means re-verifying those offsets (see llama.go's header comment).
$LlamaRelease = "b10107"
$Asset = "llama-$LlamaRelease-bin-win-cpu-x64.zip"
$Url = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaRelease/$Asset"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Work = Join-Path $PSScriptRoot ".local"
$Dest = Join-Path $Root "packages\win32-x64"

New-Item -ItemType Directory -Force -Path $Work | Out-Null
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

$Zip = Join-Path $Work $Asset
if (-not (Test-Path $Zip)) {
    Write-Host "Downloading $Asset ..."
    Invoke-WebRequest -Uri $Url -OutFile $Zip
}

$Extract = Join-Path $Work "llama-$LlamaRelease"
if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
Expand-Archive -Path $Zip -DestinationPath $Extract -Force

Write-Host "Building llama-engine-helper.exe ..."
Push-Location $PSScriptRoot
try {
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    go build -trimpath -ldflags "-s -w" -o (Join-Path $Dest "llama-engine-helper.exe") .
    if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# The runtime DLLs must sit next to the helper: llama.go loads llama.dll from
# the executable's own directory and passes that same directory to
# ggml_backend_load_all_from_path, which is where the per-CPU ggml-cpu-*.dll
# backends are discovered.
#
# The filter is exact on llama.dll: the release also ships llama-cli-impl.dll,
# llama-bench-impl.dll and a dozen other CLI-tool DLLs we have no use for.
$Dlls = Get-ChildItem -Path $Extract -Recurse -Filter "*.dll" |
    Where-Object { $_.Name -eq "llama.dll" -or $_.Name -like "ggml*.dll" -or $_.Name -like "libomp*.dll" }
if ($Dlls.Count -eq 0) { throw "no llama/ggml DLLs found in $Extract — check the release asset layout" }
foreach ($dll in $Dlls) {
    Copy-Item -Path $dll.FullName -Destination $Dest -Force
}

Write-Host "Staged $($Dlls.Count) DLL(s) and llama-engine-helper.exe into $Dest"
```

- [ ] **Step 5: Wire the script and the optional dependency into `package.json`**

In the root `package.json`, add the build script to `scripts` (after `"build"`):

```json
    "build:native": "powershell -ExecutionPolicy Bypass -File native/llama-engine/build-win32-x64.ps1",
```

and add the platform package as an exact-pinned optional dependency, after the `dependencies` block:

```json
  "optionalDependencies": {
    "human-vs-ai-mcp-server-win32-x64": "0.0.1"
  },
```

Leave `prepublishOnly` as `npm run build` — the native build is a deliberate, separate step, not something that fires on every publish attempt.

- [ ] **Step 6: Run the build and verify the staged output**

```bash
npm run build:native
ls packages/win32-x64/
```
Expected: `llama-engine-helper.exe`, `llama.dll`, and one or more `ggml*.dll` files alongside `package.json` and `README.md`.

- [ ] **Step 7: Verify the staged helper actually runs**

```bash
echo '{"modelPath":"F:\\models\\Qwen2.5-1.5B-Instruct.Q4_K_M.gguf","text":"The quick brown fox jumps over the lazy dog. It was the best of times, it was the worst of times.","ctxSize":512,"timeoutMs":60000}' \
  | packages/win32-x64/llama-engine-helper.exe
```
Expected: one line of JSON with `"ok":true`. This is the check that the DLLs were staged correctly — the Task 3 run used `.local/`, this proves the *published* layout works.

- [ ] **Step 8: Commit**

```bash
git add packages/win32-x64/package.json packages/win32-x64/README.md packages/win32-x64/.gitignore native/llama-engine/build-win32-x64.ps1 package.json .gitignore
git commit -m "build: stage the llama-engine helper into a win32-x64 platform package"
```

---

### Task 7: Future-platforms documentation — ✅ DONE (`edf21e5`)

**Files:**
- Create: `native/llama-engine/PLATFORMS.md`

**Interfaces:** none — pure documentation deliverable, required by the spec.

- [ ] **Step 1: Write the document**

Create `native/llama-engine/PLATFORMS.md`:

```markdown
# Adding platforms to the llama-engine helper

Only **Windows x64** is built today (`packages/win32-x64`, staged by
`build-win32-x64.ps1`). This is what a future implementer needs to know to add another.

## What a new platform costs

Each platform needs its own npm package — `human-vs-ai-mcp-server-<platform>-<arch>`, matching
`process.platform`/`process.arch`, since that is what `resolveHelperPath()` in
`src/lib/llamaEngine.ts` builds its `require.resolve` target from. Adding a platform means:
a new `packages/<platform>-<arch>/` directory, an entry in the main package's
`optionalDependencies`, a build script, and a CI job. **No change to the resolution code.**

The binary is named `llama-engine-helper` on non-Windows platforms (no `.exe`) — that branch
already exists in `resolveHelperPath()`.

## Cross-cutting requirements, whichever platform you add

- **The ABI assumption is Windows-specific.** `llama.go`'s core trick — passing struct-by-value
  arguments as plain pointers — works because the Microsoft x64 calling convention passes
  large structs by reference. The **System V AMD64 and AArch64 ABIs do not**: they pass
  structs in registers by field. purego *does* support struct-by-value on darwin and linux
  (amd64 and arm64), so on those platforms declare the parameters as real Go structs instead.
  Expect `llama.go` to need a per-GOOS split, not a recompile. Budget real time for this.
- **Pin the llama.cpp release per platform in one documented place.** Today that's
  `$LlamaRelease` in `build-win32-x64.ps1`, and it is load-bearing: `llama.go`'s struct field
  offsets are read from that exact release's `include/llama.h`. Bump it deliberately, for all
  platforms at once, and re-verify the offsets each time.
- **The Go↔TS JSON contract must not drift.** Engine version bumps and new platforms are both
  invisible to `src/lib/llamaEngine.ts` by design. Keep it that way.
- **Add a CI matrix job that actually runs the built helper** against a small fixture model and
  a paragraph of text, asserting valid JSON with `"ok":true`. Cross-compiling Go is trivial and
  proves nothing — only a real run on real hardware shows the llama.cpp binaries work on that
  target.
- **Confirm licensing before shipping compiled binaries.** llama.cpp is MIT, so this is expected
  to be a non-issue, but the compiled DLL/dylib/so is redistribution and should be stated
  explicitly, with llama.cpp's LICENSE included in each platform package.

## Windows ARM64 — easiest next step

Go and purego both cross-compile to `windows/arm64` with no C toolchain, and the struct-pointer
ABI trick holds (ARM64 Windows uses the same by-reference rule for large structs). The only real
work is sourcing `libllama` for win-arm64: llama.cpp's GitHub Releases already publish
`bin-win-arm64` artifacts, so the build script only needs a different asset name. Building it
yourself instead would require an ARM64 Windows toolchain or runner.

Package: `human-vs-ai-mcp-server-win32-arm64`.

## macOS arm64 (Apple Silicon)

llama.cpp has a Metal backend worth using here, which means **building on a real arm64 Mac**
(GitHub Actions `macos-14` or newer), not cross-compiling.

**Code signing is the real gotcha.** An unsigned `.dylib` downloaded via npm and `dlopen`'d at
runtime can be quarantined or outright blocked by Gatekeeper. Ad-hoc signing
(`codesign --sign - libllama.dylib`) during the build is the minimum; full notarization removes
the user-facing warning but adds an Apple Developer account to the release pipeline.

Also note purego uses `purego.Dlopen` here rather than `syscall.LoadLibrary` — the loader branch
in `llama.go` is Windows-only today.

Package: `human-vs-ai-mcp-server-darwin-arm64`.

## macOS x64 (Intel)

Same Gatekeeper concern as arm64. Build on an Intel runner (`macos-13`) rather than
cross-compiling via osxcross. Follow Node's own convention of **separate per-arch packages**
(`darwin-x64` / `darwin-arm64`) rather than a universal binary — `resolveHelperPath()` keys off
`process.arch`, so a universal binary would need resolution changes for no benefit.

Package: `human-vs-ai-mcp-server-darwin-x64`.

## Linux x64

Easiest to build (any `ubuntu-latest` runner), CPU inference on an AVX2 baseline.

**glibc versioning bites here.** Build against an older baseline — `ubuntu-20.04` or a
manylinux-style container — rather than the newest available runner, or users on older distros
get `GLIBC_2.3x not found` at load time. Set an `$ORIGIN`-relative rpath on the helper
(`-Wl,-rpath,$ORIGIN`) so `libllama.so` resolves from alongside the binary without the user
setting `LD_LIBRARY_PATH`.

musl/Alpine is deliberately deferred unless a real need appears — it needs a separate build and
a separate package.

Package: `human-vs-ai-mcp-server-linux-x64`.
```

- [ ] **Step 2: Commit**

```bash
git add native/llama-engine/PLATFORMS.md
git commit -m "docs: guidance for adding llama-engine platforms beyond win32-x64"
```

---

### Task 8: User-facing documentation — ✅ DONE (`98345c1`)

**Files:**
- Modify: `README.md`
- Modify: `TOOLS.md`
- Modify: `src/context.ts`
- Modify: `CLAUDE.md`
- Modify: `example-mcp.json`

**Interfaces:** none — documentation must match the env var names and behavior from Tasks 4-6 exactly.

- [ ] **Step 1: Add the README section**

In `README.md`, add a new `## Bundled engine perplexity (currently disabled)` section immediately **after** the existing `## Model runner (currently disabled)` section, and add it to the Table of Contents. Content:

````markdown
## Bundled engine perplexity (currently disabled)

A second, independent perplexity signal — this one measuring perplexity properly. Where the
model-runner path above asks a chat model to echo text back and reads logprobs off its own
generation (which greedy decoding makes meaningless), this path does **teacher-forced**
scoring: the actual text is fed through the model and the model's probability for each *real*
next token is read directly. No generation step, so none of the structural bias. This is the
same technique llama.cpp's own `llama-perplexity` CLI uses.

**It's implemented but disabled by default** (`enabled: false` in
`src/lib/detectors/llamaEnginePerplexity.ts`) — not because the technique is broken, but
because the perplexity→score mapping hasn't been calibrated against real human and AI text
yet. Perplexity values are model-specific and don't transfer between models, so the anchors in
that file are provisional placeholders.

### How it works

A small Go helper (`native/llama-engine/`, shipped prebuilt) loads llama.cpp's engine
(`llama.dll`) directly via [purego](https://github.com/ebitengine/purego) — no cgo, no HTTP
server, no separate installation. It runs as a one-shot subprocess: the server spawns it,
writes one JSON request to its stdin, reads one JSON response from its stdout, and it exits.
Nothing is left running.

The engine ships inside the package (as an `optionalDependency` installed only on matching
platforms). **The model does not** — you supply your own `.gguf` file. GGUF is required;
llama.cpp cannot read safetensors, and converting a model yourself is out of scope here.
Community GGUF quantizations exist on Hugging Face for most popular models.

### Configuration

| Variable | Required | Default | Notes |
|---|---|---|---|
| `LLAMA_ENGINE_MODEL_PATH` | yes | — | Absolute path to a `.gguf` model file. Unset means the detector does nothing at zero cost. |
| `LLAMA_ENGINE_CTX_SIZE` | no | `2048` | Token window the text is split into. Larger windows score more context per pass but cost more memory and time. |
| `LLAMA_ENGINE_TIMEOUT_MS` | no | `60000` | Overall time budget. On expiry the helper returns whatever chunks completed rather than failing. |
| `LLAMA_ENGINE_HELPER_PATH` | no | resolved from the platform package | Development override pointing at a locally built helper binary. |

Setting these is not sufficient on its own — the detector is disabled in code. See below.

### Platform support

Windows x64 only for now. On any other platform the optional dependency isn't installed and
the detector stays silent. See `native/llama-engine/PLATFORMS.md` for what adding a platform
involves.

### If you want to enable it

1. Build the native helper: `npm run build:native` (needs Go 1.26+ and PowerShell; downloads
   the pinned llama.cpp release).
2. Point `LLAMA_ENGINE_MODEL_PATH` at a `.gguf` model and `LLAMA_ENGINE_HELPER_PATH` at
   `packages/win32-x64/llama-engine-helper.exe`.
3. Score a corpus of known-human and known-AI prose, and replace
   `PERPLEXITY_AI_LIKE_ANCHOR`/`PERPLEXITY_HUMAN_LIKE_ANCHOR` in
   `src/lib/detectors/llamaEnginePerplexity.ts` with what you measure — recording which model
   they came from, since they don't transfer.
4. Flip `enabled` to `true` in that same file.
````

- [ ] **Step 2: Update `TOOLS.md`**

In `TOOLS.md`'s `## detect_ai_usage` **Signals** paragraph, the sentence currently reading
"A 9th signal — a real perplexity check against a local model via `MODEL_RUNNER_URL` — is implemented but **currently disabled**..."
becomes:

```markdown
Two further signals are implemented but **currently disabled**: a perplexity check against a local model runner via `MODEL_RUNNER_URL` (`enabled: false` in `src/lib/detectors/modelPerplexity.ts` — see [Model runner (currently disabled)](./README.md#model-runner-currently-disabled) in the README for why it was abandoned), and a teacher-forced perplexity check against a bundled llama.cpp engine via `LLAMA_ENGINE_MODEL_PATH` (`enabled: false` in `src/lib/detectors/llamaEnginePerplexity.ts` — technique sound, calibration pending; see [Bundled engine perplexity (currently disabled)](./README.md#bundled-engine-perplexity-currently-disabled)).
```

Check the rest of that paragraph for any other "9th"/detector-count phrasing and make it consistent — there are now 8 enabled signals and 2 disabled ones.

- [ ] **Step 3: Update `src/context.ts`**

In the `CONTEXT` entry containing "A 9th, model-runner-based perplexity signal exists in the code but is currently disabled...", replace that parenthetical with:

```
(Two model-perplexity signals exist in the code but are currently disabled: a model-runner-based one, disabled after investigation found the technique unreliable, and a bundled llama.cpp-engine one that does proper teacher-forced scoring but whose score calibration is still provisional — see README.md's "Model runner (currently disabled)" and "Bundled engine perplexity (currently disabled)" sections.)
```

- [ ] **Step 4: Update `example-mcp.json`**

Add a new server entry alongside the existing `human-vs-ai-mcp-server-with-model-runner` one, following whatever shape that entry already uses:

```json
    "human-vs-ai-mcp-server-with-llama-engine": {
      "command": "node",
      "args": ["G:/_MCP/human-vs-ai-mcp-server/dist/index.js"],
      "env": {
        "LLAMA_ENGINE_MODEL_PATH": "F:/models/Qwen2.5-1.5B-Instruct.Q4_K_M.gguf",
        "LLAMA_ENGINE_CTX_SIZE": "2048",
        "LLAMA_ENGINE_TIMEOUT_MS": "60000"
      }
    }
```

Match the existing entry's `command`/`args` style rather than copying the above verbatim if it differs.

- [ ] **Step 5: Update `CLAUDE.md`**

In the `## Architecture` list, add two entries after the `src/lib/modelRunner.ts` one:

```markdown
- `src/lib/detectors/llamaEnginePerplexity.ts` — the bundled-engine perplexity detector, calls `scorePerplexityViaEngine` from `../llamaEngine.js`. **Disabled via `enabled: false`**, but for a different reason than `modelPerplexity.ts`: the technique here is sound (real teacher-forced scoring, no generation step, no greedy-decoding bias), only the perplexity→score anchors are uncalibrated. Enabling it requires measuring anchors against a known corpus with a specific model and recording which model they came from — see README.md's "Bundled engine perplexity (currently disabled)".
- `src/lib/llamaEngine.ts` — client for the bundled llama.cpp-engine helper. Spawns `llama-engine-helper.exe` as a one-shot subprocess (JSON request on stdin, one JSON response line on stdout), enforces `LLAMA_ENGINE_TIMEOUT_MS`, and fails open to `null` on any spawn/exit/parse/shape error — same convention as `modelRunner.ts` and `checkUpdate.ts`. Activated by `LLAMA_ENGINE_MODEL_PATH` (plus optional `LLAMA_ENGINE_CTX_SIZE`, `LLAMA_ENGINE_TIMEOUT_MS`, and `LLAMA_ENGINE_HELPER_PATH` for local development). Resolves the helper from the `human-vs-ai-mcp-server-<platform>-<arch>` optional dependency, so adding platforms needs no code change here. Go source lives in `native/llama-engine/` — see that directory and `PLATFORMS.md`.
```

In `## Conventions`, add:

```markdown
- The bundled llama.cpp engine (`native/llama-engine/`) pins llama.cpp release **`b10107`** in `build-win32-x64.ps1`. This is load-bearing, not incidental: `llama.go` reads struct field offsets from that exact release's `include/llama.h`, and it passes struct-by-value arguments as raw pointers, which is valid only under the Microsoft x64 calling convention. Bumping the release means re-verifying the offsets; adding a non-Windows platform means revisiting the ABI approach entirely (see `native/llama-engine/PLATFORMS.md`).
- Prebuilt native binaries ship in per-platform npm packages under `packages/`, referenced from `optionalDependencies` at an exact version. These are first-party and don't count against the minimal-npm-dependencies convention, which is about third-party supply-chain risk. Go module dependencies (`purego`) likewise aren't npm dependencies.
```

- [ ] **Step 6: Verify the docs build and tests still pass**

```bash
npm run build && npm test
```
Expected: clean build, all tests pass.

- [ ] **Step 7: Commit**

```bash
git add README.md TOOLS.md src/context.ts CLAUDE.md example-mcp.json
git commit -m "docs: document the bundled llama-engine perplexity detector"
```

---

### Task 9: End-to-end verification and calibration handoff — ✅ DONE (`70ef365`), awaiting user decision on anchors

This task produces no shipped behavior change — it produces the evidence needed to decide whether the detector can ever be enabled, plus a written record of the measurements.

**Files:**
- Create: `docs/superpowers/notes/2026-07-25-llama-engine-calibration.md`

- [ ] **Step 1: Score the example fixtures**

With the helper built (Task 6) and the fixture model in place, score each of the three `examples/*.md` files:

```bash
node -e "const fs=require('fs');const {scorePerplexityViaEngine}=require('./dist/lib/llamaEngine.js');(async()=>{for(const f of fs.readdirSync('examples')){const t=fs.readFileSync('examples/'+f,'utf8');const r=await scorePerplexityViaEngine(t);console.error(f, JSON.stringify(r&&{perplexity:r.perplexity,tokens:r.tokensEvaluated,timedOut:r.timedOut}));}})()"
```

Run it with `LLAMA_ENGINE_MODEL_PATH` and `LLAMA_ENGINE_HELPER_PATH` set. Record each file's perplexity, token count, and wall-clock time.

- [ ] **Step 2: Score AI-generated counterparts**

Produce three comparable AI-written passages of similar length and genre to the `examples/` fixtures (any capable model; note which one). Score them the same way and record the results.

- [ ] **Step 3: Check that the signal actually discriminates**

The pass condition is the one the HTTP path failed: **the human and AI groups must separate.** Concretely, the lowest human perplexity should exceed the highest AI perplexity, or at minimum the group means should differ by a clear margin rather than clustering.

If the groups don't separate — or if every input returns a near-identical value the way the verbatim-echo technique did — **stop and report to the user**. Do not tune the anchors to manufacture a separation that isn't in the data. The correct outcome in that case is a documented negative result, exactly like the existing README section.

- [ ] **Step 4: Write the calibration note**

Create `docs/superpowers/notes/2026-07-25-llama-engine-calibration.md` recording: the model used and its quantization, each sample's perplexity/token count/wall-clock time, the human-vs-AI separation (or lack of it), the anchor values the data supports, and an explicit recommendation on whether `enabled` should be flipped.

- [ ] **Step 5: Report to the user before changing any anchors**

Present the measurements and the recommendation. **Do not flip `enabled: true` or replace the provisional anchors without the user's explicit go-ahead** — enabling a detector changes every `detect_ai_usage` score, and the project's convention is that both perplexity detectors stay off until proven.

- [ ] **Step 6: Commit the note**

```bash
git add docs/superpowers/notes/2026-07-25-llama-engine-calibration.md
git commit -m "docs: record llama-engine perplexity calibration measurements"
```

---

## Bug found during execution

`DecodeChunk` needed `llama_memory_clear` between chunks. Every chunk restarts at position 0,
so a stale KV cache made `llama_decode` fail for every chunk after the first — those chunks were
skipped and the helper still returned `ok: true`, silently scoring only a document's first
`ctxSize` tokens. Fixed in `70ef365`, guarded by `TestEngineScoresEveryChunk`. Worth remembering
that the failure mode was a *plausible-looking success*, not an error.

## Deferred / out of scope

Carried forward from the spec, deliberately not addressed by any task above:

- **Surfacing per-chunk detail** (`chunks[]`) anywhere user-facing, e.g. a `humanizeText.ts` recommendation naming the most-predictable passage. The data is returned and parsed; nothing consumes it yet.
- **Sliding-window/stride scoring** (`llama-perplexity`'s `--ppl-stride`). Non-overlapping windows only.
- **GPU offload.** The Windows CPU build is what ships; `n_gpu_layers` is hardcoded to 0.
- **safetensors→GGUF conversion.** Users supply a `.gguf`.
- **Platforms beyond win32-x64.** Documented in `PLATFORMS.md`, not built.
- **CI wiring** for the Go build and the run-the-helper matrix job. `PLATFORMS.md` specifies what the job must do; no CI config exists in this repo yet to add it to.
