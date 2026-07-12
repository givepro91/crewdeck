import { existsSync } from "node:fs";
import type { Database } from "better-sqlite3";
import { createLogger } from "../utils/logger.js";
import { recoverSquashCommitEvidence, recoverTaskCommitEvidence } from "./project/git-workflow.js";
import { cleanupStaleWorktrees, inspectWorktreeRecoveryState } from "./project/worktree.js";
import type { RecoveryDecision, RecoveryIncident, RecoveryPhase } from "../../shared/types.js";
import { processGroupHasLiveMembers, readProcessIdentity, readProcessOwnerToken } from "./agent/process-identity.js";

const log = createLogger("recovery");

export interface RecoveryResult {
  recoveredTasks: number;
  killedProcesses: number;
}

interface InterruptedTask {
  id: string;
  project_id: string;
  goal_id: string;
  status: string;
  recovery_checkpoint_head_sha: string | null;
  recovery_worktree_branch: string | null;
  recovery_worktree_dirty: number | null;
  recovery_worktree_diff_hash: string | null;
  recovery_commit_ready: number;
  recovery_commit_sha: string | null;
  recovery_resume_phase: "implementation" | "verification" | "fix" | null;
  goal_model: string;
  worktree_path: string | null;
  worktree_branch: string | null;
}

function recoveryPhaseForTask(db: Database, task: InterruptedTask): RecoveryPhase {
  if (task.recovery_resume_phase) return task.recovery_resume_phase;
  const activeFix = db.prepare(`
    SELECT 1 FROM verification_fix_rounds
     WHERE task_id = ? AND status IN ('pending', 'running')
     LIMIT 1
  `).get(task.id);
  if (activeFix) return "fix";
  return task.status === "in_review" ? "verification" : "implementation";
}

export function recordRecoveryIncident(
  db: Database,
  input: {
    projectId: string;
    goalId: string;
    phase: RecoveryPhase;
    decision: RecoveryDecision;
    reason: string;
    userAction: string | null;
    source: "startup" | "session_exit";
    activityType?: string;
  },
  broadcast?: (event: string, data: unknown) => void,
): RecoveryIncident {
  const reason = input.reason.trim().slice(0, 1000) || "recovery decision reason unavailable";
  const userAction = input.userAction?.trim().slice(0, 1000) || null;
  const result = db.transaction(() => {
    const incident = db.prepare(`
      INSERT INTO recovery_incidents (goal_id, phase, decision, reason, user_action)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id, goal_id, phase, decision, reason, user_action, created_at
    `).get(input.goalId, input.phase, input.decision, reason, userAction) as RecoveryIncident;
    const activity = db.prepare(`
      INSERT INTO activities (project_id, type, message, metadata)
      VALUES (?, ?, ?, ?)
      RETURNING id, project_id, agent_id, type, message, metadata, created_at
    `).get(
      input.projectId,
      input.activityType ?? "recovery_incident",
      `[recovery] ${input.phase} → ${input.decision}: ${reason}${userAction ? ` / 사용자 조치: ${userAction}` : ""}`,
      JSON.stringify({
        incident_id: incident.id,
        goal_id: input.goalId,
        phase: input.phase,
        decision: input.decision,
        reason,
        user_action: userAction,
        source: input.source,
      }),
    ) as {
      id: number;
      project_id: string;
      agent_id: string | null;
      type: string;
      message: string;
      metadata: string | null;
      created_at: string;
    };
    return { incident, activity };
  })();
  if (broadcast) {
    const metadata = result.activity.metadata ? JSON.parse(result.activity.metadata) : null;
    broadcast("activity:created", {
      ...result.activity,
      projectId: result.activity.project_id,
      agentId: result.activity.agent_id,
      metadata,
      createdAt: result.activity.created_at,
    });
  }
  return result.incident;
}

function loadInterruptedTask(db: Database, taskId: string): InterruptedTask | undefined {
  return db.prepare(`
    SELECT t.id, t.project_id, t.goal_id, t.status,
           t.recovery_checkpoint_head_sha, t.recovery_worktree_branch,
           t.recovery_worktree_dirty, t.recovery_worktree_diff_hash,
           t.recovery_commit_ready, t.recovery_commit_sha, t.recovery_resume_phase,
           g.goal_model, g.worktree_path, g.worktree_branch
      FROM tasks t
      JOIN goals g ON g.id = t.goal_id
     WHERE t.id = ? AND t.status IN ('in_progress', 'in_review')
  `).get(taskId) as InterruptedTask | undefined;
}

/** Reconcile one interrupted task without deleting or rewriting Git state. */
export function recoverInterruptedTask(
  db: Database,
  taskId: string,
  source: "startup" | "session_exit",
  forcedBlockReason?: string,
  phaseOverride?: RecoveryPhase,
  broadcast?: (event: string, data: unknown) => void,
): RecoveryDecision | null {
  const task = loadInterruptedTask(db, taskId);
  if (!task) return null;
  const phase = phaseOverride ?? recoveryPhaseForTask(db, task);

  const decide = (decision: RecoveryDecision, reason: string, userAction: string | null): RecoveryDecision => {
    recordRecoveryIncident(db, {
      projectId: task.project_id,
      goalId: task.goal_id,
      phase,
      decision,
      reason,
      userAction,
      source,
      activityType: decision === "advance"
        ? "recovery_promoted"
        : decision === "blocked" ? "recovery_manual_action" : "recovery_incident",
    }, broadcast);
    return decision;
  };

  const block = (reason: string): RecoveryDecision => {
    const boundedReason = reason.slice(0, 500);
    db.transaction(() => {
      db.prepare(`
        UPDATE tasks SET status = 'blocked', recovery_manual_action_required = 1,
          recovery_manual_action_reason = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(boundedReason, task.id);
      db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(task.goal_id);
    })();
    return decide("blocked", boundedReason, "worktree와 Git 산출물을 확인한 뒤 수동으로 재개하세요.");
  };

  if (forcedBlockReason) return block(forcedBlockReason);

  if (task.goal_model !== "goal_as_unit") {
    db.prepare("UPDATE tasks SET status = 'todo', updated_at = datetime('now') WHERE id = ?").run(task.id);
    return decide("resume", "legacy task session was interrupted before completion", null);
  }

  const checkpoint = task.recovery_checkpoint_head_sha;
  const expectedBranch = task.recovery_worktree_branch ?? task.worktree_branch;
  if (!task.worktree_path || !expectedBranch || !checkpoint || task.recovery_worktree_dirty === null) {
    return block("persisted task/worktree checkpoint is missing");
  }

  const worktreeState = inspectWorktreeRecoveryState(task.worktree_path, expectedBranch);
  if (worktreeState.status === "manual_action_required") {
    return block(worktreeState.reasons.join("; "));
  }

  if (!task.recovery_commit_ready) {
    // Implementation may have produced a dirty tree before the CLI/server died.
    // Preserve it and restart the implementation phase in-place, but never
    // accept an unrecorded HEAD advance (that could be a user/agent commit).
    if (worktreeState.headSha !== checkpoint) {
      return block(`worktree HEAD mismatch: expected ${checkpoint}, got ${worktreeState.headSha ?? "none"}`);
    }
    db.prepare(`
      UPDATE tasks SET status = 'todo', recovery_resume_phase = 'implementation',
        updated_at = datetime('now') WHERE id = ?
    `).run(task.id);
    return decide(
      "resume",
      worktreeState.dirty
        ? "implementation output is dirty and preserved; restart implementation from the existing worktree"
        : "implementation checkpoint is unchanged; restart implementation",
      null,
    );
  }

  // The fix commit hand-off first advances the checkpoint to the last durable
  // implementation/fix commit, then creates the next commit. If the process
  // dies between those two operations, HEAD still equals the checkpoint and
  // the dirty tree is unambiguously the interrupted fix output. Preserve it
  // and restart fix instead of treating the expected WIP as ambiguous Git
  // evidence. Any HEAD advance still falls through to strict commit recovery.
  if (phase === "fix"
    && !task.recovery_commit_sha
    && worktreeState.headSha === checkpoint) {
    db.prepare(`
      UPDATE tasks SET status = 'todo', recovery_resume_phase = 'fix',
        updated_at = datetime('now') WHERE id = ?
    `).run(task.id);
    return decide(
      "resume",
      worktreeState.dirty
        ? "fix output is dirty and preserved; restart fix before creating its commit"
        : "fix commit hand-off was interrupted before a commit was created; resume fix",
      null,
    );
  }

  const recordedFixCommit = phase === "fix"
    && !!task.recovery_commit_sha
    && worktreeState.headSha === task.recovery_commit_sha;
  const evidence = recordedFixCommit
    ? { status: "recorded" as const, commitSha: task.recovery_commit_sha, reason: undefined }
    : recoverTaskCommitEvidence(task.worktree_path, checkpoint, task.recovery_commit_sha);
  if (evidence.status === "promote" || evidence.status === "recorded") {
    // A promoted commit was created after the last durable checkpoint but the
    // process died before its SHA was recorded. For a fix checkpoint that
    // means the fix completed and only independent verification remains.
    // A recorded fix SHA, on the other hand, is the implementation commit and
    // the interrupted fix session must be restarted.
    const resumePhase = evidence.status === "promote"
      ? "verification"
      : phase === "fix" ? "fix" : "verification";
    db.prepare(`
      UPDATE tasks SET status = 'todo', recovery_commit_sha = ?, recovery_resume_phase = ?,
        updated_at = datetime('now')
       WHERE id = ?
    `).run(evidence.commitSha, resumePhase, task.id);
    return decide(
      "advance",
      `verified task commit preserved at ${evidence.commitSha}; resume ${resumePhase}`,
      null,
    );
  }
  if (evidence.status === "not_created") {
    const resumePhase = phase === "fix" ? "fix" : "implementation";
    db.prepare(`
      UPDATE tasks SET status = 'todo', recovery_commit_ready = ?,
        recovery_resume_phase = ?, updated_at = datetime('now') WHERE id = ?
    `).run(resumePhase === "fix" ? 1 : 0, resumePhase, task.id);
    return decide("resume", `commit-ready checkpoint exists but no task commit was created; resume ${resumePhase}`, null);
  }
  return block(evidence.reason ?? "task commit evidence is ambiguous");
}

/** 고아 subprocess/process group의 종료를 기다리는 최대 시간(ms). */
const ORPHAN_EXIT_TIMEOUT_MS = 3_000;
/** 종료 폴링 간격(ms). */
const ORPHAN_EXIT_POLL_MS = 25;

/**
 * 동기 sleep. recoverOnStartup 은 동기 함수라 event loop(setTimeout)를 쓸 수
 * 없으므로 Atomics.wait 로 현재 스레드를 짧게 블록한다.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Zombies have exited and cannot mutate files, although kill(-pgid, 0) still sees them. */
function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hasLiveMembers = processGroupHasLiveMembers(processGroupId);
    if (hasLiveMembers === false) return true;
    if (hasLiveMembers === null) {
      try {
        process.kill(-processGroupId, 0);
      } catch (err: any) {
        return err.code === "ESRCH";
      }
    }
    if (Date.now() >= deadline) return false;
    sleepSync(ORPHAN_EXIT_POLL_MS);
  }
}

export function recoverOnStartup(db: Database): RecoveryResult {
  let recoveredTasks = 0;
  let killedProcesses = 0;

  // 1. 고아 subprocess 를 먼저 종료시킨다. worktree/Git checkpoint 대조는 반드시
  //    구현 subprocess 가 완전히 끝난 뒤에 수행해야 한다 — 그렇지 않으면 검사 이후
  //    (또는 SIGTERM handler 안)에서 파일을 써서 검사 결과와 실제 트리가 어긋나고,
  //    scheduler 가 손상된 worktree 에서 같은 task 를 재실행한다.
  const activeSessions = db
    .prepare(`
      SELECT id, agent_id, pid, process_group_id, process_started_at,
             process_executable, process_parent_id, process_owner_token, task_id
        FROM sessions WHERE status = 'active'
    `)
    .all() as Array<{
      id: string;
      agent_id: string;
      pid: number | null;
      process_group_id: number | null;
      process_started_at: string | null;
      process_executable: string | null;
      process_parent_id: number | null;
      process_owner_token: string | null;
      task_id: string | null;
    }>;

  // 종료를 확인하지 못한(timeout·EPERM) 세션이 소유한 task. 해당 worktree 는
  // 여전히 쓰기가 진행 중일 수 있어 신뢰할 수 없으므로 todo 전환 대신 차단한다.
  const unterminatedTaskIds = new Set<string>();

  const markSessionKilled = (id: string): void => {
    db.prepare("UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?").run(id);
  };

  for (const s of activeSessions) {
    // PID-only legacy rows cannot prove ownership or that descendants are gone.
    // Do not signal a potentially reused PID; keep the owning task blocked.
    if (!s.process_group_id) {
      if (s.task_id) unterminatedTaskIds.add(s.task_id);
      if (s.pid) {
        log.warn(`Cannot prove legacy orphan ownership for pid=${s.pid} (session ${s.id}) — refusing signal`);
      } else {
        log.warn(`Cannot prove orphan ownership without PID/PGID (session ${s.id}) — refusing signal`);
      }
      markSessionKilled(s.id);
      continue;
    }

    const currentProcessIdentity = s.pid ? readProcessIdentity(s.pid) : null;
    const currentOwnerToken = s.pid ? readProcessOwnerToken(s.pid) : null;
    const parentMatches = currentProcessIdentity && s.process_parent_id !== null
      && (currentProcessIdentity.parentProcessId === s.process_parent_id || currentProcessIdentity.parentProcessId === 1);
    const identityMatches = s.pid === s.process_group_id
      && s.process_started_at !== null
      && s.process_executable !== null
      && currentProcessIdentity?.startToken === s.process_started_at
      && currentProcessIdentity.executable === s.process_executable
      && currentProcessIdentity.processGroupId === s.process_group_id
      && s.process_owner_token !== null
      && currentOwnerToken === s.process_owner_token
      && parentMatches;
    if (!identityMatches) {
      log.warn(
        `Cannot prove orphan process ownership for pgid=${s.process_group_id} (session ${s.id}) — refusing SIGKILL and blocking its task`,
      );
      if (s.task_id) unterminatedTaskIds.add(s.task_id);
      markSessionKilled(s.id);
      continue;
    }

    // POSIX kill with a negative ID addresses every member of the persisted
    // process group. The worktree is inspected only after the entire group is gone.
    const processGroupTarget = -s.process_group_id;
    try {
      process.kill(processGroupTarget, 0); // 존재 확인
      // Startup recovery cannot trust user/CLI SIGTERM handlers: a handler can
      // detach a new descendant just before the group leader exits. SIGKILL is
      // required here so no post-crash cleanup code can mutate the worktree or
      // escape into a new process group after the ownership boundary is checked.
      process.kill(processGroupTarget, "SIGKILL");
      killedProcesses++;
      log.info(`Killed orphan process group pgid=${s.process_group_id} (session ${s.id})`);
      // process group 전체가 종료될 때까지 동기적으로 기다린다.
      // 확인 실패 시 소유 task 를 차단 대상에 등록한다.
      if (!waitForProcessGroupExit(s.process_group_id, ORPHAN_EXIT_TIMEOUT_MS)) {
        log.warn(`Orphan process group pgid=${s.process_group_id} (session ${s.id}) did not exit within ${ORPHAN_EXIT_TIMEOUT_MS}ms — blocking its task`);
        if (s.task_id) unterminatedTaskIds.add(s.task_id);
      }
      markSessionKilled(s.id);
    } catch (err: any) {
      if (err.code === "ESRCH") {
        // 이미 종료된 프로세스 — DB 정리만
        markSessionKilled(s.id);
      } else if (err.code === "EPERM") {
        // 권한 부족 — 프로세스가 살아있지만 kill 불가. 무한 재시도 방지를 위해
        // killed 로 마킹하되, 종료를 보장할 수 없으므로 소유 task 는 차단한다.
        log.warn(`Cannot kill orphan process group pgid=${s.process_group_id} (EPERM) — marking session killed and blocking its task`);
        if (s.task_id) unterminatedTaskIds.add(s.task_id);
        markSessionKilled(s.id);
      } else {
        log.error(`Unexpected error killing process group pgid=${s.process_group_id}: ${err.message}`);
        if (s.task_id) unterminatedTaskIds.add(s.task_id);
        markSessionKilled(s.id);
      }
    }
  }

  // ALL stale active sessions — not just pid=NULL.
  // On restart, every "active" session is orphaned by definition: the server
  // process that owned them is gone. The pid-based kill above handles sessions
  // whose process is genuinely still running; everything else is a ghost.
  const staleActive = db.prepare(
    "UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE status = 'active'",
  ).run();
  if (staleActive.changes > 0) {
    log.info(`Cleaned ${staleActive.changes} stale active session(s) on startup`);
  }

  // 2. 중단 task 의 persisted checkpoint 를 실제 worktree/Git 상태와 대조한다.
  //    고아 subprocess 종료 이후이므로 여기서 보는 트리는 최종 상태다. 모호한
  //    상태는 파일을 건드리지 않고 goal/task 를 차단한다.
  // Legacy/current crash residue: issue ledger rows used to be marked
  // in_progress together even though one source-task fix session owned all of
  // them. They are not independent executions and have no recovery checkpoint;
  // normalize them before selecting real interrupted owners.
  db.prepare(`
    UPDATE tasks SET status = 'pending_approval', updated_at = datetime('now')
     WHERE status IN ('in_progress', 'in_review')
       AND EXISTS (
         SELECT 1 FROM verification_issue_tasks vit
          WHERE vit.task_id = tasks.id AND vit.relation = 'fix'
       )
  `).run();
  const interrupted = db.prepare(
    `SELECT id FROM tasks t
      WHERE status IN ('in_progress', 'in_review')
        AND NOT EXISTS (
          SELECT 1 FROM verification_issue_tasks vit
           WHERE vit.task_id = t.id AND vit.relation = 'fix'
        )`,
  ).all() as Array<{ id: string }>;

  for (const task of interrupted) {
    // 소유 subprocess 종료를 확인하지 못했으면 worktree 를 신뢰할 수 없다 —
    // todo 전환을 취소하고 차단해 scheduler 재실행을 막는다.
    if (unterminatedTaskIds.has(task.id)) {
      recoverInterruptedTask(db, task.id, "startup", "active session subprocess could not be confirmed terminated");
    } else {
      recoverInterruptedTask(db, task.id, "startup");
    }
    recoveredTasks++;
  }

  // 3. 에이전트 상태 초기화: working → idle, current_task_id 해제
  db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE status = 'working'").run();

  // 3b. goal_specs stuck at '{"_status":"generating"}' → failed
  //
  // If the prior process died mid spec-generation (crash, SIGKILL, tsx watch
  // reload), the placeholder row stays forever and makes processNextGoal
  // short-circuit every poll cycle. Mark any such row as failed so the
  // autopilot can retry or surface the error instead of looping silently.
  const stuckSpecs = db
    .prepare(
      `UPDATE goal_specs
       SET prd_summary = '{"_status":"failed","_error":"Generation interrupted by server restart"}',
           updated_at = datetime('now')
       WHERE prd_summary = '{"_status":"generating"}'`,
    )
    .run();
  if (stuckSpecs.changes > 0) {
    log.warn(`Cleared ${stuckSpecs.changes} stuck goal_specs row(s) left in 'generating' state`);
  }

  // 4. 잔존 worktree + agent branch 정리 (프로젝트별)
  //    단, pending_approval / approved 상태 goal 의 worktree 는 보존
  let cleanedWorktrees = 0;
  const projects = db.prepare("SELECT id, workdir FROM projects WHERE status = 'active' AND workdir != ''").all() as { id: string; workdir: string }[];
  for (const p of projects) {
    try {
      // active goal worktree 경로 수집 — merged 외에는 전부 보존.
      // ⚠ 과거 버전은 'none'도 제외해 "아직 작업 중"(squash 미트리거 = none)인
      // goal의 worktree를 재시작 시 삭제했다 — R2 크래시 복구 E2E에서 WIP 소실로 재현.
      const activeWorktreePaths = (db.prepare(
        `SELECT worktree_path FROM goals
          WHERE project_id = ?
            AND squash_status != 'merged'
            AND worktree_path IS NOT NULL`,
      ).all(p.id) as { worktree_path: string }[]).map((r) => r.worktree_path);

      cleanedWorktrees += cleanupStaleWorktrees(p.workdir, activeWorktreePaths);
    } catch (err: any) {
      log.warn(`Worktree cleanup failed for ${p.workdir}: ${err.message}`);
    }
  }

  // 5. 'triggering' 상태 복구 — 서버가 CAS 진입 후 크래시하면 goal 이 영구 'triggering' 에 고착.
  //    재시작 시 모두 'none' 으로 복원한다.
  recoverTriggeringGoals(db);

  if (recoveredTasks > 0 || killedProcesses > 0 || cleanedWorktrees > 0) {
    log.info(`Recovery complete: ${recoveredTasks} tasks restored, ${killedProcesses} orphan processes killed, ${cleanedWorktrees} stale worktrees cleaned`);
  }

  return { recoveredTasks, killedProcesses };
}

/**
 * 'triggering' 상태 복구 — 서버가 CAS 로 진입한 뒤 크래시하면 goal 이 영구 'triggering' 상태에 고착.
 * 재시작 시 모두 'none' 으로 복원한다.
 */
export function recoverTriggeringGoals(db: Database): void {
  const triggeringGoals = db.prepare(
    "SELECT id, project_id FROM goals WHERE squash_status = 'triggering'",
  ).all() as Array<{ id: string; project_id: string }>;
  const result = db.prepare(
    "UPDATE goals SET squash_status = 'none' WHERE squash_status = 'triggering'"
  ).run();
  if (result.changes > 0) {
    log.info(`Recovered ${result.changes} goal(s) from 'triggering' state after restart`);
    for (const goal of triggeringGoals) {
      recordRecoveryIncident(db, {
        projectId: goal.project_id, goalId: goal.id, phase: "approval", decision: "resume",
        reason: "approval trigger was interrupted before squash processing started",
        userAction: null, source: "startup",
      });
    }
  }

  // 승인 처리 도중 종료되면 blocked(재시도 가능)로 되돌린다. checkpoint 저장
  // 전에 크래시했어도 performSquash가 재승인 시 checkpoint를 다시 계산하므로
  // checkpoint 유무와 무관하게 복구해야 한다 — 아니면 approved+checkpoint=NULL
  // 상태가 영구 고착된다 (재시도 진입점 없음).
  const approvedGoals = db.prepare(`
    SELECT g.id, g.project_id, g.worktree_path, g.worktree_branch,
           g.squash_checkpoint_base_sha, g.squash_commit_sha,
           p.workdir, COALESCE(p.base_branch, 'main') AS base_branch
      FROM goals g
      JOIN projects p ON p.id = g.project_id
     WHERE g.squash_status = 'approved'
  `).all() as Array<{
    id: string;
    project_id: string;
    worktree_path: string | null;
    worktree_branch: string | null;
    squash_checkpoint_base_sha: string | null;
    squash_commit_sha: string | null;
    workdir: string;
    base_branch: string;
  }>;
  for (const goal of approvedGoals) {
    const evidence = goal.worktree_branch && goal.squash_checkpoint_base_sha
      ? recoverSquashCommitEvidence(
        goal.workdir,
        goal.base_branch,
        goal.worktree_branch,
        goal.squash_checkpoint_base_sha,
        goal.squash_commit_sha,
        goal.worktree_path,
      )
      : { status: "not_created" as const, commitSha: null };
    if (evidence.status === "promote" || evidence.status === "recorded") {
      db.prepare(`
        UPDATE goals SET squash_status = 'pending_approval', squash_commit_sha = ? WHERE id = ?
      `).run(evidence.commitSha, goal.id);
      recordRecoveryIncident(db, {
        projectId: goal.project_id, goalId: goal.id, phase: "approval", decision: "wait_approval",
        reason: `completed squash commit ${evidence.commitSha} was preserved`,
        userAction: "보존된 squash 산출물을 확인한 뒤 다시 승인하세요.", source: "startup",
      });
      continue;
    }
    db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goal.id);
    recordRecoveryIncident(db, {
      projectId: goal.project_id, goalId: goal.id, phase: "approval", decision: "blocked",
      reason: evidence.status === "manual_action_required"
        ? evidence.reason ?? "squash evidence is ambiguous"
        : "server stopped before the approved squash commit was completed",
      userAction: "Git 산출물을 확인한 뒤 반영 승인을 다시 실행하세요.", source: "startup",
    });
  }
  if (approvedGoals.length > 0) {
    log.info(`Recovered ${approvedGoals.length} approved goal(s) from squash evidence`);
  }

  // 'resolving'은 in-memory 해결 세션 진행 상태 — 재시작으로 세션이 죽었으므로
  // blocked로 강등한다 (재승인하면 해결을 다시 시도). 좀비 resolving 방지.
  const resolving = db.prepare(
    "SELECT id, project_id, title FROM goals WHERE squash_status = 'resolving'"
  ).all() as Array<{ id: string; project_id: string; title: string | null }>;
  for (const goal of resolving) {
    db.prepare("UPDATE goals SET squash_status = 'blocked' WHERE id = ?").run(goal.id);
    recordRecoveryIncident(db, {
      projectId: goal.project_id, goalId: goal.id, phase: "approval", decision: "blocked",
      reason: `server stopped while resolving overlapping changes: ${(goal.title ?? "").slice(0, 80)}`,
      userAction: "변경 겹침을 확인한 뒤 반영을 다시 시도하세요.", source: "startup",
    });
    log.warn(`Recovered goal ${goal.id} from 'resolving' → 'blocked' after restart`);
  }
}

/**
 * M-3: 서버 재시작 후 pending_approval 상태 goal 에 대해 goal:squash_ready 재발송.
 * WebSocket 서버와 broadcast 함수가 준비된 이후에 호출해야 한다.
 *
 * - worktree_path 실제 존재 확인
 * - 존재 시 broadcast 재발송 → 사용자가 승인 버튼을 볼 수 있음
 * - 존재 안 하면 squash_status='blocked' + activity 경고 기록
 */
export function rebroadcastPendingApprovals(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  options: { recordIncident?: boolean } = {},
): void {
  const pendingGoals = db.prepare(
    `SELECT g.id, g.title, g.project_id, g.worktree_path, g.worktree_branch
       FROM goals g
      WHERE g.squash_status = 'pending_approval'`,
  ).all() as { id: string; title: string; project_id: string; worktree_path: string | null; worktree_branch: string | null }[];

  for (const goal of pendingGoals) {
    if (goal.worktree_path && existsSync(goal.worktree_path)) {
      broadcast("goal:squash_ready", {
        goalId: goal.id,
        commitMessage: `feat: ${goal.title ?? goal.id}`,
        filesChanged: [],
        acceptanceOutput: "",
      });
      if (options.recordIncident !== false) {
        recordRecoveryIncident(db, {
          projectId: goal.project_id, goalId: goal.id, phase: "approval", decision: "wait_approval",
          reason: "approval artifact and goal worktree were preserved across restart",
          userAction: "반영할 산출물을 확인한 뒤 승인하세요.", source: "startup",
        }, broadcast);
      }
      log.info(`Rebroadcast goal:squash_ready for goal ${goal.id} (pending_approval)`);
    } else {
      db.prepare(
        "UPDATE goals SET squash_status = 'blocked' WHERE id = ?",
      ).run(goal.id);
      recordRecoveryIncident(db, {
        projectId: goal.project_id, goalId: goal.id, phase: "approval", decision: "blocked",
        reason: `approval worktree is missing: ${(goal.title ?? goal.id).slice(0, 80)}`,
        userAction: "worktree와 Git 산출물을 확인하고 반영 여부를 결정하세요.", source: "startup",
      }, broadcast);
      log.warn(`Goal ${goal.id} worktree missing on restart — squash blocked`);
    }
  }
}
