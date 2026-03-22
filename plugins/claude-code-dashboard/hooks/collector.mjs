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

const CWD_FILTER_PREFIX = join(homedir(), "work", "company");
const DASH_DIR = join(homedir(), ".claude", "claude-dash");
const BUFFER_FILE = join(DASH_DIR, "event-buffer.jsonl");
const CONFIG_FILE = join(DASH_DIR, "config.json");
const FAILED_DIR = join(DASH_DIR, "failed");
const ERROR_LOG = join(DASH_DIR, "error.log");

const INGEST_URL = process.env.CLAUDE_DASH_INGEST_URL || "";
const INGEST_API_KEY = process.env.CLAUDE_DASH_API_KEY || "";

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

function cwdMatchesFilter(cwd) {
  if (!cwd) return false;
  return resolve(cwd).startsWith(CWD_FILTER_PREFIX);
}

function extractWorkspace(cwd) {
  if (!cwd) return "unknown";
  const resolved = resolve(cwd);
  if (!resolved.startsWith(CWD_FILTER_PREFIX)) return "unknown";
  const relative = resolved.slice(CWD_FILTER_PREFIX.length + 1);
  return relative.split("/")[0] || "unknown";
}

function getUserEmail() {
  // 1. git config user.email
  try {
    const email = execSync("git config user.email", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (email) return email;
  } catch { /* ignore */ }

  // 2. environment variable
  if (process.env.CLAUDE_DASH_USER_EMAIL) {
    return process.env.CLAUDE_DASH_USER_EMAIL;
  }

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

function loadAndClearFailedEvents() {
  if (!existsSync(FAILED_DIR)) return [];
  const events = [];
  try {
    const files = readdirSync(FAILED_DIR).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const path = join(FAILED_DIR, file);
      try {
        const content = readFileSync(path, "utf-8").trim();
        if (content) {
          for (const line of content.split("\n")) {
            try { events.push(JSON.parse(line)); } catch { /* skip */ }
          }
        }
        unlinkSync(path);
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return events;
}

// ── Send to Ingest API ──────────────────────────────────────────────────────

async function sendToIngest(events, maxRetries = 3) {
  if (!INGEST_URL || !INGEST_API_KEY || !events.length) return false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(INGEST_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INGEST_API_KEY}`,
        },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      // 4xx (except 429) → don't retry
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        logError("sendToIngest", `HTTP ${res.status} - not retryable`);
        return false;
      }
    } catch (err) {
      logError("sendToIngest", `attempt ${attempt + 1}: ${err.message}`);
    }
    // Exponential backoff: 1s, 2s, 4s
    if (attempt < maxRetries - 1) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  return false;
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

  // 2. Clear this session's buffer (transcript is the authority)
  clearBuffer();

  // 3. Pick up failed events from previous crashed sessions
  const failedEvents = loadAndClearFailedEvents();

  const allEvents = [...failedEvents, ...transcriptEvents];
  if (!allEvents.length) return;

  // 4. Send to Ingest API
  const ok = await sendToIngest(allEvents);
  if (!ok) {
    saveFailedEvents(allEvents);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2]; // "post-tool-use" | "stop"

  try {
    const input = await readStdin();
    const cwd = input.cwd || "";

    // cwd filter: only ~/work/company/ 配下を計測
    if (!cwdMatchesFilter(cwd)) {
      console.log("{}");
      process.exit(0);
    }

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
