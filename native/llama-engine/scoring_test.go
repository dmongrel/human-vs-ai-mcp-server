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

func TestChunkPerplexityPunishesConfidentWrongPredictions(t *testing.T) {
	// Mirror image: the model is certain of token 1 and token 0 is what
	// actually comes next, so perplexity must be far above the uniform
	// baseline. This is the direction that makes the signal discriminating.
	tokens := []int32{0, 0, 0, 0}
	at := func(pos int) []float32 { return []float32{0, 10} }

	ppl, _, err := ChunkPerplexity(tokens, at)
	if err != nil {
		t.Fatalf("ChunkPerplexity: %v", err)
	}
	if ppl <= 100 {
		t.Fatalf("expected a large perplexity for confident wrong predictions, got %v", ppl)
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

func TestChunkPerplexityReadsLogitsFromThePrecedingPosition(t *testing.T) {
	// Teacher forcing means position i's logits predict token i+1. If the
	// off-by-one slipped -- reading position i to score token i -- this
	// asymmetric setup would score 1.0 instead of a large value.
	tokens := []int32{0, 1}
	at := func(pos int) []float32 {
		if pos == 0 {
			return []float32{10, 0} // confident the next token is 0; it is actually 1
		}
		return []float32{0, 10} // would be a perfect prediction, must not be used
	}

	ppl, scored, err := ChunkPerplexity(tokens, at)
	if err != nil {
		t.Fatalf("ChunkPerplexity: %v", err)
	}
	if scored != 1 {
		t.Fatalf("expected 1 scored position, got %d", scored)
	}
	if ppl < 100 {
		t.Fatalf("expected the position-0 logits to be used (large perplexity), got %v", ppl)
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
	if got >= 55 {
		t.Fatalf("expected the weighted result to sit below the plain mean of 55, got %v", got)
	}
}

func TestWeightedPerplexityHandlesNoChunks(t *testing.T) {
	got, total := WeightedPerplexity(nil)
	if total != 0 || got != 0 {
		t.Fatalf("expected zero values for no chunks, got %v/%d", got, total)
	}
}
