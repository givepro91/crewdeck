import { Router } from "express";
import type { AppContext } from "../../index.js";
import type { ActivityLogEntry } from "../../../shared/types.js";

interface ActivityRow {
  id: number;
  project_id: string;
  agent_id: string | null;
  type: string;
  message: string;
  metadata: string | null;
  created_at: string;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function serializeActivity(row: ActivityRow): ActivityLogEntry {
  return {
    id: row.id,
    project_id: row.project_id,
    projectId: row.project_id,
    agent_id: row.agent_id,
    agentId: row.agent_id,
    type: row.type,
    message: row.message,
    metadata: parseMetadata(row.metadata),
    created_at: row.created_at,
    createdAt: row.created_at,
  };
}

export function createActivityRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx;

  // GET /api/activities?projectId=xxx
  router.get("/", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    if (!projectId) {
      return res.status(400).json({ error: "projectId query param required" });
    }

    const activities = db
      .prepare(
        `SELECT id, project_id, agent_id, type, message, metadata, created_at FROM activities
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all(projectId) as ActivityRow[];

    res.json(activities.map(serializeActivity));
  });

  return router;
}
