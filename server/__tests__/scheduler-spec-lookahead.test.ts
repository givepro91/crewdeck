import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../core/agent/session.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import { createDatabase, migrate } from "../db/schema.js";
import { approveSpecVersion, saveSpecDraft } from "../core/goal-spec/spec-approval.js";

function createSessionManager(): SessionManager {
  return {
    spawnAgent: vi.fn(() => {
      throw new Error("execution slots are already occupied");
    }),
    getSession: vi.fn(() => undefined),
    getSessionRecord: vi.fn(() => undefined),
    killSession: vi.fn(),
    killAll: vi.fn(),
    pauseSession: vi.fn(),
    resumeSession: vi.fn(),
    setProviderOverride: vi.fn(),
    clearProviderOverride: vi.fn(),
  } as SessionManager;
}

describe("scheduler spec/decompose lookahead", () => {
  let db: Database.Database;
  let scheduler: ReturnType<typeof createScheduler>;
  const projectId = "project-lookahead";

  function seedAgent(id: string): void {
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role) VALUES (?, ?, ?, 'backend')",
    ).run(id, projectId, id);
  }

  function seedGoal(id: string, priority: string, sortOrder: number): void {
    db.prepare(
      `INSERT INTO goals (id, project_id, title, description, priority, sort_order)
       VALUES (?, ?, ?, 'goal', ?, ?)`,
    ).run(id, projectId, id, priority, sortOrder);
  }

  function seedTask(goalId: string, id: string, status: string, assigneeId: string): void {
    db.prepare(
      `INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id)
       VALUES (?, ?, ?, 'task', ?, ?)`,
    ).run(id, goalId, projectId, status, assigneeId);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO projects (id, name, source, autopilot) VALUES (?, 'test', 'new', 'goal')",
    ).run(projectId);

    seedAgent("agent-1");
    seedAgent("agent-2");
    seedGoal("running-1", "high", 0);
    seedGoal("running-2", "high", 1);
    seedTask("running-1", "running-task-1", "in_progress", "agent-1");
    seedTask("running-2", "running-task-2", "in_progress", "agent-2");
    // progress is derived and may lag or drift from the live task state.
    // Lookahead capacity must still count these two execution goals.
    db.prepare("UPDATE goals SET progress = 100 WHERE id IN ('running-1', 'running-2')").run();

    scheduler = createScheduler(db, createSessionManager(), () => {});
  });

  afterEach(() => {
    scheduler.stopQueue(projectId);
    db.close();
    vi.useRealTimers();
  });

  it("execution slot two are full but only the next priority goal occupies one preparation flight", async () => {
    seedGoal("next-critical", "critical", 0);
    seedGoal("later-medium", "medium", 0);
    seedGoal("last-low", "low", 0);

    let finishPreparation!: () => void;
    const preparationGate = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const generateSpec = vi.fn(async (goalId: string) => {
      await preparationGate;
      db.prepare("UPDATE goal_specs SET prd_summary = 'ready' WHERE goal_id = ?").run(goalId);
    });
    scheduler.setSpecGenerator(generateSpec);

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(0);

    expect(generateSpec).toHaveBeenCalledTimes(1);
    expect(generateSpec).toHaveBeenCalledWith("next-critical");

    scheduler.notifyGoalReady(projectId);
    scheduler.notifyGoalReady(projectId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(generateSpec).toHaveBeenCalledTimes(1);

    scheduler.stopQueue(projectId);
    finishPreparation();
    await vi.advanceTimersByTimeAsync(0);

    expect(scheduler.isRunning(projectId)).toBe(false);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE project_id = ? AND message LIKE '태스크 분할 중:%'",
    ).get(projectId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE goal_id = 'next-critical'").get())
      .toEqual({ count: 0 });
    scheduler.notifyGoalReady(projectId);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(generateSpec).toHaveBeenCalledTimes(1);
  });

  it("a completed preparation fills lookahead one without starting a second goal", async () => {
    seedGoal("prepared-first", "critical", 0);
    seedGoal("must-wait", "medium", 0);

    const generateSpec = vi.fn(async (goalId: string) => {
      db.prepare("UPDATE goal_specs SET prd_summary = 'ready' WHERE goal_id = ?").run(goalId);
      seedTask(goalId, `${goalId}-prepared`, "todo", "agent-1");
    });
    scheduler.setSpecGenerator(generateSpec);

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(generateSpec).toHaveBeenCalledTimes(1);
    expect(generateSpec).toHaveBeenCalledWith("prepared-first");
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE goal_id = 'must-wait'").get())
      .toEqual({ count: 0 });
  });

  it("an approved versioned spec without a legacy row is not regenerated before decompose", async () => {
    seedGoal("versioned-approved", "critical", 0);
    const version = saveSpecDraft(db, "versioned-approved", {
      scope: "approved",
      out_of_scope: "none",
      acceptance_criteria: ["pass"],
      expected_tasks: ["implement"],
      verification_methods: ["test"],
    });
    approveSpecVersion(db, "versioned-approved", version.id);
    const generateSpec = vi.fn(async () => {});
    scheduler.setSpecGenerator(generateSpec);

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(0);

    expect(generateSpec).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM goal_spec_versions WHERE goal_id = ?").get("versioned-approved"))
      .toEqual({ count: 1 });
  });

  it("a zero-task goal whose spec is still generating does not auto-stop the queue as completed", async () => {
    // All execution work is done — without the generating goal the queue would
    // legitimately auto-stop. The in-flight spec generation is owned by an
    // external actor (generate-spec route / rescue) that will call
    // notifyGoalReady when done; that callback is gated on the queue still
    // running, so a false "completed" auto-stop here strands the goal forever.
    db.prepare("UPDATE tasks SET status = 'done' WHERE id IN ('running-task-1', 'running-task-2')").run();
    seedGoal("gen-goal", "critical", 0);
    db.prepare(
      `INSERT INTO goal_specs (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by)
       VALUES ('gen-goal', '{"_status":"generating"}', '[]', '[]', '[]', '[]', 'ai')`,
    ).run();

    const stopped: unknown[] = [];
    const scheduler2 = createScheduler(db, createSessionManager(), (type, payload) => {
      if (type === "queue:stopped") stopped.push(payload);
    });
    scheduler2.setSpecGenerator(vi.fn(async () => {}));

    scheduler2.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(scheduler2.isRunning(projectId)).toBe(true);
    expect(stopped).toEqual([]);

    scheduler2.stopQueue(projectId);
  });

  it("skips a goal whose auto-approval keeps failing validation instead of wedging the pipeline", async () => {
    // "invalid-draft": top priority, but its blueprint fails approval validation
    // (empty scope) — autopilot auto-approve can never approve it. Before the fix
    // the selector re-picked this zero-task goal every poll, hit the gate, and
    // returned (busy-loop) — and no lower-priority goal was ever prepared.
    seedGoal("invalid-draft", "critical", 0);
    saveSpecDraft(db, "invalid-draft", {
      scope: "",
      out_of_scope: "",
      acceptance_criteria: [],
      expected_tasks: [],
      verification_methods: [],
    });
    // "valid-next": lower priority, no blueprint — must still get prepared.
    seedGoal("valid-next", "high", 1);

    const generateSpec = vi.fn(async (goalId: string) => {
      saveSpecDraft(db, goalId, {
        scope: "s",
        out_of_scope: "n",
        acceptance_criteria: ["a"],
        expected_tasks: ["t"],
        verification_methods: ["v"],
      });
    });
    scheduler.setSpecGenerator(generateSpec);

    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(5_000);

    // Pipeline advanced past the un-approvable goal to prepare the valid one.
    expect(generateSpec).toHaveBeenCalledWith("valid-next");
    // The stuck goal was surfaced once for manual review.
    const warned = db.prepare(
      "SELECT COUNT(*) AS c FROM activities WHERE project_id = ? AND type = 'autopilot_warning' AND message LIKE '기획서 자동 승인 실패%'",
    ).get(projectId) as { c: number };
    expect(warned.c).toBeGreaterThanOrEqual(1);
    // 'valid-next' has no failed version; 'invalid-draft' stays unapproved.
    expect(db.prepare("SELECT execution_spec_version_id FROM goals WHERE id = 'invalid-draft'").get())
      .toEqual({ execution_spec_version_id: null });
  });
});
