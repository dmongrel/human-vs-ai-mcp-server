// Loads user-authored detector plugins from PLUGINS_DIR (env var, opt-in —
// unset by default, so nothing changes for anyone not using this). Plugins
// are plain CommonJS .js files (matching this package's compiled `commonjs`
// output — there's no bundled TypeScript compiler to compile .ts plugins at
// runtime, and adding one would violate the project's minimal-dependencies
// convention) exporting a Detector-shaped object (see ./types.ts) as
// `module.exports.detector`, `module.exports.default`, or `module.exports`
// itself.
//
// Fails open, per file: a missing/unreadable PLUGINS_DIR yields no plugins
// (not an error); a file that throws on require(), doesn't export a
// Detector-shaped value, or whose `id` collides with an existing detector is
// skipped with a warning on stderr (never stdout — this is an MCP server
// using stdio for the protocol) rather than crashing the whole server.
//
// Trust note: plugin code runs in-process with full Node.js privileges, same
// as any other module this server loads. Only point PLUGINS_DIR at a
// directory of files you trust.

import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { Detector } from "./types.js";

function isDetector(value: unknown): value is Detector {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    typeof d.enabled === "boolean" &&
    typeof d.weight === "function" &&
    typeof d.run === "function"
  );
}

export function loadPlugins(existingIds: readonly string[]): Detector[] {
  const dir = process.env.PLUGINS_DIR?.trim();
  if (!dir) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  } catch {
    return [];
  }

  const seenIds = new Set(existingIds);
  const plugins: Detector[] = [];
  for (const file of files) {
    try {
      const mod = require(join(dir, file));
      const candidate = (mod?.detector ?? mod?.default ?? mod) as unknown;
      if (!isDetector(candidate)) {
        console.error(`[plugins] Skipped ${file}: does not export a valid Detector.`);
        continue;
      }
      if (seenIds.has(candidate.id)) {
        console.error(`[plugins] Skipped ${file}: id "${candidate.id}" collides with an existing detector.`);
        continue;
      }
      seenIds.add(candidate.id);
      plugins.push(candidate);
    } catch (err) {
      console.error(`[plugins] Failed to load ${file}: ${(err as Error).message}`);
    }
  }
  return plugins;
}
