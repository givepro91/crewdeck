import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type Database from "better-sqlite3";
import { WebSocket, WebSocketServer } from "ws";
import { createDatabase, migrate } from "../db/schema.js";
import { createActivityRoutes } from "../api/routes/activities.js";
import { createRecoveryRoutes } from "../api/routes/recovery.js";
import { createWSHandler } from "../api/websocket.js";
import { recoverInterruptedTask, recordRecoveryIncident } from "../core/recovery.js";
import { createSessionManager } from "../core/agent/session.js";
import { getBackend } from "../core/agent/adapters/backend.js";

vi.mock("../core/agent/adapters/backend.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../core/agent/adapters/backend.js")>(),
  getBackend: vi.fn(),
}));

let db: Database.Database | null = null;

function fixture(): Database.Database {
  db = createDatabase(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, source) VALUES ('p', 'P', 'new')").run();
  db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g', 'p', 'G')").run();
  return db;
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("recovery incident audit", () => {
  it("session_exit recovery broadcasts the same committed activity returned by the HTTP API", async () => {
    const database = fixture();
    database.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status)
      VALUES ('t', 'g', 'p', 'T', 'in_progress')
    `).run();
    database.prepare(`
      INSERT INTO agents (id, project_id, name, role)
      VALUES ('a', 'p', 'Agent', 'backend')
    `).run();

    const session = Object.assign(new EventEmitter(), {
      id: "runtime-session",
      process: null,
      status: "idle" as const,
      lastSessionId: null,
      send: vi.fn(),
      kill: vi.fn(),
      cleanup: vi.fn(),
    });
    vi.mocked(getBackend).mockReturnValue({
      provider: "claude",
      spawn: () => session,
      isAvailable: async () => true,
    });

    const app = express();
    app.use("/api/activities", createActivityRoutes({ db: database } as any));
    const server = createServer(app);
    const wss = new WebSocketServer({ server, path: "/ws" });
    const apiKey = "recovery-test-key";
    createWSHandler(wss, apiKey);
    const broadcast = (event: string, data: unknown): void => {
      const message = JSON.stringify({ type: event, payload: data });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN && (client as any).__authenticated) {
          client.send(message);
        }
      }
    };

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server address unavailable");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${apiKey}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const activityMessage = new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("activity:created was not received")), 1_000);
        ws.on("message", (raw) => {
          const message = JSON.parse(raw.toString());
          if (message.type === "activity:created") {
            clearTimeout(timeout);
            resolve(message);
          }
        });
      });

      const sessionManager = createSessionManager(database, broadcast);
      sessionManager.spawnAgent("a", process.cwd(), "implementation:t", "t");
      expect(sessionManager.recoverAbnormalExit?.(
        "implementation:t",
        "implementation",
        "reconcile",
        "agent process exited abnormally",
      )).toBe("resume");
      const received = await activityMessage;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/activities?projectId=p`);
      expect(response.status).toBe(200);
      const activities = await response.json() as any[];

      expect(received.payload).toEqual(activities[0]);
      expect(received.payload.metadata).toMatchObject({
        goal_id: "g",
        decision: "resume",
        source: "session_exit",
      });
    } finally {
      ws.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it("broadcasts the committed recovery activity in the activity API serializer shape", () => {
    const database = fixture();
    const broadcasts: Array<{ event: string; data: any }> = [];
    recordRecoveryIncident(database, {
      projectId: "p",
      goalId: "g",
      phase: "implementation",
      decision: "blocked",
      reason: "process ownership could not be proven",
      userAction: "inspect it",
      source: "session_exit",
    }, (event, data) => broadcasts.push({ event, data }));

    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toEqual({
      event: "activity:created",
      data: expect.objectContaining({
        id: expect.any(Number),
        project_id: "p",
        projectId: "p",
        agent_id: null,
        agentId: null,
        type: "recovery_incident",
        metadata: expect.objectContaining({ goal_id: "g", source: "session_exit" }),
        created_at: expect.any(String),
        createdAt: expect.any(String),
      }),
    });
  });

  it("legacy interrupted task is resumed and records the decision in activity metadata", () => {
    const database = fixture();
    database.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status)
      VALUES ('t', 'g', 'p', 'T', 'in_progress')
    `).run();

    expect(recoverInterruptedTask(database, "t", "session_exit")).toBe("resume");
    expect(database.prepare("SELECT status FROM tasks WHERE id = 't'").get()).toEqual({ status: "todo" });

    const incident = database.prepare(`
      SELECT goal_id, phase, decision, reason, user_action FROM recovery_incidents
    `).get();
    expect(incident).toEqual({
      goal_id: "g",
      phase: "implementation",
      decision: "resume",
      reason: "legacy task session was interrupted before completion",
      user_action: null,
    });
    const activity = database.prepare("SELECT type, metadata FROM activities").get() as { type: string; metadata: string };
    expect(activity.type).toBe("recovery_incident");
    expect(JSON.parse(activity.metadata)).toMatchObject({
      goal_id: "g",
      decision: "resume",
      source: "session_exit",
      user_action: null,
    });
  });

  it("GET /api/recovery/incidents returns only the exact response fields", async () => {
    const database = fixture();
    recordRecoveryIncident(database, {
      projectId: "p",
      goalId: "g",
      phase: "approval",
      decision: "wait_approval",
      reason: "artifact preserved",
      userAction: "review it",
      source: "startup",
    });

    const app = express();
    app.use("/api/recovery", createRecoveryRoutes({ db: database } as any));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server address unavailable");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/recovery/incidents`);
      expect(response.status).toBe(200);
      const body = await response.json() as { incidents: Array<Record<string, unknown>> };
      expect(body).toEqual({
        incidents: [{
          id: expect.any(String),
          goal_id: "g",
          phase: "approval",
          decision: "wait_approval",
          reason: "artifact preserved",
          user_action: "review it",
          created_at: expect.any(String),
        }],
      });
      expect(Object.keys(body)).toEqual(["incidents"]);
      expect(Object.keys(body.incidents[0])).toEqual([
        "id", "goal_id", "phase", "decision", "reason", "user_action", "created_at",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  it("records the owning verification or fix phase instead of inferring implementation", () => {
    const database = fixture();
    database.prepare(`
      INSERT INTO tasks (id, goal_id, project_id, title, status)
      VALUES ('verification-task', 'g', 'p', 'V', 'in_review')
    `).run();
    expect(recoverInterruptedTask(database, "verification-task", "session_exit")).toBe("resume");
    expect(database.prepare("SELECT phase FROM recovery_incidents ORDER BY rowid DESC LIMIT 1").get())
      .toEqual({ phase: "verification" });

    database.prepare("UPDATE tasks SET status = 'in_review' WHERE id = 'verification-task'").run();
    expect(recoverInterruptedTask(database, "verification-task", "session_exit", undefined, "fix")).toBe("resume");
    expect(database.prepare("SELECT phase FROM recovery_incidents ORDER BY rowid DESC LIMIT 1").get())
      .toEqual({ phase: "fix" });
  });
});
