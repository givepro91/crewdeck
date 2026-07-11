# 웹 세션 워크스페이스 — 대화형 에이전트 개입 UI

작성일: 2026-07-11
상태: 설계 승인 · 미구현
근거 사례: goal/task에 문제가 생기면 결국 터미널을 켜야 해서 컨텍스트 스위칭 발생. 기존 "지시 보내기"는 대화형이 아니라 맥락 유지·흐름 파악이 안 됨.
설계 목업(정적 근사치): https://claude.ai/code/artifact/5027f838-9b7b-4834-b6e4-265fcdbc2b8f

---

## Context

### 문제

실패했거나 삐끗한 goal/task를 손보려면 지금은 로컬 터미널에서 `claude`/`codex`를 직접 띄워야 한다. 대시보드에도 "지시 보내기"가 있지만 대화형이 아니다:

- **Fire-and-forget** — `POST /api/orchestration/agents/:agentId/prompt`가 요청 즉시 `res.json({ status: "started" })`로 응답하고 async 실행한다 (`server/api/routes/orchestration.ts:330`). 사용자는 "기다리며 이어가는" 대화 상대가 없다.
- **매 턴 새 세션** — 프롬프트 1건이 끝날 때마다 `finally { killSession }` (`orchestration.ts:415`). 세션 객체가 사라져 직전 지시의 맥락이 안 이어진다. 멀티턴 연속성은 다음 프롬프트가 `--resume`로 직전 *완료* 세션을 잇는 것에만 의존하는데(`session.ts:74-77`), 사용자 체감은 "매번 처음부터".
- **흐름이 안 보임** — 출력은 `broadcast("agent:output")`로 흐르지만(`orchestration.ts:343-345`), 프론트(`AgentChatLog.tsx`)는 stream-json 청크를 **raw 텍스트 말풍선**으로 흘릴 뿐이라 무슨 도구를 쓰는지·어디까지 왔는지 단계가 안 보인다.

### 이미 갖춘 것 (재사용)

| 요소 | 위치 |
|---|---|
| 서버→UI 실시간 출력 스트림 | `agent:output` broadcast + `AgentTerminal.tsx`/`AgentChatLog.tsx` 구독 |
| stream-json 파서 | `server/core/agent/adapters/stream-parser.ts`, `codex-stream-parser.ts` (`parseAgentOutput`) |
| activity 링버퍼 파싱 | `session.ts:219-244` → `parseActivityEvents` → `agent:activity` broadcast |
| 멀티턴 resume | `claude-code.ts:401-406` (`--resume`) + `session.ts:74-77` |
| 컨텍스트 주입 기계장치 | `session.ts:109-138` (CLAUDE.md·tech stack·최근 태스크·메모리) |
| goal 단위 worktree 격리·squash·승인 게이트 | `orchestration/engine.ts`, `project/git-workflow` |
| 5-dim 품질 판정 | `quality-gate/evaluator.ts` |
| WebSocket broadcast + 구독 | `server/index.ts:254-267`, `api/websocket.ts` |

**핵심 관측**: 부품은 거의 다 있다. 신규 백엔드는 세션 keep-alive + 인바운드 메시지 경로 + stream-json → 구조화 이벤트 파싱 정도이고, 나머지는 **기존 데이터/인프라의 UI 표면화**다.

---

## 목표 / 비목표

### 목표

1. 대시보드에서 프로젝트 위치의 에이전트 세션을 **소환**하고, 현재 상태(goal/task 기획서·worktree·최근 출력·판정)를 주입한 채 **대화로 read+write**(진단하고 바로 수정)한다.
2. 대화는 **지속(멀티턴)** 되고, 응답은 **구조화된 흐름**(말풍선 + 툴 카드 + Todo + diff)으로 보인다.
3. 실행 중에도 **개입**할 수 있다 (끼어들기 / 큐잉 / 중단).
4. 터미널을 켜지 않고 문제를 더 빨리 캐치한다.

### 비목표

- 진짜 인터랙티브 PTY/REPL (node-pty + xterm.js) — 채택 안 함. one-shot `send()`+resume 기반 구조화 채팅으로 간다 (근본 제약은 §제약 참고).
- 멀티에이전트 미션컨트롤(Devin Grid, Codex best-of-N) — 로컬 solo 미니멀 원칙에 과투자, 배제.
- 순수 standalone 세션(에이전트 없는 세션) — 세션은 항상 agent 레코드에 귀속(`session.ts:70-71`). 소환도 "경량 agent에 귀속" 형태.

---

## 결정

- **접근 = A(구조화 채팅)**. 이유: 사용자 페인이 "맥락 유지 + 흐름 파악"인데, raw 터미널보다 구조화 카드가 흐름 가시성을 잘 풀고, 기존 인프라를 surgical하게 재사용한다. 새 네이티브 의존성(node-pty) 없음 — `better-sqlite3` Node 업글 취약 이력을 반복하지 않는다.
- **범위 = 풀 워크스페이스(v1)**. 2-pane + diff 리뷰 + 체크포인트 + 소환 + 판정 배지 전부. (사용자가 UI/UX 완성도를 최우선으로 선택.)

---

## 아키텍처

### 데이터 흐름 (한 턴)

```
[유저 메시지]
  → (REST 또는 WS inbound) 채팅 경로
  → sessionManager 세션(keep-alive) 확보 → session.send(message)  // --resume로 직전 턴 이음
  → CLI가 stream-json 방출
  → session.on("output") 청크
      ├─ (기존) activity 링버퍼 / last_output
      └─ (신규) 구조화 파서: text / thinking / tool_use / tool_result / todo 이벤트
  → broadcast("chat:event", {sessionKey, seq, kind, payload})   // 신규 이벤트 채널
  → 프론트 워크스페이스가 kind별로 렌더 (말풍선 / 카드 / Todo / diff)
[턴 종료] → 판정 재실행 옵션 · 큐에 쌓인 메시지 있으면 자동 다음 턴
```

### 재사용 vs 신규

**재사용**: `parseAgentOutput`/stream-parser, `agent:output`·`agent:activity` broadcast, resume, 컨텍스트 주입, worktree/squash/판정, WS 인프라.

**신규 — 백엔드**
1. **세션 keep-alive** — 채팅 세션은 프롬프트마다 `killSession` 하지 않는다. `sessionManager`가 sessionKey(예: `chat-{agentId}`)로 세션 레코드와 `runtimeSessionId`를 유지해 다음 턴이 resume한다. 명시적 "세션 종료"(End Session) 시에만 정리. (주: 프로세스 상시 유지가 아니라 **세션 메타·resume id 유지**. `send()`는 여전히 턴마다 프로세스 spawn 후 종료.)
2. **인바운드 채팅 경로** — 후속 메시지를 *같은* 세션에 보낸다. 최소 변경은 기존 REST(`/prompt`)에 `sessionKey`/`keepAlive` 파라미터를 추가하는 것. (WS `chat:send`는 선택 — 현재 WS는 auth/subscribe만 처리 `websocket.ts:40-83`.)
3. **구조화 이벤트 파싱** — stream-json 라인을 채팅 이벤트(`text|thinking|tool_use|tool_result|todo`)로 변환해 `chat:event`로 broadcast. `stream-parser.ts`를 확장하거나 인접 모듈 신설. Claude/Codex 두 파서 라우팅 유지(`parseAgentOutput`이 provider로 분기).
4. **컨텍스트 주입 확장** — 소환 시 goal/task 상태(기획서·worktree 경로·최근 출력·판정 결과)를 시스템/유저 프리앰블에 주입. 기존 `session.ts` 주입 로직에 goal/task 스코프 추가.
5. **체크포인트** — 턴 경계에서 worktree 상태 스냅샷(기존 goal worktree 위에 shadow ref 또는 커밋). "코드만" / "코드+이후 대화" 2모드 되돌리기.

**신규 — 프론트 (`dashboard/src/components/`)**
- `SessionWorkspace` — 2-pane 컨테이너 (좌 대화 / 우 탭). 진입점에서 마운트.
- `ChatThread` — `AgentChatLog`를 승격: `chat:event` 구독, 말풍선 + 카드 렌더, 강제 오토스크롤 금지(바닥 근처만 follow) + "맨 아래로" 버튼, 긴 스레드 가상화.
- `ToolCard` — running/done/error 3상태, `tool_use.id`로 결과 매칭, 기본 접힘 + 한 줄 요약, 현재/과거 라벨, 명령카드 exit-code dot.
- `TodoList` — TodoWrite 이벤트 → `{done}/{total}` 헤더.
- `DiffPane` — hunk별 유지/되돌리기 + 위치-앵커드 인라인 코멘트("다음 메시지에 첨부").
- `InspectorTabs` — Diff / 최근 출력(터미널) / 작업 공간(worktree) / 판정(5-dim).
- `Composer` — nudge/queue 입력 (맥락 분기, §개입 모델), 큐 칩.

### 컴포넌트 경계 (isolation)

각 컴포넌트는 `chat:event` 스트림 또는 REST 조회만 의존하고 내부를 노출하지 않는다. `ToolCard`/`TodoList`/`DiffPane`는 순수 표시 컴포넌트(props in → render), 세션 상태는 `SessionWorkspace`가 소유. 서버의 구조화 파서는 stream-json 포맷을 프론트에서 숨긴다(프론트는 채팅 이벤트만 안다).

---

## 진입점 (3, 확정 기본값)

1. **에이전트 슬라이드 패널 내 지속 채팅** — 기존 `AgentDetail.tsx:864-915`의 단발 입력창을 지속 스레드로 승격. 빠른 개입용.
2. **실패 카드 `⚡ 소환`** — goal/task 카드에서 원클릭 → 해당 worktree·판정·최근출력이 주입된 세션이 열림. "터미널 없이 소환"의 심장.
3. **`⤢ 독립 작업공간`** — 패널/카드에서 풀 2-pane 워크스페이스로 확장.

---

## 개입 모델 (Nudge vs Queue)

입력창은 실행 중에도 **막지 않는다**. 맥락별 분기:

| 상태 | `⏎` (Enter) | `⌘⏎` | `Esc` |
|---|---|---|---|
| idle | 전송 | 전송 | — |
| 실행 중 | **큐**(현재 턴 종료 후 자동 전송, `[큐 N]` 칩) | **끼어들기(steer)** | 중단 |

큐 항목은 칩으로 가시화(드래그 재정렬은 후속). `⏎` 개행은 Shift+⏎.

> **제약 (정직)**: one-shot `--print` 모델은 실행 중인 프로세스에 mid-stream으로 메시지를 주입할 수 없다. 따라서 "끼어들기(steer)"의 실제 구현은 **현재 턴 프로세스를 중단(SIGTERM)하고, 누적 컨텍스트 + steer 메시지로 즉시 resume**하는 것이다. 진짜 툴-경계 인터럽트(Zed 방식)는 이 모델에선 불가. UI 라벨은 "지금 끼어들기"로 두되 내부는 중단+resume.

---

## 상태 표면화

- **판정 배지 🟢🟡🔴** — 기존 5-dim 판정을 헤더/카드에 색 배지로 승격. 점수판 신설이 아니라 "어디부터 볼지" 신호. (참고: `project_quality_gate_verdict` — 게이트를 죽이지 말고 채점 ceremony만 벗김.)
- **주입됨 스트립** — 소환 시 무엇을 읽었는지(worktree·판정·최근출력·기획서)를 칩으로 노출 → 잘못된 맥락을 사람이 즉시 캐치.
- **체크포인트 되돌리기** — 턴 경계 스냅샷, 2모드.

### 안티패턴 배제

- **Try-to-Fix 무한루프**(Bolt) — 반복 수정이 상태를 악화. crewdeck stall-detection과 충돌 → **"마지막 정상 worktree로 되돌리기"를 auto-fix보다 우선** 노출.
- Grid/Mission Control, best-of-N — 배제.

---

## 백엔드 제약

- **Codex resume 미구현** — `codex.ts:13` 현재 항상 fresh. Codex 세션은 v1에서 매 턴 컨텍스트 재주입(resume 없음)으로 동작, `thread_id` resume은 후속. Claude는 resume 정상.
- **Codex cost 미보고** — 컨텍스트 미터/cost는 provider별 optional(미지원 시 "—" 명시적 표기).
- 세션은 agent 레코드 필수(`session.ts:70-71`).

---

## 용어 / i18n 규칙

- 사용자 노출 껍데기(패널 제목·버튼·Toast)는 비개발자 친화 용어(`.claude/rules/ux-terminology.md`): "에이전트 종료"(=kill), "독립 작업 공간"(=worktree), "기획서"(=spec).
- 채팅 패널 내부 툴 라벨(Read/Bash/Edit)은 "개발자 전용 영역" 예외로 원어 유지.
- 사용자 노출 문자열은 i18n 키로(`dashboard/src/i18n/`), DB 저장 필드는 key:data(참고: `feedback_i18n_db`).
- `window.confirm/alert/prompt` 금지 → `ConfirmDialog`/`InputDialog`/`Toast` (`.claude/rules/dashboard-ui.md`).

---

## 검증 계획

구현 후 실제 진입점 동작으로 관통(테스트 GREEN만으로 불충분):

1. `npm run typecheck` + dashboard `tsc -b` PASS.
2. **소환 흐름** — 실패 goal 카드 `⚡소환` → 세션 오픈 → 주입 칩에 worktree/판정/최근출력 표시(Playwright 스크린샷).
3. **멀티턴** — 2턴 대화가 맥락 유지(2번째 턴이 1번째를 참조). resume 실동작 확인.
4. **구조화 렌더** — tool_use 카드 3상태 flip, Todo 갱신, Edit → diff pane 반영.
5. **개입** — 실행 중 `⏎` 큐잉 → 턴 종료 후 자동 전송 / `⌘⏎` 중단+resume / `Esc` 중단.
6. **라이브 서비스** — drain 절차 준수(큐 정지 → activeTasks=0 → build → restart).

---

## 열린 결정 (스펙 검토 때 확정)

- 인바운드 경로: REST 파라미터 확장(기본) vs WS `chat:send` 신설.
- 구조화 파싱 위치: `stream-parser.ts` 확장 vs 신규 모듈.
- 체크포인트 구현: shadow git ref vs worktree 스냅샷 커밋.
- 세션 만료/정리 정책(유휴 세션 keep-alive 상한).

---

## 레퍼런스

- 구조화 채팅 렌더: Cline / Roo Code(오픈소스, `ChatRow.tsx`·`buttonConfig.ts`·`TodoListDisplay.tsx`·`CommandExecution.tsx` 포팅 가능), Zed, Copilot, Cursor, Windsurf.
- 개입/소환: Devin(판정 신뢰도 배지·주입 컨텍스트 노출), OpenAI Codex(로그 citation·follow-up), Google Jules(플랜 게이트), Cosine Genie(Nudge/Queue), Claude web(문제→소환 딥링크).
- 안티패턴: Bolt Try-to-Fix 루프.
