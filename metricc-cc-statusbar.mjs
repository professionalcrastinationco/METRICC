#!/usr/bin/env node
/**
 * Custom HUD - Standalone Claude Code Statusline
 * No plugin dependencies. Shows: rate limits, session time, context %, agents.
 *
 * Data sources:
 * - stdin JSON from Claude Code (context window, model, transcript path)
 * - Anthropic OAuth API (5h/7d rate limits) — cached 60s
 * - Transcript JSONL (session start, running agents)
 * - ChatGPT usage API (Codex 5h/7d rate limits) — cached 60s, falls back to Codex session logs (~/.codex/sessions)
 */

import { existsSync, readFileSync, writeFileSync, renameSync, statSync, openSync, readSync, closeSync, mkdirSync, unlinkSync, createReadStream, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createInterface } from "node:readline";
import https from "node:https";
import { execSync } from "node:child_process";

// ── Constants ──────────────────────────────────────────────────────────────────
// Defaults for the usage-API cache/retry cadence — all overridable via config.jsonc, see readConfig().
const DEFAULT_SUCCESS_TTL_MS = 60_000;               // normal cache TTL once a fetch succeeds
const DEFAULT_NON_RATE_LIMIT_FAILURE_TTL_MS = 15_000; // flat retry delay for non-429 failures (network error, 5xx, etc.)
const DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS = 60_000;    // first 429 backoff starts here
const DEFAULT_RATE_LIMIT_BACKOFF_MULTIPLIER = 2;      // each consecutive 429 multiplies the backoff by this
const DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS = 300_000;    // backoff never grows past 5 minutes
const DEFAULT_RATE_LIMIT_BACKOFF_DECAY_FACTOR = 0.8;  // each success shrinks a lingering backoff by 20%
const DEFAULT_SWEET_SPOT_SENSITIVITY = 1.5;           // how fast the learned TTL climbs toward the cap as the recent 429 rate rises
const HISTORY_MAX_ENTRIES = 100;      // sweet-spot TTL is learned from this many recent fetch outcomes
const LOCK_STALE_MS = 20_000;         // abandon a lock older than this (crashed holder)
const API_TIMEOUT_MS = 8000;
const MAX_TAIL_BYTES = 512 * 1024;    // 500KB tail read for large transcripts
const MAX_AGENT_MAP = 100;
const STALE_AGENT_MS = 30 * 60_000;   // 30 min = stale agent
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const VERSION_CACHE_TTL_MS = 3_600_000; // 1hr cache for npm version check

const ALL_COLUMNS = [
  // Standard
  "5h Usage", "7d Usage", "Context", "Model", "Codex", "5h Codex", "Version",
  // Session
  "Session", "Changes", "Directory", "Cost",
  // Advanced
  "Tokens", "Output Tokens", "Cache", "API Time", "5h Reset", "7d Reset",
];

const HOME = homedir();
const CONFIG_PATH = join(HOME, ".claude", "hud", "config.jsonc");
const VERSION_CACHE_PATH = join(HOME, ".claude", "hud", ".version-cache.json");
const CRED_PATH = join(HOME, ".claude", ".credentials.json");
const CODEX_SESSIONS_PATH = join(HOME, ".codex", "sessions");
const CODEX_AUTH_PATH = join(HOME, ".codex", "auth.json");

// Each usage API gets its own cache, lock and 429 history so one provider's backoff never slows the other.
const CLAUDE_USAGE_SOURCE = {
  cachePath: join(HOME, ".claude", "hud", ".usage-cache.json"),
  lockPath: join(HOME, ".claude", "hud", ".usage-cache.lock"),
  historyPath: join(HOME, ".claude", "hud", ".usage-history.json"),
  fetchData: fetchClaudeUsage,
};
const CODEX_USAGE_SOURCE = {
  cachePath: join(HOME, ".claude", "hud", ".codex-usage-cache.json"),
  lockPath: join(HOME, ".claude", "hud", ".codex-usage-cache.lock"),
  historyPath: join(HOME, ".claude", "hud", ".codex-usage-history.json"),
  fetchData: fetchCodexUsage,
};
const CODEX_DAY_DIRS_TO_SCAN = 7; // resumed sessions keep writing into the day folder they started in
const CODEX_DAY_WINDOW_MINUTES = 1440; // rate-limit windows at least this long are the weekly one

// ── ANSI Colors ────────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[38;2;5;150;105m",      // Tailwind Emerald-600 (#059669)
  yellow: "\x1b[38;2;217;119;6m",    // Tailwind Amber-600 (#d97706)
  red: "\x1b[38;2;220;38;38m",       // Tailwind Red-600 (#dc2626)
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  // Tailwind Slate-500 (#64748b) for data values
  slate600: "\x1b[38;2;100;116;139m",
  // Tailwind Slate-700 (#334155) for labels
  slate700: "\x1b[38;2;51;65;85m",
  slate700bold: "\x1b[1;38;2;51;65;85m",
  // Tailwind Slate-700 (#334155) for separators and labels
  slate800: "\x1b[38;2;51;65;85m",
  slate800bold: "\x1b[1;38;2;51;65;85m",
};

// ── Config ─────────────────────────────────────────────────────────────────────
// Config file: ~/.claude/hud/config.json (supports // comments)
// Toggle columns with true/false. Missing keys default to their section default.
function parseJsonc(text) {
  // Strip both full-line and inline comments, then trailing commas
  const stripped = text
    .replace(/("(?:[^"\\]|\\.)*")|\/\/.*/g, (m, str) => str || "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

const SECTION_DEFAULTS = {
  // Standard: on by default
  "5h Usage": true, "7d Usage": true, "Context": true, "Model": true, "Codex": true, "5h Codex": true, "Version": true,
  // Session: off by default
  "Session": false, "Changes": false, "Directory": false, "Cost": false,
  // Advanced: off by default
  "Tokens": false, "Output Tokens": false, "Cache": false, "API Time": false, "5h Reset": false, "7d Reset": false,
};

const USAGE_RETRY_DEFAULTS = {
  successTtlMs: DEFAULT_SUCCESS_TTL_MS,
  nonRateLimitFailureTtlMs: DEFAULT_NON_RATE_LIMIT_FAILURE_TTL_MS,
  rateLimitBackoffBaseMs: DEFAULT_RATE_LIMIT_BACKOFF_BASE_MS,
  rateLimitBackoffMultiplier: DEFAULT_RATE_LIMIT_BACKOFF_MULTIPLIER,
  rateLimitBackoffMaxMs: DEFAULT_RATE_LIMIT_BACKOFF_MAX_MS,
  rateLimitBackoffDecayFactor: DEFAULT_RATE_LIMIT_BACKOFF_DECAY_FACTOR,
  sweetSpotSensitivity: DEFAULT_SWEET_SPOT_SENSITIVITY,
};

// Reads usage-API retry/backoff tunables from config.jsonc, falling back to defaults for missing or invalid values.
function readUsageRetryConfig(cfg) {
  const usage = {};
  for (const key of Object.keys(USAGE_RETRY_DEFAULTS)) {
    const value = cfg[key];
    const isValidNumber = typeof value === "number" && isFinite(value) && value > 0;
    usage[key] = isValidNumber ? value : USAGE_RETRY_DEFAULTS[key];
  }
  return usage;
}

function readConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return { columns: ALL_COLUMNS.filter((id) => SECTION_DEFAULTS[id] !== false), layout: "vertical", usage: readUsageRetryConfig({}) };
    }
    const cfg = parseJsonc(readFileSync(CONFIG_PATH, "utf-8"));
    const enabled = ALL_COLUMNS.filter((id) => {
      if (id in cfg) return cfg[id] !== false;
      return SECTION_DEFAULTS[id] !== false;
    });
    const layout = cfg.layout === "horizontal" ? "horizontal" : "vertical";
    return { columns: enabled.length > 0 ? enabled : ALL_COLUMNS, layout, usage: readUsageRetryConfig(cfg) };
  } catch {
    return { columns: ALL_COLUMNS.filter((id) => SECTION_DEFAULTS[id] !== false), layout: "vertical", usage: readUsageRetryConfig({}) };
  }
}

// ── Stdin Parser ───────────────────────────────────────────────────────────────
async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  try {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = chunks.join("");
    return raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getContextPercent(stdin) {
  const pct = stdin.context_window?.used_percentage;
  if (typeof pct === "number" && !Number.isNaN(pct)) {
    return Math.min(100, Math.max(0, Math.round(pct)));
  }
  const size = stdin.context_window?.context_window_size;
  if (!size || size <= 0) return 0;
  const usage = stdin.context_window?.current_usage;
  const total = (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
  return Math.min(100, Math.round((total / size) * 100));
}

function getModelId(stdin) {
  // Claude Code sends the human-friendly name directly — prefer it over guessing from the id.
  if (stdin.model?.display_name) return stdin.model.display_name;
  const id = stdin.model?.id ?? "unknown";
  // No whitelist of family names: split into name words vs version numbers, whatever they are.
  // "claude-opus-4-6" → "Opus 4.6", "claude-encyclopedia-5" → "Encyclopedia 5", "claude-haiku-4-5-20251001" → "Haiku 4.5"
  const parts = id.split("-").filter((part) => part !== "claude" && !/^\d{8}$/.test(part)); // drop date stamps too
  const name = parts.filter((part) => !/^\d+$/.test(part)).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const version = parts.filter((part) => /^\d+$/.test(part)).join(".");
  if (!name) return id;
  return version ? `${name} ${version}` : name;
}

function getVersion(stdin) {
  return stdin.version ?? null;
}

// ── Usage API (Anthropic OAuth) ────────────────────────────────────────────────
function readCache(source) {
  try {
    if (!existsSync(source.cachePath)) return null;
    const cache = JSON.parse(readFileSync(source.cachePath, "utf-8"));
    // Reconstitute Date objects lost during JSON serialization
    if (cache?.data) {
      if (cache.data.fiveHourResets) cache.data.fiveHourResets = new Date(cache.data.fiveHourResets);
      if (cache.data.sevenDayResets) cache.data.sevenDayResets = new Date(cache.data.sevenDayResets);
    }
    return cache;
  } catch {
    return null;
  }
}

function writeCache(source, data, error = false, { rateLimited = false, backoffMs = null } = {}) {
  try {
    const dir = dirname(source.cachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Temp-file-then-rename: readers never observe a partial write.
    const tmpPath = `${source.cachePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ timestamp: Date.now(), data, error, rateLimited, backoffMs }));
    renameSync(tmpPath, source.cachePath);
  } catch { /* ignore */ }
}

// Rolling record of the last HISTORY_MAX_ENTRIES fetch outcomes, used to learn a per-machine sweet-spot TTL.
// Concurrent sessions may race this read-modify-write; losing an occasional entry is fine for a rolling average.
function readHistory(source) {
  try {
    if (!existsSync(source.historyPath)) return [];
    const entries = JSON.parse(readFileSync(source.historyPath, "utf-8"));
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function recordHistoryEntry(source, rateLimited) {
  try {
    const entries = readHistory(source);
    entries.push({ timestamp: Date.now(), rateLimited });
    const trimmed = entries.slice(-HISTORY_MAX_ENTRIES);
    const dir = dirname(source.historyPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmpPath = `${source.historyPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(trimmed));
    renameSync(tmpPath, source.historyPath);
  } catch { /* ignore */ }
}

// The sweet-spot TTL: how often we can afford to actually hit the API without provoking 429s, learned from
// how often recent attempts got rate-limited. 0% rate-limited in the window → stay at the fast default TTL
// (favor freshness). As the rate-limited fraction climbs, slide toward the backoff cap (favor avoiding 429s),
// with a safety margin so the learned TTL sits a bit above the minimum that was merely "good enough" recently.
function computeSweetSpotTtlMs(source, usageConfig) {
  const entries = readHistory(source);
  if (entries.length === 0) return usageConfig.successTtlMs;

  const rateLimitedCount = entries.filter((entry) => entry.rateLimited).length;
  const rateLimitedRatio = rateLimitedCount / entries.length;

  const rangeMs = usageConfig.rateLimitBackoffMaxMs - usageConfig.successTtlMs;
  const sweetSpotMs = usageConfig.successTtlMs + rateLimitedRatio * usageConfig.sweetSpotSensitivity * rangeMs;
  return Math.max(usageConfig.successTtlMs, Math.min(sweetSpotMs, usageConfig.rateLimitBackoffMaxMs));
}

// 429s get their own exponential-backoff TTL (stored on the cache entry); other failures use a flat retry delay;
// a successful fetch uses the learned sweet-spot TTL instead of the raw configured default.
function isCacheValid(source, cache, usageConfig) {
  let ttl = computeSweetSpotTtlMs(source, usageConfig);
  if (cache.error) {
    ttl = cache.rateLimited ? (cache.backoffMs ?? usageConfig.rateLimitBackoffBaseMs) : usageConfig.nonRateLimitFailureTtlMs;
  }
  return Date.now() - cache.timestamp < ttl;
}

function getCredentials() {
  // Primary: read from JSON file (all platforms)
  try {
    if (existsSync(CRED_PATH)) {
      const parsed = JSON.parse(readFileSync(CRED_PATH, "utf-8"));
      const creds = parsed.claudeAiOauth || parsed;
      if (creds.accessToken) {
        return { accessToken: creds.accessToken, expiresAt: creds.expiresAt, refreshToken: creds.refreshToken };
      }
    }
  } catch { /* */ }

  // Fallback: macOS Keychain only
  if (process.platform === "darwin") {
    try {
      const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
        timeout: 3000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        const creds = parsed.claudeAiOauth || parsed;
        if (creds.accessToken) {
          return { accessToken: creds.accessToken, expiresAt: creds.expiresAt, refreshToken: creds.refreshToken };
        }
      }
    } catch { /* Keychain entry doesn't exist or parse failed */ }
  }

  return null;
}

function refreshAccessToken(refreshToken) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString();
    const req = https.request({
      hostname: "platform.claude.com",
      path: "/v1/oauth/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.on("data", (ch) => { data += ch; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const p = JSON.parse(data);
            if (p.access_token) {
              resolve({ accessToken: p.access_token, refreshToken: p.refresh_token || refreshToken, expiresAt: p.expires_in ? Date.now() + p.expires_in * 1000 : p.expires_at });
              return;
            }
          } catch { /* */ }
        }
        resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

// Includes status so callers can see 429s, not just the body.
function fetchJson(hostname, path, headers) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname,
      path,
      method: "GET",
      headers,
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.on("data", (ch) => { data += ch; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve({ status: 200, body: JSON.parse(data) }); } catch { resolve({ status: 200, body: null }); }
        } else {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on("error", () => resolve({ status: 0, body: null }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.end();
  });
}

function normalizeUsage(resp) {
  const clamp = (v) => (v == null || !isFinite(v)) ? 0 : Math.max(0, Math.min(100, v));
  const parseDate = (s) => { try { const d = new Date(s); return isNaN(d.getTime()) ? null : d; } catch { return null; } };
  return {
    fiveHour: clamp(resp.five_hour?.utilization),
    fiveHourResets: parseDate(resp.five_hour?.resets_at),
    sevenDay: clamp(resp.seven_day?.utilization),
    sevenDayResets: parseDate(resp.seven_day?.resets_at),
  };
}

function writeBackCredentials(creds) {
  try {
    if (!existsSync(CRED_PATH)) return;
    const parsed = JSON.parse(readFileSync(CRED_PATH, "utf-8"));
    const target = parsed.claudeAiOauth || parsed;
    target.accessToken = creds.accessToken;
    if (creds.expiresAt != null) target.expiresAt = creds.expiresAt;
    if (creds.refreshToken) target.refreshToken = creds.refreshToken;
    // Rename replaces the inode, so the temp file's mode is what survives, not
    // the original's. Create it 0600 or the tokens land world-readable on POSIX.
    const tmpPath = `${CRED_PATH}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
    renameSync(tmpPath, CRED_PATH);
  } catch { /* */ }
}

// Only one session refreshes the cache at a time; the rest read what it wrote.
function acquireLock(source) {
  try {
    const dir = dirname(source.lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(source.lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") return false;
    try {
      if (Date.now() - statSync(source.lockPath).mtimeMs > LOCK_STALE_MS) {
        writeFileSync(source.lockPath, String(process.pid));
        return true;
      }
    } catch { /* lock vanished mid-check; treat as contended */ }
    return false;
  }
}

function releaseLock(source) {
  try { unlinkSync(source.lockPath); } catch { /* already gone */ }
}

// { status, data } from the Anthropic usage API; status 0 covers missing credentials and network failures.
async function fetchClaudeUsage() {
  let creds = getCredentials();
  if (!creds) return { status: 0, data: null };

  if (creds.expiresAt && creds.expiresAt <= Date.now()) {
    if (!creds.refreshToken) return { status: 0, data: null };
    const refreshed = await refreshAccessToken(creds.refreshToken);
    if (!refreshed) return { status: 0, data: null };
    creds = { ...creds, ...refreshed };
    writeBackCredentials(creds);
  }

  const resp = await fetchJson("api.anthropic.com", "/api/oauth/usage", {
    Authorization: `Bearer ${creds.accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
  });
  if (!resp.body) return { status: resp.status, data: null };
  return { status: resp.status, data: normalizeUsage(resp.body) };
}

// { data, stale } — stale is true when data is carried forward from the last successful fetch, not a live read.
async function getUsage(source, usageConfig) {
  const cache = readCache(source);
  const previousData = cache?.data ?? null;
  const asStaleResult = () => ({ data: previousData, stale: previousData != null });

  if (cache && isCacheValid(source, cache, usageConfig)) return { data: cache.data, stale: !!cache.error };
  if (!acquireLock(source)) return asStaleResult();

  // Carries the last-known backoff forward so consecutive 429s keep growing it, and successes keep decaying it.
  const priorBackoffMs = cache?.backoffMs ?? usageConfig.rateLimitBackoffBaseMs;

  try {
    const result = await source.fetchData();
    if (result.status === 429) {
      const nextBackoffMs = Math.min(priorBackoffMs * usageConfig.rateLimitBackoffMultiplier, usageConfig.rateLimitBackoffMaxMs);
      writeCache(source, previousData, true, { rateLimited: true, backoffMs: nextBackoffMs });
      recordHistoryEntry(source, true);
      return asStaleResult();
    }
    if (result.status !== 200 || !result.data) { writeCache(source, previousData, true); return asStaleResult(); }

    const decayedBackoffMs = Math.max(usageConfig.rateLimitBackoffBaseMs, priorBackoffMs * usageConfig.rateLimitBackoffDecayFactor);
    writeCache(source, result.data, false, { backoffMs: decayedBackoffMs });
    recordHistoryEntry(source, false);
    return { data: result.data, stale: false };
  } finally {
    releaseLock(source);
  }
}

// ── Version Check (npm registry) ─────────────────────────────────────────────
function readVersionCache() {
  try {
    if (!existsSync(VERSION_CACHE_PATH)) return null;
    const cache = JSON.parse(readFileSync(VERSION_CACHE_PATH, "utf-8"));
    if (Date.now() - cache.timestamp < VERSION_CACHE_TTL_MS) return cache.data;
    return null;
  } catch {
    return null;
  }
}

function writeVersionCache(data) {
  try {
    const dir = dirname(VERSION_CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(VERSION_CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data }));
  } catch { /* ignore */ }
}

function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "registry.npmjs.org",
      path: "/@anthropic-ai/claude-code/latest",
      method: "GET",
      headers: { Accept: "application/json" },
      timeout: 3000,
    }, (res) => {
      let data = "";
      res.on("data", (ch) => { data += ch; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).version || null); } catch { resolve(null); }
        } else resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function getLatestVersion() {
  const cached = readVersionCache();
  if (cached) return cached;
  const latest = await fetchLatestVersion();
  if (latest) writeVersionCache(latest);
  return latest;
}

// ── Codex Usage (local session logs) ─────────────────────────────────────────
// Newest entries of a YYYY/MM/DD-style directory level, newest first.
function newestSubdirs(parentPath) {
  try {
    return readdirSync(parentPath).filter((name) => /^\d+$/.test(name)).sort().reverse().map((name) => join(parentPath, name));
  } catch {
    return [];
  }
}

// Rollout files from the newest day directories, most recently written first.
function newestCodexSessionFiles() {
  const dayDirs = [];
  for (const yearDir of newestSubdirs(CODEX_SESSIONS_PATH)) {
    for (const monthDir of newestSubdirs(yearDir)) {
      for (const dayDir of newestSubdirs(monthDir)) {
        if (dayDirs.length < CODEX_DAY_DIRS_TO_SCAN) dayDirs.push(dayDir);
      }
    }
  }

  const files = [];
  for (const dayDir of dayDirs) {
    for (const name of readdirSync(dayDir)) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const filePath = join(dayDir, name);
      const stat = statSync(filePath);
      files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return files.sort((first, second) => second.mtimeMs - first.mtimeMs);
}

// A window whose reset time has passed has rolled over to 0%.
function codexWindowPercent(window) {
  if (!window || typeof window.used_percent !== "number") return 0;
  if (window.resets_at && window.resets_at * 1000 <= Date.now()) return 0;
  return Math.max(0, Math.min(100, window.used_percent));
}

// Converts a window's unix-seconds resets_at into a Date for formatResetTime.
function codexWindowResets(window) {
  if (!window?.resets_at) return null;
  return new Date(window.resets_at * 1000);
}

// { percent, resets } for one window, or null when the plan does not report it.
function codexWindowUsage(window) {
  if (!window) return null;
  return { percent: codexWindowPercent(window), resets: codexWindowResets(window) };
}

// Codex fills primary/secondary by plan, so match windows by length; Pro reports only the weekly one.
function findCodexWindows(rateLimits) {
  const reportedWindows = [rateLimits.primary, rateLimits.secondary].filter(Boolean);
  const hasWindowLengths = reportedWindows.every((window) => typeof window.window_minutes === "number");
  if (!hasWindowLengths) return { fiveHour: rateLimits.primary ?? null, sevenDay: rateLimits.secondary ?? null };

  const fiveHour = reportedWindows.find((window) => window.window_minutes < CODEX_DAY_WINDOW_MINUTES) ?? null;
  const sevenDay = reportedWindows.find((window) => window.window_minutes >= CODEX_DAY_WINDOW_MINUTES) ?? null;
  return { fiveHour, sevenDay };
}

// The last Codex rate_limits payload in a rollout file with its event time, or null when the file has none.
function lastCodexRateLimits(file) {
  const lines = readTailLines(file.filePath, file.size, MAX_TAIL_BYTES);
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].includes('"token_count"')) continue;
    let entry;
    try { entry = JSON.parse(lines[index]); } catch { continue; }
    const rateLimits = entry.payload?.rate_limits;
    if (!rateLimits) continue;
    if (rateLimits.limit_id && rateLimits.limit_id !== "codex") continue;
    if (!rateLimits.primary && !rateLimits.secondary) continue;
    return { rateLimits, timestampMs: Date.parse(entry.timestamp) || 0 };
  }
  return null;
}

// The rate_limits payload of the newest Codex token_count event, or null when there is no Codex data.
// Codex appends non-usage events (e.g. thread_settings_applied) to old threads, so mtime alone doesn't point at the newest usage.
function newestLocalCodexRateLimits() {
  try {
    let newest = null;
    for (const file of newestCodexSessionFiles()) {
      // A file can't hold an event newer than its own mtime.
      if (newest && file.mtimeMs < newest.timestampMs) break;
      const candidate = lastCodexRateLimits(file);
      if (candidate && (!newest || candidate.timestampMs > newest.timestampMs)) newest = candidate;
    }
    return newest?.rateLimits ?? null;
  } catch { /* no Codex data */ }
  return null;
}

// { status, data } from the ChatGPT usage endpoint the Codex CLI reads, mapped to the session-log rate_limits shape.
// ponytail: never refreshes the Codex token (Codex rotates it); an expired token falls back to session logs until Codex refreshes it.
async function fetchCodexUsage() {
  let tokens;
  try { tokens = JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf-8")).tokens; } catch { return { status: 0, data: null }; }
  if (!tokens?.access_token) return { status: 0, data: null };

  const headers = { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": "codex-cli" };
  if (tokens.account_id) headers["ChatGPT-Account-Id"] = tokens.account_id;
  const resp = await fetchJson("chatgpt.com", "/backend-api/wham/usage", headers);

  const rateLimit = resp.body?.rate_limit;
  if (!rateLimit?.primary_window && !rateLimit?.secondary_window) return { status: resp.status, data: null };
  const toWindow = (window) => {
    if (!window) return null;
    const mapped = { used_percent: window.used_percent, resets_at: window.reset_at };
    if (typeof window.limit_window_seconds === "number") mapped.window_minutes = window.limit_window_seconds / 60;
    return mapped;
  };
  return { status: resp.status, data: { primary: toWindow(rateLimit.primary_window), secondary: toWindow(rateLimit.secondary_window) } };
}

// { fiveHour, sevenDay } as { percent, resets } from the live usage API, else the newest session log; fiveHour is null on plans without a 5h window. Null when there is no Codex data.
// Session logs only update when Codex runs a turn, so they miss early resets; the live API doesn't.
async function getCodexUsage(usageConfig) {
  const live = await getUsage(CODEX_USAGE_SOURCE, usageConfig);
  const rateLimits = live.data ?? newestLocalCodexRateLimits();
  if (!rateLimits) return null;

  const windows = findCodexWindows(rateLimits);
  if (!windows.sevenDay) return null;
  return { fiveHour: codexWindowUsage(windows.fiveHour), sevenDay: codexWindowUsage(windows.sevenDay) };
}

// ── Transcript Parser ──────────────────────────────────────────────────────────
function readTailLines(filePath, fileSize, maxBytes) {
  const start = Math.max(0, fileSize - maxBytes);
  const len = fileSize - start;
  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(len);
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0 && lines.length > 0) lines.shift(); // discard partial first line
  return lines;
}

async function parseTranscript(transcriptPath) {
  const result = { sessionStart: null, agents: [], todos: [] };
  if (!transcriptPath || !existsSync(transcriptPath)) return result;

  const agentMap = new Map();
  const bgMap = new Map();
  let latestTodos = [];

  function processLine(line) {
    if (!line.trim()) return;
    let entry;
    try { entry = JSON.parse(line); } catch { return; }
    const ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
    if (!result.sessionStart && entry.timestamp) result.sessionStart = ts;

    const content = entry.message?.content;
    if (!content || !Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === "tool_use" && block.id && block.name) {
        if (block.name === "Task" || block.name === "proxy_Task") {
          const input = block.input;
          if (agentMap.size >= MAX_AGENT_MAP) {
            // Evict oldest completed
            let oldest = null, oldestT = Infinity;
            for (const [id, a] of agentMap) {
              if (a.status === "completed" && a.startTime.getTime() < oldestT) {
                oldestT = a.startTime.getTime();
                oldest = id;
              }
            }
            if (oldest) agentMap.delete(oldest);
          }
          agentMap.set(block.id, {
            id: block.id,
            type: input?.subagent_type ?? "unknown",
            model: input?.model,
            description: input?.description ?? "",
            status: "running",
            startTime: ts,
          });
        }
        if (block.name === "TaskCreate" || block.name === "TodoWrite") {
          const input = block.input;
          if (input?.todos && Array.isArray(input.todos)) {
            latestTodos = input.todos.map((t) => ({ content: t.content, status: t.status }));
          }
        }
      }

      if (block.type === "tool_result" && block.tool_use_id) {
        const agent = agentMap.get(block.tool_use_id);
        if (agent) {
          const text = typeof block.content === "string" ? block.content : (Array.isArray(block.content) ? block.content.map(c => c.text || "").join("") : "");
          if (text.includes("Async agent launched")) {
            const m = text.match(/agentId:\s*([a-zA-Z0-9]+)/);
            if (m) bgMap.set(m[1], block.tool_use_id);
          } else {
            agent.status = "completed";
            agent.endTime = ts;
          }
        }
        // Check TaskOutput completion
        if (block.content) {
          const text = typeof block.content === "string" ? block.content : (Array.isArray(block.content) ? block.content.map(c => c.text || "").join("") : "");
          const tidM = text.match(/<task_id>([^<]+)<\/task_id>/);
          const stM = text.match(/<status>([^<]+)<\/status>/);
          if (tidM && stM && stM[1] === "completed") {
            const origId = bgMap.get(tidM[1]);
            if (origId) {
              const bg = agentMap.get(origId);
              if (bg && bg.status === "running") { bg.status = "completed"; bg.endTime = ts; }
            }
          }
        }
      }
    }
  }

  try {
    const stat = statSync(transcriptPath);
    if (stat.size > MAX_TAIL_BYTES) {
      // For session start, read just the first line
      const fd = openSync(transcriptPath, "r");
      const firstBuf = Buffer.alloc(Math.min(4096, stat.size));
      try { readSync(fd, firstBuf, 0, firstBuf.length, 0); } finally { closeSync(fd); }
      const firstLine = firstBuf.toString("utf8").split("\n")[0];
      if (firstLine.trim()) {
        try {
          const e = JSON.parse(firstLine);
          if (e.timestamp) result.sessionStart = new Date(e.timestamp);
        } catch { /* */ }
      }
      // Then tail-read for agents
      for (const line of readTailLines(transcriptPath, stat.size, MAX_TAIL_BYTES)) processLine(line);
    } else {
      const stream = createReadStream(transcriptPath);
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) processLine(line);
    }
  } catch { /* partial results */ }

  // Mark stale agents
  const now = Date.now();
  for (const a of agentMap.values()) {
    if (a.status === "running" && now - a.startTime.getTime() > STALE_AGENT_MS) {
      a.status = "completed";
    }
  }

  const running = [...agentMap.values()].filter((a) => a.status === "running");
  const completed = [...agentMap.values()].filter((a) => a.status === "completed");
  result.agents = [...running, ...completed.slice(-(10 - running.length))].slice(0, 10);
  result.todos = latestTodos;
  return result;
}

// ── Rendering ──────────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function colorForPercent(pct, warnAt = 70, critAt = 85) {
  if (pct >= critAt) return c.red;
  if (pct >= warnAt) return c.yellow;
  return c.green;
}

function contextBar(pct) {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  const color = colorForPercent(pct);
  return `${color}[${"█".repeat(filled)}${"░".repeat(empty)}]${pct}%${c.reset}`;
}

function formatResetTime(resetDate) {
  if (!resetDate) return "";
  const d = resetDate instanceof Date ? resetDate : new Date(resetDate);
  if (isNaN(d.getTime())) return "";
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return "";
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const short = h > 0 ? `~${h}h` : `${m}m`;
  return `${c.slate600}(${short})${c.reset}`;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function padAnsi(str, width) {
  const visible = stripAnsi(str).length;
  const padding = Math.max(0, width - visible);
  return str + " ".repeat(padding);
}



function render(usage, usageStale, transcript, contextPct, modelId, version, latestVersion, cost, stdinData, config, codexUsage) {
  const pipe = `${c.slate800}│`;
  const show = (id) => config.columns.includes(id);
  // Dimmed color still shows the real value's severity (red/yellow/green), just softened to signal "from cache".
  const dimIfStale = (color) => (usageStale ? `${c.dim}${color}` : color);

  // ── Build columns: { label, value } ──
  const columns = [];

  // 5h rate limit
  if (show("5h Usage")) {
    let fhValue;
    if (usage) {
      const fhColor = dimIfStale(colorForPercent(usage.fiveHour, 60, 80));
      const fhReset = formatResetTime(usage.fiveHourResets);
      fhValue = `${fhColor}${Math.round(usage.fiveHour)}%${c.reset}${fhReset ? ` ${dimIfStale(fhReset)}` : ""}`;
    } else {
      fhValue = `${c.slate600}N/A${c.reset}`;
    }
    columns.push({ label: `${c.slate800bold}5h Usage:${c.reset}`, value: fhValue });
  }

  // 7d rate limit
  if (show("7d Usage")) {
    let wkValue;
    if (usage) {
      const wkColor = dimIfStale(colorForPercent(usage.sevenDay, 60, 80));
      const wkReset = formatResetTime(usage.sevenDayResets);
      wkValue = `${wkColor}${Math.round(usage.sevenDay)}%${c.reset}${wkReset ? ` ${dimIfStale(wkReset)}` : ""}`;
    } else {
      wkValue = `${c.slate600}N/A${c.reset}`;
    }
    columns.push({ label: `${c.slate800bold}7d Usage:${c.reset}`, value: wkValue });
  }

  // Context
  if (show("Context")) {
    const ctxColor = colorForPercent(contextPct);
    const ctxValue = `${ctxColor}${contextPct}%${c.reset} ${c.slate600}Used${c.reset}`;
    columns.push({ label: `${c.slate800bold}Context:${c.reset}`, value: ctxValue });
  }

  // Changes
  if (show("Changes")) {
    const added = cost?.total_lines_added ?? 0;
    const removed = cost?.total_lines_removed ?? 0;
    let chgValue;
    if (added || removed) {
      chgValue = `${c.green}+${added}${c.reset}${c.slate600}/${c.reset}${c.red}-${removed}${c.reset}`;
    } else {
      chgValue = `${c.slate600}+0/-0${c.reset}`;
    }
    columns.push({ label: `${c.slate800bold}Changes:${c.reset}`, value: chgValue });
  }

  // Session
  if (show("Session")) {
    const durationMs = cost?.total_duration_ms ?? 0;
    const sessionVal = durationMs > 0 ? formatDuration(durationMs) : "N/A";
    columns.push({ label: `${c.slate800bold}Session:${c.reset}`, value: `${c.slate600}${sessionVal}${c.reset}` });
  }

  // Model
  if (show("Model")) {
    columns.push({ label: `${c.slate800bold}Model:${c.reset}`, value: `${c.slate600}${modelId}${c.reset}` });
  }

  // Codex rate limits (hidden when this machine has no Codex sessions)
  if (show("Codex") && codexUsage) {
    const sevenDayColor = colorForPercent(codexUsage.sevenDay.percent, 60, 80);
    const sevenDayReset = formatResetTime(codexUsage.sevenDay.resets);
    if (show("5h Codex")) {
      if (codexUsage.fiveHour) {
        const fiveHourColor = colorForPercent(codexUsage.fiveHour.percent, 60, 80);
        const fiveHourReset = formatResetTime(codexUsage.fiveHour.resets);
        columns.push({ label: `${c.slate800bold}5h Codex:${c.reset}`, value: `${fiveHourColor}${Math.round(codexUsage.fiveHour.percent)}%${c.reset}${fiveHourReset ? ` ${fiveHourReset}` : ""}` });
      } else {
        columns.push({ label: `${c.slate800bold}5h Codex:${c.reset}`, value: `${c.slate600}Uncapped${c.reset}` });
      }
    }
    columns.push({ label: `${c.slate800bold}7d Codex:${c.reset}`, value: `${sevenDayColor}${Math.round(codexUsage.sevenDay.percent)}%${c.reset}${sevenDayReset ? ` ${sevenDayReset}` : ""}` });
  }

  // Version
  if (show("Version")) {
    const displayVersion = version || latestVersion;
    if (displayVersion) {
      const dot = (version && latestVersion && version !== latestVersion)
        ? `${c.yellow}●${c.reset}` : `${c.green}●${c.reset}`;
      columns.push({ label: `${c.slate800bold}Version:${c.reset}`, value: `${dot} ${c.slate600}v${displayVersion}${c.reset}` });
    } else {
      columns.push({ label: `${c.slate800bold}Version:${c.reset}`, value: `${c.slate600}N/A${c.reset}` });
    }
  }

  // Directory
  if (show("Directory")) {
    const workDir = stdinData?.workspace?.current_dir ?? "N/A";
    columns.push({ label: `${c.slate800bold}Directory:${c.reset}`, value: `${c.slate600}${workDir}${c.reset}` });
  }

  // Cost (session cost in USD)
  if (show("Cost")) {
    const usd = cost?.total_cost_usd ?? 0;
    const costColor = usd >= 1 ? c.red : usd >= 0.25 ? c.yellow : c.green;
    columns.push({ label: `${c.slate800bold}Cost:${c.reset}`, value: `${costColor}$${usd.toFixed(2)}${c.reset}` });
  }

  // Tokens (input tokens in current context)
  if (show("Tokens")) {
    const cu = stdinData?.context_window?.current_usage;
    const total = (cu?.input_tokens ?? 0) + (cu?.cache_creation_input_tokens ?? 0) + (cu?.cache_read_input_tokens ?? 0);
    columns.push({ label: `${c.slate800bold}Tokens:${c.reset}`, value: `${c.slate600}${formatTokens(total)}${c.reset}` });
  }

  // Output Tokens (cumulative output tokens across session)
  if (show("Output Tokens")) {
    const outTokens = stdinData?.context_window?.total_output_tokens ?? 0;
    columns.push({ label: `${c.slate800bold}Out Tokens:${c.reset}`, value: `${c.slate600}${formatTokens(outTokens)}${c.reset}` });
  }

  // Cache (cache read vs total tokens)
  if (show("Cache")) {
    const cu = stdinData?.context_window?.current_usage;
    const cacheRead = cu?.cache_read_input_tokens ?? 0;
    const total = (cu?.input_tokens ?? 0) + (cu?.cache_creation_input_tokens ?? 0) + cacheRead;
    const cachePct = total > 0 ? Math.round((cacheRead / total) * 100) : 0;
    const cacheColor = cachePct >= 50 ? c.green : cachePct >= 20 ? c.yellow : c.slate600;
    columns.push({ label: `${c.slate800bold}Cache:${c.reset}`, value: `${cacheColor}${cachePct}%${c.reset} ${c.slate600}hit${c.reset}` });
  }

  // API Time (time spent waiting for API responses)
  if (show("API Time")) {
    const apiMs = cost?.total_api_duration_ms ?? 0;
    const apiVal = apiMs > 0 ? formatDuration(apiMs) : "N/A";
    columns.push({ label: `${c.slate800bold}API Time:${c.reset}`, value: `${c.slate600}${apiVal}${c.reset}` });
  }

  // 5h Reset (standalone countdown)
  if (show("5h Reset")) {
    const resetStr = usage?.fiveHourResets ? formatResetTime(usage.fiveHourResets) : `${c.slate600}N/A${c.reset}`;
    columns.push({ label: `${c.slate800bold}5h Reset:${c.reset}`, value: resetStr || `${c.slate600}N/A${c.reset}` });
  }

  // 7d Reset (standalone countdown)
  if (show("7d Reset")) {
    const resetStr = usage?.sevenDayResets ? formatResetTime(usage.sevenDayResets) : `${c.slate600}N/A${c.reset}`;
    columns.push({ label: `${c.slate800bold}7d Reset:${c.reset}`, value: resetStr || `${c.slate600}N/A${c.reset}` });
  }

  const layout = config.layout || "vertical";
  const blankLine = `\n${c.reset}\u200B`;
  let output;

  if (layout === "horizontal") {
    // ── Horizontal: single row with "label value" cells ──
    const hRow = c.reset + columns.map((col) => `${col.label} ${col.value}`).join(` ${pipe} `) + c.reset;
    output = hRow;
  } else {
    // ── Vertical (default): labels on row 1, values on row 2 ──
    const colWidths = columns.map((col) => {
      const labelLen = stripAnsi(col.label).length;
      const valueLen = stripAnsi(col.value).length;
      return Math.max(labelLen, valueLen);
    });
    const labelRow = c.reset + columns.map((col, i) => padAnsi(col.label, colWidths[i])).join(` ${pipe} `) + c.reset;
    const valueRow = c.reset + columns.map((col, i) => padAnsi(col.value, colWidths[i])).join(` ${pipe} `) + c.reset;
    output = labelRow + "\n" + valueRow;
  }

  // ── Line 3: Agents, Agent name, Todos (only if any exist) ──
  const line3 = [];
  const running = transcript.agents.filter((a) => a.status === "running");

  if (running.length > 0) {
    line3.push(`${c.slate800bold}Agents:${c.reset} ${c.cyan}${running.length}${c.reset}`);
  }

  const agentName = stdinData?.agent?.name;
  if (agentName) {
    line3.push(`${c.slate800bold}Agent:${c.reset} ${c.magenta}${agentName}${c.reset}`);
  }

  if (transcript.todos.length > 0) {
    const done = transcript.todos.filter((t) => t.status === "completed").length;
    const total = transcript.todos.length;
    const todoColor = done === total ? c.green : c.yellow;
    line3.push(`${c.slate800bold}Todos:${c.reset} ${todoColor}${done}/${total}${c.reset}`);
  }

  if (line3.length > 0) {
    const line3Sep = ` ${pipe} `;
    output += blankLine + "\n" + c.reset + line3.join(line3Sep);
  }

  // Agent detail tree
  const agentLines = [];
  if (running.length > 0) {
    for (let i = 0; i < running.length && i < 5; i++) {
      const a = running[i];
      const isLast = i === running.length - 1 || i === 4;
      const prefix = isLast ? "└─" : "├─";
      const elapsed = formatDuration(Date.now() - a.startTime.getTime());
      const type = (a.type || "agent").substring(0, 14);
      const desc = (a.description || "").substring(0, 45);
      const modelLabel = a.model === "opus" ? `${c.magenta}Opus${c.reset}` : a.model === "haiku" ? `${c.green}Haiku${c.reset}` : `${c.cyan}Sonnet${c.reset}`;
      agentLines.push(`${c.reset}${c.slate800}${prefix}${c.reset} ${c.white}${type}${c.reset} ${modelLabel} ${c.slate600}${elapsed.padStart(5)}${c.reset}   ${c.slate600}${desc}${c.reset}`);
    }
  }

  if (agentLines.length > 0) {
    output += "\n" + agentLines.join("\n");
  }

  return (output + blankLine + "\n").replace(/ /g, "\u00A0");
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const stdin = await readStdin();
  if (!stdin) {
    console.log(`${c.dim}[HUD] waiting for data...${c.reset}`);
    return;
  }

  const config = readConfig();
  const contextPct = getContextPercent(stdin);
  const modelId = getModelId(stdin);
  const version = getVersion(stdin);

  // Run usage APIs, transcript parsing, and version check concurrently
  const [usageResult, transcript, latestVersion, codexUsage] = await Promise.all([
    getUsage(CLAUDE_USAGE_SOURCE, config.usage),
    parseTranscript(stdin.transcript_path),
    getLatestVersion(),
    config.columns.includes("Codex") ? getCodexUsage(config.usage) : null,
  ]);

  console.log(render(usageResult.data, usageResult.stale, transcript, contextPct, modelId, version, latestVersion, stdin.cost, stdin, config, codexUsage));
}

main().catch((err) => {
  console.log(`[HUD] error: ${err.message}`);
});
