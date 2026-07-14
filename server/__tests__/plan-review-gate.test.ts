import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { SessionManager } from "../core/agent/session.js";
import { createOrchestrationEngine } from "../core/orchestration/engine.js";
import { createDatabase, migrate } from "../db/schema.js";

/** Wrap text in the claude stream-json envelope that parseAgentOutput expects. */
function streamJson(text: string) {
  return {
    stdout: [
      JSON.stringify({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text }] } }),
      JSON.stringify({ type: "result", session_id: "s", result: text }),
    ].join("\n"),
    stderr: "",
    exitCode: 0,
    sessionId: "s",
    provider: "claude",
  };
}

/**
 * Minimal SessionManager stub: the plan-review reviewer session always replies
 * with `reviewsOrText` — either a reviews[] array (wrapped in a ```json block)
 * or a raw string (to simulate an unparseable reviewer response).
 */
function fakeSessionManager(reviewsOrText: unknown): SessionManager {
  return {
    spawnAgent: () => ({
      id: "planreview",
      send: async () =>
        streamJson(
          typeof reviewsOrText === "string"
            ? reviewsOrText
            : "```json\n" + JSON.stringify({ reviews: reviewsOrText }) + "\n```",
        ),
    }),
    getSession: () => undefined,
    getSessionRecord: () => undefined,
    killSession: vi.fn(),
    killAll: vi.fn(),
    pauseSession: vi.fn(),
    resumeSession: vi.fn(),
    setProviderOverride: vi.fn(),
    clearProviderOverride: vi.fn(),
  } as unknown as SessionManager;
}

describe("applyPlanReviewGate", () => {
  let db: Database.Database;
  const projectId = "p1";
  const goalId = "g1";

  function seed(autopilot: "off" | "goal" | "full") {
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare(
      "INSERT INTO projects (id, name, source, autopilot, workdir) VALUES (?, 'p', 'new', ?, '/tmp/planreview-test')",
    ).run(projectId, autopilot);
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('cto', ?, 'cto', 'cto')").run(projectId);
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('rev', ?, 'rev', 'reviewer')").run(projectId);
    db.prepare("INSERT INTO goals (id, project_id, title, description) VALUES (?, ?, 'g', 'do it')").run(goalId, projectId);
  }

  function addTask(id: string, extra: Record<string, string | number> = {}) {
    db.prepare(
      "INSERT INTO tasks (id, goal_id, project_id, title, description, status, assignee_id) VALUES (?, ?, ?, ?, 'desc', 'pending_approval', 'cto')",
    ).run(id, goalId, projectId, `task ${id}`);
    for (const [k, v] of Object.entries(extra)) {
      db.prepare(`UPDATE tasks SET ${k} = ? WHERE id = ?`).run(v, id);
    }
  }

  const status = (id: string) => (db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as { status: string }).status;
  const task = (id: string) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as any;

  afterEach(() => db.close());

  it("maps verdicts: approve→todo, reject→blocked (reason appended), escalate→pending_approval (flagged)", async () => {
    seed("goal");
    addTask("t-appr");
    addTask("t-rej");
    addTask("t-esc");
    const engine = createOrchestrationEngine(db, fakeSessionManager([
      { taskId: "t-appr", verdict: "approve", reason: "sound" },
      { taskId: "t-rej", verdict: "reject", reason: "bad scope" },
      { taskId: "t-esc", verdict: "escalate", reason: "removes the billing menu" },
    ]), () => {});

    await engine.applyPlanReviewGate(goalId, { autopilot: "goal" });

    expect(status("t-appr")).toBe("todo");
    expect(status("t-rej")).toBe("blocked");
    expect(status("t-esc")).toBe("pending_approval");
    expect(task("t-rej").description).toContain("bad scope");
    expect(task("t-esc").requires_human_approval).toBe(1);
    expect(task("t-esc").approval_reason).toContain("billing menu");
  });

  it("excludes verification-derived pending_approval — the Quality Gate is preserved", async () => {
    seed("goal");
    addTask("t-plan");
    addTask("t-verif", { verification_id: "v1" }); // verification-derived → must be excluded
    const engine = createOrchestrationEngine(db, fakeSessionManager([
      { taskId: "t-plan", verdict: "approve", reason: "ok" },
      { taskId: "t-verif", verdict: "approve", reason: "should be ignored" },
    ]), () => {});

    await engine.applyPlanReviewGate(goalId, { autopilot: "goal" });

    expect(status("t-plan")).toBe("todo");
    expect(status("t-verif")).toBe("pending_approval"); // untouched by the gate
  });

  it("off autopilot is a no-op — the human approval gate stays", async () => {
    seed("off");
    addTask("t1");
    const engine = createOrchestrationEngine(db, fakeSessionManager([
      { taskId: "t1", verdict: "approve", reason: "" },
    ]), () => {});

    await engine.applyPlanReviewGate(goalId, { autopilot: "off" });

    expect(status("t1")).toBe("pending_approval");
  });

  it("reviewer parse failure → everything stays pending_approval + plan_review_failed activity", async () => {
    seed("goal");
    addTask("t1");
    const engine = createOrchestrationEngine(db, fakeSessionManager("no json here at all"), () => {});

    await engine.applyPlanReviewGate(goalId, { autopilot: "goal" });

    expect(status("t1")).toBe("pending_approval");
    const acts = db.prepare("SELECT COUNT(*) c FROM activities WHERE type = 'plan_review_failed'").get() as { c: number };
    expect(acts.c).toBe(1);
  });

  it("a task missing from the reviewer output is escalated (safe default)", async () => {
    seed("goal");
    addTask("t1");
    addTask("t2");
    const engine = createOrchestrationEngine(db, fakeSessionManager([
      { taskId: "t1", verdict: "approve", reason: "" },
    ]), () => {});

    await engine.applyPlanReviewGate(goalId, { autopilot: "goal" });

    expect(status("t1")).toBe("todo");
    expect(status("t2")).toBe("pending_approval");
    expect(task("t2").requires_human_approval).toBe(1);
  });
});
