import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import { recoverOnStartup } from "../core/recovery.js";
import { createScheduler } from "../core/orchestration/scheduler.js";
import { createGoalWorktree } from "../core/project/worktree.js";
import type { SessionManager, SessionRecord } from "../core/agent/session.js";
import type { AgentProvider, AgentSession } from "../core/agent/adapters/backend.js";
import type { RunResult } from "../core/agent/adapters/claude-code.js";

type SpawnRecord = {
  sessionId: string;
  agentId: string;
  taskId: string | null;
  workdir: string;
  active: boolean;
};

class PendingSession extends EventEmitter implements AgentSession {
  process = null;
  status: AgentSession["status"] = "idle";
  lastSessionId: string | null = null;

  constructor(readonly id: string, private readonly record: SpawnRecord) {
    super();
  }

  async send(): Promise<RunResult> {
    this.status = "working";
    return new Promise<RunResult>(() => {});
  }

  kill(): void {
    this.status = "completed";
    this.record.active = false;
  }

  cleanup(): void {
    this.kill();
  }
}

class RecoverySessionManager implements SessionManager {
  readonly spawns: SpawnRecord[] = [];
  readonly duplicateLiveSessionIds: string[] = [];
  readonly concurrentWorkdirReuse: string[] = [];
  private readonly sessions = new Map<string, PendingSession>();
  private readonly records = new Map<string, SessionRecord>();

  spawnAgent(
    agentId: string,
    projectWorkdir: string,
    sessionKey?: string,
    taskId?: string | null,
  ): AgentSession {
    const key = sessionKey ?? agentId;
    const live = [...this.spawns].reverse().find(
      (spawn: SpawnRecord) => spawn.active && spawn.agentId === agentId,
    );
    if (live) this.duplicateLiveSessionIds.push(live.sessionId);
    const sessionId = `recovered-session-${this.spawns.length + 1}`;
    const workdirOwner = [...this.spawns].reverse().find(
      (spawn: SpawnRecord) => spawn.active && spawn.workdir === projectWorkdir,
    );
    if (workdirOwner) this.concurrentWorkdirReuse.push(workdirOwner.sessionId);
    const record = {
      sessionId,
      agentId,
      taskId: taskId ?? null,
      workdir: projectWorkdir,
      active: true,
    };
    const session = new PendingSession(sessionId, record);
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

  getSession(key: string): AgentSession | undefined {
    return this.sessions.get(key);
  }

  getSessionRecord(key: string): SessionRecord | undefined {
    return this.records.get(key);
  }

  killSession(key: string): void {
    this.sessions.get(key)?.cleanup();
    this.sessions.delete(key);
  }

  killAll(): void {
    for (const key of [...this.sessions.keys()]) this.killSession(key);
  }

  pauseSession(): void {}
  resumeSession(): void {}
  setProviderOverride(_sessionKey: string, _provider: AgentProvider): void {}
  clearProviderOverride(): void {}
}

let repo: string | null = null;
let db: Database.Database | null = null;
let scheduler: ReturnType<typeof createScheduler> | null = null;

function makeRepo(): string {
  const path = mkdtempSync(join(tmpdir(), "crewdeck-recovery-scheduling-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.email", "test@crewdeck.local"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Crewdeck Test"], { cwd: path });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: path });
  writeFileSync(join(path, ".gitignore"), ".crewdeck-worktrees/\n.claude/worktrees/\n");
  writeFileSync(join(path, "README.md"), "# recovery fixture\n");
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync("git", ["commit", "-m", "base"], { cwd: path });
  return path;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(() => {
  scheduler?.stopQueue("project-recovery");
  scheduler = null;
  if (db) {
    db.close();
    db = null;
  }
  if (repo) {
    rmSync(repo, { recursive: true, force: true });
    repo = null;
  }
});

describe("restart recovery scheduling integration", () => {
  it("restores one interrupted task once and reuses its preserved goal worktree", { timeout: 30_000 }, async () => {
    repo = makeRepo();
    db = createDatabase(":memory:");
    migrate(db);
    const worktree = createGoalWorktree(repo, "restart-contract");
    if (!worktree) throw new Error("failed to create recovery fixture worktree");
    writeFileSync(join(worktree.path, "interrupted.txt"), "preserve this WIP across restart\n");

    db.prepare(`
      INSERT INTO projects (id, name, source, workdir, base_branch)
      VALUES ('project-recovery', 'recovery', 'local_import', ?, 'main')
    `).run(repo);
    db.prepare(`
      INSERT INTO agents (id, project_id, name, role, needs_worktree, status, current_task_id)
      VALUES ('agent-recovery', 'project-recovery', 'recovery worker', 'qa', 0, 'working', 'task-recovery')
    `).run();
    db.prepare(`
      INSERT INTO goals (
        id, project_id, title, description, goal_model, worktree_path, worktree_branch
      ) VALUES ('goal-recovery', 'project-recovery', 'restart contract', 'restart contract',
        'goal_as_unit', ?, ?)
    `).run(worktree.path, worktree.branch);
    db.prepare(`
      INSERT INTO tasks (
        id, goal_id, project_id, title, description, status, assignee_id, started_at
      ) VALUES ('task-recovery', 'goal-recovery', 'project-recovery', 'resume interrupted task',
        'resume once', 'in_progress', 'agent-recovery', datetime('now', '-1 minute'))
    `).run();
    db.prepare(`
      INSERT INTO sessions (id, agent_id, status, provider, task_id)
      VALUES ('orphan-session', 'agent-recovery', 'active', 'claude', 'task-recovery')
    `).run();

    const firstRecovery = recoverOnStartup(db);
    const secondRecovery = recoverOnStartup(db);

    expect(firstRecovery).toEqual({ recoveredTasks: 1, killedProcesses: 0 });
    expect(secondRecovery).toEqual({ recoveredTasks: 0, killedProcesses: 0 });
    expect(db.prepare("SELECT status, started_at FROM tasks WHERE id = 'task-recovery'").get())
      .toEqual(expect.objectContaining({ status: "todo" }));
    expect(db.prepare("SELECT status FROM sessions WHERE id = 'orphan-session'").get())
      .toEqual({ status: "killed" });
    expect(db.prepare("SELECT status, current_task_id FROM agents WHERE id = 'agent-recovery'").get())
      .toEqual({ status: "idle", current_task_id: null });
    expect(existsSync(worktree.path)).toBe(true);
    expect(existsSync(join(worktree.path, "interrupted.txt"))).toBe(true);

    const sessions = new RecoverySessionManager();
    scheduler = createScheduler(db, sessions, () => {});
    scheduler.startQueue("project-recovery");
    await waitFor(() => sessions.spawns.length === 1, "recovered task dispatch");
    scheduler.startQueue("project-recovery");
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    expect(sessions.spawns).toEqual([
      expect.objectContaining({
        sessionId: "recovered-session-1",
        agentId: "agent-recovery",
        taskId: "task-recovery",
        workdir: worktree.path,
        active: true,
      }),
    ]);
    expect(sessions.duplicateLiveSessionIds).toEqual([]);
    expect(sessions.concurrentWorkdirReuse).toEqual([]);
    expect(db.prepare("SELECT worktree_path, worktree_branch FROM goals WHERE id = 'goal-recovery'").get())
      .toEqual({ worktree_path: worktree.path, worktree_branch: worktree.branch });
    expect(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf-8" }))
      .toContain(worktree.path);
  });
});
