import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import { markProviderFailoverLoopGuardBlocked } from "../core/orchestration/scheduler.js";

describe("scheduler failover observability", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, mission, source) VALUES (?, ?, ?, ?)").run(
      "project-1",
      "Project",
      "",
      "new",
    );
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, ?)").run(
      "agent-1",
      "project-1",
      "Backend",
      "backend",
    );
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES (?, ?, ?)").run(
      "goal-1",
      "project-1",
      "Goal",
    );
    db.prepare(
      `INSERT INTO tasks (
         id, goal_id, project_id, title, assignee_id,
         provider_failover_reason_code, provider_failover_from_provider,
         provider_failover_to_provider, provider_failover_redispatched,
         provider_failover_original_session_id, provider_failover_redispatched_session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task-1",
      "goal-1",
      "project-1",
      "Task",
      "agent-1",
      "rate_limit",
      "claude",
      "codex",
      1,
      "session-claude",
      "session-codex",
    );
    db.prepare("INSERT INTO sessions (id, agent_id, status, provider) VALUES (?, ?, ?, ?)").run(
      "session-claude",
      "agent-1",
      "failed",
      "claude",
    );
    db.prepare("INSERT INTO sessions (id, agent_id, status, provider) VALUES (?, ?, ?, ?)").run(
      "session-codex",
      "agent-1",
      "failed",
      "codex",
    );
  });

  afterEach(() => {
    db.close();
  });

  it("marks loop guard blocking on the task and failed session without overwriting redispatch trace", () => {
    markProviderFailoverLoopGuardBlocked(db, "task-1", "session-codex");

    const task = db.prepare(
      `SELECT provider_failover_loop_guard_blocked,
              provider_failover_redispatched,
              provider_failover_from_provider,
              provider_failover_to_provider,
              provider_failover_original_session_id,
              provider_failover_redispatched_session_id
       FROM tasks WHERE id = ?`,
    ).get("task-1") as Record<string, unknown>;
    expect(task.provider_failover_loop_guard_blocked).toBe(1);
    expect(task.provider_failover_redispatched).toBe(1);
    expect(task.provider_failover_from_provider).toBe("claude");
    expect(task.provider_failover_to_provider).toBe("codex");
    expect(task.provider_failover_original_session_id).toBe("session-claude");
    expect(task.provider_failover_redispatched_session_id).toBe("session-codex");

    const sessions = db.prepare(
      "SELECT id, provider_failover_loop_guard_blocked FROM sessions ORDER BY id",
    ).all() as { id: string; provider_failover_loop_guard_blocked: number }[];
    expect(sessions).toEqual([
      { id: "session-claude", provider_failover_loop_guard_blocked: 0 },
      { id: "session-codex", provider_failover_loop_guard_blocked: 1 },
    ]);
  });
});
