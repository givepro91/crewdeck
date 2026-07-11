import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { claimTaskForExecution, createOrchestrationEngine } from "../core/orchestration/engine.js";
import { createSessionManager } from "../core/agent/session.js";
import { makeSpawnFailedError } from "../utils/errors.js";
import type Database from "better-sqlite3";

/**
 * task claim + execute 계약 회귀 테스트.
 *
 * 두 회귀를 고정한다:
 *  1. in_progress 태스크 claim 은 conflict + status='in_progress' 로 실패한다
 *     (route 의 409 계약을 구동 — assignee 유무와 무관).
 *  2. claim 성공 후 setup 오류(존재하지 않는 workdir)가 나면 태스크가
 *     in_progress 에 방치되지 않고 blocked 로 해제된다.
 */

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  return db;
}

let seq = 0;

function seedProject(db: Database.Database, workdir: string | null): { projectId: string; agentId: string } {
  const projectId = `p${++seq}`;
  db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES (?, 'test', 'new', ?)").run(projectId, workdir);
  const agentId = `a${seq}`;
  db.prepare(
    "INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'dev', 'backend')",
  ).run(agentId, projectId);
  return { projectId, agentId };
}

function seedGoal(db: Database.Database, projectId: string): string {
  const goalId = `g${++seq}`;
  db.prepare(
    "INSERT INTO goals (id, project_id, description, priority, sort_order) VALUES (?, ?, 'goal', 'medium', 0)",
  ).run(goalId, projectId);
  return goalId;
}

function seedTask(
  db: Database.Database,
  goalId: string,
  projectId: string,
  status: string,
  assigneeId: string | null,
): string {
  const taskId = `t${++seq}`;
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id) VALUES (?, ?, ?, 'task', ?, ?)",
  ).run(taskId, goalId, projectId, status, assigneeId);
  return taskId;
}

describe("claimTaskForExecution", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("todo 태스크를 claim 한다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);

    const claim = claimTaskForExecution(db, taskId);
    expect(claim.claimed).toBe(true);
    expect(claim.taskId).toBe(taskId);
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(row.status).toBe("in_progress");
  });

  it("이미 in_progress 인 태스크는 conflict + status 로 거절한다 (assignee=NULL 이어도)", () => {
    // route 의 409 계약: assignee 선검사가 아니라 conflict 가 이겨야 한다.
    const { projectId } = seedProject(db, "/tmp");
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "in_progress", null);

    const claim = claimTaskForExecution(db, taskId);
    expect(claim.claimed).toBe(false);
    if (claim.claimed) throw new Error("unreachable");
    expect(claim.reason).toBe("conflict");
    expect(claim.status).toBe("in_progress");
  });

  it("존재하지 않는 태스크는 not_found 로 거절한다", () => {
    const claim = claimTaskForExecution(db, "nope");
    expect(claim.claimed).toBe(false);
    if (claim.claimed) throw new Error("unreachable");
    expect(claim.reason).toBe("not_found");
  });

  it("다른 goal이라도 동일 agent가 실행 중이면 claim을 거절한다", () => {
    const { projectId, agentId } = seedProject(db, "/tmp");
    const activeGoalId = seedGoal(db, projectId);
    const candidateGoalId = seedGoal(db, projectId);
    const activeTaskId = seedTask(db, activeGoalId, projectId, "in_progress", agentId);
    const candidateTaskId = seedTask(db, candidateGoalId, projectId, "todo", agentId);

    const claim = claimTaskForExecution(db, candidateTaskId);

    expect(claim.claimed).toBe(false);
    if (claim.claimed) throw new Error("unreachable");
    expect(claim.reason).toBe("conflict");
    expect(claim.error).toBe(`Agent already has an active task (${activeTaskId})`);
    expect(claim.status).toBe("todo");

    const rows = db.prepare(
      "SELECT id, status FROM tasks WHERE id IN (?, ?) ORDER BY id",
    ).all(activeTaskId, candidateTaskId) as { id: string; status: string }[];
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
      [activeTaskId]: "in_progress",
      [candidateTaskId]: "todo",
    });
  });
});

describe("executeTask — claim 해제", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("claim 성공 후 workdir 부재 오류가 나면 태스크를 in_progress 에 방치하지 않고 blocked 로 해제한다", async () => {
    const missingWorkdir = "/nonexistent/crewdeck-test-workdir-does-not-exist";
    const { projectId, agentId } = seedProject(db, missingWorkdir);
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);

    const sessionManager = createSessionManager(db);
    const engine = createOrchestrationEngine(db, sessionManager, () => {});

    const claim = claimTaskForExecution(db, taskId);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");

    await expect(engine.executeTask(taskId, {}, claim)).rejects.toThrow(/Working directory does not exist/);

    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(row.status).not.toBe("in_progress");
    expect(row.status).toBe("blocked");
  });

  it("claim 성공 후 session spawn 오류가 나면 태스크를 in_progress 에 방치하지 않고 blocked 로 해제한다", async () => {
    const { projectId, agentId } = seedProject(db, process.cwd());
    db.prepare("UPDATE agents SET needs_worktree = 0 WHERE id = ?").run(agentId);
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);

    const baseSessionManager = createSessionManager(db);
    const spawnAgent = vi.fn(() => {
      throw new Error("synthetic spawn failure");
    });
    const engine = createOrchestrationEngine(
      db,
      { ...baseSessionManager, spawnAgent },
      () => {},
    );

    const claim = claimTaskForExecution(db, taskId);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");

    await expect(engine.executeTask(taskId, {}, claim)).rejects.toThrow(
      /Agent spawn failed: synthetic spawn failure/,
    );

    expect(spawnAgent).toHaveBeenCalledOnce();
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(row.status).not.toBe("in_progress");
    expect(row.status).toBe("blocked");
  });

  it("session spawn AgentError의 code·detail을 보존하고 env_error는 todo로 해제한다", async () => {
    const { projectId, agentId } = seedProject(db, process.cwd());
    db.prepare("UPDATE agents SET needs_worktree = 0 WHERE id = ?").run(agentId);
    const goalId = seedGoal(db, projectId);
    const taskId = seedTask(db, goalId, projectId, "todo", agentId);
    const spawnError = makeSpawnFailedError("codex not installed");

    const baseSessionManager = createSessionManager(db);
    const engine = createOrchestrationEngine(
      db,
      { ...baseSessionManager, spawnAgent: vi.fn(() => { throw spawnError; }) },
      () => {},
    );

    const claim = claimTaskForExecution(db, taskId);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("unreachable");

    await expect(engine.executeTask(taskId, {}, claim)).rejects.toBe(spawnError);
    expect(spawnError.code).toBe("SPAWN_FAILED");
    expect(spawnError.detail).toBe("codex not installed");

    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
    expect(row.status).toBe("todo");
  });
});
