// purego binding to llama.cpp's libllama (Windows x64, pinned release b10107).
//
// ABI NOTE: purego cannot pass or return C structs by value on windows/amd64.
// It doesn't have to. Under the Microsoft x64 calling convention a struct whose
// size is not 1/2/4/8 bytes is passed as a pointer to a caller-allocated copy,
// and returned through a hidden pointer passed as the *first* argument. Every
// struct here (llama_model_params, llama_context_params, llama_batch) is far
// larger than 8 bytes, so declaring those parameters as plain uintptr pointers
// reproduces the ABI exactly. This is why the llama.cpp release is pinned:
// the field offsets below are read from that release's include/llama.h, and
// llama.cpp reorders these structs between releases.
//
// Offsets verified against
// https://raw.githubusercontent.com/ggml-org/llama.cpp/b10107/include/llama.h:
//
//	llama_model_params:                     llama_context_params:
//	  0  devices               (ptr)          0  n_ctx           uint32
//	  8  tensor_buft_overrides (ptr)          4  n_batch         uint32
//	 16  n_gpu_layers          int32          8  n_ubatch        uint32
//	                                         12  n_seq_max       uint32
//	llama_batch (56 bytes, 8-byte aligned):  16  n_rs_seq        uint32
//	  0  n_tokens              int32         20  n_outputs_max   uint32
//	  8  token                 *int32        24  n_threads       int32
//	 16  embd                  *float32      28  n_threads_batch int32
//	 24  pos                   *int32
//	 32  n_seq_id              *int32
//	 40  seq_id                **int32
//	 48  logits                *int8

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

	offCtxNCtx        = 0
	offCtxNBatch      = 4
	offCtxNUbatch     = 8
	offCtxNSeqMax     = 12
	offCtxNOutputsMax = 20
)

// Params structs are read into an over-allocated, zeroed buffer: we only ever
// patch fields at known offsets near the front, so the exact total size never
// has to be known (and can grow between llama.cpp releases without breaking).
const paramsBufSize = 1024

// llamaBatch mirrors struct llama_batch. Only read/written through a pointer
// filled in by llama_batch_init — never constructed on the Go side.
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

	ggmlBackendLoadAllFromPath func(dirPath string)
)

var libLoaded bool

var (
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	procLoadLibraryExW = kernel32.NewProc("LoadLibraryExW")
)

// LOAD_WITH_ALTERED_SEARCH_PATH makes Windows resolve the DLL's *own*
// dependencies from the directory it was loaded from. llama.dll needs
// ggml.dll and friends, and plain LoadLibrary would look for those in the
// process's directory and PATH instead -- which fails whenever the engine
// lives anywhere other than beside the running executable (notably under
// `go test`). Requires an absolute path.
const loadWithAlteredSearchPath = 0x00000008

func loadLibraryFrom(path string) (uintptr, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return 0, fmt.Errorf("resolving %s: %w", path, err)
	}
	wide, err := syscall.UTF16PtrFromString(abs)
	if err != nil {
		return 0, fmt.Errorf("encoding %s: %w", abs, err)
	}
	handle, _, callErr := procLoadLibraryExW.Call(uintptr(unsafe.Pointer(wide)), 0, loadWithAlteredSearchPath)
	if handle == 0 {
		return 0, fmt.Errorf("loading %s: %w", abs, callErr)
	}
	return handle, nil
}

// loadLib loads llama.dll from the helper executable's own directory. The
// dependent ggml*.dll files ship alongside it and resolve via Windows' normal
// search order (the application directory is searched first).
//
// LLAMA_ENGINE_LIB_DIR overrides that directory. It exists for development and
// for `go test`, which builds the test binary into a temp directory where no
// DLLs live — it is not part of the shipped configuration surface.
func loadLib() error {
	if libLoaded {
		return nil
	}
	libDir := os.Getenv("LLAMA_ENGINE_LIB_DIR")
	if libDir == "" {
		exe, err := os.Executable()
		if err != nil {
			return fmt.Errorf("locating executable: %w", err)
		}
		libDir = filepath.Dir(exe)
	}
	lib, err := loadLibraryFrom(filepath.Join(libDir, "llama.dll"))
	if err != nil {
		return err
	}

	// ggml's compute backends are themselves separate DLLs (ggml-cpu-*.dll,
	// one per CPU feature level) discovered at runtime. Left to itself ggml
	// scans the running executable's directory, which is right in the shipped
	// layout but wrong anywhere else -- notably under `go test`. Pointing it
	// at libDir explicitly makes the engine work wherever it is staged. Without
	// this, model loading fails with "no backends are loaded".
	ggml, err := loadLibraryFrom(filepath.Join(libDir, "ggml.dll"))
	if err != nil {
		return err
	}
	purego.RegisterLibFunc(&ggmlBackendLoadAllFromPath, ggml, "ggml_backend_load_all_from_path")
	ggmlBackendLoadAllFromPath(libDir)

	purego.RegisterLibFunc(&llamaBackendInit, lib, "llama_backend_init")
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
