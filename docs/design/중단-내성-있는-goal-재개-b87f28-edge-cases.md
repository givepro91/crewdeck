# 중단 내성 있는 Goal 재개 — 실세계 실패 패턴 조사

작성일: 2026-07-11  
대상: 서버 시작 및 비정상 세션 종료 후 Goal-as-Unit 복구  
목적: DB 상태만 신뢰해 같은 task를 중복 실행하거나, 반대로 Git 산출물을 잃는 false-positive를 후속 구현 전에 고정한다.

## 조사 범위와 판정 원칙

- 실제 사용자 워크스페이스인 Crewdeck 프로젝트 루트와 현재 goal worktree, 등록된 다른 goal worktree를 읽기 전용으로 표본 조사했다.
- `.crewdeck` DB, API key, `.env` 등 비밀·운영 데이터는 열거나 수정하지 않았다. 표본은 `git status`, `git worktree list`, branch/HEAD, shared stash처럼 복구 판정에 필요한 Git 메타데이터로 한정했다.
- 현재 worktree의 미커밋 server 변경은 완료된 선행 복구 태스크의 산출물이므로 수정하거나 정리하지 않았다.
- 안전한 자동 재개는 **실행 소유권이 회수되었고, 저장된 checkpoint와 실제 worktree/Git 증거가 하나의 결론만 가리킬 때만** 허용한다. 증거가 없거나 충돌하면 파일을 바꾸지 않고 goal을 차단하고 사용자 조치를 기록한다.
- 아래의 “예상 결과”는 후속 구현과 회귀 테스트가 지켜야 할 계약이다. 실제 표본 하나가 모든 운영 변형을 대표한다는 뜻은 아니다.

## 실제 워크스페이스 표본

| 표본 | 관찰한 실제 특성 | 복구 위험 |
|---|---|---|
| `/Users/keunsik/develop/givepro91/crewdeck` | `main` HEAD와 goal worktree들이 하나의 common Git dir를 공유 | base branch와 goal branch 증거를 혼동하거나 다른 goal 산출물을 정리할 수 있음 |
| 현재 goal worktree `.../goal-중단-내성-있는-goal-재개-f76ca11b` | 한글 branch, 13개 이상의 tracked dirty 파일, 추가 후 수정된(`AM`) 테스트 파일 존재 | 단순 dirty boolean 또는 unstaged diff만으로는 crash 전후 상태를 구별하지 못함 |
| 다른 goal worktree `.../goal-실행-전-goal-spec-승인-게이트-03a16e9a` | dashboard/server 양쪽에 독립적인 tracked dirty 변경 존재 | cleanup 또는 전역 stash 복원이 sibling goal의 WIP를 훼손할 수 있음 |
| `git stash list` | 서로 다른 goal의 `crewdeck-checkpoint-*`, `crewdeck-final-*`, 임시 main merge stash가 같은 저장소에 공존 | `stash@{N}` 순번과 prefix만으로 소유 stash를 고르면 다른 goal 증거를 소비함 |
| `git worktree list` | 프로젝트 루트 외에 `.crewdeck-worktrees`와 `/private/tmp` worktree가 등록되어 있고, 한 임시 branch 표시는 깨진 문자로 보임 | 경로 존재만 확인하거나 출력 인코딩을 신뢰하면 잘못된 worktree/branch를 정상으로 판정함 |

## 실패 패턴 10가지

### 1. 서버는 죽었지만 CLI의 자식 프로세스가 worktree에 계속 쓰는 경우

입력 예시:

```json
{
  "task.status": "in_progress",
  "session.status": "active",
  "session.pid": 48120,
  "session.process_group_id": 48120,
  "checkpoint.head": "64bbf38...",
  "worktree.dirty": false
}
```

프로세스는 `SIGTERM` handler에서 detached child를 만들고 500ms 뒤 `late.txt`를 쓴다.

예상 결과:

- 복구는 task/worktree 대조보다 먼저 해당 실행의 **전체 process group 종료**를 시도하고, 더 이상 쓰는 프로세스가 없음을 확인한다.
- 종료 확인 후의 최종 worktree를 checkpoint와 대조한다.
- timeout, `EPERM`, PID-only legacy row 등으로 전체 종료를 증명하지 못하면 task와 goal을 차단한다. scheduler는 같은 worktree에 새 세션을 띄우지 않는다.
- 종료 시도, 확인 결과, 차단 사유와 사용자 조치를 activity log에 남긴다.

실패 이유:

- DB의 `active`를 `killed`로 바꾸는 것만으로 OS 프로세스 소유권은 회수되지 않는다.
- root PID만 종료하거나 종료 완료를 기다리지 않으면 대조 직후 late write가 발생해, 새 attempt와 이전 CLI가 같은 worktree를 동시에 수정한다.

후속 고정 포인트:

- 실제 child process fixture로 “종료 확인 전 대조 금지”와 “종료 불명 시 재실행 0회”를 고정한다.

### 2. 이전 attempt의 종료 callback과 failover 재디스패치가 엇갈리는 경우

입력 예시:

```text
attempt A (claude): rate_limit 감지 → failover 예약
scheduler poll: 같은 task를 codex attempt B로 claim
attempt A close callback: task를 blocked/todo로 갱신
server restart: DB에는 B의 in_progress와 A의 늦은 결과가 혼재
```

예상 결과:

- task claim, 수동 실행, retry, failover는 동일한 원자적 실행 소유권 계약을 사용한다.
- 각 상태 변경은 현재 attempt/owner token이 일치할 때만 성공한다. A의 늦은 callback은 B의 상태나 checkpoint를 덮지 못한다.
- 재시작 시 만료된 owner만 회수하고, 같은 task/goal execution lane에는 최대 한 attempt만 재개한다.
- 회수한 attempt와 무시한 stale callback을 activity log에서 식별할 수 있어야 한다.

실패 이유:

- `tasks.status = 'in_progress'` 한 칼럼과 in-memory `busyAgents`만으로는 어느 실행이 현재 소유자인지 구별할 수 없다.
- failover callback과 poll이 각각 `todo → in_progress`를 수행하면 동일 task가 두 provider에서 중복 실행되고, 먼저 끝난 쪽이 다른 쪽의 결과를 덮는다.

후속 고정 포인트:

- callback/poll barrier를 둔 테스트에서 동시 active session과 동일 worktree 재사용이 모두 0건인지 확인한다.

### 3. claim은 저장됐지만 checkpoint 또는 session 식별자는 저장되기 전에 종료된 경우

입력 예시:

```json
{
  "task.status": "in_progress",
  "attempt.owner": "attempt-7",
  "task.recovery_checkpoint_head_sha": null,
  "task.recovery_worktree_dirty": null,
  "sessions": []
}
```

예상 결과:

- checkpoint, worktree/branch, owner/attempt와 실행 상태 사이의 crash window를 저장 순서 또는 transaction으로 제거한다.
- 구버전/부분 저장 row처럼 필수 증거가 없으면 “아무 작업도 안 했을 것”이라고 추정해 `todo`로 돌리지 않는다.
- 파일을 그대로 보존하고 `blocked + manual_action_required`로 안전 정지하며, 누락된 증거 필드를 activity log에 기록한다.

실패 이유:

- spawn 전후에는 에이전트가 파일을 썼는지 알 수 없는 구간이 있다. session row가 없다는 사실은 subprocess가 없었거나 작업하지 않았다는 증거가 아니다.
- 무조건 `todo`로 전환하면 숨은 이전 실행과 재실행이 겹치거나 기존 WIP를 새 실행이 덮을 수 있다.

후속 고정 포인트:

- claim 직후, checkpoint 저장 직후, spawn 직후의 세 crash point를 각각 fixture로 둔다.

### 4. 구현 도중 dirty 여부는 같지만 파일 내용이 달라진 경우

입력 예시:

```json
{
  "checkpoint.dirty": true,
  "checkpoint.diff_hash": "sha256:before",
  "actual.dirty": true,
  "actual.diff_hash": "sha256:after",
  "actual.status": [" M server/core/recovery.ts", "AM server/__tests__/git-recovery-guard.test.ts"]
}
```

예상 결과:

- tracked staged/unstaged diff와 untracked file 내용을 포함하는 안정적인 hash로 checkpoint를 비교한다.
- dirty boolean이 같아도 hash가 다르면 이전 task의 WIP인지, 중단된 task의 부분 결과인지 자동 판정하지 않고 차단한다.
- `reset`, `checkout`, stash pop, 재실행을 하지 않은 채 실제 파일을 보존한다.

실패 이유:

- 현재 실제 표본처럼 `M`과 `AM`이 함께 있으면 `dirty=true`만으로 crash 전 snapshot과 crash 후 부분 구현을 구별할 수 없다.
- `git diff`만 hash하면 staged 변경이나 untracked 파일이 빠져 동일 snapshot으로 오판될 수 있다.

후속 고정 포인트:

- staged-only, unstaged-only, untracked, rename, 파일명 공백/한글을 각각 hash 변화 입력으로 고정한다.

### 5. 구현은 끝났고 검증도 통과했지만 task commit SHA 저장 전에 종료된 경우

입력 예시:

```text
checkpoint HEAD = A
검증 완료 marker(recovery_commit_ready) = true
실제 goal branch HEAD = B (B의 parent는 A, tree는 검증된 결과)
task.recovery_commit_sha = NULL
task.status = in_progress
```

예상 결과:

- B가 checkpoint A의 유일한 직접 후속 task commit이고 기대한 branch/tree 증거와 일치하면 같은 SHA B를 기록하고 task를 `done`으로 승격한다.
- 파일을 다시 수정하거나 새 commit을 만들지 않고, 후속 검증/goal 단계가 B를 재사용한다.
- 승격 근거와 SHA를 `recovery_promoted` activity로 남긴다.

실패 이유:

- DB에 commit SHA가 없다는 이유만으로 `todo`로 돌리면 동일 구현 task가 재실행되어 검증된 commit 위에 중복 변경을 만든다.
- 반대로 단순히 `HEAD != checkpoint`만 보고 완료 처리하면 에이전트가 임의로 만든 미검증 commit도 승인한다.

후속 고정 포인트:

- “commit 후 DB update 전 crash” 실제 Git fixture에서 재실행 0회와 SHA 동일성을 검사한다.

### 6. 검증/fix 사이에 둘 이상의 commit 또는 오래된 검증 증거가 남은 경우

입력 예시:

```text
checkpoint A
B = 구현 commit
C = fix commit
DB recovery_commit_sha = B
latest evaluator PASS는 B 기준이지만 실제 HEAD는 C
task.status = in_review
```

예상 결과:

- verification/fix checkpoint는 판정 대상 SHA와 round를 명시하며, PASS 증거는 정확히 그 tree에만 유효하다.
- recorded SHA와 실제 HEAD가 다르거나 checkpoint 뒤 commit 후보가 여러 개면 자동으로 `done` 승격하거나 PASS를 재사용하지 않는다.
- C를 삭제·reset하지 않고 goal을 차단하며 “C 재검증 또는 올바른 commit 선택”을 사용자 조치로 안내한다.

실패 이유:

- “checkpoint 이후 commit이 있다”는 사실만으로 구현, evaluator 생성물, fix 결과, 사용자 수동 commit을 구분할 수 없다.
- B의 PASS를 C에 전이하면 미검증 fix가 승인 단계로 넘어가고, C를 무시해 B로 되돌리면 fix 산출물이 유실된다.

후속 고정 포인트:

- A→B, A→B→C, merge commit, recorded SHA가 branch 밖에 있는 경우를 분리한다.

### 7. worktree 경로는 존재하지만 등록/branch/HEAD가 checkpoint와 다른 경우

입력 예시:

```json
{
  "goal.worktree_path": "/private/tmp/crewdeck-goal-recovery",
  "goal.worktree_branch": "goal/복구-a1b2c3d4",
  "git.registered": true,
  "git.actual_branch": "goal/다른-goal-e5f6g7h8",
  "git.actual_head": "deadbeef..."
}
```

예상 결과:

- 경로 존재성뿐 아니라 common repo의 `git worktree list --porcelain`, canonical path, branch, HEAD를 모두 대조한다.
- missing, unregistered, detached HEAD, branch mismatch, checkpoint HEAD mismatch는 자동 checkout/branch 강제 변경 없이 차단한다.
- 기대값과 실제값을 activity log에 남겨 사용자가 올바른 worktree를 식별할 수 있게 한다.

실패 이유:

- 실제 표본에는 프로젝트 내부와 `/private/tmp` 등록 worktree가 함께 있다. 디렉터리 재사용이나 stale registration 때문에 같은 경로가 다른 branch를 가리킬 수 있다.
- 문자열 경로만 비교하면 symlink/canonical path 차이로 정상 worktree를 누락하거나, 반대로 다른 저장소의 같은 이름 디렉터리를 정상으로 오판한다.

후속 고정 포인트:

- missing directory, `git worktree prune` 뒤 unregistered directory, detached HEAD, symlink path를 각각 테스트한다.

### 8. shared stash 순번이 바뀌거나 sibling goal의 checkpoint와 충돌한 경우

입력 예시:

```text
stash@{0}: On goal/중단-내성-...: crewdeck-checkpoint-f19d...
stash@{1}: On goal/실행-전-...: crewdeck-checkpoint-370a...
stash@{2}: On goal/실행-전-...: crewdeck-final-goal-spec-contract-...
새 stash 생성 후 기존 stash@{1}은 stash@{2}로 이동
DB stash_ref = "stash@{1}"
```

예상 결과:

- stash는 순번이나 prefix가 아니라 immutable object SHA와 goal/task/attempt 소유 메타데이터로 식별한다.
- 복구 전 stash object가 기대한 base/tree와 연결되는지 검증한다.
- 누락·충돌·소유 불명 stash는 pop/drop하지 않고 파일과 모든 sibling stash를 그대로 둔 채 차단한다.

실패 이유:

- 실제 표본처럼 stash stack은 common repo의 모든 worktree가 공유한다. 새 stash 하나만 생겨도 `stash@{N}` 의미가 바뀐다.
- 가장 가까운 `crewdeck-checkpoint-*`를 pop하면 다른 goal의 WIP가 현재 worktree에 적용되고 원래 rollback 증거는 사라진다.

후속 고정 포인트:

- 두 goal이 번갈아 stash를 만든 뒤 순번을 이동시키고, 어느 sibling stash도 변경되지 않음을 검사한다.

### 9. task가 없는 승인 대기 goal이 재시작 정리에서 stale로 오인되는 경우

입력 예시:

```json
{
  "goal.squash_status": "pending_approval",
  "goal.worktree_path": ".../.crewdeck-worktrees/goal-복구-a1b2c3d4",
  "goal.worktree_branch": "goal/복구-a1b2c3d4",
  "tasks": [{ "status": "done" }],
  "active_sessions": []
}
```

예상 결과:

- 승인 대기는 active task/session이 없어도 goal-level checkpoint로 복구한다.
- worktree와 branch/HEAD 증거가 유효하면 worktree를 보존하고 `goal:squash_ready`를 재발송하며 중복 task를 생성하지 않는다.
- worktree가 없거나 Git 증거가 다르면 `blocked`로 전환하고 승인 버튼 대신 필요한 수동 조치를 activity log에 남긴다.

실패 이유:

- task 중심 cleanup은 “실행 중 task 없음”을 종료된 goal로 오해해 승인 전 worktree를 삭제할 수 있다.
- WebSocket 이벤트는 재시작을 넘지 않으므로 DB 상태만 유지하고 재발송하지 않으면 산출물은 남아도 사용자는 승인 진입점을 잃는다.

후속 고정 포인트:

- task 없는 pending approval, worktree missing, 클라이언트 미접속 상태의 재발송 멱등성을 고정한다.

### 10. 승인 후 local squash 또는 PR 산출물이 생겼지만 DB 기록 전에 종료된 경우

입력 예시:

```text
squash_status = approved
checkpoint base SHA = A
goal branch tree = T
base branch HEAD = S (parent S = A, tree S = T)
squash_commit_sha = NULL
origin/base HEAD = A
```

또는 checkpoint 저장 직전에 종료되어 `squash_status=approved`, `checkpoint base SHA=NULL`만 남는다.

PR 모드의 대체 입력:

```text
gitMode = pr
저장된 goal 산출물 SHA/tree = G/T
goal branch push = 성공
gh pr create = 성공, PR URL = https://github.com/example/repo/pull/42
squash_status = approved
DB에는 PR URL/완료 상태가 기록되지 않음
```

같은 위험은 goal branch push 성공 직후 `gh pr create` 전에 종료될 때도 발생한다.

예상 결과:

- checkpoint가 있으면 S가 A의 직접 후속 commit이고 goal tree와 정확히 같은지 검증해 **같은 squash SHA**를 재사용한다.
- local-only 정책이면 S 기록 후 `merged`, push 정책이면 origin 반영 성공까지 확인한 뒤 `merged`로 전환한다.
- checkpoint가 없거나 S가 branch 밖/다른 tree/여러 commit 뒤라면 새 squash를 만들거나 기존 commit을 지우지 않고 `blocked`로 되돌려 재승인 가능한 상태로 만든다.
- PR 정책은 repo/base/head branch로 `OPEN/CLOSED/MERGED` 전체 상태의 기존 PR을 조회하고, remote head SHA/tree를 저장된 goal 산출물 SHA/tree와 대조한다.
- 유일한 `OPEN` PR과 remote head 증거가 모두 일치할 때만 동일 URL을 재사용한다. 일치하는 `MERGED` PR은 base 반영 SHA/tree까지 확인한 뒤 완료로 복구한다.
- 새 PR 생성은 모든 상태에서 matching PR이 하나도 없고 remote head SHA/tree가 저장된 goal 산출물과 일치할 때만 재개한다. `OPEN` 조회 결과가 0개라는 사실만으로는 새 PR을 만들지 않는다.
- `CLOSED`지만 미병합, SHA/tree 불일치, 후보 복수, remote 상태 조회 실패처럼 결론이 불명확하면 branch나 PR을 삭제·닫거나 재생성하지 않고 차단한다. activity에는 확인할 branch, PR 후보와 상태, 기대/실제 SHA, 필요한 사용자 조치를 기록한다.
- 자동 판단, 재사용 SHA, push 여부 또는 차단 이유를 activity log에 남긴다.

실패 이유:

- DB의 `approved`만 보고 squash를 다시 실행하면 같은 goal의 두 squash commit이 생기거나 이미 전진한 base에서 중복 적용된다.
- DB SHA가 없다는 이유로 `reset --hard A`를 하면 로컬에 완성된 squash 또는 사용자의 후속 base commit이 유실된다.
- local commit 성공과 remote push 성공은 별도 crash point라서 하나의 boolean으로는 안전하게 재개할 수 없다.
- PR URL이 WebSocket 응답에만 있고 복구 가능한 저장 증거가 없으면, 재승인이 이미 열린 PR을 모르고 `gh pr create`를 다시 호출해 중복 PR 생성 시도 또는 영구 차단을 일으킨다.
- open PR이 없더라도 사용자가 crash 뒤 기존 PR을 close/merge했을 수 있고, 같은 head branch도 force-push나 추가 push로 tree가 달라질 수 있다. PR 상태와 remote SHA/tree를 생략하면 이미 처리된 산출물 또는 다른 산출물을 현재 goal 것으로 오판한다.

후속 고정 포인트:

- checkpoint 전 crash, local squash 후 DB 전 crash, DB 기록 후 push 전 crash, remote 반영 후 DB 전 crash를 각각 테스트한다.
- PR 모드는 goal branch push 후 PR 생성 전 crash와 PR 생성 후 DB/URL 기록 전 crash를 나눈다. matching PR의 0/1/복수뿐 아니라 `OPEN/CLOSED/MERGED`, remote head SHA/tree 일치 여부, merged base 반영 여부를 조합해 생성/재사용/완료 복구/차단이 선택되는지 검사한다.

## 후속 구현용 최소 회귀 매트릭스

| 단계 | 안전 자동 재개 | 안전 차단 | 절대 금지 |
|---|---|---|---|
| 구현 | owner 종료 확인 + checkpoint 완전 일치 시 같은 task 재claim | 종료 불명, checkpoint 누락, diff hash 불일치 | 이전 process와 동시 실행, dirty tree reset |
| 검증 | 검증 대상 SHA와 실제 tree가 동일할 때만 판정 재사용 | HEAD 전진, 오래된 PASS, commit 후보 복수 | PASS를 다른 tree에 전이 |
| fix | attempt/round와 commit/tree가 일대일일 때 다음 검증으로 재개 | 구현·fix·사용자 commit 구분 불가 | 모호한 commit 삭제 또는 임의 선택 |
| 승인 대기 | goal-level checkpoint 유효 시 worktree 보존 + 이벤트 재발송 | worktree/branch/HEAD 증거 불일치 | task 없음만으로 cleanup |
| squash/push/PR | base checkpoint의 유일한 직접 후속이면 같은 SHA 재사용; 유일한 OPEN PR과 remote SHA/tree가 모두 일치하면 같은 URL 재사용; MERGED와 base 반영 증거가 일치하면 완료 복구 | checkpoint 누락, branch 밖 SHA, tree 불일치, CLOSED-unmerged, PR 후보 복수·상태 불명 | 새 squash/PR 중복 생성, reset/force push, 기존 PR 삭제·닫기 |

## 조사 결론

복구의 핵심 false-positive는 “DB 상태를 실제 실행/Git 증거보다 강하게 믿는 것”과 “증거가 모호한데도 자동으로 한쪽을 선택하는 것”이다. 후속 구현은 모든 phase에서 `소유권 회수 → read-only 대조 → 유일한 결정만 자동 적용 → activity 기록` 순서를 지켜야 한다. 특히 현재 실제 워크스페이스가 보여 주는 dirty index, sibling worktree, shared stash는 정상 운영 상태이므로 cleanup 대상이나 오류 자체로 간주하면 안 된다.
