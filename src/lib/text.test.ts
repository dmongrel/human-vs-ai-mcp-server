import assert from "node:assert/strict";
import { test } from "node:test";

import { clamp, countSyllables, mean, splitParagraphs, splitSentences, stdev, stripMarkdownMarkup, tokenizeWords } from "./text.js";

test("splitSentences splits on terminal punctuation followed by a capital/quote", () => {
  const result = splitSentences("This is one. This is two! Is this three? Yes.");
  assert.deepEqual(result, ["This is one.", "This is two!", "Is this three?", "Yes."]);
});

test("splitSentences collapses internal whitespace", () => {
  const result = splitSentences("Line one.\n\nLine   two.");
  assert.deepEqual(result, ["Line one.", "Line two."]);
});

test("splitParagraphs splits on blank lines and trims", () => {
  const result = splitParagraphs("Para one.\n\n  Para two.  \n\n\nPara three.");
  assert.deepEqual(result, ["Para one.", "Para two.", "Para three."]);
});

test("stripMarkdownMarkup removes '*', '_', and '#' only", () => {
  assert.equal(stripMarkdownMarkup("# Header\n**bold** text\n_italic_ and __also bold__\n- bullet"), " Header\nbold text\nitalic and also bold\n- bullet");
});

test("stripMarkdownMarkup leaves text with none unchanged", () => {
  assert.equal(stripMarkdownMarkup("Plain prose, no markup here."), "Plain prose, no markup here.");
});

test("tokenizeWords lowercases and strips punctuation", () => {
  assert.deepEqual(tokenizeWords("Hello, WORLD! It's fine."), ["hello", "world", "it's", "fine"]);
});

test("tokenizeWords keeps decimal numbers as one token", () => {
  // Splitting "11.9" into "11" and "9" inflates word counts and manufactures
  // phantom trigrams ("11 9 light") that look like repetition but aren't.
  assert.deepEqual(tokenizeWords("11.9 light years away"), ["11.9", "light", "years", "away"]);
});

test("tokenizeWords keeps thousands separators as one token", () => {
  assert.deepEqual(tokenizeWords("It cost 1,000 credits"), ["it", "cost", "1,000", "credits"]);
  assert.deepEqual(tokenizeWords("about 1,250,000.75 total"), ["about", "1,250,000.75", "total"]);
});

test("tokenizeWords does not merge across a sentence boundary", () => {
  // The separator only counts between digits, so a full stop still ends a word.
  assert.deepEqual(tokenizeWords("It ended. The next day"), ["it", "ended", "the", "next", "day"]);
  assert.deepEqual(tokenizeWords("chapter 9. Then it stopped"), ["chapter", "9", "then", "it", "stopped"]);
});

test("tokenizeWords handles a trailing separator and dotted versions", () => {
  assert.deepEqual(tokenizeWords("9, then 3.5.2 shipped"), ["9", "then", "3.5.2", "shipped"]);
});

test("tokenizeWords returns empty array for no words", () => {
  assert.deepEqual(tokenizeWords("... !! ??"), []);
});

test("mean of empty array is 0", () => {
  assert.equal(mean([]), 0);
});

test("mean computes average", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
});

test("stdev of fewer than 2 values is 0", () => {
  assert.equal(stdev([5]), 0);
  assert.equal(stdev([]), 0);
});

test("stdev computes the sample standard deviation (Bessel's correction)", () => {
  // Population stdev of this set is exactly 2; the sample estimate applies
  // Bessel's correction, so it is 2 * sqrt(8/7).
  const expected = 2 * Math.sqrt(8 / 7);
  assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - expected) < 1e-12);
});

test("stdev is unbiased: small samples are not systematically low", () => {
  // Dividing by n instead of n-1 understates spread, and worst at small n.
  // Two points one apart have a sample stdev of exactly sqrt(2)/2 ~ 0.707;
  // the population form would give 0.5.
  assert.ok(Math.abs(stdev([0, 1]) - Math.SQRT2 / 2) < 1e-12);
});

test("countSyllables handles short words as one syllable", () => {
  assert.equal(countSyllables("a"), 1);
  assert.equal(countSyllables("the"), 1);
  assert.equal(countSyllables("cat"), 1);
});

test("countSyllables approximates multi-syllable words", () => {
  assert.equal(countSyllables("banana"), 3);
  assert.equal(countSyllables("elephant"), 3);
});

test("clamp restricts to [0,1] by default", () => {
  assert.equal(clamp(-5), 0);
  assert.equal(clamp(5), 1);
  assert.equal(clamp(0.5), 0.5);
});

test("clamp respects custom bounds", () => {
  assert.equal(clamp(150, 0, 100), 100);
  assert.equal(clamp(-10, 0, 100), 0);
});
