import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { loadPlugins } from "./loadPlugins.js";

const ORIGINAL_ENV = { ...process.env };
let dir: string | null = null;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.PLUGINS_DIR;
  dir = null;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  dir = mkdtempSync(join(tmpdir(), "hva-plugins-test-"));
  return dir;
}

test("returns no plugins when PLUGINS_DIR is unset", () => {
  assert.deepEqual(loadPlugins([]), []);
});

test("returns no plugins when PLUGINS_DIR does not exist", () => {
  process.env.PLUGINS_DIR = join(tmpdir(), "hva-plugins-does-not-exist");
  assert.deepEqual(loadPlugins([]), []);
});

test("loads a valid CommonJS plugin exporting `detector`", () => {
  const d = makeDir();
  writeFileSync(
    join(d, "example.js"),
    `module.exports.detector = {
      id: "example-plugin",
      name: "example plugin",
      enabled: true,
      weight: () => 0.1,
      run: () => ({ name: "example plugin", score: 0.5, detail: "ok" }),
    };`
  );
  process.env.PLUGINS_DIR = d;
  const plugins = loadPlugins([]);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].id, "example-plugin");
});

test("loads a valid plugin exported as module.exports directly", () => {
  const d = makeDir();
  writeFileSync(
    join(d, "example.js"),
    `module.exports = {
      id: "bare-export-plugin",
      name: "bare export plugin",
      enabled: true,
      weight: () => 0.1,
      run: () => null,
    };`
  );
  process.env.PLUGINS_DIR = d;
  const plugins = loadPlugins([]);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].id, "bare-export-plugin");
});

test("skips a file that throws during require", () => {
  const d = makeDir();
  writeFileSync(join(d, "broken.js"), `throw new Error("boom");`);
  process.env.PLUGINS_DIR = d;
  assert.deepEqual(loadPlugins([]), []);
});

test("skips a file that does not export a Detector-shaped value", () => {
  const d = makeDir();
  writeFileSync(join(d, "notadetector.js"), `module.exports = { hello: "world" };`);
  process.env.PLUGINS_DIR = d;
  assert.deepEqual(loadPlugins([]), []);
});

test("skips a plugin whose id collides with an existing detector id", () => {
  const d = makeDir();
  writeFileSync(
    join(d, "collide.js"),
    `module.exports.detector = {
      id: "burstiness",
      name: "colliding plugin",
      enabled: true,
      weight: () => 0.1,
      run: () => null,
    };`
  );
  process.env.PLUGINS_DIR = d;
  assert.deepEqual(loadPlugins(["burstiness"]), []);
});

test("ignores non-.js files in the directory", () => {
  const d = makeDir();
  writeFileSync(join(d, "notes.txt"), "not a plugin");
  process.env.PLUGINS_DIR = d;
  assert.deepEqual(loadPlugins([]), []);
});
