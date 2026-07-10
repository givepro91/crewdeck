import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../../db/schema.js";
import { markProviderFailoverLoopGuardBlocked } from "./scheduler.js";

describe("markProviderFailoverLoopGuardBlocked", () => {
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
         provider_failover_reason_code, provider_failover_user_message,
         provider_failover_from_provider, provider_failover_to_provider,
         provider_failover_redispatched,
         provider_failover_original_session_id, provider_failover_redispatched_session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task-1",
      "goal-1",
      "project-1",
      "Task",
      "agent-1",
      "rate_limit",
      "claude 사용량 한도로 codex에 재디스패치했습니다.",
      "claude",
      "codex",
      1,
      "session-claude",
      "session-codex",
    );
    db.prepare(
      `INSERT INTO sessions (
         id, agent_id, status, provider,
         provider_failover_reason_code, provider_failover_user_message,
         provider_failover_from_provider, provider_failover_to_provider,
         provider_failover_redispatched,
         provider_failover_original_session_id, provider_failover_redispatched_session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "session-claude",
      "agent-1",
      "failed",
      "claude",
      "rate_limit",
      "claude 사용량 한도로 codex에 재디스패치했습니다.",
      "claude",
      "codex",
      1,
      "session-claude",
      "session-codex",
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

  it("marks the second failed session as loop-guard blocked without clearing the original redispatch trace", () => {
    markProviderFailoverLoopGuardBlocked(db, "task-1", "session-codex", {
      reasonCode: "rate_limit",
      userMessage: "codex 사용량 한도가 발생했지만 claude는 이미 이 태스크에서 시도되어 재디스패치하지 않았습니다.",
      fromProvider: "codex",
      toProvider: "claude",
      redispatched: false,
      loopGuardBlocked: true,
    });

    const task = db.prepare(
      `SELECT provider_failover_reason_code,
              provider_failover_user_message,
              provider_failover_from_provider,
              provider_failover_to_provider,
              provider_failover_redispatched,
              provider_failover_loop_guard_blocked,
              provider_failover_original_session_id,
              provider_failover_redispatched_session_id
       FROM tasks WHERE id = ?`,
    ).get("task-1") as Record<string, unknown>;
    expect(task).toMatchObject({
      provider_failover_reason_code: "rate_limit",
      provider_failover_user_message: "claude 사용량 한도로 codex에 재디스패치했습니다.",
      provider_failover_from_provider: "claude",
      provider_failover_to_provider: "codex",
      provider_failover_redispatched: 1,
      provider_failover_loop_guard_blocked: 1,
      provider_failover_original_session_id: "session-claude",
      provider_failover_redispatched_session_id: "session-codex",
    });

    const sessions = db.prepare(
      `SELECT id,
              provider_failover_reason_code,
              provider_failover_from_provider,
              provider_failover_to_provider,
              provider_failover_redispatched,
              provider_failover_loop_guard_blocked
       FROM sessions ORDER BY id`,
    ).all() as Record<string, unknown>[];
    expect(sessions).toEqual([
      {
        id: "session-claude",
        provider_failover_reason_code: "rate_limit",
        provider_failover_from_provider: "claude",
        provider_failover_to_provider: "codex",
        provider_failover_redispatched: 1,
        provider_failover_loop_guard_blocked: 0,
      },
      {
        id: "session-codex",
        provider_failover_reason_code: "rate_limit",
        provider_failover_from_provider: "codex",
        provider_failover_to_provider: "claude",
        provider_failover_redispatched: 0,
        provider_failover_loop_guard_blocked: 1,
      },
    ]);
  });
});
