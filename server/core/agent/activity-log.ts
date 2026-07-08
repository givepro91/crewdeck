/**
 * Agent Activity Log — in-memory ring buffer of recent agent activity.
 *
 * Purpose: the dashboard "라이브 활동" view needs to show what an agent is
 * actively doing (running a command, reading/editing a file, thinking) so the
 * user can tell a busy agent apart from a stuck one. Claude Code CLI already
 * streams stream-json output through `session.on("output")`; this module turns
 * those events into a bounded, human-readable activity feed per agent.
 *
 * Design is split into pure, testable pieces:
 *   - `parseActivityEvents(line)` — pure stream-json line → activity events
 *   - `AgentActivityRing`         — pure bounded ring buffer (last 50)
 *   - `ActivityLogStore`          — per-agent rings + throttled broadcast
 */

export interface ActivityEvent {
  /** ISO timestamp when recorded */
  ts: string;
  /** command | file_read | file_edit | search | text | tool */
  kind: string;
  /** Short human-readable detail, truncated to ACTIVITY_DETAIL_MAX chars */
  detail: string;
}

export interface ActivitySnapshot {
  lastEventAt: string | null;
  events: ActivityEvent[];
}

/** Keep the most recent N activity events per agent. */
export const ACTIVITY_RING_SIZE = 50;
/** Details longer than this are truncated (single-line, whitespace-collapsed). */
export const ACTIVITY_DETAIL_MAX = 200;

/** Collapse whitespace to a single line and hard-cap length. Pure. */
export function truncateDetail(raw: unknown, max = ACTIVITY_DETAIL_MAX): string {
  const clean = String(raw ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** Claude Code tool name → activity kind. Unknown tools fall back to "tool". */
const TOOL_KIND: Record<string, string> = {
  Bash: "command",
  Read: "file_read",
  Edit: "file_edit",
  Write: "file_edit",
  MultiEdit: "file_edit",
  NotebookEdit: "file_edit",
  Grep: "search",
  Glob: "search",
};

/** Summarize a tool_use block into { kind, detail }. Pure. */
function summarizeTool(name: string, input: unknown): { kind: string; detail: string } {
  const kind = TOOL_KIND[name] ?? "tool";
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  let detail = "";
  if (name === "Bash") {
    detail = String(inp.command ?? "");
  } else if (kind === "file_edit" || name === "Read") {
    detail = String(inp.file_path ?? inp.notebook_path ?? inp.path ?? "");
  } else if (name === "Grep" || name === "Glob") {
    detail = [inp.pattern, inp.path].filter(Boolean).join(" ");
  } else {
    detail = String(
      inp.command ?? inp.file_path ?? inp.path ?? inp.pattern ?? inp.description ?? "",
    );
    if (!detail && Object.keys(inp).length > 0) {
      try { detail = JSON.stringify(inp); } catch { detail = ""; }
    }
  }
  return { kind, detail: detail || name };
}

/**
 * Extract human-readable activity events from a single stream-json line.
 * Returns 0+ events (an assistant turn can carry multiple content blocks).
 * Pure — never throws on malformed input.
 */
export function parseActivityEvents(line: string): Array<{ kind: string; detail: string }> {
  const out: Array<{ kind: string; detail: string }> = [];
  let parsed: any;
  try { parsed = JSON.parse(line); } catch { return out; }
  if (!parsed || typeof parsed !== "object") return out;

  // Assistant turns carry text + tool_use blocks in message.content[]
  const content = parsed?.message?.content;
  if ((parsed.type === "assistant" || parsed.type === "message") && Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ kind: "text", detail: block.text });
      } else if (block.type === "tool_use") {
        out.push(summarizeTool(String(block.name ?? "tool"), block.input));
      }
    }
  }

  // Alternative top-level tool_use shape
  if (parsed.type === "tool_use" || parsed.subtype === "tool_use") {
    out.push(summarizeTool(String(parsed.name ?? parsed.tool_name ?? "tool"), parsed.input ?? parsed.tool_input));
  }

  return out;
}

/** Bounded, in-memory ring buffer of one agent's recent activity. Pure. */
export class AgentActivityRing {
  private events: ActivityEvent[] = [];
  private _lastEventAt: string | null = null;

  /** Append an event, evicting the oldest beyond capacity. Returns the stored event. */
  push(kind: string, detail: string, ts: string = new Date().toISOString()): ActivityEvent {
    const ev: ActivityEvent = { ts, kind, detail: truncateDetail(detail) };
    this.events.push(ev);
    if (this.events.length > ACTIVITY_RING_SIZE) {
      this.events.splice(0, this.events.length - ACTIVITY_RING_SIZE);
    }
    this._lastEventAt = ts;
    return ev;
  }

  get lastEventAt(): string | null { return this._lastEventAt; }
  get size(): number { return this.events.length; }

  /** Chronological (oldest → newest) copy. */
  list(): ActivityEvent[] { return this.events.slice(); }

  snapshot(): ActivitySnapshot {
    return { lastEventAt: this._lastEventAt, events: this.events.slice() };
  }

  clear(): void {
    this.events = [];
    this._lastEventAt = null;
  }
}

type Broadcaster = (event: string, data: unknown) => void;

/**
 * Per-agent activity rings plus a throttled WebSocket broadcaster.
 *
 * Session boundary decision: rings are keyed by agentId and are NOT reset when
 * a new CLI session spawns for the same agent. A single task routinely spans
 * multiple sessions (resume, rate-limit retry, fix cycles); clearing on each
 * respawn would blank the "라이브 활동" panel exactly when a retry begins,
 * making a working agent look reset/stuck. The ring is self-bounding (last 50),
 * so a genuinely new task's output naturally evicts the previous one, and
 * `lastEventAt` drives the staleness indicator regardless of session churn.
 */
export class ActivityLogStore {
  private rings = new Map<string, AgentActivityRing>();
  private lastBroadcastAt = new Map<string, number>();
  private broadcaster: Broadcaster | null = null;
  private readonly throttleMs: number;

  constructor(opts: { throttleMs?: number } = {}) {
    this.throttleMs = opts.throttleMs ?? 1000;
  }

  /** Wire the WS broadcaster (set once at server startup). Pass null to detach. */
  setBroadcaster(fn: Broadcaster | null): void {
    this.broadcaster = fn;
  }

  private ring(agentId: string): AgentActivityRing {
    let r = this.rings.get(agentId);
    if (!r) { r = new AgentActivityRing(); this.rings.set(agentId, r); }
    return r;
  }

  /** Record one event; broadcasts `agent:activity` at most once/sec per agent. */
  record(agentId: string, kind: string, detail: string, ts?: string): ActivityEvent {
    const ev = this.ring(agentId).push(kind, detail, ts);
    if (this.broadcaster) {
      const now = Date.now();
      const last = this.lastBroadcastAt.get(agentId) ?? 0;
      if (now - last >= this.throttleMs) {
        this.lastBroadcastAt.set(agentId, now);
        this.broadcaster("agent:activity", { agentId, event: ev, lastEventAt: ev.ts });
      }
    }
    return ev;
  }

  snapshot(agentId: string): ActivitySnapshot {
    return this.rings.get(agentId)?.snapshot() ?? { lastEventAt: null, events: [] };
  }

  reset(agentId: string): void {
    this.rings.get(agentId)?.clear();
  }
}

/** Process-wide singleton — recorded from session.ts, read by the agents route. */
export const agentActivityLog = new ActivityLogStore();
