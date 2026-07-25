// llama-engine-helper: one-shot teacher-forced perplexity scorer.
//
// Reads one JSON request from stdin, writes exactly one single-line JSON
// response to stdout, exits 0 on success and 1 on failure -- with a JSON object
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
		fmt.Fprint(w, `{"ok":false,"error":"failed to encode error"}`+"\n")
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
