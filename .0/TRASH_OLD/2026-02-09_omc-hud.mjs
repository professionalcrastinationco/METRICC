#!/usr/bin/env node
/**
 * OMC HUD - Statusline Script
 * Wrapper that imports from plugin cache or development paths
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Semantic version comparison: returns negative if a < b, positive if a > b, 0 if equal
function semverCompare(a, b) {
  // Use parseInt to handle pre-release suffixes (e.g. "0-beta" -> 0)
  const pa = a.replace(/^v/, "").split(".").map(s => parseInt(s, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  // If numeric parts equal, non-pre-release > pre-release
  const aHasPre = /-/.test(a);
  const bHasPre = /-/.test(b);
  if (aHasPre && !bHasPre) return -1;
  if (!aHasPre && bHasPre) return 1;
  return 0;
}

async function main() {
  const home = homedir();
  let pluginCacheDir = null;

  // 1. Try plugin cache first (marketplace: omc, plugin: oh-my-claudecode)
  const pluginCacheBase = join(home, ".claude/plugins/cache/omc/oh-my-claudecode");
  if (existsSync(pluginCacheBase)) {
    try {
      const versions = readdirSync(pluginCacheBase);
      if (versions.length > 0) {
        const latestVersion = versions.sort(semverCompare).reverse()[0];
        pluginCacheDir = join(pluginCacheBase, latestVersion);
        const pluginPath = join(pluginCacheDir, "dist/hud/index.js");
        if (existsSync(pluginPath)) {
          await import(pathToFileURL(pluginPath).href);
          return;
        }
      }
    } catch { /* continue */ }
  }

  // 2. Development paths
  const devPaths = [
    join(home, "Workspace/oh-my-claude-sisyphus/dist/hud/index.js"),
    join(home, "workspace/oh-my-claude-sisyphus/dist/hud/index.js"),
    join(home, "Workspace/oh-my-claudecode/dist/hud/index.js"),
    join(home, "workspace/oh-my-claudecode/dist/hud/index.js"),
  ];

  for (const devPath of devPaths) {
    if (existsSync(devPath)) {
      try {
        await import(pathToFileURL(devPath).href);
        return;
      } catch { /* continue */ }
    }
  }

  // 3. Fallback - HUD not found (provide actionable error message)
  if (pluginCacheDir) {
    console.log(`[OMC] HUD not built. Run: cd "${pluginCacheDir}" && npm install`);
  } else {
    console.log("[OMC] Plugin not found. Run: /oh-my-claudecode:omc-setup");
  }
}

main();
