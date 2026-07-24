import assert from "node:assert/strict";
import { test } from "node:test";

import { getCurrentVersion, isNewer } from "./checkUpdate.js";

test("isNewer detects a newer remote version", () => {
  assert.equal(isNewer("0.1.0", "1.0.0"), true);
  assert.equal(isNewer("0.1.0", "0.2.0"), true);
  assert.equal(isNewer("0.1.0", "0.1.1"), true);
});

test("isNewer rejects equal versions", () => {
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("1.2.3", "1.2.3"), false);
});

test("isNewer rejects an older remote version", () => {
  assert.equal(isNewer("1.0.0", "0.9.9"), false);
  assert.equal(isNewer("2.0.0", "1.99.99"), false);
});

test("isNewer handles versions with missing segments (pads to zero)", () => {
  assert.equal(isNewer("1", "1.0.1"), true);
  assert.equal(isNewer("0.9", "0.9.1"), true);
});

test("getCurrentVersion reads the version out of this repo's package.json", async () => {
  // Sanity check that path resolution up to package.json actually works —
  // a wrong relative depth here silently falls back to "0.0.0".
  assert.notEqual(await getCurrentVersion(), "0.0.0");
});
