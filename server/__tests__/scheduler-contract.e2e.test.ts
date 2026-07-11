import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import { createGoalRoutes } from "../api/routes/goals.js";
import { createOrchestrationRoutes } from "../api/routes/orchestration.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import type { SessionManager, SessionRecord } from "../core/agent/session.js";
import type { AgentProvider, AgentSession } from "../core/agent/adapters/backend.js";
import type { RunResult } from "../core/agent/adapters/claude-code.js";
import type { AppContext } from "../index.js";

type SpawnRecord = {
  sessionId: string;
  agentId: string;
  sessionKey: string;
  taskId: string | null;
  workdir: string;
  active: boolean;
};

type SendBehavior = (record: SpawnRecord, message: string) => Promise<RunResult>;

const pendingSend: SendBehavior = () => new Promise<RunResult>(() => {});

class RecordingSession extends EventEmitter implements AgentSession {
  process = null;
  status: AgentSession["status"] = "idle";
  lastSessionId: string | null = null;

  constructor(
    readonly id: string,
    private readonly record: SpawnRecord,
    private readonly behavior: SendBehavior,
  ) {
    super();
  }

  async send(message: string): Promise<RunResult> {
    this.status = "working";
    this.emit("status", "working");
    try {
      const result = await this.behavior(this.record, message);
      this.lastSessionId = result.sessionId;
      this.status = "completed";
      return result;
    } catch (error) {
      this.status = "failed";
      throw error;
    } finally {
      // An unresolved send remains active. Once it settles, the subprocess is
      // no longer concurrently using the workdir even if killSession follows
      // on the next engine statement.
      this.record.active = false;
    }
  }

  kill(): void {
    this.status = "completed";
    this.record.active = false;
  }

  cleanup(): void {
    this.kill();
  }
}

class RecordingSessionManager implements SessionManager {
  readonly spawns: SpawnRecord[] = [];
  readonly killedKeys: string[] = [];
  readonly concurrentReuse: Array<{ previous: string; next: string; workdir: string }> = [];
  readonly concurrentWorkdirReuse: Array<{ previous: string; next: string; workdir: string }> = [];
  private readonly sessions = new Map<string, RecordingSession>();
  private readonly records = new Map<string, SessionRecord>();
  private sequence = 0;

  constructor(private readonly behavior: SendBehavior = pendingSend) {}

  spawnAgent(
    agentId: string,
    projectWorkdir: string,
    sessionKey?: string,
    taskId?: string | null,
  ): AgentSession {
    const key = sessionKey ?? agentId;
    const sessionId = `recorded-session-${++this.sequence}`;
    const existing = [...this.spawns].reverse().find(
      (record: SpawnRecord) => record.sessionKey === key && record.active,
    );
    const workdirOwner = [...this.spawns].reverse().find(
      (record: SpawnRecord) => record.workdir === projectWorkdir && record.active,
    );
    if (workdirOwner) {
      this.concurrentWorkdirReuse.push({
        previous: workdirOwner.sessionId,
        next: sessionId,
        workdir: projectWorkdir,
      });
    }
    if (existing) {
      this.concurrentReuse.push({ previous: existing.sessionId, next: sessionId, workdir: projectWorkdir });
      existing.active = false;
      this.sessions.get(key)?.cleanup();
    }

    const record: SpawnRecord = {
      sessionId,
      agentId,
      sessionKey: key,
      taskId: taskId ?? null,
      workdir: projectWorkdir,
      active: true,
    };
    const session = new RecordingSession(sessionId, record, this.behavior);
    this.spawns.push(record);
    this.sessions.set(key, session);
    this.records.set(key, {
      sessionKey: key,
      agentId,
      rowId: sessionId,
      provider: "claude",
      runtimeSessionId: sessionId,
    });
    return session;
  }

  getSession(sessionKey: string): AgentSession | undefined {
    return this.sessions.get(sessionKey);
  }

  getSessionRecord(sessionKey: string): SessionRecord | undefined {
    return this.records.get(sessionKey);
  }

  killSession(sessionKey: string): void {
    this.killedKeys.push(sessionKey);
    const session = this.sessions.get(sessionKey);
    if (session) session.cleanup();
    this.sessions.delete(sessionKey);
  }

  killAll(): void {
    for (const key of [...this.sessions.keys()]) this.killSession(key);
  }

  pauseSession(): void {}
  resumeSession(): void {}
  setProviderOverride(_sessionKey: string, _provider: AgentProvider): void {}
  clearProviderOverride(): void {}
}

const tempDirs: string[] = [];
const dbs: Database.Database[] = [];
const servers: Server[] = [];
const schedulers: Array<{ stopQueue(projectId: string): void; projectId: string }> = [];

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "crewdeck-scheduler-contract-repo-"));
  tempDirs.push(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@crewdeck.local"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Crewdeck Test"], { cwd: repo });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  writeFileSync(join(repo, ".gitignore"), ".crewdeck-worktrees/\n.claude/worktrees/\n");
  writeFileSync(join(repo, "README.md"), "# scheduling contract fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo });
  return repo;
}

function makeDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  dbs.push(db);
  return db;
}

function seedProject(db: Database.Database, workdir: string, projectId = "project-contract"): string {
  db.prepare(`
    INSERT INTO projects (id, name, source, workdir, autopilot, base_branch)
    VALUES (?, 'scheduler contract', 'local_import', ?, 'off', 'main')
  `).run(projectId, workdir);
  return projectId;
}

function seedAgent(db: Database.Database, projectId: string, id: string): void {
  db.prepare(`
    INSERT INTO agents (id, project_id, name, role, needs_worktree)
    VALUES (?, ?, ?, 'backend', 1)
  `).run(id, projectId, id);
}

function seedGoalLane(
  db: Database.Database,
  projectId: string,
  goalId: string,
  firstAgentId: string,
  secondAgentId: string,
  sortOrder: number,
): { parentId: string; firstTaskId: string; secondTaskId: string } {
  const parentId = `${goalId}-parent`;
  const firstTaskId = `${goalId}-task-1`;
  const secondTaskId = `${goalId}-task-2`;
  db.prepare(`
    INSERT INTO goals (id, project_id, title, description, priority, sort_order, goal_model)
    VALUES (?, ?, ?, 'integration lane', 'high', ?, 'goal_as_unit')
  `).run(goalId, projectId, goalId, sortOrder);
  db.prepare(`
    INSERT INTO tasks (id, goal_id, project_id, title, description, status, assignee_id, sort_order)
    VALUES (?, ?, ?, ?, 'delegation parent', 'in_progress', ?, 0)
  `).run(parentId, goalId, projectId, parentId, firstAgentId);
  db.prepare(`
    INSERT INTO tasks (
      id, goal_id, project_id, parent_task_id, title, description, status, assignee_id, sort_order
    ) VALUES (?, ?, ?, ?, ?, 'first child', 'todo', ?, 1)
  `).run(firstTaskId, goalId, projectId, parentId, firstTaskId, firstAgentId);
  db.prepare(`
    INSERT INTO tasks (
      id, goal_id, project_id, parent_task_id, title, description, status, assignee_id, sort_order
    ) VALUES (?, ?, ?, ?, ?, 'second child', 'todo', ?, 2)
  `).run(secondTaskId, goalId, projectId, parentId, secondTaskId, secondAgentId);
  return { parentId, firstTaskId, secondTaskId };
}

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = await new Promise<Server>((resolve) => {
    const value = app.listen(0, () => resolve(value));
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(async () => {
  for (const item of schedulers.splice(0)) item.stopQueue(item.projectId);
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch { /* best effort */ }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scheduler scheduling contract integration", () => {
  it("runs two goals in parallel while nested polls never spawn a second task in either goal worktree", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedProject(db, repo);
    for (const id of ["agent-a1", "agent-a2", "agent-b1", "agent-b2"]) {
      seedAgent(db, projectId, id);
    }
    const laneA = seedGoalLane(db, projectId, "goal-a", "agent-a1", "agent-a2", 0);
    const laneB = seedGoalLane(db, projectId, "goal-b", "agent-b1", "agent-b2", 1);
    const sessions = new RecordingSessionManager();
    const scheduler = createScheduler(db, sessions, () => {});
    schedulers.push({ ...scheduler, projectId });

    scheduler.startQueue(projectId);
    await waitFor(() => sessions.spawns.filter((spawn) => spawn.taskId !== null).length === 2, "two goal sessions");

    // Keep polling while both sends are unresolved. A stale in-memory snapshot
    // used to select the second child from the same goal and replace its session.
    scheduler.startQueue(projectId);
    scheduler.notifyGoalReady(projectId);
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const implementationSpawns = sessions.spawns.filter((spawn) => spawn.taskId !== null);
    expect(implementationSpawns).toHaveLength(2);
    expect(new Set(implementationSpawns.map((spawn) => spawn.taskId))).toEqual(
      new Set([laneA.firstTaskId, laneB.firstTaskId]),
    );
    expect(new Set(implementationSpawns.map((spawn) => spawn.sessionId)).size).toBe(2);
    expect(new Set(implementationSpawns.map((spawn) => spawn.workdir)).size).toBe(2);
    expect(sessions.concurrentReuse).toEqual([]);
    expect(sessions.concurrentWorkdirReuse).toEqual([]);

    const goals = db.prepare(`
      SELECT id, worktree_path FROM goals WHERE id IN ('goal-a', 'goal-b') ORDER BY id
    `).all() as Array<{ id: string; worktree_path: string }>;
    expect(goals.map((goal) => goal.worktree_path).sort()).toEqual(
      implementationSpawns.map((spawn) => spawn.workdir).sort(),
    );
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(laneA.secondTaskId))
      .toEqual({ status: "todo" });
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(laneB.secondTaskId))
      .toEqual({ status: "todo" });
    expect(scheduler.getQueueState(projectId).activeTasks).toBe(2);
  });

  it("manual execute API CAS race returns one 202 and one 409 without creating duplicate sessions", { timeout: 20_000 }, async () => {
    const db = makeDb();
    const missingWorkdir = join(tmpdir(), `crewdeck-missing-${Date.now()}`);
    const projectId = seedProject(db, missingWorkdir, "project-manual-race");
    seedAgent(db, projectId, "agent-manual");
    db.prepare(`
      INSERT INTO goals (id, project_id, title, description)
      VALUES ('goal-manual', ?, 'manual race', 'manual race')
    `).run(projectId);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, description, status, assignee_id)
      VALUES ('task-manual', 'goal-manual', ?, 'manual race', 'manual race', 'todo', 'agent-manual')
    `).run(projectId);

    const app = express();
    app.use(express.json());
    app.use("/api/orchestration", createOrchestrationRoutes({
      db,
      broadcast: () => {},
    } as unknown as AppContext));
    const { baseUrl } = await listen(app);

    const responses = await Promise.all([
      fetch(`${baseUrl}/api/orchestration/tasks/task-manual/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      fetch(`${baseUrl}/api/orchestration/tasks/task-manual/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies).toEqual(expect.arrayContaining([
      { status: "started", taskId: "task-manual" },
      expect.objectContaining({
        taskId: "task-manual",
        error: expect.any(String),
        status: expect.stringMatching(/^(in_progress|blocked)$/),
      }),
    ]));

    await waitFor(
      () => (db.prepare("SELECT status FROM tasks WHERE id = 'task-manual'").get() as { status: string }).status === "blocked",
      "manual setup failure cleanup",
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
  });

  it("retries the exact failed task in the same worktree without running its later sibling", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedProject(db, repo, "project-retry-contract");
    seedAgent(db, projectId, "agent-retry");
    seedAgent(db, projectId, "agent-later");
    const lane = seedGoalLane(db, projectId, "goal-retry", "agent-retry", "agent-later", 0);
    let implementationAttempt = 0;
    const sessions = new RecordingSessionManager(async (record) => {
      if (record.taskId === lane.firstTaskId && ++implementationAttempt === 1) {
        throw new Error("synthetic implementation failure");
      }
      return pendingSend(record, "");
    });
    const scheduler = createScheduler(db, sessions, () => {});
    schedulers.push({ ...scheduler, projectId });

    scheduler.startQueue(projectId);
    await waitFor(
      () => (db.prepare("SELECT status FROM tasks WHERE id = ?").get(lane.firstTaskId) as { status: string }).status === "blocked",
      "first attempt failure",
    );
    db.prepare(`
      UPDATE tasks
      SET started_at = datetime('now', '-1 day'), updated_at = datetime('now', '-1 day')
      WHERE id = ?
    `).run(lane.firstTaskId);
    await waitFor(() => sessions.spawns.filter((spawn) => spawn.taskId !== null).length === 2, "retry session");

    const implementationSpawns = sessions.spawns.filter((spawn) => spawn.taskId !== null);
    expect(implementationSpawns.map((spawn) => spawn.taskId)).toEqual([
      lane.firstTaskId,
      lane.firstTaskId,
    ]);
    expect(new Set(implementationSpawns.map((spawn) => spawn.sessionId)).size).toBe(2);
    expect(new Set(implementationSpawns.map((spawn) => spawn.workdir)).size).toBe(1);
    expect(sessions.concurrentReuse).toEqual([]);
    expect(sessions.concurrentWorkdirReuse).toEqual([]);
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(lane.secondTaskId))
      .toEqual({ status: "todo" });
    expect(db.prepare("SELECT status, retry_count FROM tasks WHERE id = ?").get(lane.firstTaskId))
      .toEqual({ status: "in_progress", retry_count: 1 });
  });

  it("deleting a live goal releases the lane, kills task sessions, and removes its worktree", { timeout: 30_000 }, async () => {
    const repo = makeRepo();
    const db = makeDb();
    const projectId = seedProject(db, repo, "project-live-cancel");
    seedAgent(db, projectId, "agent-cancel-a");
    seedAgent(db, projectId, "agent-cancel-b");
    const lane = seedGoalLane(db, projectId, "goal-live-cancel", "agent-cancel-a", "agent-cancel-b", 0);
    const sessions = new RecordingSessionManager();
    const scheduler = createScheduler(db, sessions, () => {});
    schedulers.push({ ...scheduler, projectId });

    scheduler.startQueue(projectId);
    await waitFor(() => sessions.spawns.some((spawn) => spawn.taskId === lane.firstTaskId), "live goal session");
    const spawn = sessions.spawns.find((item) => item.taskId === lane.firstTaskId)!;
    expect(scheduler.getQueueState(projectId).activeTasks).toBe(1);

    const app = express();
    app.use(express.json());
    app.use("/api/goals", createGoalRoutes({
      db,
      broadcast: () => {},
      sessionManager: sessions,
      scheduler,
    } as unknown as AppContext));
    const { baseUrl } = await listen(app);
    const response = await fetch(`${baseUrl}/api/goals/goal-live-cancel`, { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(db.prepare("SELECT id FROM goals WHERE id = 'goal-live-cancel'").get()).toBeUndefined();
    expect(scheduler.getQueueState(projectId).activeTasks).toBe(0);
    expect(spawn.active).toBe(false);
    expect(sessions.killedKeys).toEqual(expect.arrayContaining([
      "agent-cancel-a",
      `architect-${lane.firstTaskId}`,
      `evaluator-${lane.firstTaskId}`,
      "spec-goal-live-cancel",
      "decompose-goal-live-cancel",
    ]));
    expect(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf-8" }))
      .not.toContain(spawn.workdir);
    expect(sessions.concurrentReuse).toEqual([]);
    expect(sessions.concurrentWorkdirReuse).toEqual([]);
  });
});
