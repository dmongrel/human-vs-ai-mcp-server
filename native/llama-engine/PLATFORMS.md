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

## The hard part: `llama.go` is Windows-specific in two ways

Neither is obvious from reading it, and both will break silently or confusingly elsewhere.

### 1. The struct-by-value ABI trick

purego **cannot pass or return C structs by value on `windows/amd64`** — it only supports
`SyscallN`/`NewCallback` there. `llama_decode`, `llama_batch_init`, `llama_batch_free`,
`llama_model_load_from_file` and `llama_init_from_model` all take or return structs by value.

`llama.go` works around this by declaring those parameters as plain `uintptr` pointers, which
is valid **only** under the Microsoft x64 calling convention: a struct whose size is not
1/2/4/8 bytes is passed as a pointer to a caller-allocated copy, and returned through a hidden
pointer passed as the first argument.

**The System V AMD64 and AArch64 ABIs do not work this way** — they pass structs in registers,
field by field. The good news is that purego *does* support real struct-by-value on darwin and
linux (both amd64 and arm64), so on those platforms you declare the parameters as actual Go
structs mirroring `llama_batch` / `llama_model_params` / `llama_context_params`. That means
mirroring those structs *completely and correctly*, not just the first few fields.

Expect `llama.go` to need a per-GOOS split (`llama_windows.go` / `llama_unix.go`), not a
recompile. Budget real time for this — it is the single largest piece of work in adding a
platform.

### 2. Library loading and backend discovery

Two separate mechanisms, both currently Windows-shaped:

- **Loading `llama.dll`** uses `LoadLibraryExW` with `LOAD_WITH_ALTERED_SEARCH_PATH`, because
  plain `LoadLibrary` will not resolve `llama.dll`'s own `ggml.dll` dependency from the
  directory the DLL lives in. On POSIX this becomes `purego.Dlopen` plus a correct rpath (see
  Linux below).
- **Finding the compute backends** is a distinct problem. ggml's actual compute kernels are
  *separate* shared libraries (`ggml-cpu-*.dll`, one per CPU feature level), discovered at
  runtime. Left alone, ggml scans the running executable's directory — right in the shipped
  layout, wrong anywhere else. `loadLib` therefore calls `ggml_backend_load_all_from_path`
  explicitly with the resolved library directory. **That symbol is exported from `ggml.dll`,
  not `ggml-base.dll`.** Without this call, model loading fails with a bare "model load
  failed" and no further explanation. Whatever platform you add, keep this explicit call.

`LLAMA_ENGINE_LIB_DIR` overrides the library directory. It exists for development and for
`go test` (which runs the test binary from a temp directory) and is deliberately undocumented
in the README — it is not part of the shipped configuration surface.

## Cross-cutting requirements, whichever platform you add

- **Pin the llama.cpp release per platform in one documented place.** Today that's
  `$LlamaRelease` in `build-win32-x64.ps1`, and it is load-bearing: `llama.go`'s struct field
  offsets are read from that exact release's `include/llama.h`. Bump it deliberately, for all
  platforms at once, and re-verify the offsets each time. The cheap verification is the one the
  original spike used: dump the first 32 bytes of `llama_context_default_params` and check them
  against the documented defaults (`n_ctx` 512, `n_batch` 2048, `n_ubatch` 512, `n_seq_max` 1).
  Garbage there means the offsets moved.
- **The Go↔TS JSON contract must not drift.** Engine version bumps and new platforms are both
  invisible to `src/lib/llamaEngine.ts` by design. Keep it that way.
- **Add a CI matrix job that actually runs the built helper** against a small fixture model and
  a paragraph of text, asserting valid JSON with `"ok":true`. Cross-compiling Go is trivial and
  proves nothing — only a real run on real hardware shows the llama.cpp binaries work on that
  target. A useful stronger assertion: score two texts of very different predictability and
  check the perplexities differ by an order of magnitude. That catches a silently broken
  binding, which a single "did it return JSON" check does not.
- **Ship llama.cpp's LICENSE with the binaries.** It is MIT, so there is no copyleft obligation,
  but redistributing compiled DLLs/dylibs/sos does require carrying the notice. The release
  zips don't contain one; `build-win32-x64.ps1` fetches it from the pinned tag.

## Windows ARM64 — easiest next step

Go and purego both cross-compile to `windows/arm64` with no C toolchain, and the struct-pointer
ABI trick holds (ARM64 Windows uses the same by-reference rule for large structs), so
`llama.go` needs no changes. The only real work is sourcing `libllama` for win-arm64:
llama.cpp's GitHub Releases already publish `bin-win-arm64` artifacts, so the build script only
needs a different asset name. Building it yourself instead would require an ARM64 Windows
toolchain or runner.

Package: `human-vs-ai-mcp-server-win32-arm64`.

## macOS arm64 (Apple Silicon)

llama.cpp has a Metal backend worth using here, which means **building on a real arm64 Mac**
(GitHub Actions `macos-14` or newer), not cross-compiling. Note that a GPU backend changes the
`n_gpu_layers` decision: `llama.go` currently hardcodes 0 for the CPU-only build.

**Code signing is the real gotcha.** An unsigned `.dylib` downloaded via npm and `dlopen`'d at
runtime can be quarantined or outright blocked by Gatekeeper. Ad-hoc signing
(`codesign --sign - libllama.dylib`) during the build is the minimum; full notarization removes
the user-facing warning but adds an Apple Developer account to the release pipeline.

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
setting `LD_LIBRARY_PATH` — this is the POSIX equivalent of the `LOAD_WITH_ALTERED_SEARCH_PATH`
problem described above.

musl/Alpine is deliberately deferred unless a real need appears — it needs a separate build and
a separate package.

Package: `human-vs-ai-mcp-server-linux-x64`.
