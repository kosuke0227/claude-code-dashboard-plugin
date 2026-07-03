#!/usr/bin/env node

/**
 * Claude Code Dashboard - Usage Metrics Collector
 *
 * C案: PostToolUse → ローカルファイルにバッファ、Stop → まとめて Ingest API へ送信
 *
 * PostToolUse: Skill/Subagent/unknown_external イベントをローカルファイルにバッファ（クラッシュ保護）
 * Stop: セッションのトランスクリプト JSONL を解析し、全メトリクスを抽出して Ingest API へ送信
 *       - トランスクリプト解析が権威データソース（トークン/モデル情報含む）
 *       - バッファは Stop が呼ばれなかった（クラッシュ）セッションの復旧用
 *
 * Privacy: メタデータ/イベント種別のみ収集。会話本文は送信しない。
 */

import {
  readFileSync, writeFileSync, appendFileSync,
  existsSync, mkdirSync, unlinkSync, readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// ── Configuration ──────────────────────────────────────────────────────────

// CWD_FILTER_PREFIX is no longer used — all directories are tracked.
const DASH_DIR = join(homedir(), ".claude", "claude-dash");
const BUFFER_FILE = join(DASH_DIR, "event-buffer.jsonl");
const CONFIG_FILE = join(DASH_DIR, "config.json");
const FAILED_DIR = join(DASH_DIR, "failed");
const ERROR_LOG = join(DASH_DIR, "error.log");

// Ingest payload limits — keep headroom under the server's caps (2MB body / 1000
// events) so a single request can never trip HTTP 413/400. Without this guard a
// failed queue snowballs and stays stuck in a permanent 413 loop.
const MAX_EVENTS_PER_REQUEST = 500;
const MAX_BYTES_PER_REQUEST = 1_500_000;
// Drain a large failed backlog gradually so the Stop hook never blocks on a huge
// queue, and an oversized queue can self-recover instead of failing forever.
const MAX_BACKLOG_EVENTS_PER_SESSION = 2000;

// env vars → .env ファイルフォールバック（デスクトップアプリ等で .zshrc が読まれない場合の対策）
function loadEnvFallback(key) {
  if (process.env[key]) return process.env[key];
  const envFile = join(DASH_DIR, ".env");
  try {
    if (existsSync(envFile)) {
      // 先頭 BOM を除去（メモ帳等が UTF-8 BOM で保存すると 1 行目がマッチしなくなるため）
      const content = readFileSync(envFile, "utf-8").replace(/^﻿/, "");
      // 同一キーが重複した場合は最後の一致を採用（値を打ち直して追記した際、古い誤値が勝たないように）
      const matches = [...content.matchAll(new RegExp(`^${key}=(.+)$`, "gm"))];
      if (matches.length) return matches[matches.length - 1][1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* ignore */ }
  return "";
}

const INGEST_URL = loadEnvFallback("CLAUDE_DASH_INGEST_URL");
const INGEST_API_KEY = loadEnvFallback("CLAUDE_DASH_API_KEY");

// Built-in tools — everything else is potentially MCP or custom
const BUILTIN_TOOLS = new Set([
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep",
  "Agent", "Task",
  "Skill",
  "ToolSearch",
  "WebFetch", "WebSearch",
  "NotebookEdit",
  "AskUserQuestion",
  "TodoRead", "TodoWrite",
  "CronCreate", "CronDelete", "CronList",
  "EnterPlanMode", "ExitPlanMode",
  "EnterWorktree", "ExitWorktree",
  "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
  "Config",
  "SendMessage",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const dir of [DASH_DIR, FAILED_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function logError(context, err) {
  try {
    ensureDirs();
    const msg = `[${new Date().toISOString()}] [${context}] ${err?.message || err}\n`;
    appendFileSync(ERROR_LOG, msg, "utf-8");
  } catch {
    // swallow
  }
}

function extractWorkspace(cwd) {
  if (!cwd) return "unknown";
  const resolved = resolve(cwd);

  // 1. Try git repo root name (most accurate for project identification)
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      timeout: 3000,
      cwd: resolved,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (gitRoot) {
      const name = gitRoot.split("/").pop();
      if (name) return name;
    }
  } catch { /* not a git repo — fall through */ }

  // 2. Fall back to directory basename
  const name = resolved.split("/").pop();
  return name || "unknown";
}

function getUserEmail() {
  // 1. environment variable or .env ファイル (明示的な上書き — git config より優先)
  const envEmail = loadEnvFallback("CLAUDE_DASH_USER_EMAIL");
  if (envEmail) return envEmail;

  // 2. git config user.email
  try {
    const email = execSync("git config user.email", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (email) return email;
  } catch { /* ignore */ }

  // 3. local config file
  try {
    if (existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      if (cfg.user_email) return cfg.user_email;
    }
  } catch { /* ignore */ }

  // 4. OS username (fallback)
  return process.env.USER || "unknown";
}

function classifyTool(toolName, toolInput) {
  if (toolName === "Skill") {
    return { event_type: "skill", event_name: toolInput?.skill || "unknown" };
  }
  if (toolName === "Agent" || toolName === "Task") {
    return {
      event_type: "subagent",
      event_name: toolInput?.subagent_type || "general-purpose",
      event_detail: toolInput?.description || "",
    };
  }
  if (BUILTIN_TOOLS.has(toolName)) {
    return { event_type: "builtin_tool", event_name: toolName };
  }
  // Unknown → possibly MCP, stored separately
  return { event_type: "unknown_external", event_name: toolName };
}

// ── stdin reading ───────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error(`stdin parse error: ${e.message}`)); }
    });
    process.stdin.on("error", reject);
    setTimeout(() => reject(new Error("stdin read timeout")), 4000);
  });
}

// ── Buffer operations ───────────────────────────────────────────────────────

function appendToBuffer(event) {
  ensureDirs();
  appendFileSync(BUFFER_FILE, JSON.stringify(event) + "\n", "utf-8");
}

function readBuffer() {
  if (!existsSync(BUFFER_FILE)) return [];
  try {
    const content = readFileSync(BUFFER_FILE, "utf-8").trim();
    if (!content) return [];
    return content.split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function clearBuffer() {
  try { if (existsSync(BUFFER_FILE)) unlinkSync(BUFFER_FILE); } catch { /* ignore */ }
}

function saveFailedEvents(events) {
  if (!events.length) return;
  ensureDirs();
  const file = join(FAILED_DIR, `failed-${Date.now()}.jsonl`);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

// Load up to `limit` events from the failed/ backlog so a large queue drains
// gradually instead of being re-sent (and re-failing) all at once. A fully
// consumed file is removed; a partially consumed file is rewritten with its
// remainder. Files beyond the limit are left untouched for the next session.
function loadFailedEvents(limit = MAX_BACKLOG_EVENTS_PER_SESSION) {
  if (!existsSync(FAILED_DIR)) return [];
  const events = [];
  try {
    const files = readdirSync(FAILED_DIR).filter((f) => f.endsWith(".jsonl")).sort();
    for (const file of files) {
      if (events.length >= limit) break;
      const path = join(FAILED_DIR, file);
      try {
        const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
        const room = limit - events.length;
        if (lines.length <= room) {
          for (const line of lines) {
            try { events.push(JSON.parse(line)); } catch { /* skip */ }
          }
          unlinkSync(path);
        } else {
          for (let i = 0; i < room; i++) {
            try { events.push(JSON.parse(lines[i])); } catch { /* skip */ }
          }
          writeFileSync(path, lines.slice(room).join("\n") + "\n", "utf-8");
        }
      } catch { /* skip unreadable file */ }
    }
  } catch { /* ignore */ }
  return events;
}

// ── Send to Ingest API ──────────────────────────────────────────────────────

// Approximate JSON byte size of one event, plus a small overhead for the array
// separators in the final payload.
function eventByteSize(event) {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf-8") + 2;
  } catch {
    return MAX_BYTES_PER_REQUEST; // unserializable → isolate it (dropped if it can't fit)
  }
}

// Greedily split events into chunks that respect BOTH the event-count and the
// payload-size limits, keeping headroom under the server's 2MB / 1000 caps.
function chunkEvents(events) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const ev of events) {
    const size = eventByteSize(ev);
    if (current.length >= MAX_EVENTS_PER_REQUEST ||
        (current.length > 0 && currentBytes + size > MAX_BYTES_PER_REQUEST)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(ev);
    currentBytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// POST a single chunk. Returns:
//   "ok"        → accepted
//   "too_large" → HTTP 413, caller should split and retry
//   "drop"      → other non-retryable 4xx (bad data) → discard, never re-queue
//   "retry"     → 5xx / 429 / network error after retries → keep for next session
async function postChunk(events, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(INGEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INGEST_API_KEY}`,
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return "ok";
      if (res.status === 413) return "too_large";
      // Other 4xx (except 429) → not retryable; discard to avoid a poison-pill loop.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        logError("postChunk", `HTTP ${res.status} - dropping ${events.length} event(s)`);
        return "drop";
      }
      // 5xx / 429 → fall through to retry
    } catch (err) {
      logError("postChunk", `attempt ${attempt + 1}: ${err.message}`);
    }
    // Exponential backoff: 1s, 2s, 4s
    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  return "retry";
}

// Send a chunk, halving it on 413 until it fits. A single event that still 413s
// can never fit, so it is dropped (logged). Returns events to re-queue (transient
// failures only); sent and permanently-rejected events are not returned.
async function sendChunkWithSplit(events) {
  const status = await postChunk(events);
  if (status === "ok" || status === "drop") return [];
  if (status === "retry") return events;
  // status === "too_large"
  if (events.length <= 1) {
    logError("sendChunkWithSplit", `single event exceeds size limit - dropping event_id=${events[0]?.event_id}`);
    return [];
  }
  const mid = Math.floor(events.length / 2);
  const left = await sendChunkWithSplit(events.slice(0, mid));
  const right = await sendChunkWithSplit(events.slice(mid));
  return [...left, ...right];
}

// Send all events in size-bounded chunks. Returns events that should be re-queued
// (transient failures). When the endpoint is unconfigured, everything is kept.
async function sendEvents(events) {
  if (!events.length) return [];
  if (!INGEST_URL || !INGEST_API_KEY) return events;
  const leftover = [];
  for (const chunk of chunkEvents(events)) {
    const requeue = await sendChunkWithSplit(chunk);
    if (requeue.length) leftover.push(...requeue);
  }
  return leftover;
}

// ── Transcript parsing ──────────────────────────────────────────────────────

async function parseTranscript(transcriptPath, sessionId, cwd) {
  if (!transcriptPath || !existsSync(transcriptPath)) return [];

  const userEmail = getUserEmail();
  const workspace = extractWorkspace(cwd);
  const now = new Date().toISOString();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let messageCount = 0;
  let model = "unknown";
  let ccVersion = "unknown";
  const toolCounts = new Map(); // "type:name" → count

  const rl = createInterface({
    input: createReadStream(transcriptPath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.version) ccVersion = entry.version;
    if (entry.type !== "assistant" || !entry.message) continue;

    const msg = entry.message;
    if (msg.model) model = msg.model;

    if (msg.usage) {
      totalInputTokens += msg.usage.input_tokens || 0;
      totalOutputTokens += msg.usage.output_tokens || 0;
      totalCacheReadTokens += msg.usage.cache_read_input_tokens || 0;
      totalCacheCreationTokens += msg.usage.cache_creation_input_tokens || 0;
    }

    messageCount++;

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type !== "tool_use") continue;
        const c = classifyTool(block.name, block.input);
        const key = `${c.event_type}:${c.event_name}`;
        toolCounts.set(key, (toolCounts.get(key) || 0) + 1);
      }
    }
  }

  const base = { session_id: sessionId, user_email: userEmail, timestamp: now, model, cwd, workspace, claude_code_version: ccVersion };

  const events = [];

  // Session summary (tokens / messages)
  events.push({
    ...base,
    event_id: randomUUID(),
    event_type: "session_summary",
    event_name: "session",
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    cache_read_tokens: totalCacheReadTokens,
    cache_creation_tokens: totalCacheCreationTokens,
    message_count: messageCount,
    count: 1,
  });

  // Per-tool counts
  for (const [key, count] of toolCounts) {
    const [eventType, eventName] = key.split(":");
    events.push({
      ...base,
      event_id: randomUUID(),
      event_type: eventType,
      event_name: eventName,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      message_count: 0,
      count,
    });
  }

  return events;
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function handlePostToolUse(input) {
  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  const classified = classifyTool(toolName, toolInput);

  // Only buffer interesting events (skip built-in tools)
  if (classified.event_type === "builtin_tool") return;

  const cwd = input.cwd || "";
  const event = {
    event_id: randomUUID(),
    session_id: input.session_id || "unknown",
    user_email: getUserEmail(),
    timestamp: new Date().toISOString(),
    event_type: classified.event_type,
    event_name: classified.event_name,
    event_detail: classified.event_detail || "",
    model: "unknown",
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0,
    message_count: 0, count: 1,
    cwd,
    workspace: extractWorkspace(cwd),
    claude_code_version: "unknown",
  };

  appendToBuffer(event);
}

async function handleStop(input) {
  const sessionId = input.session_id || "unknown";
  const cwd = input.cwd || "";
  const transcriptPath = input.transcript_path || "";

  // 1. Parse transcript (authoritative data with tokens/model)
  const transcriptEvents = await parseTranscript(transcriptPath, sessionId, cwd);

  // 2. Read buffer events (fallback if transcript is empty/unavailable)
  const bufferEvents = readBuffer();
  clearBuffer();

  // 3. Pick up a bounded slice of failed events from previous sessions
  const failedEvents = loadFailedEvents();

  // 4. Fresh session data first (priority), then the older backlog
  const sessionEvents = transcriptEvents.length > 0 ? transcriptEvents : bufferEvents;
  const allEvents = [...sessionEvents, ...failedEvents];
  if (!allEvents.length) return;

  // 5. Send in size-bounded chunks; only transient failures are re-queued
  const leftover = await sendEvents(allEvents);
  if (leftover.length) saveFailedEvents(leftover);
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2]; // "post-tool-use" | "stop"

  try {
    const input = await readStdin();
    const cwd = input.cwd || "";

    if (mode === "post-tool-use") {
      await handlePostToolUse(input);
    } else if (mode === "stop") {
      await handleStop(input);
    }
  } catch (err) {
    logError(mode, err);
  }

  // Hooks must always output JSON and exit 0
  console.log("{}");
  process.exit(0);
}

main();
