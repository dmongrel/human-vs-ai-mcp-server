// TEMPORARY spike entry point — replaced entirely in Task 3 by the real
// stdin/stdout JSON contract. It exists only to verify the windows/amd64
// struct-by-value ABI workaround described in llama.go's header comment
// before any other code is built on top of it.

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
