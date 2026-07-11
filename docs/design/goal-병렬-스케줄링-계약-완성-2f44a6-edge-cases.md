# Goal 병렬 스케줄링 계약 완성 — 실세계 실패 패턴 조사

작성일: 2026-07-10  
대상: goal 간 병렬 슬롯, goal 내부 순차 lane, 공용 atomic task claim, dependency/reviewer gate  
목적: 후속 구현이 정상적인 실사용 상태를 중복 실행·교착·기아로 오판하는 false-positive를 줄인다.

## 샘플링 범위와 방법

- 비밀 파일, API key, 프롬프트, agent 산출물은 읽지 않았다.
- 현재 프로젝트 root와 부모/sibling worktree는 git 상태와 경로 구조만 확인했다.
- `~/.crewdeck/crewdeck.db`는 `sqlite3 -readonly`로 상태·개수·관계만 집계했다. 운영 DB write는 없었다. 변동 가능한 수치는 2026-07-10 23:02 KST 재확인 스냅샷이다.
- 주변 사용자 workspace는 git branch/worktree와 manifest 존재 여부만 확인했다.
- 아래 입력의 ID와 이름은 커밋 가능한 문서에 개인 데이터를 남기지 않기 위해 익명화했다. 구조와 개수는 실측값을 반영한다.

## 실제 workspace 스냅샷

| 표본 | 관찰 | 이 계약에 주는 신호 |
|---|---|---|
| 현재 root: `.crewdeck-worktrees/goal-goal-병렬-스케줄링-계약-완성-337e8e04` | Crewdeck 자체가 goal worktree 안에서 실행 중이고, 해당 worktree에 이전 task의 dirty 변경이 존재 | 한 goal의 후속 task는 동일 worktree 상태를 순차로 이어받아야 함 |
| 부모 Crewdeck repo | 동시에 서로 다른 goal worktree 3개가 등록됨 | goal 간 병렬은 실제 일반 상태이며, 슬롯 단위는 agent가 아닌 goal이어야 함 |
| `~/.crewdeck` read-only 스냅샷 | 5 projects, 19 goals, 113 tasks, 369 sessions. 활성 lane은 `in_progress` 3개였고 각각 다른 goal에 속함. goal 내 활성 lane 최댓값은 1 | 프로젝트 전체에서 여러 goal이 동시 진행되는 상태와 goal 내부 순차 lane이 함께 실측됨 |
| 동일 DB의 DAG/정렬 분포 | dependency 0개 35 tasks, 1개 46 tasks, 2개 이상 32 tasks. `sort_order` 중복 goal 1개, 동일 goal·동일 `created_at` 초 충돌 14그룹 | dependency gate와 tie-break는 희귀 예외가 아닌 일상 데이터 경로임 |
| 동일 DB의 role/type 분포 | `task_type='review'`인데 reviewer/qa role이 아닌 task 11개, reviewer/qa role에 배정됐지만 review type이 아닌 task 8개 | reviewer gate를 assignee role 또는 task type 하나로만 추론하면 양방향 오판 가능 |
| 익명화한 두 사용자 workspace root의 주변 repo | `main`, `master`, feature branch, user-created worktree, monorepo, package manifest 없는 repo가 혼재 | scheduler 계약은 프로젝트 stack이나 branch 형태를 가정하지 말고 DB goal/task 상태로 결정해야 함 |

## 실패 패턴 10가지

### 1. agent 수를 슬롯으로 오인해 한 goal의 task를 동시 실행

입력 예시:

```text
maxConcurrency = 2
Goal A: A1(todo, backend-1), A2(todo, backend-2)
Goal B: B1(todo, reviewer-1)
```

예상 결과:

- 첫 poll은 `A1 + B1` 처럼 goal당 최대 1개를 선택한다.
- `A2`는 A1이 `done`/해제될 때까지 대기한다.
- `activeTasks`가 2여도 활성 goal 수도 2이어야 한다.

실패 이유:

- 기존 agent-단위 동시성 로직은 다른 agent에 배정된 A1/A2를 독립 작업으로 본다.
- Goal-as-Unit은 A1/A2가 같은 worktree와 stash checkpoint를 공유하므로 파일 쓰기·롤백·이전 task 맥락이 충돌한다.

후속 고정 포인트: 여유 agent가 3명 이상이어도 live lane의 동시 개수는 goal당 1을 넘지 않아야 한다. 단, 미종결 child를 기다리는 `in_progress` 위임 부모는 live lane이 아니므로 raw status 개수만으로 이 불변식을 판정하지 않는다.

### 2. 수동 실행 중인 agent를 scheduler가 유휴 agent로 오판

입력 예시:

```text
Goal A: A1(in_progress, agent-X), active session exists, manual API로 시작
Goal B: B1(todo, agent-X)
Goal C: C1(todo, agent-Y)
maxConcurrency = 2
```

예상 결과:

- Goal A는 goal 슬롯 1개, agent-X는 agent lane 1개를 점유한다.
- scheduler는 B1을 건너뛰고 C1만 시작한다.
- agent-X의 정상 세션을 cleanup/SIGTERM하지 않는다.

실패 이유:

- scheduler 메모리의 `busyAgents`는 scheduler가 스폰한 세션만 안다.
- DB의 `in_progress`/`in_review` task와 `sessions.status='active'`를 함께 보지 않으면 수동 실행 세션 위에 다른 task를 spawn해 정상 세션을 종료시킨다.

후속 고정 포인트: in-memory busy 집합이 빈 상태에서 DB active task/session만으로 agent-X가 제외되는지 검증한다.

### 3. scheduler와 수동 API가 같은 goal의 다른 task를 동시 claim

입력 예시:

```text
Goal A: A1(todo, agent-X), A2(todo, agent-Y)
t0: scheduler poll이 A1 선택
t0: POST /tasks/A2/execute
```

예상 결과:

- DB transaction에서 먼저 goal lane을 claim한 한 요청만 성공한다.
- API 기준 성공은 `202 { status: "started", taskId }`, 패배는 `409 { error, taskId, status }`다.
- 세션 생성, task `in_progress` 전이, WebSocket 시작 표시는 전체 1회만 발생한다.

실패 이유:

- task ID에 대한 CAS만 하면 A1과 A2는 모두 `todo → in_progress`를 성공한다.
- 선택 단계의 메모리 체크와 실제 spawn 사이에 race window가 있으므로 claim 자체가 `goal_id`의 active sibling을 원자적으로 검사해야 한다.

후속 고정 포인트: 같은 task 중복 요청과 sibling task 교차 요청을 따로 실행한다.

### 4. claim 후 setup/env 실패가 발생한 5초 내 sibling 재claim

입력 예시:

```text
Goal A: A1(todo), A2(todo)
t0: A1 claim 성공
t0+20ms: CLI/env setup 실패로 A1이 todo로 복귀, started_at=t0 유지
t0+50ms: nested poll 또는 POST /tasks/A2/execute
```

예상 결과:

- env/rate-limit 계열 실패로 `todo`로 복귀한 claim은 최대 5초의 settle lease로 goal lane을 잠시 유지한다.
- settle 중 A1/A2 claim은 `409`로 충돌하고 session은 추가 생성되지 않는다.
- task 논리 실패는 `blocked`, 재시도 가능한 env/rate-limit 실패는 `todo`로 복귀하며 DB와 마지막 WebSocket 상태가 일치한다.

실패 이유:

- 실패 처리가 빠르면 첫 요청이 `in_progress`를 해제한 후 동시에 도착한 두 번째 요청이 DB를 읽는다.
- settle 표시가 없으면 한 번의 사용자 실행 의도가 여러 session 시도로 부풀고, spawn cleanup과 상태 broadcast가 엇갈린다.

후속 고정 포인트: 5초 경계 직전은 충돌, 경계 직후는 재claim 가능을 fake clock과 실제 동시 요청 두 방식으로 고정한다.

### 5. `in_review`를 빈 lane으로 보아 후속 구현을 먼저 시작

입력 예시:

```text
Goal A: A1(in_review, evaluator 진행 중), A2(todo)
Goal B: B1(todo)
maxConcurrency = 2
```

예상 결과:

- A1은 검증이 종료될 때까지 Goal A lane을 점유한다.
- 빈 project 슬롯에는 B1만 들어가고 A2는 대기한다.
- 실패/수정 라운드가 필요하면 A1의 같은 worktree 상태에서 먼저 수렴한다.

실패 이유:

- implementation subprocess가 끝났다는 이유로 `in_review`를 유휴로 보면 evaluator/fix가 읽는 diff 위에 A2가 동시로 변경을 쓴다.
- 구현·검증 사이 상태인 `in_review`를 제외하면 subprocess 종료 직후부터 evaluator 종료 전까지 동일 worktree를 보호할 주체가 사라진다. 현재 재확인 스냅샷에는 `in_review`가 없었으므로 이 패턴은 코드 경로와 상태 계약에 근거한 폭로 분석이다.

후속 고정 포인트: 점유 goal 집합과 atomic claim 둘 다 `in_progress`, `in_review`를 동일하게 취급해야 한다.

### 6. 위임 대기 부모를 실행 lane으로 계산해 자식을 영구 기아시킴

입력 예시:

```text
Goal A:
  Parent(in_progress, live session 없음)
  Child-1(todo, parent_task_id=Parent)
  Sibling(todo)
```

예상 결과:

- 미종결 child를 가진 Parent는 상태 표시는 `in_progress`이지만 live execution lane은 점유하지 않는다.
- Child-1이 실행 lane을 점유하면 그때부터 Goal A의 다른 task는 멈춘다.
- child가 모두 종결되면 parent completion 로직이 부모를 후속 검증으로 이끌어야 한다.

실패 이유:

- status만 보는 `COUNT(DISTINCT goal_id WHERE status IN (...))`는 Parent를 점유 lane으로 계산한다.
- 그러면 Child-1을 시작할 유일한 슬롯이 자기 부모에 의해 닫혀 자기 교착이 된다. 반대로 parent를 무조건 제외하고 실제 child도 제외하면 sibling 병렬이 열린다.

후속 고정 포인트: `parent waiting`, `child running`, `child in_review` 세 상태의 lane 계산을 따로 검증한다.

### 7. 최상위 goal이 dependency/reviewer gate에 막혀 남은 슬롯이 놀아버림

입력 예시:

```text
maxConcurrency = 2
Goal A(critical): A1(todo, dependency 미완료), A2(todo, reviewer gate)
Goal B(high):     B1(todo, executable)
Goal C(medium):   C1(todo, executable)
```

예상 결과:

- A의 우선순위는 유지하되, 현재 실행 가능한 task가 없으면 이 poll에서는 건너뛴다.
- B1과 C1이 두 goal 슬롯을 채우고, A는 gate가 풀린 다음 poll에 다시 가장 먼저 평가된다.
- A가 막혀 있는 이유는 stuck 진단에서 확인 가능해야 한다.

실패 이유:

- gate 검사 전에 goal 후보를 `LIMIT maxSlots`로 잘라내면 A가 슬롯 하나를 소모하거나, A만 반복 검사하며 B/C가 기아된다.
- 운영 DB에서 113 tasks 중 78 tasks가 dependency를 1개 이상 사용하므로 gate로 인한 lookahead는 주요 경로다.

후속 고정 포인트: 선택할 수는 2개지만 후보 goal은 gate 통과 후 2개가 찰 때까지 끝까지 순회해야 한다.

### 8. `depends_on` 손상·범위 오해로 의존성이 모두 완료된 것으로 오판

입력 예시:

```json
{
  "taskId": "A2",
  "goalId": "A",
  "depends_on": ["deleted-task", 3, "task-from-goal-B"]
}
```

또는 legacy row:

```text
depends_on = '["A1"'  // malformed JSON
```

예상 결과:

- JSON 파싱 실패, 존재하지 않는 ID, string이 아닌 항목은 "의존성 없음"이 아니라 진단 가능한 부정합으로 취급한다. A2는 실행하지 않고 task/goal 식별자가 포함된 activity를 남긴다.
- 다른 goal의 유효한 task ID는 현행 전역 task-ID 계약상 정상 dependency다. 대상 task가 `done`이 될 때까지 A2를 미루며, goal이 다르다는 이유만으로 삭제하거나 완료로 간주하지 않는다.
- 손상된 dependency는 사용자가 수정하거나 명시적으로 해제한 후에만 lane 후보가 된다.

실패 이유:

- `JSON.parse` 예외를 `[]`로 fallback하거나, 조회되지 않는 dependency를 "이미 없음"으로 무시하면 후행 task가 조기 실행된다.
- dependency 조회를 같은 goal로 제한하는 후속 변경도 유효한 cross-goal dependency를 누락해 같은 조기 실행을 만든다. 현재 scheduler는 ID를 전체 `tasks`에서 조회하므로 이 동작을 보존해야 한다.
- 현재 스냅샷은 malformed/missing/cross-goal reference가 모두 0이지만, dependency를 사용하는 task가 78개라 한 번의 삭제/마이그레이션 오류가 조용한 조기 실행으로 이어질 노출면이 크다.

후속 고정 포인트: malformed, non-array, missing ID, mixed type은 차단되는 fixture로 두고, 유효한 cross-goal ID는 대상 완료 전까지 대기하는 fixture로 따로 둔다.

### 9. reviewer 역할과 `task_type` 불일치로 gate가 너무 빨리 열리거나 영구 닫힘

입력 예시:

```text
Case A: QA-1(task_type=review, assignee.role=backend), sibling code task=todo
Case B: Audit-1(task_type=code, assignee.role=reviewer), independent sibling=todo
Case C: Root-Review(assignee.role=reviewer) ← dependent code tasks가 Root-Review를 의존
```

예상 결과:

- Case A의 실질 QA/review task는 sibling 구현이 종결될 때까지 대기한다.
- Case B의 일반 구현/분석 task는 assignee가 reviewer라는 이유만으로 마지막으로 밀리지 않는다.
- Case C는 role gate가 자기 의존성과 순환 대기를 만들지 않도록 DAG를 우선한다.
- gate 근거는 최소한 `task_type`, assignee role, 명시적 `depends_on`을 함께 본 결과로 일관되어야 한다.

실패 이유:

- role만 보면 Case A가 조기 실행되고 Case B는 불필요하게 지연된다.
- type만 보면 legacy/사용자 생성 task에서 역할 의도를 놓칠 수 있다.
- 실제 DB에 양방향 불일치가 각각 11개와 8개 존재했으므로 단일 필드 추론은 이론적 경계가 아니다.

후속 고정 포인트: role×type 2×2 matrix와 "reviewer root를 후행 task가 의존"하는 역방향 DAG를 검증한다.

### 10. `sort_order`/`created_at` 동률로 goal 내 선행 맥락이 재시작마다 바뀌는 경우

입력 예시:

```text
Goal A:
  A1(todo, sort_order=3, priority=high, created_at=2026-07-10 12:00:00)
  A2(todo, sort_order=3, priority=high, created_at=2026-07-10 12:00:00)
  depends_on=[] for both
```

예상 결과:

- 동순위라도 선택 결과는 서버 재시작·SQLite query plan에 따라 바뀌지 않는다.
- 명시 dependency가 있으면 그것이 정렬보다 우선한다.
- 정말 독립적인 동률 task라도 안정적인 최종 tie-break(예: `id ASC`)로 항상 같은 하나를 먼저 실행한다.

실패 이유:

- SQLite `datetime('now')`는 초 단위라 한 번의 decompose transaction이 만든 여러 row의 `created_at`이 같을 수 있다.
- 실제 스냅샷에 `sort_order` 중복 goal 1개와 동일 초 생성 충돌 14그룹이 있었다.
- 타이가 완전히 풀리지 않은 `ORDER BY`는 후속 task가 어떤 파일 상태와 `result_summary` 맥락을 받는지를 비결정적으로 만든다.

후속 고정 포인트: 동일 sort/priority/timestamp fixture를 반복 조회하고 재시작 후에도 선택 순서가 같은지 확인한다.

## 후속 구현의 최소 합격 계약

1. 프로젝트 동시성은 활성 agent/task 수가 아니라 점유 goal 수로 차감한다.
2. 한 goal의 live/settling lane은 항상 1개고, scheduler와 수동 API가 같은 DB claim을 사용한다.
3. `in_review`는 live lane이다. 단, 미종결 child를 기다리는 delegation parent는 live lane이 아니다.
4. 상위 goal이 gate에 막혀도 하위 ready goal로 남은 슬롯을 채우며, 우선순위는 gate 해제 후 다시 적용한다.
5. dependency/reviewer/order 부정합은 조용한 "ready" fallback으로 숨기지 않고 진단 가능하게 표면화한다.
6. 모든 실행 전이와 WebSocket 표시는 DB의 실제 상태와 일치하고, 중복/실패 claim이 유령 `in_progress`를 남기지 않는다.

## 조사의 한계

- 스냅샷은 한 사용자의 현재 local workspace와 운영 DB에 한정된다.
- 고부하 3개 이상 goal의 장시간 병렬 완주, 서버 재시작 중 claim 복구, 동시 squash는 이 조사에서 실행하지 않았다.
- 실제 DB의 dependency 손상 건수는 0이었다. 패턴 8은 현재 정상 데이터에 대한 폭로 분석이며, 삭제·마이그레이션 fixture로 재현해야 한다.
