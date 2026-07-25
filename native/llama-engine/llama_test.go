package main

import (
	"os"
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
