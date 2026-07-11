# 웹 세션 워크스페이스 — Phase 1 구현 계획 (대화형 세션 코어)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 에이전트 패널에서 세션을 죽이지 않고 멀티턴으로 대화하며, 응답을 말풍선 + 툴 카드(running/done/error) + Todo로 구조화해 보여주는 대화형 세션 코어를 만든다.

**Architecture:** stream-json을 **라인별 증분 파서**로 typed `ChatEvent`로 변환해 `chat:event` WebSocket으로 broadcast하고, 프론트가 kind별로 렌더한다. 세션은 `chat-{agentId}` 키로 keep-alive되어 턴마다 `session.send()`가 `--resume`으로 이어진다. 기존 `agent:output` 인프라·resume·컨텍스트 주입은 재사용, 신규는 증분 파서 + 채팅 엔드포인트 + 프론트 3컴포넌트.

**Tech Stack:** TypeScript, Express 5, `ws` WebSocket, better-sqlite3, React 18, Tailwind v4, Zustand, vitest 4 (server 유닛), `tsc -b` + eslint + Playwright (dashboard 검증 — 유닛 러너 없음).

**설계 근거:** `docs/design/web-session-workspace.md` · 목업 https://claude.ai/code/artifact/5027f838-9b7b-4834-b6e4-265fcdbc2b8f

## Global Constraints

- 언어: 사용자 노출 문자열은 한국어 + i18n 키(`dashboard/src/i18n/`). 코드·경로·툴 라벨(Read/Bash/Edit)은 원어(개발자 패널 예외).
- 커밋 컨벤션: 영문 prefix + 한국어 본문 (`feat:`/`fix:`/`update:`/`refactor:`/`test:`). 기본 브랜치 `main`에 직접 커밋. **커밋/푸시는 사용자 명시 요청 시에만** — 계획 실행 중 각 Task 끝 커밋은 로컬 단계로 수행하되 push 금지.
- typecheck PASS 없이 커밋 금지 (pre-commit hook 강제). TS 변경 시 `npm run typecheck`, dashboard 변경 시 `cd dashboard && npx tsc -b`.
- `window.confirm/alert/prompt` 금지 → `ConfirmDialog`/`InputDialog`/`Toast` (`dashboard/eslint.config.js` error 강제).
- DB 직접 수정 금지, 항상 API 경유. `.env`·`.crewdeck/**`·`*.db`·`*.pem` 커밋 금지 (hook 차단).
- `npm run build:server` 단독 실행 금지 — 항상 `npm run build` 전체. 라이브 서비스 재시작은 drain 절차(큐 정지 → activeTasks=0 → build → restart).
- Phase 1 범위: **idle 전송만** (실행 중 큐/steer는 Phase 4). Codex는 텍스트만 파싱(tool 카드는 claude 우선, codex 후속). 진짜 mid-stream 인터럽트 불가 — one-shot resume 모델.

---

## File Structure

**신규**
- `shared/types.ts` (MODIFY) — `ChatEvent` union 타입 추가 (서버·프론트 공유 계약).
- `server/core/agent/adapters/chat-events.ts` (CREATE) — 라인별 증분 파서 `parseChatEvents()` + 라인 재조립 `ChatEventAssembler`.
- `server/core/agent/chat-session.ts` (CREATE) — get-or-spawn keep-alive 결정 `resolveChatSession()`.
- `server/api/routes/orchestration.ts` (MODIFY) — `POST /agents/:agentId/chat` 엔드포인트 추가.
- `dashboard/src/types.ts` (MODIFY) — `ChatEvent` 미러 타입 (WS payload용, shared와 동기 유지).
- `dashboard/src/hooks/useWebSocket.ts` (MODIFY) — `chat:event` 수신 → CustomEvent dispatch.
- `dashboard/src/components/ToolCard.tsx` (CREATE) — 툴 카드 3상태.
- `dashboard/src/components/ChatThread.tsx` (CREATE) — chat:event → 말풍선/카드/Todo 렌더.
- `dashboard/src/components/ChatComposer.tsx` (CREATE) — idle 전송 입력창.
- `dashboard/src/lib/api.ts` (MODIFY) — `sendChat()` API.
- `dashboard/src/components/AgentDetail.tsx` (MODIFY) — 단발 입력창을 ChatThread+ChatComposer로 교체.

**책임 경계:** 파서(`chat-events.ts`)는 stream-json 포맷을 프론트에서 숨긴다 — 프론트는 `ChatEvent`만 안다. `ToolCard`/`ChatThread`는 순수 표시(props/이벤트 in → render), 세션 상태는 `AgentDetail`이 소유.

---

## Task 1: ChatEvent 타입 + 증분 파서

**Files:**
- Modify: `shared/types.ts` (파일 끝에 추가)
- Create: `server/core/agent/adapters/chat-events.ts`
- Test: `server/__tests__/chat-events.test.ts`

**Interfaces:**
- Produces:
  - `type ChatEvent = { kind:"text"; text:string } | { kind:"thinking"; text:string } | { kind:"tool_use"; id:string; name:string; input:unknown } | { kind:"tool_result"; id:string; isError:boolean; content:string } | { kind:"todo"; items:Array<{content:string; status:"pending"|"in_progress"|"completed"}> } | { kind:"result"; text:string }`
  - `function parseChatEvents(line: string, provider: "claude"|"codex"): ChatEvent[]`
  - `class ChatEventAssembler { constructor(provider:"claude"|"codex"); push(chunk: string): ChatEvent[] }`

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/chat-events.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseChatEvents, ChatEventAssembler } from '../core/agent/adapters/chat-events.js';

describe('parseChatEvents — claude stream-json', () => {
  it('extracts assistant text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([{ kind: 'text', text: 'Hello' }]);
  });

  it('extracts thinking blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'let me check' }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([{ kind: 'thinking', text: 'let me check' }]);
  });

  it('extracts tool_use with id/name/input', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.ts' } }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([
      { kind: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.ts' } },
    ]);
  });

  it('maps TodoWrite tool_use to a todo event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'TodoWrite',
        input: { todos: [{ content: 'fix', status: 'in_progress' }] } }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([
      { kind: 'todo', items: [{ content: 'fix', status: 'in_progress' }] },
    ]);
  });

  it('extracts tool_result from user message (error flagged)', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: true, content: 'boom' }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([
      { kind: 'tool_result', id: 'tu_1', isError: true, content: 'boom' },
    ]);
  });

  it('stringifies array tool_result content', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3',
        content: [{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }] }] },
    });
    expect(parseChatEvents(line, 'claude')).toEqual([
      { kind: 'tool_result', id: 'tu_3', isError: false, content: 'line1\nline2' },
    ]);
  });

  it('ignores non-JSON and unknown lines', () => {
    expect(parseChatEvents('not json', 'claude')).toEqual([]);
    expect(parseChatEvents(JSON.stringify({ type: 'system' }), 'claude')).toEqual([]);
  });
});

describe('ChatEventAssembler — reassembles split lines', () => {
  it('buffers partial lines across chunks', () => {
    const asm = new ChatEventAssembler('claude');
    const full = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    const mid = Math.floor(full.length / 2);
    expect(asm.push(full.slice(0, mid))).toEqual([]);
    expect(asm.push(full.slice(mid) + '\n')).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('emits multiple events for multiple complete lines in one chunk', () => {
    const asm = new ChatEventAssembler('claude');
    const l1 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } });
    const l2 = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] } });
    expect(asm.push(l1 + '\n' + l2 + '\n')).toEqual([
      { kind: 'text', text: 'a' }, { kind: 'text', text: 'b' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/chat-events.test.ts`
Expected: FAIL — "Cannot find module '../core/agent/adapters/chat-events.js'"

- [ ] **Step 3: Add ChatEvent type to shared/types.ts**

Append to `shared/types.ts`:

```ts
/**
 * 라이브 채팅 렌더용 구조화 이벤트. stream-json을 프론트에서 숨기는 계약.
 * ⚠ dashboard/src/types.ts 의 ChatEvent 미러와 동기 유지.
 */
export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; isError: boolean; content: string }
  | { kind: "todo"; items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { kind: "result"; text: string };
```

- [ ] **Step 4: Create the parser**

Create `server/core/agent/adapters/chat-events.ts`:

```ts
/**
 * 라인별 stream-json → ChatEvent 증분 파서.
 *
 * 기존 parseStreamJson(stream-parser.ts)은 전체 stdout를 집계하는 배치 파서라
 * 라이브 채팅엔 부적합하다. 여기서는 라인 1개 → ChatEvent[]로 즉시 변환하고,
 * tool_use.id ↔ tool_result 매칭은 프론트가 카드 상태로 처리한다(파서는 stateless).
 */
import type { ChatEvent } from "../../../../shared/types.js";

/** tool_result.content(배열/문자열)을 사람이 읽을 문자열로 평탄화. */
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === "string" ? b : b?.text ?? JSON.stringify(b)))
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** stream-json 한 줄을 ChatEvent 배열로 변환한다. 파싱 불가/무관한 줄은 []. */
export function parseChatEvents(line: string, provider: "claude" | "codex"): ChatEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: any;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (provider === "codex") {
    // Codex는 Phase 1에서 텍스트만 지원(툴 카드는 후속). codex-stream-parser의
    // 이벤트 형태에 맞춰 텍스트 델타만 흘린다.
    if (typeof obj?.text === "string" && obj.text) return [{ kind: "text", text: obj.text }];
    if (obj?.type === "message" && typeof obj?.content === "string") {
      return [{ kind: "text", text: obj.content }];
    }
    return [];
  }

  const out: ChatEvent[] = [];

  // assistant 메시지: text / thinking / tool_use 블록
  if (obj?.type === "assistant" && Array.isArray(obj?.message?.content)) {
    for (const block of obj.message.content) {
      if (block?.type === "text" && typeof block.text === "string") {
        out.push({ kind: "text", text: block.text });
      } else if (block?.type === "thinking" && typeof block.thinking === "string") {
        out.push({ kind: "thinking", text: block.thinking });
      } else if (block?.type === "tool_use") {
        if (block.name === "TodoWrite" && Array.isArray(block.input?.todos)) {
          out.push({ kind: "todo", items: block.input.todos });
        } else {
          out.push({ kind: "tool_use", id: block.id ?? "", name: block.name ?? "unknown", input: block.input ?? {} });
        }
      }
    }
  }

  // user 메시지: tool_result 블록
  if (obj?.type === "user" && Array.isArray(obj?.message?.content)) {
    for (const block of obj.message.content) {
      if (block?.type === "tool_result") {
        out.push({
          kind: "tool_result",
          id: block.tool_use_id ?? "",
          isError: Boolean(block.is_error),
          content: flattenContent(block.content),
        });
      }
    }
  }

  // 최종 result 텍스트
  if (obj?.type === "result" && typeof obj?.result === "string" && obj.result) {
    out.push({ kind: "result", text: obj.result });
  }

  return out;
}

/**
 * output 청크는 라인 경계로 안 잘려 온다. 버퍼에 누적하고 완결된 라인만 파싱한다.
 * (session.ts의 activityLineBuf와 같은 재조립 패턴 — 채팅 전용으로 격리.)
 */
export class ChatEventAssembler {
  private buf = "";
  constructor(private provider: "claude" | "codex") {}

  push(chunk: string): ChatEvent[] {
    this.buf += chunk;
    const nl = this.buf.lastIndexOf("\n");
    if (nl < 0) {
      if (this.buf.length > 1_000_000) this.buf = this.buf.slice(-1_000_000);
      return [];
    }
    const complete = this.buf.slice(0, nl);
    this.buf = this.buf.slice(nl + 1);
    const events: ChatEvent[] = [];
    for (const l of complete.split("\n")) {
      if (l.trim()) events.push(...parseChatEvents(l, this.provider));
    }
    return events;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run server/__tests__/chat-events.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors

```bash
git add shared/types.ts server/core/agent/adapters/chat-events.ts server/__tests__/chat-events.test.ts
git commit -m "feat: 라이브 채팅용 stream-json 증분 파서(ChatEvent) 추가"
```

---

## Task 2: keep-alive 세션 해석 (get-or-spawn)

**Files:**
- Create: `server/core/agent/chat-session.ts`
- Test: `server/__tests__/chat-session.test.ts`

**Interfaces:**
- Consumes: `SessionManager` (`server/core/agent/session.ts:14-27` — `spawnAgent`, `getSession`).
- Produces:
  - `interface ChatSessionDeps { getSession(key: string): { status: string } | undefined; spawnAgent(agentId: string, workdir: string, sessionKey: string): { status: string }; }`
  - `function chatSessionKey(agentId: string): string` → `chat-${agentId}` (오타 방지용 단일 소스)
  - `function resolveChatSession(deps: ChatSessionDeps, agentId: string, workdir: string): { session: { status: string }; reused: boolean } | { busy: true }`

> 규칙: 채팅 세션은 `chat-{agentId}` 키로 유지한다. 이미 있고 idle이면 재사용(resume), 없으면 spawn, 실행 중(working)이면 `{ busy: true }` (Phase 1은 큐 없음).

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/chat-session.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveChatSession, chatSessionKey } from '../core/agent/chat-session.js';

function makeDeps(existing?: { status: string }) {
  const spawned = { status: 'idle' };
  return {
    spawned,
    deps: {
      getSession: vi.fn((_key: string) => existing),
      spawnAgent: vi.fn((_a: string, _w: string, _k: string) => spawned),
    },
  };
}

describe('resolveChatSession', () => {
  it('spawns a new session when none exists', () => {
    const { deps, spawned } = makeDeps(undefined);
    const r = resolveChatSession(deps, 'agent-1', '/repo');
    expect(r).toEqual({ session: spawned, reused: false });
    expect(deps.spawnAgent).toHaveBeenCalledWith('agent-1', '/repo', 'chat-agent-1');
  });

  it('reuses an existing idle session (resume path)', () => {
    const existing = { status: 'idle' };
    const { deps } = makeDeps(existing);
    const r = resolveChatSession(deps, 'agent-1', '/repo');
    expect(r).toEqual({ session: existing, reused: true });
    expect(deps.spawnAgent).not.toHaveBeenCalled();
  });

  it('returns busy when the session is working', () => {
    const { deps } = makeDeps({ status: 'working' });
    expect(resolveChatSession(deps, 'agent-1', '/repo')).toEqual({ busy: true });
  });

  it('chatSessionKey is stable', () => {
    expect(chatSessionKey('abc')).toBe('chat-abc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/chat-session.test.ts`
Expected: FAIL — "Cannot find module '../core/agent/chat-session.js'"

- [ ] **Step 3: Create the module**

Create `server/core/agent/chat-session.ts`:

```ts
/**
 * 채팅 세션 keep-alive 해석. 오케스트레이션 경로와 달리 턴마다 killSession 하지
 * 않고 chat-{agentId} 키로 세션을 유지해, session.send()가 --resume으로 이어지게 한다.
 */
export interface ChatSessionLike { status: string }
export interface ChatSessionDeps {
  getSession(key: string): ChatSessionLike | undefined;
  spawnAgent(agentId: string, workdir: string, sessionKey: string): ChatSessionLike;
}

/** 채팅 세션 키(단일 소스). */
export function chatSessionKey(agentId: string): string {
  return `chat-${agentId}`;
}

/**
 * 채팅 세션을 확보한다.
 * - 없으면 spawn (reused=false)
 * - idle이면 재사용 (reused=true → 호출부가 send()로 resume)
 * - working이면 { busy: true } (Phase 1은 큐 없음)
 */
export function resolveChatSession(
  deps: ChatSessionDeps,
  agentId: string,
  workdir: string,
): { session: ChatSessionLike; reused: boolean } | { busy: true } {
  const key = chatSessionKey(agentId);
  const existing = deps.getSession(key);
  if (existing) {
    if (existing.status === "working") return { busy: true };
    return { session: existing, reused: true };
  }
  return { session: deps.spawnAgent(agentId, workdir, key), reused: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/__tests__/chat-session.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/core/agent/chat-session.ts server/__tests__/chat-session.test.ts
git commit -m "feat: 채팅 세션 keep-alive 해석(resolveChatSession) 추가"
```

---

## Task 3: POST /agents/:agentId/chat 엔드포인트

**Files:**
- Modify: `server/api/routes/orchestration.ts` (기존 `/agents/:agentId/prompt` 핸들러 뒤에 추가)
- Test: 수동 curl (엔드포인트는 실제 CLI spawn을 하므로 유닛 대신 진입점 검증)

**Interfaces:**
- Consumes: `resolveChatSession`, `chatSessionKey` (Task 2), `ChatEventAssembler` (Task 1), `ctx.sessionManager`, `broadcast`.
- Produces: `POST /api/orchestration/agents/:agentId/chat` — body `{ message: string }` → 응답 `{ status: "done", agentId } | { status: "busy" }`; 실행 중 `broadcast("chat:event", { agentId, sessionKey, seq, event })`.

- [ ] **Step 1: Read the existing prompt handler for context**

Read `server/api/routes/orchestration.ts:258-420` — `POST /agents/:agentId/prompt`. 재사용: agent/project/workdir 조회, `MAX_PROMPT_LEN` 검증, orgContext 빌드(`:281-327`). 신규 핸들러는 `killSession`을 **하지 않고**, output을 `ChatEventAssembler`로 파싱해 `chat:event`로 broadcast한다.

- [ ] **Step 2: Add the chat endpoint**

`server/api/routes/orchestration.ts` 상단 import에 추가:

```ts
import { resolveChatSession, chatSessionKey } from "../../core/agent/chat-session.js";
import { ChatEventAssembler } from "../../core/agent/adapters/chat-events.js";
```

`/agents/:agentId/prompt` 핸들러 등록 직후에 추가 (같은 `router`, 같은 `ctx` 스코프):

```ts
// 대화형 채팅 — 세션을 죽이지 않고(keep-alive) 멀티턴 resume. 구조화 이벤트 broadcast.
router.post("/agents/:agentId/chat", async (req, res) => {
  const { agentId } = req.params;
  const message: string = (req.body?.message ?? "").toString();
  if (!message.trim()) return res.status(400).json({ error: "message is required" });
  if (message.length > MAX_PROMPT_LEN) {
    return res.status(400).json({ error: `message too long (max ${MAX_PROMPT_LEN})` });
  }
  if (!ctx.sessionManager) return res.status(503).json({ error: "Session manager not ready" });

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as any;
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(agent.project_id) as any;
  const workdir = project?.workdir || process.cwd();

  const resolved = resolveChatSession(ctx.sessionManager, agentId, workdir);
  if ("busy" in resolved) return res.status(409).json({ status: "busy" });

  const session = ctx.sessionManager.getSession(chatSessionKey(agentId))!;
  // 이 세션에 실제로 해석된 provider(claude/codex). SessionManager가 spawn 시 sessions row에
  // 기록하고 getSessionRecord로 노출한다(session.ts SessionRecord.provider). AgentSession 자체엔
  // provider 필드가 없으므로 record에서 읽는다. 없으면 claude 폴백.
  const provider = ctx.sessionManager.getSessionRecord(chatSessionKey(agentId))?.provider ?? "claude";
  const assembler = new ChatEventAssembler(provider);
  let seq = 0;

  const onOutput = (text: string) => {
    for (const event of assembler.push(text)) {
      broadcast("chat:event", { agentId, sessionKey: chatSessionKey(agentId), seq: seq++, event });
    }
  };
  session.on("output", onOutput);

  try {
    await session.send(message.trim());
    res.json({ status: "done", agentId });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "chat failed" });
  } finally {
    session.off("output", onOutput); // ⚠ killSession 하지 않음 — keep-alive
  }
});
```

> 주: `provider`는 `getSessionRecord(key).provider`(spawn 시 해석·기록된 값)에서 읽고, 없으면 claude 폴백(Codex tool 카드는 후속이지만 텍스트는 Task 1 codex 파서가 처리). `broadcast`·`db`·`MAX_PROMPT_LEN`·`ctx`·`ctx.sessionManager`는 기존 파일 스코프에 이미 있다. `session.on/off`는 `AgentSession extends EventEmitter`라 존재.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (에러 시: `session.on/off` 시그니처는 `AgentSession extends EventEmitter`라 존재. `lastProvider` 접근이 타입 에러면 `(session as any)`로 캐스팅 유지.)

- [ ] **Step 4: Verify via curl against dev server**

Terminal A — dev 서버 기동 (predev가 launchd 정지시킴, dev 종료 후 `scripts/service-macos.sh start`로 복구):

Run: `npm run dev:server`
Expected: `server listening on 127.0.0.1:7200`

Terminal B — 실제 채팅 2턴(멀티턴 resume 확인). `AGENT_ID`는 기존 프로젝트의 에이전트 id로 치환:

```bash
API_KEY=$(cat .crewdeck/api-key)
AGENT_ID=<대상 에이전트 id>
curl -s -X POST http://127.0.0.1:7200/api/orchestration/agents/$AGENT_ID/chat \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"message":"내 이름은 진욱이야. 기억해."}'
curl -s -X POST http://127.0.0.1:7200/api/orchestration/agents/$AGENT_ID/chat \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"message":"내 이름 뭐라고 했지?"}'
```

Expected: 두 요청 다 `{"status":"done",...}`. 2번째 응답 로그/세션에서 "진욱" 회상 → resume 동작 확인. (`.crewdeck/api-key`는 dev 데이터 디렉토리 기준.)

- [ ] **Step 5: Commit**

```bash
git add server/api/routes/orchestration.ts
git commit -m "feat: 대화형 채팅 엔드포인트(/agents/:id/chat) — keep-alive + chat:event broadcast"
```

---

## Task 4: 프론트 — chat:event 수신 + API + 미러 타입

**Files:**
- Modify: `dashboard/src/types.ts` (ChatEvent 미러)
- Modify: `dashboard/src/hooks/useWebSocket.ts` (`switch(msg.type)`에 case 추가)
- Modify: `dashboard/src/lib/api.ts` (`sendChat`)

**Interfaces:**
- Produces: `dashboard/src/types.ts`의 `ChatEvent` (shared 미러); `window` CustomEvent `"crewdeck:chat-event"` detail `{ agentId:string; sessionKey:string; seq:number; event:ChatEvent }`; `api.sendChat(agentId, message): Promise<{status:string}>`.

- [ ] **Step 1: Mirror the ChatEvent type**

`dashboard/src/types.ts` 끝에 추가 (shared/types.ts와 동일 형태 유지):

```ts
/** ⚠ shared/types.ts 의 ChatEvent 와 동기 유지 (WS payload 계약). */
export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; isError: boolean; content: string }
  | { kind: "todo"; items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> }
  | { kind: "result"; text: string };
```

- [ ] **Step 2: Handle chat:event in useWebSocket**

`dashboard/src/hooks/useWebSocket.ts`의 `switch (msg.type)` 블록(약 `:61-246`)에 case 추가:

```ts
      case "chat:event":
        window.dispatchEvent(new CustomEvent("crewdeck:chat-event", { detail: msg.payload }));
        break;
```

- [ ] **Step 3: Add sendChat API**

`dashboard/src/lib/api.ts`에 추가 (기존 `sendPrompt`(`:351-354`) 옆, 같은 fetch 헬퍼 패턴):

```ts
  sendChat: (agentId: string, message: string) =>
    request<{ status: string }>(`/orchestration/agents/${agentId}/chat`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
```

> 주: `request` 헬퍼·베이스 경로·인증 헤더 처리는 기존 `sendPrompt`와 동일 규약을 따른다. 파일의 기존 헬퍼명이 다르면(`apiFetch` 등) 그 이름을 쓴다.

- [ ] **Step 4: Typecheck**

Run: `cd dashboard && npx tsc -b`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/types.ts dashboard/src/hooks/useWebSocket.ts dashboard/src/lib/api.ts
git commit -m "feat: 프론트 chat:event 수신 + sendChat API + ChatEvent 미러 타입"
```

---

## Task 5: ToolCard 컴포넌트 (3상태)

**Files:**
- Create: `dashboard/src/components/ToolCard.tsx`

**Interfaces:**
- Consumes: `ChatEvent` (`dashboard/src/types.ts`).
- Produces: `interface ToolCardData { id:string; name:string; input:unknown; state:"running"|"done"|"error"; result?:string }`; `function ToolCard({ data }: { data: ToolCardData }): JSX.Element`.

- [ ] **Step 1: Create the component**

Create `dashboard/src/components/ToolCard.tsx` (스타일은 `AgentChatLog.tsx`의 Tailwind 관용 — `text-xs`, `rounded-lg`, `border`, `dark:` 변형 — 을 따른다):

```tsx
import { useState } from "react";

export interface ToolCardData {
  id: string;
  name: string;
  input: unknown;
  state: "running" | "done" | "error";
  result?: string;
}

function summarize(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const target = i.file_path ?? i.path ?? i.command ?? i.pattern ?? "";
  return String(target);
}

export function ToolCard({ data }: { data: ToolCardData }) {
  const [open, setOpen] = useState(false);
  const statusChip = {
    running: "text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-500/10",
    done: "text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-500/10",
    error: "text-red-500 bg-red-50 dark:text-red-400 dark:bg-red-500/10",
  }[data.state];
  const statusLabel = { running: "running", done: "done", error: "error" }[data.state];

  return (
    <div className="border border-gray-100 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full text-left px-3 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-700/40"
      >
        <span className="font-mono font-bold">{data.name}</span>
        <span className="font-mono text-gray-400 dark:text-gray-500 truncate flex-1 min-w-0">
          {summarize(data.name, data.input)}
        </span>
        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${statusChip}`}>
          {statusLabel}
        </span>
        <span className="text-gray-400 text-[10px]">{open ? "▼" : "▶"}</span>
      </button>
      {open && (
        <pre className="border-t border-gray-100 dark:border-gray-700 px-3 py-2 text-[11px] font-mono text-gray-500 dark:text-gray-400 whitespace-pre-wrap break-words bg-gray-50 dark:bg-gray-900/40 m-0">
{data.result ?? JSON.stringify(data.input, null, 2)}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd dashboard && npx tsc -b`
Expected: no errors

- [ ] **Step 3: Lint**

Run: `cd dashboard && npm run lint`
Expected: no errors (특히 no-restricted-globals — window.* 미사용 확인)

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/ToolCard.tsx
git commit -m "feat: ToolCard 컴포넌트(running/done/error 3상태 + 접힘)"
```

---

## Task 6: ChatThread + ChatComposer + AgentDetail 통합

**Files:**
- Create: `dashboard/src/components/ChatThread.tsx`
- Create: `dashboard/src/components/ChatComposer.tsx`
- Modify: `dashboard/src/components/AgentDetail.tsx` (단발 입력창 `:864-915`을 교체)

**Interfaces:**
- Consumes: `ChatEvent`, `ToolCard`/`ToolCardData` (Task 5), `api.sendChat` (Task 4), CustomEvent `"crewdeck:chat-event"` (Task 4).
- Produces: `function ChatThread({ agentId }: { agentId: string }): JSX.Element`; `function ChatComposer({ agentId, disabled }: { agentId: string; disabled?: boolean }): JSX.Element`.

- [ ] **Step 1: Create ChatThread**

Create `dashboard/src/components/ChatThread.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import type { ChatEvent } from "../types";
import { ToolCard, type ToolCardData } from "./ToolCard";

type Item =
  | { row: "text"; text: string }
  | { row: "thinking"; text: string }
  | { row: "tool"; data: ToolCardData }
  | { row: "todo"; items: Array<{ content: string; status: string }> };

export function ChatThread({ agentId }: { agentId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolIndex = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const handler = (e: Event) => {
      const { agentId: aid, event } = (e as CustomEvent<{ agentId: string; event: ChatEvent }>).detail;
      if (aid !== agentId) return;
      setItems((prev) => {
        const next = [...prev];
        switch (event.kind) {
          case "text":
          case "result":
            next.push({ row: "text", text: event.text });
            break;
          case "thinking":
            next.push({ row: "thinking", text: event.text });
            break;
          case "todo":
            next.push({ row: "todo", items: event.items });
            break;
          case "tool_use": {
            toolIndex.current.set(event.id, next.length);
            next.push({ row: "tool", data: { id: event.id, name: event.name, input: event.input, state: "running" } });
            break;
          }
          case "tool_result": {
            const idx = toolIndex.current.get(event.id);
            if (idx != null && next[idx]?.row === "tool") {
              const t = next[idx] as Extract<Item, { row: "tool" }>;
              next[idx] = { row: "tool", data: { ...t.data, state: event.isError ? "error" : "done", result: event.content } };
            }
            break;
          }
        }
        return next;
      });
    };
    window.addEventListener("crewdeck:chat-event", handler);
    return () => window.removeEventListener("crewdeck:chat-event", handler);
  }, [agentId]);

  // 강제 오토스크롤 금지 — 바닥 근처(80px)일 때만 follow
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
      {items.map((it, i) => {
        if (it.row === "tool") return <ToolCard key={i} data={it.data} />;
        if (it.row === "thinking")
          return (
            <details key={i} className="text-xs">
              <summary className="text-gray-400 dark:text-gray-500 cursor-pointer">🧠 생각 정리</summary>
              <div className="text-gray-500 dark:text-gray-400 border-l-2 border-gray-200 dark:border-gray-700 pl-2 mt-1 whitespace-pre-wrap">{it.text}</div>
            </details>
          );
        if (it.row === "todo")
          return (
            <div key={i} className="border border-gray-100 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 px-3 py-2 text-xs">
              <div className="font-semibold mb-1">
                진행 {it.items.filter((t) => t.status === "completed").length} / {it.items.length}
              </div>
              {it.items.map((t, j) => (
                <div key={j} className={t.status === "completed" ? "text-gray-400 line-through" : t.status === "in_progress" ? "font-semibold" : "opacity-70"}>
                  {t.status === "completed" ? "✓" : "▸"} {t.content}
                </div>
              ))}
            </div>
          );
        return <div key={i} className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">{it.text}</div>;
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create ChatComposer**

Create `dashboard/src/components/ChatComposer.tsx` (Cmd/Ctrl+Enter 전송 + CJK IME 조합 가드):

```tsx
import { useState } from "react";
import { api } from "../lib/api";

export function ChatComposer({ agentId, disabled }: { agentId: string; disabled?: boolean }) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [composing, setComposing] = useState(false);

  const send = async () => {
    const msg = value.trim();
    if (!msg || sending) return;
    setSending(true);
    // 유저 메시지를 즉시 스레드에 반영 (에코)
    window.dispatchEvent(new CustomEvent("crewdeck:chat-event", {
      detail: { agentId, event: { kind: "text", text: `🧑 ${msg}` } },
    }));
    setValue("");
    try {
      await api.sendChat(agentId, msg);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (composing || (e as any).nativeEvent?.isComposing) return; // CJK 조합 중 전송 방지
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 p-3">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        disabled={disabled || sending}
        placeholder="메시지를 입력하세요…  (⌘/Ctrl+Enter 전송)"
        className="w-full border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 resize-none disabled:opacity-50"
        rows={2}
      />
      <div className="flex justify-end mt-2">
        <button
          onClick={() => void send()}
          disabled={disabled || sending || !value.trim()}
          className="bg-indigo-500 text-white text-xs font-bold px-4 py-1.5 rounded-lg disabled:opacity-40"
        >
          {sending ? "전송 중…" : "전송 ⌘⏎"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire into AgentDetail**

`dashboard/src/components/AgentDetail.tsx` 상단 import 추가:

```tsx
import { ChatThread } from "./ChatThread";
import { ChatComposer } from "./ChatComposer";
```

기존 "Direct Prompt" 단발 입력창 블록(`:864-915` 근처, `handleSendDirectPrompt`/textarea/전송 버튼)을 아래로 교체. 에이전트가 `working`이면 composer만 비활성(스레드는 계속 스트림):

```tsx
{/* 대화형 세션 — 지속 스레드 + 입력 (기존 단발 Direct Prompt 대체) */}
<div className="flex flex-col h-80 border-t border-gray-100 dark:border-gray-700">
  <ChatThread agentId={agent.id} />
  <ChatComposer agentId={agent.id} disabled={agent.status === "working"} />
</div>
```

> 사이드이펙트 체크(`.claude/rules/dashboard-ui.md`): 이 교체는 `handleSendDirectPrompt`·`crewdeck:prompt-complete` 리스너(`:295-331`)·전송 버튼을 제거/대체한다. 제거 전 해당 핸들러가 다른 곳에서 안 쓰이는지 확인하고, 쓰이면 남겨둔다.

- [ ] **Step 4: Typecheck + lint**

Run: `cd dashboard && npx tsc -b && npm run lint`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/ChatThread.tsx dashboard/src/components/ChatComposer.tsx dashboard/src/components/AgentDetail.tsx
git commit -m "feat: 지속 대화 스레드(ChatThread)+입력(ChatComposer)을 에이전트 패널에 통합"
```

---

## Task 7: E2E 검증 (멀티턴 + 툴 카드)

**Files:** 없음 (검증 전용)

- [ ] **Step 1: Build + start**

Run: `npm run build` (전체 — build:server 단독 금지)
Expected: server + dashboard 산출물 생성

Run: `npm start`
Expected: `127.0.0.1:7200` listening

- [ ] **Step 2: Playwright — 대화형 흐름 검증**

Playwright MCP로 다음을 관통(스크린샷으로 증거 남김):
1. `http://127.0.0.1:7200` 접속 → 프로젝트 → 에이전트 클릭 → 패널 오픈.
2. Composer에 "server 폴더에 뭐 있는지 봐줘" 입력 → ⌘⏎.
3. 관찰: 유저 말풍선 즉시 표시 → 잠시 후 **ToolCard(예: Bash/Read)** 가 running → done으로 flip → assistant 텍스트. 스크린샷 저장.
4. 이어서 "방금 첫 번째 파일 이름 뭐였지?" 전송 → 응답이 **직전 턴을 참조**(resume 확인). 스크린샷 저장.

Expected: 2턴이 한 스레드에 누적, 툴 카드 상태 전이가 보이고, 2번째 답이 1번째 맥락을 인용.

- [ ] **Step 3: 정직 보고**

검증 결과를 스크린샷과 함께 기록. 실패 시 "완료"로 포장하지 말 것 — 실패 지점을 출력과 함께 보고하고 반복 수정.

- [ ] **Step 4: (해당 시) 라이브 서비스 복구**

dev로 launchd가 정지됐다면 `scripts/service-macos.sh start`로 상시 서비스 복구.

---

## Phase 1 이후 (후속 계획으로 분리)

각 페이즈는 별도 계획 문서로 작성한다(독립 배포·검증 단위):

- **Phase 2 — 소환 + 컨텍스트 주입 + 판정 배지:** 실패 goal/task 카드 `⚡소환`, worktree·판정·최근출력 주입, "주입됨" 스트립, 🟢🟡🔴 배지.
- **Phase 3 — 풀 2-pane 워크스페이스:** `SessionWorkspace`(좌 대화/우 탭 Diff·최근출력·작업공간·판정), `DiffPane`(hunk별 유지/되돌리기 + 위치-앵커드 코멘트), `⤢ 독립 작업공간` 진입.
- **Phase 4 — 개입 + 체크포인트:** nudge/queue(idle 전송 → 실행중 큐·⌘⏎ steer=중단+resume·Esc), 턴 체크포인트 롤백 2모드, "마지막 정상 상태 되돌리기" 우선 노출.

---

## Self-Review (작성자 체크)

**Spec 커버리지:**
- 지속 채팅/멀티턴 → Task 2·3 (keep-alive + resume) ✓
- 구조화 흐름(툴 카드/Todo/생각) → Task 1(파서)·5(ToolCard)·6(ChatThread) ✓
- 대화 입력 → Task 6(ChatComposer) ✓
- 소환·컨텍스트 주입·판정 배지·2-pane·diff·개입·체크포인트 → **Phase 2~4로 명시 분리** (Phase 1 범위 밖, 의도된 제외) ✓
- 용어/i18n/다이얼로그/커밋/drain 규칙 → Global Constraints ✓

**Placeholder 스캔:** 각 코드 스텝에 실제 코드 존재, "TBD/적절히 처리" 없음. Codex tool 파싱은 "후속"으로 명시(placeholder 아님, 범위 결정). ✓

**타입 일관성:** `ChatEvent`(Task 1 shared ↔ Task 4 미러 동일), `ToolCardData`(Task 5 정의 ↔ Task 6 소비), `resolveChatSession`/`chatSessionKey`(Task 2 정의 ↔ Task 3 소비), `api.sendChat`(Task 4 정의 ↔ Task 6 소비) — 일치 확인. ✓

**알려진 위험:**
- Task 3의 `provider`/`lastProvider` 접근은 AgentSession 실제 필드에 의존 — 없으면 claude 폴백(코드에 반영). 구현 시 `AgentSession` 타입 확인.
- 실제 Claude Code stream-json의 tool_use 중첩 구조(assistant content block) 가정 — Task 3 curl 단계에서 실데이터로 검증. 형태가 다르면 Task 1 파서의 블록 경로 조정(테스트도 함께).
