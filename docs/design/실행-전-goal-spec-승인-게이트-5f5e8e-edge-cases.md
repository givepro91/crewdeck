# 실행 전 Goal Spec 승인 게이트 — 실세계 실패 패턴 조사

작성일: 2026-07-11  
대상: Goal Spec 생성·편집·버전 이력·승인/재승인·실행 차단·승인본 컨텍스트 전달·dashboard 조회  
목적: 후속 구현이 불완전하거나 오래된 spec을 승인·실행 가능한 상태로 오판하는 false-positive를 줄인다.

## 샘플링 범위와 방법

- 현재 Crewdeck goal worktree와 프로젝트 root에서 `goal_specs` schema, Goal/Task API, scheduler, decomposition prompt, dashboard spec UI를 읽었다.
- 부모 repo의 `git worktree list --porcelain`은 경로 내용을 저장하지 않고 등록 개수와 branch 상태만 집계했다.
- 사용자 운영 DB `~/.crewdeck/crewdeck.db`는 `sqlite3 -readonly`로 행 개수, 상태, JSON 배열 길이, 문자열 길이만 집계했다. title, description, prompt, agent 산출물, API key는 읽거나 기록하지 않았고 DB write도 없었다.
- 아래 ID·문구·시각은 재현용 가상 값이다. 실측 데이터는 개인 식별이 불가능한 개수와 분포만 반영했다.

## 실제 workspace 스냅샷

변동 가능한 수치는 2026-07-11 KST의 한 시점 기준이다.

| 표본 | 관찰 | 승인 게이트에 주는 신호 |
|---|---|---|
| 현재 task workspace | Crewdeck 자체가 goal 전용 worktree에서 실행 중이며 대상 문서 작성 전 worktree는 clean 상태였다. | 한 Goal의 승인본은 해당 worktree 실행 전체에서 고정돼야 한다. |
| 부모 Crewdeck repo | branch가 연결된 worktree 4개가 동시에 등록돼 있었다. | 서로 다른 Goal의 spec 생성·편집·승인은 실제로 동시에 일어날 수 있다. 전역 `current spec` 상태를 두면 안 된다. |
| 현재 source schema/API | `goal_specs.goal_id`가 `UNIQUE`인 단일 가변 row이고 PATCH/AI refine가 같은 row의 `version`을 증가시킨다. 생성 중/실패는 `prd_summary` 안의 `_status` sentinel로 표현한다. 별도 승인 snapshot은 없다. | 버전 이력과 승인 불변성을 기존 row의 숫자/문자열 상태에 덧붙이는 방식은 유실·경합·sentinel 오승인을 만들기 쉽다. |
| 현재 실행 진입점 | 수동 task 실행, goal/full autopilot, rescue, 재시작 복구, scheduler 준비 경로가 task를 실행 가능 상태로 바꿀 수 있다. | UI 버튼 하나만 막아서는 "미승인 실행 100% 차단"을 달성하지 못한다. 공용 claim 직전의 서버 게이트가 필요하다. |
| 운영 DB read-only 표본 | 5 projects, 19 goals, 136 tasks, 18 specs. 18개 spec은 모두 AI 생성이며 `version=2`; 1개 Goal은 spec이 없다. | `version>1`은 승인 의미가 아니다. spec 없음, 기존 단일-row spec, 생성된 최신 spec을 별개로 분류해야 한다. |
| 동일 DB의 spec 내용 분포 | feature 2~7개, user flow 4~10개, acceptance criteria 3~12개, tech consideration 4~12개. `prd_summary` JSON은 504~1,204자, acceptance JSON은 325~1,375자였다. | 빈 배열만 막는 검증과 짧은 고정 크기 가정 모두 부족하다. 구조별 유효성 및 합리적인 payload 한도가 필요하다. |
| 동일 DB의 실행 결합 | 17개 Goal에 task가 있고, 16개는 spec과 task가 함께 있다. 표본 시점에 서로 다른 2개 Goal의 task가 `in_progress`였다. | 기존 task가 있는 Goal과 실행 중 Goal의 spec 변경 정책을 명시하지 않으면 승인본과 실제 실행 컨텍스트가 갈라진다. |

## 실패 패턴 10가지

### 1. 형태만 맞는 빈 spec을 승인

입력 예시:

```json
{
  "prdSummary": {
    "background": "   ",
    "objective": "로그인 개선",
    "scope": "",
    "successMetrics": ["", "  "]
  },
  "featureSpecs": [],
  "userFlow": [{ "step": 1, "action": "", "expected": "완료" }],
  "acceptanceCriteria": ["  "],
  "techConsiderations": []
}
```

예상 결과:

- 생성·저장 중 draft로는 보존할 수 있지만 승인 요청은 거절한다.
- 필수 문자열은 trim 후 비어 있지 않아야 하고, 배열 원소도 필드별 schema와 최소 개수를 만족해야 한다.
- 오류는 `acceptanceCriteria[0]`처럼 사용자가 고칠 위치를 반환한다.

실패 이유:

- `NOT NULL`, JSON array 여부, 배열 길이만 검사하면 공백 원소와 부분 객체가 통과한다.
- 빈 완료 조건을 승인하면 decomposition은 임의 task를 만들고 Quality Gate는 검증 근거가 없어 서로 다른 성공 정의를 사용한다.

후속 고정 포인트: missing/null/빈 문자열/공백 문자열/빈 배열/부분 객체를 각 필드별 승인 거절 fixture로 둔다.

### 2. 생성 상태 sentinel 또는 손상된 legacy JSON을 정상 버전으로 승인

입력 예시:

```text
prd_summary = '{"_status":"generating"}'
acceptance_criteria = '["API 200",'
```

또는:

```json
{ "prdSummary": { "_status": "failed", "_error": "CLI timeout" } }
```

예상 결과:

- `_status=generating|failed` row는 draft 완료본이 아니며 승인·분해·실행 후보에서 제외한다.
- JSON 파싱 실패나 schema 불일치는 "spec 없음"으로 조용히 fallback하지 않고 진단 가능한 오류로 차단한다.
- 재생성 성공은 새 draft version을 추가하고 실패 sentinel 자체를 승인 이력으로 복제하지 않는다.

실패 이유:

- 현재 source는 비동기 생성 상태를 `prd_summary` 내부 sentinel로 저장하고 일부 경로는 문자열 포함 여부로 판별한다.
- 파싱 예외를 무시하고 기본 Goal 설명으로 분해하면 사용자는 spec 승인이 적용됐다고 보지만 실제 실행은 spec 없이 시작한다.

후속 고정 포인트: exact sentinel, sentinel에 부가 필드가 있는 경우, malformed JSON, 유효 JSON이나 잘못된 타입을 별도 fixture로 고정한다.

### 3. 두 편집자가 같은 base version을 저장해 한쪽 변경을 유실

입력 예시:

```text
현재 draft version=3
Tab A: version=3을 읽고 acceptanceCriteria 수정
Tab B: version=3을 읽고 scope 수정
t1: A PATCH(expectedVersion=3) → version=4
t2: B PATCH(expectedVersion=3)

또는 비동기 writer:

t0: AI refine(baseVersion=3, generationToken=R1) 시작
t1: 사용자 PATCH(expectedVersion=3) → version=4
t2: 사용자가 version=4 승인
t3: R1의 CLI 응답 도착
```

예상 결과:

- A만 성공하고 B는 stale version 충돌로 거절한다. B에게 최신 version=4를 반환해 재적용하게 한다.
- 새 버전 생성과 `(goal_id, version)` 증가는 한 transaction/CAS 안에서 수행한다.
- R1 완료 write도 시작 당시의 base version과 generation token을 CAS로 확인한다. v4 저장·승인이 먼저 끝났다면 R1은 stale completion으로 폐기되고 새 version을 만들거나 승인 상태를 바꾸지 않는다.
- 서로 다른 Goal의 동시 편집은 독립적으로 성공한다.

실패 이유:

- 기존 단일 row의 `UPDATE ... version=version+1`은 B가 오래된 전체 payload로 A의 변경을 덮어도 둘 다 성공한다.
- `SELECT max(version)+1` 후 INSERT도 동시 요청에서 같은 version을 계산해 unique 충돌이나 비결정적 재시도를 만든다.
- 현재 AI generate/refine 경로처럼 CLI 작업 뒤 최신 상태를 재확인하지 않고 UPDATE하면, 오래 걸린 응답이 그 사이의 수동 PATCH나 승인보다 나중에 도착해 최신 draft를 덮는다. HTTP 요청끼리의 optimistic lock만으로는 이 background writer를 막을 수 없다.

후속 고정 포인트: 같은 Goal 동시 PATCH는 1승 1충돌, 다른 Goal 동시 PATCH는 2승이 되는 실제 병렬 요청 테스트를 둔다. `refine(v3 시작) → PATCH v4/approve → refine 응답` 순서에서는 stale 응답이 version/event를 추가하지 않는 fixture를 별도로 둔다.

### 4. 오래 열린 화면이나 중복 클릭이 다른 버전을 승인

입력 예시:

```text
Tab A가 draft v4를 표시
Tab B가 v5를 생성
Tab A: POST approve { version: 4, idempotencyKey: "approve-click-1" }
네트워크 timeout 후 같은 요청을 재전송
```

예상 결과:

- 승인 API는 `goalId`의 현재 version을 추론하지 않고 요청에 명시된 immutable version ID를 승인한다.
- v4 승인이 제품 정책상 허용되지 않는다면 stale preview 충돌을 반환하고 v5 재검토를 요구한다. 허용한다면 실행본도 정확히 v4로 고정한다. 어느 경우에도 v5를 대신 승인하면 안 된다.
- 동일 idempotency key 재전송은 승인 event와 version을 중복 생성하지 않고 최초 결과를 반환한다.

실패 이유:

- `POST /approve`가 body 없이 "현재 최신"을 승인하면 클릭 시 사용자가 본 v4와 transaction 시점의 v5가 달라진다.
- timeout 재시도를 새 승인으로 처리하면 dashboard 이력과 승인 시각이 부풀고 WebSocket event 순서에 따라 상태가 흔들린다.

후속 고정 포인트: stale tab, double-click, 응답 유실 후 retry를 승인 version ID와 event 개수까지 검증한다.

### 5. spec 수정과 승인 race가 승인 무효화를 놓침

입력 예시:

```text
v7 = approved
t0: PATCH v7 기반으로 v8 생성
t0: 실행 요청이 v7 승인 상태를 조회
```

예상 결과:

- v8 생성과 기존 `current approval` 무효화는 한 transaction에서 일어난다.
- transaction 순서가 PATCH 먼저면 실행은 재승인 전 차단된다.
- 실행 claim이 먼저 확정됐다면 `goals.execution_spec_version_id=v7`이 원자적으로 고정되고 뒤따른 편집은 패턴 8의 실행 중 정책을 따른다.
- 승인된 v7 snapshot 자체의 UPDATE/DELETE는 항상 거절한다.

실패 이유:

- `INSERT v8`과 `approved=false`를 별도 query로 실행하면 그 사이 실행 요청이 오래된 승인 플래그를 보고 worktree를 시작한다.
- 승인 row를 가변 row로 재사용하면 "승인 취소" 과정에서 이미 사용된 판정 근거까지 바뀌어 감사 이력이 깨진다.

후속 고정 포인트: PATCH/approve/execute 세 요청의 순서를 barrier로 교차하며 `execution_spec_version_id`, 승인 상태, 생성 session 수를 확인한다.

### 6. 수동 실행은 막았지만 autopilot·rescue·재시작 경로가 게이트를 우회

입력 예시:

```text
Goal G: spec v2=draft, tasks=0
Case A: POST /goals/G/run
Case B: full autopilot queue start
Case C: rescue가 zero-task Goal 복구
Case D: 재시작 후 todo task를 scheduler가 claim
```

예상 결과:

- 네 경로 모두 승인된 immutable version이 없으면 worktree 생성, decompose session, task claim을 시작하지 않는다.
- 차단 결과는 동일한 machine-readable reason과 `goalId`, 현재 draft version을 노출한다.
- gate 판정은 UI나 개별 route가 아니라 모든 실행이 통과하는 서버측 preparation/atomic claim 경계에 있다.

실패 이유:

- 현재 source에는 수동 실행 외에도 goal/full autopilot, rescue, scheduler preparation, restart recovery가 task를 실행 가능 상태로 만드는 경로가 있다.
- route 한 곳의 `if (!approved)`는 다른 경로의 자동 승인이나 `pending_approval → todo` 일괄 UPDATE를 막지 못한다.

후속 고정 포인트: 각 진입점에서 session/worktree/task가 0건 생성되는 contract test와 공용 gate 직접 테스트를 둔다.

### 7. 단계마다 latest spec을 다시 읽어 decomposition·구현·Quality Gate가 서로 다른 버전을 사용

입력 예시:

```text
v10 승인
decompose가 v10으로 task 생성
사용자가 v11 draft 저장
구현 prompt가 `ORDER BY version DESC LIMIT 1`로 v11 읽음
Quality Gate가 goal_specs 현재 row에서 v11 또는 v12 읽음
```

예상 결과:

- 실행 승인/claim 시 `execution_spec_version_id=v10`을 한 번 고정한다.
- decomposition, 모든 Generator/fix prompt, Evaluator/acceptance 판정, dashboard 실행 표시는 모두 같은 v10 snapshot ID를 참조한다.
- v11은 다음 실행을 위한 미승인 draft로만 보이며 현재 실행의 기준을 바꾸지 않는다.

실패 이유:

- "승인된 최신" 또는 Goal의 현재 spec을 각 단계에서 재조회하면 단계 사이 편집·재승인에 따라 기준이 이동한다.
- 텍스트를 prompt에 복사만 하고 version ID를 task/session/verification에 남기지 않으면 실제로 동일본을 썼는지 추적할 수 없다.

후속 고정 포인트: v10 실행 중 v11 생성 후 decompose/implementation/evaluator prompt 캡처가 모두 v10 ID와 핵심 acceptance criterion을 포함하는지 관통 테스트한다.

### 8. 실행 중 spec 편집이 현재 worktree를 재시작하거나 승인본을 바꿈

입력 예시:

```text
Goal G: execution_spec_version_id=v3, task=in_progress, healthy session 존재
사용자: PATCH spec 또는 AI refine 요청
```

예상 결과:

- "실행 중 spec 자동 변경"은 범위 밖이므로 편집/refine 요청을 명시적으로 거절하거나, 현재 실행과 분리된 next-run draft로만 저장한다. 선택한 정책은 API와 dashboard가 동일하게 표현해야 한다.
- 어떤 경우에도 healthy session을 kill/restart하지 않고 v3 승인 snapshot이나 현재 prompt chain을 변경하지 않는다.
- 현재 실행이 끝날 때까지 `execution_spec_version_id`는 v3로 유지된다.

실패 이유:

- 운영 표본에는 spec+task가 함께 있는 Goal 16개와 실제 `in_progress` Goal 2개가 있어 실행 중 편집은 이론적 경계가 아니다.
- "새 spec이 생겼으니 다시 분해"하는 watcher는 기존 worktree 변경, task 상태, evaluator chain과 충돌하고 사용자 작업을 유실할 수 있다.

후속 고정 포인트: active session fixture에서 PATCH/refine 후 PID/session ID, task 상태, execution version이 그대로인지 검증한다.

### 9. 서버 재시작·WebSocket 재연결 후 승인 상태와 이력이 퇴행

입력 예시:

```text
t0: v6 승인 transaction commit
t1: 응답/WS broadcast 전에 프로세스 종료
t2: 서버 재시작, dashboard reconnect
t3: 지연된 `spec:updated(v5 draft)` event 수신
```

예상 결과:

- 재시작 후 DB의 v6 승인 event와 승인 시각을 조회해 같은 상태를 복원한다. broadcast 유실은 상태 유실이 아니다.
- dashboard는 event 수신만 믿지 않고 재조회하며, version이 낮은 지연 event로 v6 approved를 v5 draft로 퇴행시키지 않는다.
- 승인 audit event는 transaction과 함께 영속화되고 재시작 때문에 중복 생성되지 않는다.

실패 이유:

- 메모리의 `approvedSpec`이나 WebSocket toast만 승인 근거로 쓰면 commit 후 crash window에서 UI와 scheduler가 서로 다른 상태를 본다.
- 비동기 spec 생성의 `_status=generating` 복구만 처리하고 승인 복구를 누락하면 queue가 영구 대기하거나 반대로 draft를 실행한다.

후속 고정 포인트: commit 직후 broadcast 전 crash를 주입하고 REST 재조회, scheduler 차단/허용, event 단조성을 검증한다.

### 10. 기존 Goal·기존 단일-row spec을 신규 승인 필수 Goal로 오분류

입력 예시:

```text
Legacy A: 완료 Goal, spec 없음
Legacy B: task 6개 중 4개 done, 단일-row spec version=2, 승인 record 없음
New C: 기능 배포 이후 생성, draft v1, task 없음
```

예상 결과:

- 요구 범위대로 기존 완료 Goal은 소급 변환하지 않고 조회 가능 상태를 유지한다.
- 진행 중 legacy Goal의 정책은 명시적 migration marker/feature activation 시점으로 결정하며, `version=2`나 spec 존재만으로 승인됐다고 추론하지 않는다.
- New C는 승인 없이는 모든 실행 경로가 차단된다.
- migration은 기존 단일 row의 내용을 immutable version으로 보존하되 승인자·승인 시각을 날조하지 않는다.

실패 이유:

- 운영 DB에는 19개 중 spec 없는 Goal 1개, AI spec 18개가 있고 그 18개가 모두 `version=2`다. 따라서 version 숫자는 승인 여부를 구분하지 못한다.
- `created_at >= deployTime` 같은 시각 비교는 SQLite 초 단위 시각, clock 차이, 복원 DB에서 경계 Goal을 잘못 분류한다.
- 모든 기존 Goal을 일괄 미승인 처리하면 이미 진행 중인 task를 갑자기 멈추고, 모두 승인 처리하면 신규 보안 경계가 무력화된다.

후속 고정 포인트: 완료/진행 중/zero-task legacy와 신규 Goal을 migration fixture로 두고, 정책 marker가 재실행에도 idempotent한지 확인한다.

## 후속 구현의 최소 합격 계약

1. draft 저장 유효성과 승인 가능 유효성을 분리하고, 승인 시 전체 구조를 재검증한다.
2. 버전 생성, 승인/무효화, 실행 version 고정은 각각 명시적 transaction/CAS 경계를 가진다.
3. 승인본은 immutable하며 모든 실행 단계는 `goals.execution_spec_version_id`가 가리키는 동일 snapshot을 사용한다.
4. 수동 API, autopilot, rescue, recovery, scheduler claim이 하나의 서버측 승인 게이트를 공유한다.
5. 실행 중 healthy session과 고정된 승인본은 spec 편집/refine 때문에 변경되거나 종료되지 않는다.
6. dashboard는 version별 생성·수정·승인·무효화 시각을 DB에서 재구성하고 오래된 event로 상태를 퇴행시키지 않는다.
7. legacy 적용 여부는 명시적 marker로 결정하며 spec 존재, version 숫자, 배포 시각으로 승인 상태를 추론하지 않는다.

## 조사의 한계

- 한 사용자의 local workspace와 한 시점의 운영 DB 표본이므로 다중 사용자 권한 충돌은 조사 범위에 포함하지 않았다.
- 운영 DB에는 아직 승인 snapshot/event 모델이 없어 실제 승인 race 빈도를 측정할 수 없었다. 패턴 3~5와 9는 현재 동시 worktree·가변 단일-row 구조에 대한 폭로 분석이며 후속 동시성 fixture로 재현해야 한다.
- long payload, 손상 JSON, server crash는 운영 데이터에 주입하지 않았다. production DB write 금지 원칙에 따라 읽기 전용 집계와 source 경로 분석만 수행했다.
