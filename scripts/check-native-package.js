#!/usr/bin/env node
// Publish guard for the prebuilt platform package.
//
// The binaries in packages/win32-x64/ are gitignored build output, staged by
// `npm run build:native`. Without this check, publishing from a fresh clone
// succeeds and produces a package containing only package.json and README --
// which installs cleanly, because optionalDependencies fail open and
// llamaEngine.ts falls open to null on a missing helper. The result is a
// perplexity signal that is silently absent with no error explaining why.
// That is the worst shape this failure can take, so fail loudly here instead.
//
// Also enforces the version lockstep the exact-pin in optionalDependencies
// depends on.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PKG_DIR = path.join(ROOT, "packages", "win32-x64");

// One representative file per category rather than the whole manifest: the
// helper itself, the two libraries it resolves at runtime, and both licences —
// llama.cpp's, which we are obliged to redistribute alongside its compiled
// DLLs, and the project's own, since this publishes as a standalone tarball.
// If the build ran, all of these exist.
const REQUIRED = [
  "llama-engine-helper.exe",
  "llama.dll",
  "ggml.dll",
  "ggml-base.dll",
  "LICENSE",
  "LICENSE.llama.cpp",
];

const problems = [];

for (const file of REQUIRED) {
  const full = path.join(PKG_DIR, file);
  if (!fs.existsSync(full)) problems.push(`missing ${file}`);
  else if (fs.statSync(full).size === 0) problems.push(`${file} is empty`);
}

// ggml dispatches to a CPU-specific backend at load time; shipping none of
// them leaves a package that loads llama.dll and then fails to find a backend.
const backends = fs.existsSync(PKG_DIR)
  ? fs.readdirSync(PKG_DIR).filter((f) => /^ggml-cpu-.*\.dll$/.test(f))
  : [];
if (backends.length === 0) problems.push("no ggml-cpu-*.dll backends staged");

const root = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const platform = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
const pinned = (root.optionalDependencies || {})[platform.name];

if (platform.version !== root.version) {
  problems.push(`version drift: root is ${root.version}, ${platform.name} is ${platform.version}`);
}
if (pinned !== platform.version) {
  problems.push(`optionalDependencies pins ${platform.name}@${pinned}, but that package is ${platform.version}`);
}

if (problems.length > 0) {
  console.error(`\nplatform package is not publishable:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
  console.error("Run `npm run build:native` to stage the binaries, and keep the two package.json");
  console.error("versions in lockstep with the optionalDependencies pin.\n");
  process.exit(1);
}

console.log(`platform package OK: ${platform.name}@${platform.version}, ${backends.length} CPU backends staged`);
