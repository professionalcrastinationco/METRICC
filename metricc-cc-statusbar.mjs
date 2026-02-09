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

// ── Constants ──────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60_000;          // 60s cache for usage API
const CACHE_TTL_FAILURE_MS = 15_000;  // 15s on failure
const API_TIMEOUT_MS = 8000;
const MAX_TAIL_BYTES = 512 * 1024;    // 500KB tail read for large transcripts
const MAX_AGENT_MAP = 100;
const STALE_AGENT_MS = 30 * 60_000;   // 30 min = stale agent
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const VERSION_CACHE_TTL_MS = 3_600_000; // 1hr cache for npm version check

const HOME = homedir();
const CACHE_PATH = join(HOME, ".claude", "hud", ".usage-cache.json");
const VERSION_CACHE_PATH = join(HOME, ".claude", "hud", ".version-cache.json");
const CRED_PATH = join(HOME, ".claude", ".credentials.json");

// ── ANSI Colors ────────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

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
  try {
    if (!existsSync(CRED_PATH)) return null;
    const parsed = JSON.parse(readFileSync(CRED_PATH, "utf-8"));
    const creds = parsed.claudeAiOauth || parsed;
    if (!creds.accessToken) return null;
    return { accessToken: creds.accessToken, expiresAt: creds.expiresAt, refreshToken: creds.refreshToken };
  } catch {
    return null;
  }
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
  return `${c.dim}(${formatDuration(ms)})${c.reset}`;
}

function render(usage, transcript, contextPct, modelId, version, latestVersion, cost) {
  const parts = [];

  // Rate limits
  if (usage) {
    const fhColor = colorForPercent(usage.fiveHour, 60, 80);
    const wkColor = colorForPercent(usage.sevenDay, 60, 80);
    const fhReset = formatResetTime(usage.fiveHourResets);
    const wkReset = formatResetTime(usage.sevenDayResets);
    parts.push(`${c.gray}5h:${c.reset} ${fhColor}${Math.round(usage.fiveHour)}%${c.reset}${fhReset ? ` ${fhReset}` : ""}`);
    parts.push(`${c.gray}7d:${c.reset} ${wkColor}${Math.round(usage.sevenDay)}%${c.reset}${wkReset ? ` ${wkReset}` : ""}`);
  } else {
    parts.push(`${c.gray}5h: --${c.reset}`);
    parts.push(`${c.gray}7d: --${c.reset}`);
  }

  // Context window
  const ctxColor = colorForPercent(contextPct);
  parts.push(`${c.gray}Context:${c.reset} ${ctxColor}${contextPct}%${c.reset}`);

  // Lines changed
  const added = cost?.total_lines_added ?? 0;
  const removed = cost?.total_lines_removed ?? 0;
  if (added || removed) {
    parts.push(`${c.gray}Changes:${c.reset} ${c.green}+${added}${c.reset}${c.dim}/${c.reset}${c.red}-${removed}${c.reset}`);
  } else {
    parts.push(`${c.gray}Changes:${c.reset} ${c.dim}+0/-0${c.reset}`);
  }

  // Agents
  const running = transcript.agents.filter((a) => a.status === "running");
  if (running.length > 0) {
    parts.push(`${c.gray}Agents:${c.reset} ${c.cyan}${running.length}${c.reset}`);
  }

  // Todos
  if (transcript.todos.length > 0) {
    const done = transcript.todos.filter((t) => t.status === "completed").length;
    const total = transcript.todos.length;
    const todoColor = done === total ? c.green : c.yellow;
    parts.push(`${c.gray}Todos:${c.reset} ${todoColor}${done}/${total}${c.reset}`);
  }

  // Model ID
  parts.push(`${c.dim}${modelId}${c.reset}`);

  // CC version + update status
  const displayVersion = version || latestVersion;
  if (displayVersion) {
    let versionStatus = "";
    if (version && latestVersion) {
      versionStatus = version === latestVersion
        ? ` ${c.dim}(latest)${c.reset}`
        : ` ${c.yellow}(update avail)${c.reset}`;
    } else if (!version && latestVersion) {
      versionStatus = ` ${c.dim}(latest)${c.reset}`;
    }
    parts.push(`${c.dim}CC v${displayVersion}${c.reset}${versionStatus}`);
  }

  // Main line
  const mainLine = parts.join(` ${c.dim}|${c.reset} `);

  // Agent detail lines
  const agentLines = [];
  if (running.length > 0) {
    for (let i = 0; i < running.length && i < 5; i++) {
      const a = running[i];
      const isLast = i === running.length - 1 || i === 4;
      const prefix = isLast ? "└─" : "├─";
      const elapsed = formatDuration(Date.now() - a.startTime.getTime());
      const type = (a.type || "agent").substring(0, 14).padEnd(14);
      const desc = (a.description || "").substring(0, 45);
      const modelBadge = a.model === "opus" ? `${c.magenta}O${c.reset}` : a.model === "haiku" ? `${c.green}h${c.reset}` : `${c.cyan}s${c.reset}`;
      agentLines.push(`${c.dim}${prefix}${c.reset} ${modelBadge} ${c.white}${type}${c.reset} ${c.dim}${elapsed.padStart(5)}${c.reset}   ${c.gray}${desc}${c.reset}`);
    }
  }

  const output = agentLines.length > 0 ? mainLine + "\n" + agentLines.join("\n") : mainLine;
  return output + "\n";
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const stdin = await readStdin();
  if (!stdin) {
    console.log(`${c.dim}[HUD] waiting for data...${c.reset}`);
    return;
  }

  const contextPct = getContextPercent(stdin);
  const modelId = getModelId(stdin);
  const version = getVersion(stdin);

  // Run usage API, transcript parsing, and version check concurrently
  const [usage, transcript, latestVersion] = await Promise.all([
    getUsage(),
    parseTranscript(stdin.transcript_path),
    getLatestVersion(),
  ]);

  console.log(render(usage, transcript, contextPct, modelId, version, latestVersion, stdin.cost));
}

main().catch((err) => {
  console.log(`[HUD] error: ${err.message}`);
});
