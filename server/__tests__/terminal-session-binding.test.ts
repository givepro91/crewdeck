import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { getTerminalBridgeContext } from "../core/terminal/bridge.js";
import {
  bindTerminalSession,
  claimNextTerminalTask,
  listTerminalDecisions,
  recordTerminalDecision,
  requestTerminalTaskCompletion,
  startNextTerminalTask,
} from "../core/terminal/session-binding.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  cleanup.splice(0).reverse().forEach((run) => run());
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "crewdeck-terminal-binding-"));
  const db = createDatabase(join(dir, "crewdeck.db"));
  migrate(db);
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'Project', 'local_import', ?)").run(dir);
  db.prepare("INSERT INTO agents (id, project_id, name, role, provider) VALUES ('a1', 'p1', 'Coder', 'coder', 'codex')").run();
  db.prepare("INSERT INTO goals (id, project_id, title, description, sort_order) VALUES ('g1', 'p1', 'Goal', 'Ship it', 0)").run();
  db.prepare("INSERT INTO goals (id, project_id, title, description, sort_order) VALUES ('g2', 'p1', 'Other', 'Other', 1)").run();
  db.prepare(`
    INSERT INTO workspaces (id, project_id, goal_id, active_goal_id, name, kind, state, worktree_path, worktree_branch)
    VALUES ('w1', 'p1', 'g1', 'g1', 'Workspace', 'goal', 'ready', ?, 'workspace/g1')
  `).run(dir);
  db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on) VALUES ('t0', 'g1', 'p1', 'Prerequisite', 'done', 0, '[]')").run();
  db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, assignee_id, status, sort_order, depends_on) VALUES ('t1', 'g1', 'p1', 'Implement', 'a1', 'todo', 1, '[\"t0\"]')").run();
  db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on) VALUES ('t2', 'g2', 'p1', 'Wrong goal', 'todo', 0, '[]')").run();
  db.prepare("INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, status, goal_id) VALUES ('term1', 'w1', 'p1', '/bin/zsh', ?, 'active', 'g1')").run(dir);
  return db;
}

describe("goal-bound terminal session", () => {
  it("claims the next ready task and exposes the exact binding to the agent context", () => {
    const db = fixture();
    bindTerminalSession(db, "term1", { goalId: "g1", agentId: "a1", provider: "codex" });

    const task = claimNextTerminalTask(db, "term1");

    expect(task).toMatchObject({ id: "t1", status: "in_progress", assignee_id: "a1" });
    expect(db.prepare("SELECT goal_id, agent_id, active_task_id, provider FROM terminal_sessions WHERE id = 'term1'").get())
      .toEqual({ goal_id: "g1", agent_id: "a1", active_task_id: "t1", provider: "codex" });
    expect(getTerminalBridgeContext(db, "w1", "term1").sessionBinding).toMatchObject({
      goal_id: "g1",
      agent_id: "a1",
      active_task_id: "t1",
      task_title: "Implement",
      task_status: "in_progress",
    });
  });

  it("records a terminal decision, resumes a blocked task, and requests Quality Gate review", () => {
    const db = fixture();
    bindTerminalSession(db, "term1", { goalId: "g1", agentId: "a1", taskId: "t1", provider: "claude" });
    db.prepare("UPDATE tasks SET status = 'blocked' WHERE id = 't1'").run();

    const recorded = recordTerminalDecision(db, "term1", "기존 API 계약을 유지하고 adapter로 해결해");

    expect(recorded.task).toMatchObject({ id: "t1", status: "in_progress" });
    expect(listTerminalDecisions(db, "w1", "g1")[0]).toMatchObject({
      terminalSessionId: "term1",
      taskId: "t1",
      message: "기존 API 계약을 유지하고 adapter로 해결해",
    });

    const completion = requestTerminalTaskCompletion(db, "term1", "adapter 구현 및 unit test 통과");
    expect(completion.task).toMatchObject({ id: "t1", status: "in_review" });
  });

  it("rejects binding a task from a different goal", () => {
    const db = fixture();
    expect(() => bindTerminalSession(db, "term1", { goalId: "g1", taskId: "t2" }))
      .toThrow("Task does not belong to the selected goal");
  });

  it("rejects binding a task that another active terminal already holds", () => {
    const db = fixture();
    db.prepare("INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, status, goal_id, active_task_id) VALUES ('term2', 'w1', 'p1', '/bin/zsh', '.', 'active', 'g1', 't1')").run();

    expect(() => bindTerminalSession(db, "term1", { goalId: "g1", taskId: "t1" }))
      .toThrow("Task is already bound to another terminal");
    // 종료된 터미널의 잔존 바인딩은 점유로 치지 않는다.
    db.prepare("UPDATE terminal_sessions SET status = 'exited' WHERE id = 'term2'").run();
    expect(() => bindTerminalSession(db, "term1", { goalId: "g1", taskId: "t1" })).not.toThrow();
  });

  it("refuses to rebind or clear a terminal while its active task is in flight", () => {
    const db = fixture();
    bindTerminalSession(db, "term1", { goalId: "g1", agentId: "a1", provider: "claude" });
    claimNextTerminalTask(db, "term1");

    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on) VALUES ('t3', 'g1', 'p1', 'Another', 'todo', 2, '[]')").run();
    expect(() => bindTerminalSession(db, "term1", { taskId: "t3" }))
      .toThrow("Terminal is busy with its active task");
    expect(() => bindTerminalSession(db, "term1", { goalId: "g1", taskId: null }))
      .toThrow("Terminal is busy with its active task");
    // 같은 태스크 유지(goal/provider만 갱신)는 허용 — launch 경로가 이 모양이다.
    expect(() => bindTerminalSession(db, "term1", { goalId: "g1", provider: "codex" })).not.toThrow();
    // done이 되면 교체 가능.
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run();
    expect(() => bindTerminalSession(db, "term1", { taskId: "t3" })).not.toThrow();
  });

  it("claims the exact requested task instead of the priority queue", () => {
    const db = fixture();
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, priority, sort_order, depends_on) VALUES ('t3', 'g1', 'p1', 'Urgent', 'todo', 'critical', 2, '[]')").run();
    bindTerminalSession(db, "term1", { goalId: "g1", agentId: "a1", provider: "claude" });

    const task = claimNextTerminalTask(db, "term1", { taskId: "t1" });

    expect(task).toMatchObject({ id: "t1", status: "in_progress" });
    expect(db.prepare("SELECT active_task_id FROM terminal_sessions WHERE id = 'term1'").get())
      .toEqual({ active_task_id: "t1" });
  });

  it("rejects claiming a task that is not ready or already held elsewhere", () => {
    const db = fixture();
    expect(() => claimNextTerminalTask(db, "term1", { taskId: "t0" }))
      .toThrow("Task is not ready to start");

    db.prepare("INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd, status, goal_id, active_task_id) VALUES ('term2', 'w1', 'p1', '/bin/zsh', '.', 'active', 'g1', 't1')").run();
    expect(() => claimNextTerminalTask(db, "term1", { taskId: "t1", agentId: "a1" }))
      .toThrow("Task is already bound to another terminal");
  });

  it("refuses to claim a different task while the terminal is busy", () => {
    const db = fixture();
    bindTerminalSession(db, "term1", { goalId: "g1", agentId: "a1", provider: "claude" });
    claimNextTerminalTask(db, "term1");
    db.prepare("INSERT INTO tasks (id, goal_id, project_id, title, status, sort_order, depends_on) VALUES ('t3', 'g1', 'p1', 'Another', 'todo', 2, '[]')").run();

    expect(() => claimNextTerminalTask(db, "term1", { taskId: "t3" }))
      .toThrow("Terminal is busy with its active task");
    // 같은 태스크 재요청은 멱등 — 현재 태스크를 그대로 돌려준다.
    expect(claimNextTerminalTask(db, "term1", { taskId: "t1" })).toMatchObject({ id: "t1", status: "in_progress" });
  });

  it("claims and requests the provider once, then continues idempotently", () => {
    const db = fixture();
    const launches: string[] = [];

    const first = startNextTerminalTask(db, "term1", {}, (provider, key) => {
      launches.push(`${provider}:${key}`);
      return true;
    });
    const second = startNextTerminalTask(db, "term1", {}, () => {
      launches.push("duplicate");
      return true;
    });

    expect(first).toMatchObject({ provider: "codex", launchState: "requested" });
    expect(second).toMatchObject({ provider: "codex", launchState: "continued", launchKey: first.launchKey });
    expect(launches).toEqual([`codex:${first.launchKey}`]);
    expect(db.prepare("SELECT status FROM tasks WHERE id = 't1'").get()).toEqual({ status: "in_progress" });
  });

  it("launches a todo task that was bound in the UI before start", () => {
    const db = fixture();
    bindTerminalSession(db, "term1", { taskId: "t1", agentId: "a1", provider: "codex" });
    const launches: string[] = [];

    const first = startNextTerminalTask(db, "term1", {}, (provider) => {
      launches.push(provider);
      return true;
    });
    const second = startNextTerminalTask(db, "term1", {}, () => {
      launches.push("duplicate");
      return true;
    });

    expect(first.launchState).toBe("requested");
    expect(second.launchState).toBe("continued");
    expect(launches).toEqual(["codex"]);
  });

  it("restores the task claim when the terminal rejects the provider command", () => {
    const db = fixture();

    expect(() => startNextTerminalTask(db, "term1", {}, () => false))
      .toThrow("Terminal provider launch failed before the task could start");

    expect(db.prepare("SELECT status, started_at FROM tasks WHERE id = 't1'").get())
      .toEqual({ status: "todo", started_at: null });
    expect(db.prepare("SELECT active_task_id, provider FROM terminal_sessions WHERE id = 'term1'").get())
      .toEqual({ active_task_id: null, provider: null });
    expect(db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'a1'").get())
      .toEqual({ status: "idle", current_task_id: null });
    expect(db.prepare("SELECT active_goal_id FROM workspaces WHERE id = 'w1'").get())
      .toEqual({ active_goal_id: "g1" });
  });

  it("refuses to switch providers while the same task launch lease is active", () => {
    const db = fixture();
    startNextTerminalTask(db, "term1", {}, () => true);

    expect(() => startNextTerminalTask(db, "term1", { provider: "claude" }, () => true))
      .toThrow("This task is already running with codex");
  });
});
