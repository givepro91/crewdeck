import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";
import { createGoalRoutes } from "../api/routes/goals.js";
import { createOrchestrationRoutes } from "../api/routes/orchestration.js";
import type { AppContext } from "../index.js";
import type { GoalSpecStateResponse } from "../../shared/types.js";

const dbs: Database.Database[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch { /* best effort */ }
  }
});

// The AI refine session returns a COMPLETE spec; the fixed refineGoalSpec must
// convert it into a new immutable draft snapshot (via saveSpecDraft), not only
// touch the legacy goal_specs row.
const refinedSpec = {
  scope: "refined scope",
  out_of_scope: "excluded",
  acceptance_criteria: ["Given a refine request, when it succeeds, then a new draft version exists"],
  expected_tasks: ["Approval gate: block unapproved runs"],
  verification_methods: ["reuse saveSpecDraft"],
};

// Minimal Claude stream-json line carrying the bare JSON shape Codex may return.
function claudeStdout(payload: unknown): string {
  const text = JSON.stringify(payload);
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

describe("POST /refine-spec persists a new immutable draft snapshot", () => {
  it("makes GET /spec surface changes_pending and invalidates the approved pointer", async () => {
    const db = createDatabase(":memory:");
    migrate(db);
    dbs.push(db);
    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'test', 'new', '/tmp')").run();
    db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'goal')").run();
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'cto', 'cto')").run();
    const ctx = { db, broadcast: () => {} } as unknown as AppContext;
    // Registers ctx.refineGoalSpec + ctx.sessionManager (the real refine closure).
    createOrchestrationRoutes(ctx);
    // Bypass the real Claude Code subprocess with a canned stream-json response.
    (ctx.sessionManager as any).spawnAgent = () => ({
      send: async () => ({ stdout: claudeStdout(refinedSpec), stderr: "", exitCode: 0, provider: "claude", sessionId: "s1" }),
    });

    const app = express();
    app.use(express.json());
    app.use("/api/goals", createGoalRoutes(ctx));
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const created = await fetch(`${baseUrl}/api/goals/g1/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope: "original scope",
        out_of_scope: "excluded",
        acceptance_criteria: ["original criterion"],
        expected_tasks: ["original task"],
        verification_methods: ["original check"],
      }),
    }).then((r) => r.json()) as GoalSpecStateResponse;
    const approved = await fetch(`${baseUrl}/api/goals/g1/spec/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version_id: created.versions[0].id }),
    }).then((r) => r.json()) as GoalSpecStateResponse;
    expect(approved).toMatchObject({
      status: "approved",
      execution_spec_version_id: created.versions[0].id,
      versions: [{ version: 1, state: "approved", scope: "original scope" }],
    });

    const refineResponse = await fetch(`${baseUrl}/api/goals/g1/refine-spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "add an approval gate" }),
    });
    expect(refineResponse.status).toBe(200);

    const after = await fetch(`${baseUrl}/api/goals/g1/spec`).then((r) => r.json()) as GoalSpecStateResponse;
    expect(after).toMatchObject({
      status: "changes_pending",
      execution_spec_version_id: null,
      versions: [
        { version: 1, state: "approved", scope: "original scope" },
        {
          version: 2,
          state: "draft",
          scope: "refined scope",
          acceptance_criteria: ["Given a refine request, when it succeeds, then a new draft version exists"],
          expected_tasks: ["Approval gate: block unapproved runs"],
          verification_methods: ["reuse saveSpecDraft"],
        },
      ],
    });
  });
});
