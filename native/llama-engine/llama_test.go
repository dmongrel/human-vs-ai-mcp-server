package main

import (
	"os"
	"strings"
	"testing"
)

// Requires a real .gguf; skipped in CI and in any checkout without one.
// Also needs LLAMA_ENGINE_LIB_DIR pointing at the staged llama.cpp DLLs --
// `go test` runs from a temp directory, so the usual next-to-the-executable
// lookup finds nothing. Run it as:
//
//	LLAMA_ENGINE_LIB_DIR=.local LLAMA_ENGINE_TEST_MODEL=<path.gguf> go test -v ./...
func TestEngineSmoke(t *testing.T) {
	modelPath := os.Getenv("LLAMA_ENGINE_TEST_MODEL")
	if modelPath == "" {
		t.Skip("LLAMA_ENGINE_TEST_MODEL not set")
	}
	if os.Getenv("LLAMA_ENGINE_LIB_DIR") == "" {
		t.Skip("LLAMA_ENGINE_LIB_DIR not set (needs the staged llama.cpp DLLs)")
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

// Regression test: every chunk restarts at position 0, so the KV cache has to
// be cleared between decodes. Without that, the second and later chunks fail
// with "failed to initialize batch" and get skipped -- which looks like
// success, but silently scores only the first ctxSize tokens of the document.
func TestEngineScoresEveryChunk(t *testing.T) {
	modelPath := os.Getenv("LLAMA_ENGINE_TEST_MODEL")
	if modelPath == "" {
		t.Skip("LLAMA_ENGINE_TEST_MODEL not set")
	}
	if os.Getenv("LLAMA_ENGINE_LIB_DIR") == "" {
		t.Skip("LLAMA_ENGINE_LIB_DIR not set (needs the staged llama.cpp DLLs)")
	}

	const ctxSize = 64
	eng, err := Open(modelPath, ctxSize)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer eng.Close()

	tokens, err := eng.Tokenize(strings.Repeat("The archive was quiet that morning, and the lamps had not yet been lit. ", 40), true)
	if err != nil {
		t.Fatalf("Tokenize: %v", err)
	}
	chunks := SplitChunks(tokens, ctxSize)
	if len(chunks) < 3 {
		t.Fatalf("test needs several chunks to be meaningful, got %d", len(chunks))
	}

	for i, chunk := range chunks {
		at, err := eng.DecodeChunk(chunk)
		if err != nil {
			t.Fatalf("chunk %d of %d failed to decode: %v", i+1, len(chunks), err)
		}
		if _, _, err := ChunkPerplexity(chunk, at); err != nil {
			t.Fatalf("chunk %d of %d failed to score: %v", i+1, len(chunks), err)
		}
	}
}
