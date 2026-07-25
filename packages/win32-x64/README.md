# human-vs-ai-mcp-server-win32-x64

Prebuilt binaries for [`human-vs-ai-mcp-server`](https://github.com/dmongrel/human-vs-ai-mcp-server)'s
optional bundled-engine perplexity detector. **Don't install this directly** — it's an
`optionalDependency` of the main package, installed automatically on Windows x64 and skipped
everywhere else.

Contents:

- `llama-engine-helper.exe` — a one-shot teacher-forced perplexity scorer (Go, source in the
  main repo at `native/llama-engine/`).
- `llama.dll`, `ggml*.dll`, `libomp*.dll` — [llama.cpp](https://github.com/ggml-org/llama.cpp)
  CPU build, release `b10107`, MIT licensed. The `ggml-cpu-*.dll` files are per-CPU-feature
  backend variants; the engine picks the right one at runtime, so they all need to be present.

No model is bundled. The `.gguf` model file is a separate download, supplied by the user via
`LLAMA_ENGINE_MODEL_PATH`.
