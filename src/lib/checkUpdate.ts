// SPDX-FileCopyrightText: 2026 Joel L. Caesar
// SPDX-License-Identifier: MIT

/**
 * checkUpdate — at server start, check the npm registry for a newer release.
 * Node-only (this package targets Node/CommonJS, unlike the Bun/Deno-portable
 * epub-mcp-server and fdx-mcp-server siblings).
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Locate and parse package.json by walking up from this module's location.
 * Bundling changes how many directory levels separate this file from the
 * package root, so a fixed relative path is not reliable — walk up instead
 * of hardcoding a depth.
 */
async function findPackageJson(): Promise<{ version: string } | null> {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    try {
      const raw = await readFile(join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { name?: string; version: string };
      if (pkg.name === "human-vs-ai-mcp-server") return pkg;
    } catch {
      // not found at this level — keep walking up
    }
    dir = dirname(dir);
  }
  return null;
}

/** Read current version from package.json. */
export async function getCurrentVersion(): Promise<string> {
  const pkg = await findPackageJson();
  return pkg?.version ?? "0.0.0";
}

/** Fetch the latest published version from the npm registry. */
async function getLatestNpmVersion(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/human-vs-ai-mcp-server/latest", {
      headers: { "User-Agent": "mcp-server-updater" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

/** Parse a version string "X.Y.Z" into [major, minor, patch]. */
function parseVersion(v: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = v.split(".").map(Number);
  return [major, minor, patch];
}

/** Return true if `remote` is strictly greater than `local`. */
export function isNewer(local: string, remote: string): boolean {
  const a = parseVersion(local);
  const b = parseVersion(remote);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false; // equal
}

/**
 * Check for an update. Returns:
 *   null            — on any failure (network, parse, etc.) — fail open
 *   { available: true,  latest: "X.Y.Z" }  — newer version exists
 *   { available: false }                     — current is up-to-date
 */
export async function checkForUpdate(): Promise<
  { available: true; latest: string } | { available: false } | null
> {
  const local = await getCurrentVersion();
  const remote = await getLatestNpmVersion();
  if (remote === null) return null; // network error or rate-limited
  if (isNewer(local, remote)) return { available: true, latest: remote };
  return { available: false };
}
