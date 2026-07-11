import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../core/agent/session.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import { createDatabase, migrate } from "../db/schema.js";

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

/**
 * Regression for the generating-spec deadlock (issue-0):
 * a zero-task goal whose spec is still '{"_status":"generating"}' must keep
 * the queue running (no false "completed" auto-stop), and when the external
 * spec generation finishes and calls notifyGoalReady, the scheduler must hand
 * the goal to decompose exactly once — not zero times (stranded) and not
 * repeatedly.
 */
describe("scheduler resumes decompose after a generating spec completes", () => {
  let db: Database.Database;
  let scheduler: ReturnType<typeof createScheduler>;
  const projectId = "project-decompose-resume";

  const decomposeActivityCount = (): number =>
    (db.prepare(
      "SELECT COUNT(*) AS count FROM activities WHERE project_id = ? AND message LIKE '태스크 분할 중:%'",
    ).get(projectId) as { count: number }).count;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO projects (id, name, source, autopilot) VALUES (?, 'test', 'new', 'goal')",
    ).run(projectId);
    db.prepare(
      "INSERT INTO agents (id, project_id, name, role) VALUES ('cto-1', ?, 'cto', 'cto')",
    ).run(projectId);

    // A single zero-task goal whose spec is owned by an in-flight external
    // generation (generate-spec route / rescue), marked as generating.
    db.prepare(
      "INSERT INTO goals (id, project_id, title, description, priority, sort_order) VALUES ('gen-goal', ?, 'gen-goal', 'goal', 'critical', 0)",
    ).run(projectId);
    db.prepare(
      `INSERT INTO goal_specs (goal_id, prd_summary, feature_specs, user_flow, acceptance_criteria, tech_considerations, generated_by)
       VALUES ('gen-goal', '{"_status":"generating"}', '[]', '[]', '[]', '[]', 'ai')`,
    ).run();

    scheduler = createScheduler(db, createSessionManager(), () => {});
    // Spec generation is external here; processNextGoal must never invoke this
    // while the marker is present — it should defer, not generate.
    scheduler.setSpecGenerator(vi.fn(async () => {}));
  });

  afterEach(() => {
    scheduler.stopQueue(projectId);
    db.close();
    vi.useRealTimers();
  });

  it("defers while generating, then decomposes exactly once on completion", async () => {
    scheduler.startQueue(projectId);
    await vi.advanceTimersByTimeAsync(5_000);

    // Still generating: queue alive, decompose not started (no false auto-stop,
    // no premature decompose of a spec-less goal).
    expect(scheduler.isRunning(projectId)).toBe(true);
    expect(decomposeActivityCount()).toBe(0);

    // External spec generation completes: marker cleared, then it notifies.
    db.prepare("UPDATE goal_specs SET prd_summary = 'ready' WHERE goal_id = 'gen-goal'").run();
    scheduler.notifyGoalReady(projectId);
    await vi.advanceTimersByTimeAsync(0);

    // Decompose was handed off exactly once by the completion callback.
    expect(decomposeActivityCount()).toBe(1);
  });
});
