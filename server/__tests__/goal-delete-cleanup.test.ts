import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { createDatabase, migrate } from "../db/schema.js";
import { createGoalRoutes } from "../api/routes/goals.js";
import { stashCheckpoint } from "../core/project/worktree.js";
import type { AppContext } from "../index.js";
import type Database from "better-sqlite3";

/**
 * DELETE /goals/:id 취소 정리 회귀 (Smart Resume round 1 발견).
 *
 * 계약:
 *  (1) task-phase 세션(architect-/evaluator-) + assignee 세션 종료.
 *  (2) scheduler in-flight ownership(cancelGoal) 해제.
 *  (3) goal worktree + task checkpoint stash 정리.
 *
 * 이전 결함: worktree/checkpoint 가 그대로 남고
 * (`worktreeExists:true, checkpointExists:true`), architect/evaluator 세션과
 * scheduler flight 가 삭제된 goal 을 위해 계속 살아있었다.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
const GIT_TEST_TIMEOUT_MS = 20_000;

describe("DELETE /goals/:id — 취소 정리", { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  let repo: string;
  let db: Database.Database;
  let server: Server;
  let baseUrl: string;
  let killedKeys: string[];
  let cancelGoalCalls: Array<{ projectId: string; goalId: string; taskIds: string[] }>;

  const projectId = "proj-del";
  const agentId = "agent-del";
  const goalId = "goal-del";
  const taskId = "task-del";

  beforeEach(async () => {
    // 1) 임시 git repo + goal worktree + checkpoint stash
    repo = mkdtempSync(join(tmpdir(), "crewdeck-goal-del-repo-"));
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "test@crewdeck.local");
    git(repo, "config", "user.name", "Crewdeck Test");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");

    const worktreeBranch = "goal/del-x";
    const worktreePath = join(repo, ".crewdeck-worktrees", "del-x");
    mkdirSync(join(repo, ".crewdeck-worktrees"), { recursive: true });
    git(repo, "worktree", "add", "-b", worktreeBranch, worktreePath, "main");
    // task 체크포인트 stash 생성 (변경이 있어야 stash 됨)
    writeFileSync(join(worktreePath, "wip.txt"), "work in progress\n");
    expect(stashCheckpoint(worktreePath, taskId)).toBe(true);
    expect(git(repo, "stash", "list")).toContain(`crewdeck-checkpoint-${taskId}`);

    // 2) DB seed — goal 에 worktree 정보 기록, task 는 in_progress + assignee
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES (?, 'test', 'new', ?)").run(projectId, repo);
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, 'dev', 'backend')").run(agentId, projectId);
    db.prepare(
      "INSERT INTO goals (id, project_id, description, worktree_path, worktree_branch) VALUES (?, ?, 'goal', ?, ?)",
    ).run(goalId, projectId, worktreePath, worktreeBranch);
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id) VALUES (?, ?, ?, 'task', 'in_progress', ?)",
    ).run(taskId, goalId, projectId, agentId);

    // 3) ctx — killSession/cancelGoal 호출 기록용 mock
    killedKeys = [];
    cancelGoalCalls = [];
    const ctx = {
      db,
      broadcast: () => {},
      sessionManager: { killSession: (key: string) => { killedKeys.push(key); } },
      scheduler: {
        cancelGoal: (p: string, g: string, t: string[]) => { cancelGoalCalls.push({ projectId: p, goalId: g, taskIds: t }); },
      },
    } as unknown as AppContext;

    // 4) 실제 Express 라우터 마운트 + 리스닝
    const app = express();
    app.use(express.json());
    app.use("/api/goals", createGoalRoutes(ctx));
    await new Promise<void>((res) => { server = app.listen(0, () => res()); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, GIT_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await new Promise<void>((res) => server.close(() => res()));
    db.close();
    rmSync(repo, { recursive: true, force: true });
  }, GIT_TEST_TIMEOUT_MS);

  it("worktree·checkpoint·세션·scheduler ownership 을 모두 정리한다", async () => {
    const worktreePath = join(repo, ".crewdeck-worktrees", "del-x");

    const resp = await fetch(`${baseUrl}/api/goals/${goalId}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ success: true });

    // goal 행 CASCADE 삭제
    expect(db.prepare("SELECT id FROM goals WHERE id = ?").get(goalId)).toBeUndefined();
    expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId)).toBeUndefined();

    // task-phase 세션 + assignee 세션 종료
    expect(killedKeys).toContain(`architect-${taskId}`);
    expect(killedKeys).toContain(`evaluator-${taskId}`);
    expect(killedKeys).toContain(agentId);
    expect(killedKeys).toContain(`spec-${goalId}`);
    expect(killedKeys).toContain(`decompose-${goalId}`);

    // scheduler in-flight ownership 해제
    expect(cancelGoalCalls).toEqual([{ projectId, goalId, taskIds: [taskId] }]);

    // worktree + checkpoint stash 제거
    expect(existsSync(worktreePath)).toBe(false);
    expect(git(repo, "stash", "list")).not.toContain(`crewdeck-checkpoint-${taskId}`);
  });

  it("존재하지 않는 goal 은 404", async () => {
    const resp = await fetch(`${baseUrl}/api/goals/nope`, { method: "DELETE" });
    expect(resp.status).toBe(404);
    expect(cancelGoalCalls).toEqual([]);
  });

  // Smart Resume round 1 발견: 삭제 대상 goal의 위임 대기 부모 task가 in_progress로
  // 남아있는 사이, 동일 agent가 다른 goal의 정상 task를 실행 중이면 sessionKey(agentId)가
  // 겹쳐 그 정상 세션까지 killSession되던 결함.
  it("동일 agent가 다른 goal의 정상 task를 실행 중이면 그 세션은 죽이지 않는다", async () => {
    const otherGoalId = "goal-other";
    const otherTaskId = "task-other";
    db.prepare(
      "INSERT INTO goals (id, project_id, description) VALUES (?, ?, 'other goal')",
    ).run(otherGoalId, projectId);
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id) VALUES (?, ?, ?, 'other task', 'in_progress', ?)",
    ).run(otherTaskId, otherGoalId, projectId, agentId);
    // 이 agent의 실제 살아있는 세션은 다른 goal의 task를 실행 중 (spawn 시 task_id 스탬프)
    db.prepare("INSERT INTO sessions (agent_id, status, task_id) VALUES (?, 'active', ?)").run(agentId, otherTaskId);

    const resp = await fetch(`${baseUrl}/api/goals/${goalId}`, { method: "DELETE" });
    expect(resp.status).toBe(200);

    // 삭제 대상 goal의 task-phase 세션은 여전히 정리
    expect(killedKeys).toContain(`architect-${taskId}`);
    expect(killedKeys).toContain(`evaluator-${taskId}`);
    // 하지만 assignee 세션 kill은 건너뛴다 — 실제로는 다른 goal의 정상 task 실행 중
    expect(killedKeys).not.toContain(agentId);

    // 다른 goal/task는 그대로 살아있어야 함
    expect(db.prepare("SELECT id FROM tasks WHERE id = ?").get(otherTaskId)).toBeTruthy();
  });

  // Smart Resume round 3 발견: activeSession.task_id가 NULL이면(delegation 등 taskId를
  // 안 넘기는 spawn 경로) "다른 goal 소속이 아님"으로 오판해 무조건 killSession하던 결함.
  // task_id를 모르면 이 goal 소속인지 증명할 수 없으므로 죽이지 않아야 한다.
  it("동일 agent의 살아있는 세션이 task_id NULL이면(귀속 불명) 죽이지 않는다", async () => {
    const otherGoalId = "goal-other-null";
    const otherTaskId = "task-other-null";
    db.prepare(
      "INSERT INTO goals (id, project_id, description) VALUES (?, ?, 'other goal')",
    ).run(otherGoalId, projectId);
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id) VALUES (?, ?, ?, 'other task', 'in_review', ?)",
    ).run(otherTaskId, otherGoalId, projectId, agentId);
    // task_id를 스탬프하지 않는 spawn 경로(예: delegation)를 흉내낸 활성 세션
    db.prepare("INSERT INTO sessions (agent_id, status, task_id) VALUES (?, 'active', NULL)").run(agentId);

    const resp = await fetch(`${baseUrl}/api/goals/${goalId}`, { method: "DELETE" });
    expect(resp.status).toBe(200);

    // 삭제 대상 goal의 task-phase 세션은 여전히 정리
    expect(killedKeys).toContain(`architect-${taskId}`);
    expect(killedKeys).toContain(`evaluator-${taskId}`);
    // task_id 불명 세션은 귀속을 증명할 수 없으므로 건드리지 않는다
    expect(killedKeys).not.toContain(agentId);

    // 다른 goal/task는 in_review로 그대로 살아있어야 함
    expect((db.prepare("SELECT status FROM tasks WHERE id = ?").get(otherTaskId) as { status: string }).status).toBe("in_review");
  });

  it("assignee의 살아있는 세션이 삭제 대상 goal 자신의 task면 그대로 죽인다", async () => {
    db.prepare("INSERT INTO sessions (agent_id, status, task_id) VALUES (?, 'active', ?)").run(agentId, taskId);

    const resp = await fetch(`${baseUrl}/api/goals/${goalId}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    expect(killedKeys).toContain(agentId);
  });
});
