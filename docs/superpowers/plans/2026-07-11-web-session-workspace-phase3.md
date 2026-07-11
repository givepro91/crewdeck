# 웹 세션 워크스페이스 Phase 3 — 풀 2-pane 워크스페이스

**Goal:** 소환된 세션을 좁은 슬라이드 패널이 아니라 **풀 2-pane 워크스페이스**(좌 대화 / 우 탭: Diff·최근출력·작업공간·판정)로 확장해, 대화하며 변경/판정/출력을 한 화면에서 본다.

**Base:** `c21f73f` (Phase 2, feat/web-session-workspace-phase2 워크트리). 근거: `docs/design/web-session-workspace.md` §진입점 3, §아키텍처 신규-프론트.

**워크트리 격리:** `/Users/keunsik/develop/givepro91/crewdeck-phase2` (main의 사이드바 activity 작업과 분리).

## 범위 (완성도 우선 — design 결정 "풀 워크스페이스 v1")

**Phase 3a (이 계획):**
- `SessionWorkspace` — 2-pane 컨테이너 (좌 `ChatThread`+`ChatComposer` 재사용 / 우 `InspectorTabs`). 풀스크린 오버레이.
- `InspectorTabs` — Diff / 최근 출력 / 작업 공간 / 판정 4탭.
- `DiffPane` — worktree diff **읽기 렌더**(파일별·hunk 구분, 추가/삭제 색).
- `⤢ 독립 작업공간` 진입 — AgentDetail 슬라이드 패널·소환에서 풀 워크스페이스로 확장.
- 판정 탭 = 기존 verification timeline UI 재사용. 최근출력 탭 = session last_output. 작업공간 탭 = worktree 파일 목록.

**Phase 3b (후속 분리):** DiffPane hunk별 유지/되돌리기(git 부분 revert) + 위치-앵커드 인라인 코멘트("다음 메시지에 첨부"). 복잡도 높아 독립 검증 단위.

## 백엔드 (Explore 결과로 확정 — 자리표시)

- **worktree diff API**: `GET /goals/:goalId/diff` — goal worktree의 `git diff <base>..HEAD`(또는 워킹트리 변경)를 파일별 hunk로 반환. (기존 squash 흐름의 diff 계산 재사용 가능한지 Explore 확인)
- **worktree 파일 목록 API**: `GET /goals/:goalId/files` — worktree 파일 트리(작업공간 탭).
- 판정: 기존 `GET /goals/:goalId/verification-timeline` 재사용.
- 최근출력: 기존 sessions.last_output (필요 시 sessions API에 노출 추가 — Phase 2 백엔드 조사에서 sessions.ts SELECT에 last_output 누락 확인됨).

## 프론트 컴포넌트 (design §신규-프론트)

- `dashboard/src/components/SessionWorkspace.tsx` (신규) — 2-pane 컨테이너. props `{ agentId, taskId?, goalId?, onClose }`. 좌: `<ChatThread agentId/>` + `<ChatComposer agentId taskId/>`. 우: `<InspectorTabs goalId/>`. 풀스크린 fixed 오버레이(기존 모달 관례 따름).
- `dashboard/src/components/InspectorTabs.tsx` (신규) — 4탭 스위처. 탭별 lazy fetch.
- `dashboard/src/components/DiffPane.tsx` (신규) — diff 읽기 렌더. props `{ goalId }`. 파일별 접힘 + hunk 라인 색(+green/-red).
- 진입점: AgentDetail 헤더 `⤢` 버튼 → `SessionWorkspace` 마운트(ProjectHome state). 소환(open-agent)도 풀 워크스페이스로 직행 옵션.

**컴포넌트 경계:** `DiffPane`/`InspectorTabs`는 순수 표시(REST 조회 → render), 세션 상태는 `SessionWorkspace`가 소유. `ChatThread`/`ChatComposer`는 Phase 1·2 그대로 재사용(agentId/taskId).

## 검증
1. `npm run typecheck` + dashboard `tsc -b` PASS, lint 신규 0.
2. 라이브 E2E는 **Phase 2·3·4 통합 시점**에 워크트리 별도 포트로 1회(소환→워크스페이스→diff/판정/출력 탭→대화). drain 절차.

## i18n / 규칙
- 신규 문자열 ko/en 동시(`workspaceTab*`, `diffEmpty` 등). "독립 작업 공간"=worktree(ux-terminology).
- `window.confirm` 금지 → ConfirmDialog/Toast.
