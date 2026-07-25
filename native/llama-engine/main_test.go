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

func TestParseRequestClampsAnOversizedContext(t *testing.T) {
	req, err := parseRequest(strings.NewReader(`{"modelPath":"m.gguf","text":"hello","ctxSize":1000000}`))
	if err != nil {
		t.Fatalf("parseRequest: %v", err)
	}
	if req.CtxSize != maxCtxSize {
		t.Fatalf("expected ctxSize to clamp to %d, got %d", maxCtxSize, req.CtxSize)
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
	if _, present := first["perplexity"]; !present {
		t.Fatalf("chunk entries must carry a perplexity field, got %v", first)
	}
}
