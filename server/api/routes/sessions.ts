import { Router } from "express";
import type { AppContext } from "../../index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("sessions-api");

export function createSessionRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db, broadcast } = ctx;

  // List all sessions with agent/project info
  router.get("/", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    let where = "1=1";
    const params: string[] = [];

    if (status) {
      where += " AND s.status = ?";
      params.push(status);
    }
    if (projectId) {
      where += " AND a.project_id = ?";
      params.push(projectId);
    }

    const sessions = db.prepare(`
      SELECT s.id, s.agent_id, s.pid, s.started_at, s.ended_at, s.status,
             s.token_usage, s.cost_usd,
             a.name AS agent_name, a.role AS agent_role, a.status AS agent_status,
             a.current_activity, a.current_task_id,
             p.id AS project_id, p.name AS project_name
      FROM sessions s
      JOIN agents a ON s.agent_id = a.id
      JOIN projects p ON a.project_id = p.id
      WHERE ${where}
      ORDER BY s.started_at DESC
      LIMIT 200
    `).all(...params);

    res.json(sessions);
  });

  // Get session stats summary (optionally scoped to a project)
  router.get("/stats", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    const whereClause = projectId
      ? "WHERE s.agent_id IN (SELECT id FROM agents WHERE project_id = ?)"
      : "";
    const params = projectId ? [projectId] : [];

    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN s.status = 'killed' THEN 1 ELSE 0 END) as killed,
        SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) as failed,
        COALESCE(SUM(s.token_usage), 0) as total_tokens,
        COALESCE(SUM(s.cost_usd), 0) as total_cost
      FROM sessions s
      ${whereClause}
    `).get(...params);

    // Detect orphan sessions: active in DB but process not running.
    const activeSessions = db.prepare(
      `SELECT s.id, s.pid, s.started_at FROM sessions s
       ${projectId ? "WHERE s.status = 'active' AND s.agent_id IN (SELECT id FROM agents WHERE project_id = ?)" : "WHERE s.status = 'active'"}`,
    ).all(...params) as { id: string; pid: number | null; started_at: string }[];

    let orphanCount = 0;
    const now = Date.now();
    const GRACE_MS = 30_000;
    for (const s of activeSessions) {
      const age = now - new Date(s.started_at + "Z").getTime();
      if (age < GRACE_MS) continue; // still starting up
      if (!s.pid) { orphanCount++; continue; }
      try {
        process.kill(s.pid, 0);
      } catch {
        orphanCount++;
      }
    }

    res.json({ ...(stats as Record<string, unknown>), orphan: orphanCount });
  });

  // Kill a specific session
  router.delete("/:id", (req, res) => {
    const session = db.prepare(
      "SELECT s.id, s.agent_id, a.name FROM sessions s JOIN agents a ON s.agent_id = a.id WHERE s.id = ?",
    ).get(req.params.id) as { id: string; agent_id: string; name: string } | undefined;

    if (!session) return res.status(404).json({ error: "Session not found" });

    ctx.sessionManager?.killSession(session.agent_id);

    // Force DB update in case killSession didn't reach this row
    db.prepare(
      "UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ? AND status = 'active'",
    ).run(req.params.id);

    log.info(`Session ${req.params.id} killed via API (agent: ${session.name})`);
    broadcast("project:updated", {});
    res.json({ success: true, killed: session.id });
  });

  // Cleanup orphan sessions (active in DB but process dead)
  router.post("/cleanup", (_req, res) => {
    const active = db.prepare(
      "SELECT id, pid, agent_id, started_at FROM sessions WHERE status = 'active'",
    ).all() as { id: string; pid: number | null; agent_id: string; started_at: string }[];

    const now = Date.now();
    const GRACE_MS = 30_000;
    let cleaned = 0;
    for (const s of active) {
      const age = now - new Date(s.started_at + "Z").getTime();
      if (age < GRACE_MS) continue; // still starting up — don't kill
      let alive = false;
      if (s.pid) {
        try { process.kill(s.pid, 0); alive = true; } catch { alive = false; }
      }
      if (!alive) {
        db.prepare(
          "UPDATE sessions SET status = 'killed', ended_at = datetime('now') WHERE id = ?",
        ).run(s.id);
        // Reset agent status too
        db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = NULL, current_activity = NULL WHERE id = ?",
        ).run(s.agent_id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.info(`Cleaned ${cleaned} orphan session(s)`);
      broadcast("project:updated", {});
    }

    res.json({ success: true, cleaned, checked: active.length });
  });

  return router;
}
