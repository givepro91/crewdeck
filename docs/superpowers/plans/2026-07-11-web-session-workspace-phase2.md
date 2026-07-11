# 웹 세션 워크스페이스 Phase 2 — 소환 + 컨텍스트 주입 + 판정 배지

**Goal:** 실패/이월 task 카드에서 원클릭 `⚡ 소환` → 해당 goal의 worktree·판정·최근출력·기획서를 채팅 세션에 주입한 채 대화 시작. 무엇을 주입했는지 "주입됨 스트립"(칩)으로 노출하고, 판정은 🟢🟡🔴 tone 칩으로 승격.

**Base:** `bb30628` (Phase 1 완료·main 반영). 근거: `docs/design/web-session-workspace.md` §진입점 2, §상태 표면화.

**핵심 관측:** 판정 배지는 이미 TaskList/KanbanBoard/GoalDetail/TaskDetail 카드에 있음(중복 4곳). Phase 2는 **새 배지 시스템이 아니라** 소환 흐름 + 주입 스트립에 판정 tone을 얹는 것. 4곳 리팩터는 스코프 밖(surgical).

## 계약 (서버↔프론트 공유)

`ChatEvent`에 `context` kind 추가 — 소환 시 "무엇을 주입했는지" 1회 broadcast:

```ts
| { kind: "context"; items: Array<{ label: string; detail?: string; tone?: "pass" | "conditional" | "fail" | "neutral" }> }
```

- `shared/types.ts` 원본 + `dashboard/src/types.ts` 미러 동기.
- 예: `[{label:"기획서",tone:"neutral"}, {label:"작업 공간",detail:"goal/feat-x",tone:"neutral"}, {label:"판정",detail:"fail",tone:"fail"}, {label:"최근 출력",tone:"neutral"}]`

## 데이터 흐름

```
[⚡소환 클릭] (TaskList 이월 버튼 옆)
 → window CustomEvent "crewdeck:open-agent" {agentId, goalId, taskId}
 → ProjectHome 리스너 → setSelectedAgentId + pending 주입 컨텍스트 보관
 → AgentDetail 열림 → ChatComposer가 goalId/taskId를 첫 sendChat에 실어 전송
 → POST /agents/:id/chat {message, goalId, taskId}
 → chat 핸들러: resolveChatSession(taskId) → 새 spawn이면 session.ts가 goal 스코프 주입
   + 주입 요약 칩 조립 → broadcast("chat:event",{kind:"context",items})
 → session.send(message)
 → ChatThread: context 이벤트 → 상단 sticky 주입됨 스트립
```

## Tasks

### T2.1 — 백엔드: ChatEvent context kind + chat 핸들러 goalId/taskId
- `shared/types.ts` — `ChatEvent`에 `context` kind 추가.
- `server/core/agent/chat-session.ts` — `ChatSessionDeps.spawnAgent`/`resolveChatSession`에 `taskId?: string|null` 추가, `deps.spawnAgent(agentId, workdir, key, taskId)` 전달.
- `server/api/routes/orchestration.ts:427` — chat 핸들러가 `{ message, goalId, taskId }` 파싱, `resolveChatSession(..., taskId)` 전달. 새 spawn(reused=false)이면 주입 요약 칩 조립 후 `broadcast("chat:event",{agentId,sessionKey,seq,event:{kind:"context",items}})`.

### T2.2 — 백엔드: session.ts goal 스코프 주입
- `server/core/agent/session.ts:96-138` — `taskId`(이미 spawnAgent 4번째 인자)로 `SELECT goal_id FROM tasks` → goal 스코프 조회:
  - spec: `SELECT * FROM goal_specs WHERE goal_id=?` (prd_summary/feature_specs/acceptance_criteria)
  - worktree: `SELECT worktree_path, worktree_branch FROM goals WHERE id=?`
  - 판정: `SELECT v.verdict,v.severity,v.issues FROM verifications v WHERE v.id=(SELECT verification_id FROM tasks WHERE id=?)`
  - 최근 출력: `SELECT last_output FROM sessions WHERE task_id=? ORDER BY started_at DESC LIMIT 1`
  - → `## 소환 컨텍스트` 블록으로 `enrichedPrompt`(138줄)에 concat. 없는 항목 스킵.
- 조립한 "무엇을 넣었나" 요약을 chat 핸들러가 칩으로 쓸 수 있게 반환하거나(리팩터), chat 핸들러가 동일 조회로 칩만 별도 조립(중복 조회 저렴, 격리 우선).

### T2.3 — 프론트: 소환 버튼 + open-agent 흐름
- `dashboard/src/components/TaskList.tsx:663-673` — 이월 "↻ 다시 해결" 버튼 옆 `⚡ 소환` 버튼. `verification_verdict==="fail"` 또는 이월 시 노출. 클릭 → `window.dispatchEvent(new CustomEvent("crewdeck:open-agent",{detail:{agentId:task.assignee_id, goalId:task.goal_id, taskId:task.id}}))`.
- `dashboard/src/components/ProjectHome.tsx` — `crewdeck:open-agent` 리스너 추가 → `setSelectedAgentId(agentId)` + pending 주입 컨텍스트(goalId/taskId) state 보관 → AgentDetail/ChatThread에 전달.

### T2.4 — 프론트: sendChat 확장 + 주입됨 스트립
- `dashboard/src/lib/api.ts:356` — `sendChat(agentId, message, opts?: {goalId?, taskId?})` → body에 goalId/taskId.
- `dashboard/src/types.ts` — `ChatEvent` context kind 미러.
- `dashboard/src/components/ChatThread.tsx:69` — context 이벤트 구독 → 상단 sticky 주입됨 스트립(칩, 판정 tone 색). `ChatComposer`가 pending goalId/taskId를 첫 전송에 포함.

## 검증
1. `npm run typecheck` + `cd dashboard && npx tsc -b` PASS, lint 신규 0.
2. 라이브 E2E(drain): smoke-calc 실패/이월 task `⚡소환` → AgentDetail 열림 → 첫 메시지 전송 → 주입됨 스트립에 기획서/작업공간/판정/최근출력 칩 표시(Playwright). 응답이 주입 컨텍스트를 참조(예: worktree 파일 인지).
3. drain 절차 재배포.

## 알려진 제약
- 컨텍스트 주입은 **새 세션 spawn 시 1회**(reused=true면 이미 주입됨 — 재소환 시 "이미 열림" 처리). Codex는 resume 없어 매 턴 fresh(주입 반복) — v1은 Claude 우선.
- goal 레벨 단일 verdict 쿼리는 기존에 없음 — task 레벨 verification_id로 조회(설계 문서와 일치).
