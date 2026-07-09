# Codex 백엔드 지원 — 설계 스펙

- **날짜**: 2026-07-09
- **상태**: 설계 승인, 구현 계획 대기
- **목표**: Crewdeck의 에이전트 백엔드를 Claude Code CLI 전용에서 **Claude / Codex 선택 + 자동 failover** 구조로 확장한다.

## 1. 배경 & 목표

현재 모든 에이전트 세션은 `claude` CLI 서브프로세스로만 실행된다. Claude 구독 세션이 한도(rate-limit)에 걸리거나 소진되면 태스크가 쿨다운 후 **Claude 회복만 기다린다**. 사용자 니즈:

1. **자동 failover** — 실행 중 세션이 한도/소진/환경오류로 막히면, 기다리지 말고 **같은 태스크를 Codex로 즉시 재디스패치**해 진행을 이어간다.
2. **수동 개입(하이브리드)** — 에이전트/프로젝트 단위로 실행 엔진(자동/Claude/Codex)을 지정하고 언제든 되돌릴 수 있다.
3. **작업 중 무영향** — 수동 변경이나 타 에이전트의 failover가 **건강하게 실행 중인** 세션을 죽이지 않는다. (단, 한도에 *걸린* 세션은 failover의 주 대상이지 무영향 대상이 아니다.)

### 비목표 (YAGNI)

- 교차 Generator-Evaluator(Claude 구현 + Codex 검증 자동 조합) — 추후 판단.
- 모델 네임스페이스 완전 정규화 / 3개 이상 provider.
- Codex 세션 resume 체인 완전 구현(1차는 failover 시 fresh 세션 허용).

## 2. 현재 아키텍처 — 결합 지점 (근거)

Explore 매핑 결과. provider 추상화는 **없고** 아래가 claude 전용으로 결합돼 있다.

| # | 결합 지점 | 위치 |
|---|---|---|
| 1 | `spawn("claude", ...)` 커맨드명 | `adapters/claude-code.ts:129` |
| 2 | CLI 인자(`--print - --output-format stream-json --verbose`, `--resume`, `--model`, `--add-dir`, `--append-system-prompt-file`, `--dangerously-skip-permissions`) | `claude-code.ts:384-444` |
| 3 | stdin 프롬프트 주입 | `claude-code.ts:234-235` |
| 4 | stream-json 이벤트 스키마(text/usage/tool/rate_limit/session_id) | `adapters/stream-parser.ts:82-187` |
| 5 | session-id resume 체인 | `claude-code.ts:302-322,493-519`, `session.ts:55-57,128` |
| 6 | stderr/stdout 에러·rate-limit 패턴 | `claude-code.ts:512-542`, `utils/errors.ts:103-144` |
| 7 | model 문자열→`--model` 직행, provider 컬럼 부재 | `session.ts:122`, `utils/constants.ts:44-57`, `db/schema.ts:366-369` |

**유지 가능한 중립 경계**: `ClaudeCodeSession`(EventEmitter) 이벤트 계약(`status`/`pid`/`output`/`stderr`/`rate-limit`/`crewdeck:error`), `RunResult`·`ParsedStreamOutput` 반환 타입, `SessionManager` pause/resume(OS 시그널), `sessions` 테이블 token/cost 집계.

**직접 소비 지점**: `session.ts:30`·`team-designer.ts:233`이 `createClaudeCodeAdapter()`를 직접 인스턴스화. `parseStreamJson(...)`은 15+ 지점에서 직접 호출(`engine.ts`, `delegation.ts`, `evaluator.ts`, `orchestration.ts` 등).

## 3. Codex CLI 대응 (검증 완료 — codex-cli 0.141.0)

`codex exec` 비대화 실행이 claude 어댑터에 매핑된다:

| Claude | Codex | 비고 |
|---|---|---|
| `claude --print - --output-format stream-json --verbose` | `codex exec --json -` | stdin 프롬프트(`-`) |
| `--model <m>` | `-m <m>` | 기본은 생략(Codex 기본 모델) |
| `--add-dir <d>` | `--add-dir <d>` + `-C <cwd>` | |
| `--resume <sid>` | `codex exec resume <uuid> [prompt]` / `--last` | 1차는 미사용(fresh) |
| `--append-system-prompt-file <f>` | (없음) | → stdin prepend |
| `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | |
| stream-json JSONL | `--json` JSONL | **스키마 상이 → 전용 파서** |

추가 유용 플래그: `-s/--sandbox {read-only,workspace-write,danger-full-access}`, `--skip-git-repo-check`, `--ephemeral`, `-o/--output-last-message <FILE>`, `--output-schema <FILE>`.

> ⚠ Codex `--json` 이벤트 스키마와 rate-limit/소진/에러 신호 포맷은 **미확정**. 구현 첫 태스크에서 실캡처로 확정한다(§9).

## 4. 설계 — 컴포넌트

### 4.1 백엔드 추상화 (`adapters/backend.ts` 신설)

provider-중립 인터페이스 추출:

```ts
interface AgentBackendConfig { /* 기존 ClaudeCodeConfig 상위집합 + provider 무관 필드 */ }
interface AgentSession extends EventEmitter { id; process; status; lastSessionId; send(); kill(); cleanup(); }
interface AgentBackend { readonly provider: "claude" | "codex"; spawn(config: AgentBackendConfig): AgentSession; isAvailable(): Promise<boolean>; }
```

- `claude-code.ts`를 `AgentBackend`(provider="claude")로 정리(동작 무변경).
- `codex.ts` 신설(provider="codex") — §3 매핑으로 spawn.
- 팩토리 `getBackend(provider): AgentBackend`.
- 이벤트 계약(`output`/`stderr`/`rate-limit`/`crewdeck:error`/`status`/`pid`)은 provider 공통 — 소비자(`session.ts`) 무변경.

### 4.2 스트림 파서 분기

- `stream-parser.ts`(claude) 유지. `codex-stream-parser.ts` 신설 — Codex `--json` JSONL을 **동일한 `ParsedStreamOutput`**(text/usage/tools/rateLimit/sessionId)으로 정규화.
- 파서 선택: 세션이 어느 provider로 돌았는지에 따라 라우팅. `parseStreamJson` 15+ 직접 호출부는 `parseAgentOutput(output, provider)` 헬퍼로 감싸거나, 세션 결과에 provider를 실어 파서를 고른다. (반환 타입 고정이라 호출부 시그니처 영향 최소)

### 4.3 시스템 프롬프트 주입 (Codex)

Codex엔 `--append-system-prompt-file`가 없음 → `session.ts`가 만든 **enriched 프롬프트(시스템 + 컨텍스트 체인 + CLAUDE.md/AGENTS.md)를 stdin 본문 앞에 prepend**. 레포에 파일을 쓰지 않는다.

### 4.4 모델 매핑

- agent.model(opus/sonnet/haiku, Claude 별칭)은 Claude에서만 `--model`로 직행(현행 유지).
- Codex 실행 시 **기본: `-m` 생략**(Codex 설정 기본 모델). 하드코딩 모델명 회피.
- 선택 오버라이드: `~/.crewdeck/config.json`의 `codexModelMap`(예: `{ "opus": "<high>", "sonnet": "<default>" }`)이 있으면 매핑 적용.

## 5. 백엔드 선택 & failover

### 5.1 provider 해석 순서 (spawn 시점)

```
resolveProvider(agent, project, config) → 시작 백엔드:
  1. agent.provider            ("claude" | "codex" | null=상속)
  2. project.default_provider  ("claude" | "codex" | null=상속)
  3. 전역 기본 (config.defaultProvider ?? "claude")
```

- `provider` 컬럼 값은 `"claude"|"codex"|null`뿐(저장). UI의 **"자동"** = null(상속). "Claude"/"Codex" = 해당 값으로 pin(= *시작* 백엔드 고정).
- **failover는 pin과 독립(직교)** — 전역 토글 `config.codexFailover`가 켜져 있으면, *시작* 백엔드가 pin이든 상속이든 상관없이, 세션이 트리거 클래스(§5.2)로 실패하면 대체 백엔드를 시도한다(루프 가드·가용성 조건 하에). 즉 pin은 "어디서 시작하나"만 정하고 failover를 끄지 않는다.
- **해석은 `spawnAgent()` 시점에만** → 수동 변경·타 에이전트 failover는 실행 중 세션에 무영향(§1.3).

### 5.2 failover 동작 (핵심)

현재: 세션 rate-limit 종료 → `classifyAgentFailure` → `rate_limit`/`session_exhausted`/`env_error` → scheduler `handleRateLimit`/`handleEnvError`(쿨다운 + Claude 자동재개).

변경:

1. **failover 결정 지점 신설** — 세션이 `rate_limit | session_exhausted | env_error`로 실패했을 때:
   - 대체 백엔드(현재 provider의 반대)가 **가용**하고, **이 태스크 시도에서 아직 안 써봤고**, failover가 **켜져 있으면** → 같은 태스크를 대체 백엔드로 **즉시 재디스패치**(쿨다운 대기 없이).
   - 아니면 → 기존 쿨다운-대기(레이어드 폴백).
2. **어댑터 내부 Claude rate-limit 대기-재시도**(`claude-code.ts:328-350`)가 세션을 붙잡지 않도록 — failover 활성 시엔 수동 대기 대신 **실패로 surface**해 scheduler가 failover하게 한다(Claude 재개 선호보다 failover 우선).
3. **failover 루프 가드** — 태스크 시도 단위로 "이미 시도한 provider" 집합을 두어 Claude↔Codex 무한 왕복 차단. 양쪽 모두 소진이면 쿨다운.
4. **트리거 범위** = `rate_limit`, `session_exhausted`, `env_error`. `task_error`(코드 버그 fail)는 failover 대상 아님(기존 blocked/재시도 유지).

### 5.3 사용자 수동 개입

- **실행 엔진 선택**: 에이전트 상세 / 프로젝트 설정에 `자동 / Claude / Codex`. 다음 spawn부터 적용.
- **전역 토글**: "Codex failover 사용"(config).
- 실행 중 세션은 절대 죽이지 않음.
- 용어: `.claude/rules/ux-terminology.md` 준수 — "provider/backend" 노출 금지, **"실행 엔진"** 등 사용.

## 6. Codex 에러/한도 분류

- `classifyAgentFailure`(`errors.ts:95-121`)와 어댑터의 `isRateLimitError`/`isUnknownSessionError`는 claude stderr/stdout 패턴 결합.
- Codex 세션엔 **Codex 신호 감지**를 별도 적용(어댑터가 정규화된 `rate-limit`/실패 신호를 올리고, 분류기는 provider별 분기 또는 정규화 신호 소비).
- Codex도 소진 → 대체 없음 → Claude 쿨다운 폴백.
- *실제 Codex rate-limit/소진 문자열은 §9 첫 태스크에서 확정.*

## 7. 데이터 모델 변경

DB(인라인 마이그레이션 `db/schema.ts`):

- `agents.provider TEXT` — null=상속. (`"claude"|"codex"|null`)
- `projects.default_provider TEXT` — null=전역.
- `sessions.provider TEXT` — 세션이 **실제** 돈 백엔드(관찰·비용 귀속·failover 추적).

`~/.crewdeck/config.json`:

- `defaultProvider: "claude"|"codex"` (기본 "claude")
- `codexFailover: boolean` (기본 true — 사용자 니즈)
- `codexModelMap?: Record<string,string>`

전부 하위호환(미설정 시 현행 claude 동작 동일).

## 8. 테스트

- `codex-stream-parser` 유닛 — §9에서 캡처한 **실 JSONL 픽스처** 기반(text/usage/tool/rate_limit/session_id 추출).
- `resolveProvider` 해석 순서(agent>project>global, auto/pin).
- **failover 결정 로직** 유닛 — (classifyAgentFailure 결과 × 대체 가용성 × 시도이력 × 토글) → 다음 액션(재디스패치/쿨다운). 루프 가드 포함.
- 모델 매핑(map 유무).
- 회귀: 기존 claude 경로 무변경(281건 그린 유지), Generator-Evaluator 분리 provider별 유지.

## 9. 구현 순서 (첫 태스크 = 실캡처)

1. **Codex 실출력 캡처** — 사소한 프롬프트로 임시 git repo에서 `codex exec --json -` 1회 실행, JSONL 이벤트 스키마·usage 필드·session-id·rate-limit/에러 신호를 픽스처로 저장. `codex login` 인증 상태 확인. (파서·분류기의 사실 근거)
2. `AgentBackend` 인터페이스 추출 + `claude-code.ts` 정리(동작 무변경, 회귀 그린).
3. `codex.ts` + `codex-stream-parser.ts`(캡처 픽스처 기반).
4. `resolveProvider` + DB 마이그레이션(`agents.provider`, `projects.default_provider`, `sessions.provider`) + config 필드.
5. failover 결정 지점 + 루프 가드 + 어댑터 대기-재시도 surface 전환.
6. Codex 에러/한도 분류 분기.
7. UI(실행 엔진 선택 + 전역 토글) + 상태 표면화(Codex 가용성).
8. 검증: typecheck ×2, vitest, drain-safe 배포, **실 failover 관통**(Claude 한도 상황을 유도하거나 강제 트리거로 Codex 인계 실측).

## 10. 리스크 / 열린 질문

- **Codex JSONL 스키마 미확정** → 첫 태스크로 해소(파서·분류기의 전제).
- **Codex 인증 전제** — 미인증이면 failover no-op. 상태로 표면화.
- **Claude 세션 컨텍스트 손실** — failover 시 Codex는 fresh 세션(Claude resume 컨텍스트 미승계). 태스크 프롬프트에 실패 이력(Smart Resume)이 이미 실리므로 수용 가능. Codex→Codex resume은 추후.
- **비용 귀속** — Codex 세션의 token/cost 집계는 Codex `--json` usage 필드 유무에 의존(§9에서 확인). 없으면 세션 수만 기록.
- **샌드박스 정책** — Codex 기본 sandbox가 워크트리 쓰기를 막을 수 있음 → `-s workspace-write` 또는 `--dangerously-bypass-...`(claude의 skip-permissions 대응, config 게이트) 필요. §9에서 확인.
