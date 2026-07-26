#!/usr/bin/env node
// Printed at the end of `npm run release` (and previewed by `release:dry`).
// Written 2026-07-26 after three releases in a row needed a manual
// `npm cache clean --force` + reinstall before `npm install -g` resolved the
// engine package -- npm's registry metadata is CDN-cached and can lag a
// fresh publish by a minute or two, and because the engine is an optional
// dependency, a stale-cache miss installs silently with no error and no
// perplexity signal. The wait is measured from when the publish itself
// completes, not from when a release tag was pushed or a workflow started.
//
// A plain node script rather than shell `echo`, so the same wording renders
// identically under package.json's cmd.exe-on-Windows / sh-on-CI script
// runner without fighting quoting differences between the two.

const dry = process.argv.includes("--dry");

const lines = dry
  ? [
      "",
      "(dry run -- nothing was published)",
      "When you run the real release, wait a minute or two from when the publish",
      "itself completes -- not from when a tag was pushed or a workflow started --",
      "before running `npm install -g human-vs-ai-mcp-server`. npm's registry",
      "metadata is CDN-cached and can lag a fresh publish. If the engine package",
      "(human-vs-ai-mcp-server-win32-x64) is missing afterward, run:",
      "  npm cache clean --force",
      "  npm uninstall -g human-vs-ai-mcp-server",
      "  npm install -g human-vs-ai-mcp-server",
      "",
    ]
  : [
      "",
      "Published. Wait a minute or two from now before running",
      "`npm install -g human-vs-ai-mcp-server` -- npm's registry metadata is",
      "CDN-cached and can lag a fresh publish. If the engine package",
      "(human-vs-ai-mcp-server-win32-x64) is missing afterward, run:",
      "  npm cache clean --force",
      "  npm uninstall -g human-vs-ai-mcp-server",
      "  npm install -g human-vs-ai-mcp-server",
      "",
    ];

console.log(lines.join("\n"));
