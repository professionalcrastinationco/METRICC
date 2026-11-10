/*
 * Runs the HUD against a fake ~/.codex to check which Codex usage it shows.
 * Run with: node --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT_PATH = join(import.meta.dirname, "..", "metricc-cc-statusbar.mjs");

function tokenCountLine(timestamp, fiveHourUsed, sevenDayUsed) {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const rateLimits = {
    limit_id: "codex",
    primary: { used_percent: fiveHourUsed, window_minutes: 300, resets_at: resetsAt },
    secondary: { used_percent: sevenDayUsed, window_minutes: 10080, resets_at: resetsAt },
  };
  return JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", rate_limits: rateLimits } });
}

// A fake HOME with Codex session logs: the active thread at 32%/17%, plus an older thread reopened later.
function homeWithSessionLogs() {
  const home = mkdtempSync(join(tmpdir(), "metricc-codex-"));
  const dayDir = join(home, ".codex", "sessions", "2026", "10", "07");
  mkdirSync(dayDir, { recursive: true });

  const activePath = join(dayDir, "rollout-active.jsonl");
  writeFileSync(activePath, tokenCountLine("2026-10-10T19:43:43Z", 32, 17) + "\n");
  utimesSync(activePath, new Date("2026-10-10T19:43:43Z"), new Date("2026-10-10T19:43:43Z"));

  // Reopening an old thread appends a non-usage event and bumps its mtime.
  const reopenedPath = join(dayDir, "rollout-reopened.jsonl");
  const settingsLine = JSON.stringify({ timestamp: "2026-10-10T20:02:31Z", type: "event_msg", payload: { type: "thread_settings_applied" } });
  writeFileSync(reopenedPath, `${tokenCountLine("2026-10-07T20:49:24Z", 0, 1)}\n${settingsLine}\n`);
  utimesSync(reopenedPath, new Date("2026-10-10T20:02:31Z"), new Date("2026-10-10T20:02:31Z"));

  const hudDir = join(home, ".claude", "hud");
  mkdirSync(hudDir, { recursive: true });
  writeFileSync(join(hudDir, ".version-cache.json"), JSON.stringify({ timestamp: Date.now(), data: null }));
  return home;
}

// Runs the HUD with the given HOME and returns a column-label → value lookup.
function runHud(home) {
  const output = execFileSync("node", [SCRIPT_PATH], { input: "{}", env: { ...process.env, HOME: home } }).toString();
  const plainOutput = output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\u00A0/g, " ");
  const [header, values] = plainOutput.split("\n");
  return (label) => values.split("│")[header.split("│").findIndex((cell) => cell.includes(label))].trim();
}

test("shows the newest Codex usage even when an older thread was touched later", () => {
  const columnValue = runHud(homeWithSessionLogs());
  assert.match(columnValue("5h Codex"), /^32%/);
  assert.match(columnValue("7d Codex"), /^17%/);
});

test("prefers live Codex usage over session logs, so an early reset shows right away", () => {
  const home = homeWithSessionLogs();
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const liveUsage = { primary: { used_percent: 0, resets_at: resetsAt }, secondary: { used_percent: 0, resets_at: resetsAt } };
  writeFileSync(join(home, ".claude", "hud", ".codex-usage-cache.json"), JSON.stringify({ timestamp: Date.now(), data: liveUsage, error: false }));

  const columnValue = runHud(home);
  assert.match(columnValue("5h Codex"), /^0%/);
  assert.match(columnValue("7d Codex"), /^0%/);
});
