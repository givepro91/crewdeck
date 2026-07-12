import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import { approveSpecVersion, beginExecutionRun, saveSpecDraft } from "../core/goal-spec/spec-approval.js";
import { createSessionRoutes } from "../api/routes/sessions.js";

vi.mock("../core/agent/adapters/backend.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBackend: () => ({
      spawn: () => Object.assign(new EventEmitter(), {
        id: "runtime-session",
        status: "idle",
        process: null,
        lastSessionId: null,
        send: vi.fn(),
        kill: vi.fn(),
        cleanup: vi.fn(),
      }),
    }),
  };
});

import { createSessionManager } from "../core/agent/session.js";

describe("session execution snapshot audit", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'test', 'new', '/tmp')").run();
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'agent', 'backend')").run();
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'goal')").run();
  });

  it("preserves the approved snapshot in task/session history and exposes its IDs", async () => {
    const version = saveSpecDraft(db, "g1", {
      scope: "scope v1",
      out_of_scope: "none",
      acceptance_criteria: ["accepted"],
      expected_tasks: ["implement"],
      verification_methods: ["test"],
    });
    approveSpecVersion(db, "g1", version.id);
    db.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, assignee_id)
      VALUES ('t1', 'g1', 'p1', 'task', 'a1')
    `).run();
    const run = beginExecutionRun(db, "g1");
    expect(run).not.toBeNull();
    if (!run) throw new Error("execution run was not created");

    const manager = createSessionManager(db);
    manager.spawnAgent("a1", "/tmp", "decompose-g1", null, {
      executionRunId: run.id,
      executionSpecVersionId: run.executionSpecVersionId,
    });
    manager.spawnAgent("a1", "/tmp", "implementation-t1", "t1");

    const rows = db.prepare(`
      SELECT task_id, execution_run_id, execution_spec_version_id
      FROM sessions ORDER BY rowid
    `).all() as Array<{
      task_id: string | null;
      execution_run_id: string;
      execution_spec_version_id: string;
    }>;
    expect(rows).toEqual([
      {
        task_id: null,
        execution_run_id: run.id,
        execution_spec_version_id: version.id,
      },
      {
        task_id: "t1",
        execution_run_id: run.id,
        execution_spec_version_id: version.id,
      },
    ]);

    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't1'").run();
    const nextVersion = saveSpecDraft(db, "g1", {
      scope: "scope v2",
      out_of_scope: "none",
      acceptance_criteria: ["accepted v2"],
      expected_tasks: ["implement v2"],
      verification_methods: ["test v2"],
    });
    approveSpecVersion(db, "g1", nextVersion.id);

    const history = db.prepare(`
      SELECT
        task.execution_spec_version_id AS task_version_id,
        session.execution_spec_version_id AS session_version_id,
        version.scope
      FROM tasks AS task
      JOIN sessions AS session ON session.task_id = task.id
      JOIN goal_execution_runs AS run ON run.id = task.execution_run_id
      JOIN goal_spec_versions AS version ON version.id = run.execution_spec_version_id
      WHERE task.id = 't1'
    `).get() as {
      task_version_id: string;
      session_version_id: string;
      scope: string;
    };
    expect(history).toEqual({
      task_version_id: version.id,
      session_version_id: version.id,
      scope: "scope v1",
    });
    expect(db.prepare("SELECT execution_spec_version_id FROM goals WHERE id = 'g1'").get())
      .toEqual({ execution_spec_version_id: nextVersion.id });

    const app = express();
    app.use("/api/sessions", createSessionRoutes({
      db,
      broadcast: () => {},
    } as any));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions`);
      expect(response.status).toBe(200);
      const sessions = await response.json() as Array<Record<string, unknown>>;
      const taskSession = sessions.find((session) => session.task_id === "t1");
      expect(taskSession).toMatchObject({
        task_id: "t1",
        execution_run_id: run.id,
        execution_spec_version_id: version.id,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
