#!/usr/bin/env node
/**
 * Custom HUD - Standalone Claude Code Statusline
 * No plugin dependencies. Shows: rate limits, session time, context %, agents.
 *
 * Data sources:
 * - stdin JSON from Claude Code (context window, model, transcript path)
 * - Anthropic OAuth API (5h/7d rate limits) — cached 60s
 * - Transcript JSONL (session start, running agents)
 */

import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, mkdirSync, createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createInterface } from "node:readline";
import https from "node:https";
import { execSync } from "node:child_process";

// ── Constants ──────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60_000;          // 60s cache for usage API
const CACHE_TTL_FAILURE_MS = 15_000;  // 15s on failure
const API_TIMEOUT_MS = 8000;
const MAX_TAIL_BYTES = 512 * 1024;    // 500KB tail read for large transcripts
const MAX_AGENT_MAP = 100;
const STALE_AGENT_MS = 30 * 60_000;   // 30 min = stale agent
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const VERSION_CACHE_TTL_MS = 3_600_000; // 1hr cache for npm version check

const ALL_COLUMNS = [
  // Standard
  "5h Usage", "7d Usage", "Context", "Model", "Version",
  // Session
  "Session", "Changes", "Directory", "Cost",
  // Advanced
  "Tokens", "Output Tokens", "Cache", "API Time", "5h Reset", "7d Reset",
];

const HOME = homedir();
const CONFIG_PATH = join(HOME, ".claude", "hud", "config.jsonc");
const CACHE_PATH = join(HOME, ".claude", "hud", ".usage-cache.json");
const VERSION_CACHE_PATH = join(HOME, ".claude", "hud", ".version-cache.json");
const CRED_PATH = join(HOME, ".claude", ".credentials.json");

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
  "5h Usage": true, "7d Usage": true, "Context": true, "Model": true, "Version": true,
  // Session: off by default
  "Session": false, "Changes": false, "Directory": false, "Cost": false,
  // Advanced: off by default
  "Tokens": false, "Output Tokens": false, "Cache": false, "API Time": false, "5h Reset": false, "7d Reset": false,
};

function readConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) {
      return { columns: ALL_COLUMNS.filter((id) => SECTION_DEFAULTS[id] !== false), layout: "vertical" };
    }
    const cfg = parseJsonc(readFileSync(CONFIG_PATH, "utf-8"));
    const enabled = ALL_COLUMNS.filter((id) => {
      if (id in cfg) return cfg[id] !== false;
      return SECTION_DEFAULTS[id] !== false;
    });
    const layout = cfg.layout === "horizontal" ? "horizontal" : "vertical";
    return { columns: enabled.length > 0 ? enabled : ALL_COLUMNS, layout };
  } catch {
    return { columns: ALL_COLUMNS.filter((id) => SECTION_DEFAULTS[id] !== false), layout: "vertical" };
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
  const id = stdin.model?.id ?? stdin.model?.display_name ?? "unknown";
  // "claude-opus-4-6" → "Opus 4.6", "claude-sonnet-4-5-20250929" → "Sonnet 4.5"
  const m = id.match(/(?:claude-)?(opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (m) {
    const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return `${name} ${m[2]}.${m[3]}`;
  }
  return id;
}

function getVersion(stdin) {
  return stdin.version ?? null;
}

// ── Usage API (Anthropic OAuth) ────────────────────────────────────────────────
function readCache() {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
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

function writeCache(data, error = false) {
  try {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data, error }));
  } catch { /* ignore */ }
}

function isCacheValid(cache) {
  const ttl = cache.error ? CACHE_TTL_FAILURE_MS : CACHE_TTL_MS;
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

function fetchUsage(accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/api/oauth/usage",
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      let data = "";
      res.on("data", (ch) => { data += ch; });
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        } else resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function writeBackCredentials(creds) {
  try {
    if (!existsSync(CRED_PATH)) return;
    const parsed = JSON.parse(readFileSync(CRED_PATH, "utf-8"));
    const target = parsed.claudeAiOauth || parsed;
    target.accessToken = creds.accessToken;
    if (creds.expiresAt != null) target.expiresAt = creds.expiresAt;
    if (creds.refreshToken) target.refreshToken = creds.refreshToken;
    writeFileSync(CRED_PATH, JSON.stringify(parsed, null, 2));
  } catch { /* */ }
}

async function getUsage() {
  const cache = readCache();
  if (cache && isCacheValid(cache)) return cache.data;

  let creds = getCredentials();
  if (!creds) { writeCache(null, true); return null; }

  // Refresh if expired
  if (creds.expiresAt && creds.expiresAt <= Date.now()) {
    if (creds.refreshToken) {
      const refreshed = await refreshAccessToken(creds.refreshToken);
      if (refreshed) {
        creds = { ...creds, ...refreshed };
        writeBackCredentials(creds);
      } else {
        writeCache(null, true);
        return null;
      }
    } else {
      writeCache(null, true);
      return null;
    }
  }

  const resp = await fetchUsage(creds.accessToken);
  if (!resp) { writeCache(null, true); return null; }

  const clamp = (v) => (v == null || !isFinite(v)) ? 0 : Math.max(0, Math.min(100, v));
  const parseDate = (s) => { try { const d = new Date(s); return isNaN(d.getTime()) ? null : d; } catch { return null; } };

  const data = {
    fiveHour: clamp(resp.five_hour?.utilization),
    fiveHourResets: parseDate(resp.five_hour?.resets_at),
    sevenDay: clamp(resp.seven_day?.utilization),
    sevenDayResets: parseDate(resp.seven_day?.resets_at),
  };
  writeCache(data);
  return data;
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



function render(usage, transcript, contextPct, modelId, version, latestVersion, cost, stdinData, config) {
  const pipe = `${c.slate800}│`;
  const show = (id) => config.columns.includes(id);

  // ── Build columns: { label, value } ──
  const columns = [];

  // 5h rate limit
  if (show("5h Usage")) {
    let fhValue;
    if (usage) {
      const fhColor = colorForPercent(usage.fiveHour, 60, 80);
      const fhReset = formatResetTime(usage.fiveHourResets);
      fhValue = `${fhColor}${Math.round(usage.fiveHour)}%${c.reset}${fhReset ? ` ${fhReset}` : ""}`;
    } else {
      fhValue = `${c.slate600}N/A${c.reset}`;
    }
    columns.push({ label: `${c.slate800bold}5h Usage:${c.reset}`, value: fhValue });
  }

  // 7d rate limit
  if (show("7d Usage")) {
    let wkValue;
    if (usage) {
      const wkColor = colorForPercent(usage.sevenDay, 60, 80);
      const wkReset = formatResetTime(usage.sevenDayResets);
      wkValue = `${wkColor}${Math.round(usage.sevenDay)}%${c.reset}${wkReset ? ` ${wkReset}` : ""}`;
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

  // Run usage API, transcript parsing, and version check concurrently
  const [usage, transcript, latestVersion] = await Promise.all([
    getUsage(),
    parseTranscript(stdin.transcript_path),
    getLatestVersion(),
  ]);

  console.log(render(usage, transcript, contextPct, modelId, version, latestVersion, stdin.cost, stdin, config));
}

main().catch((err) => {
  console.log(`[HUD] error: ${err.message}`);
});
