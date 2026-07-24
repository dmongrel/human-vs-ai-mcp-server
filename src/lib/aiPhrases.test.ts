import assert from "node:assert/strict";
import { test } from "node:test";

import { countAiTellPhrases } from "./aiPhrases.js";

test("countAiTellPhrases finds no hits in plain text", () => {
  const hits = countAiTellPhrases("the cat sat on the mat and looked outside");
  assert.deepEqual(hits, []);
});

test("countAiTellPhrases counts single and repeated phrases", () => {
  const text = "let's delve into this. we should delve into it further, and also delve into that.";
  const hits = countAiTellPhrases(text);
  const delve = hits.find((h) => h.phrase === "delve into");
  assert.ok(delve, "expected to find 'delve into'");
  assert.equal(delve!.count, 3);
});

test("countAiTellPhrases matches multiple distinct phrases", () => {
  const text = "it's important to note that this is seamless and robust.";
  const hits = countAiTellPhrases(text);
  const phrases = hits.map((h) => h.phrase).sort();
  assert.deepEqual(phrases, ["it's important to note", "robust", "seamless"]);
});

test("countAiTellPhrases ignores placeholder patterns containing '...'", () => {
  const hits = countAiTellPhrases("not only is this true but also that");
  assert.deepEqual(hits.find((h) => h.phrase.includes("...")), undefined);
});
