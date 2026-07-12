import { Router } from "express";
import type { AppContext } from "../../index.js";
import type { RecoveryIncident } from "../../../shared/types.js";

export function createRecoveryRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/incidents", (_req, res) => {
    const incidents = ctx.db.prepare(`
      SELECT id, goal_id, phase, decision, reason, user_action, created_at
        FROM recovery_incidents
       ORDER BY created_at DESC, rowid DESC
    `).all() as RecoveryIncident[];

    res.json({ incidents });
  });

  return router;
}
