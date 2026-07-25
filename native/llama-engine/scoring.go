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
// The JSON field names are part of the helper's wire contract.
type ChunkResult struct {
	Tokens     int     `json:"tokens"`
	Perplexity float64 `json:"perplexity"`
}

// SplitChunks cuts the token stream into non-overlapping context-sized chunks.
// No sliding window / stride: there's no generation step here to make the extra
// passes worthwhile. A trailing chunk of fewer than two tokens is dropped -- a
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
// scored positions (one fewer than the token count -- the last token has no
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
// log space -- which is where perplexity is additive. A plain mean would be
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
