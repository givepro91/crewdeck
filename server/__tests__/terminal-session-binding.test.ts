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
});
