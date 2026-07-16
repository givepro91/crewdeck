import { Router } from "express";
import type { AppContext } from "../../index.js";
import {
  archiveManualWorkspace,
  createManualWorkspace,
  getWorkspace,
  getWorkspaceDiff,
  getWorkspaceFiles,
  listWorkspaces,
  selectWorkspaceGoal,
  WorkspaceArchiveError,
} from "../../core/project/workspace.js";

export function createWorkspaceRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    res.json(listWorkspaces(ctx.db, projectId));
  });

  router.post("/", (req, res) => {
    const projectId = typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const baseRef = typeof req.body?.baseRef === "string" ? req.body.baseRef.trim() : undefined;
    if (!projectId) return res.status(400).json({ error: "projectId is required" });
    if (!name) return res.status(400).json({ error: "name is required" });
    if (name.length > 120) return res.status(400).json({ error: "name is too long (max 120)" });
    if (baseRef && baseRef.length > 200) return res.status(400).json({ error: "baseRef is too long (max 200)" });

    try {
      const workspace = createManualWorkspace(ctx.db, { projectId, name, baseRef });
      ctx.broadcast("workspace:updated", { projectId, workspaceId: workspace.id, state: workspace.state });
      ctx.broadcast("project:updated", { projectId });
      res.status(201).json(workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Workspace creation failed";
      if (message === `Project ${projectId} not found`) return res.status(404).json({ error: message });
      res.status(500).json({ error: message });
    }
  });

  router.get("/:id/diff", (req, res) => {
    const result = getWorkspaceDiff(ctx.db, req.params.id);
    if (!result) return res.status(404).json({ error: "Workspace not found" });
    res.json(result);
  });

  router.get("/:id/files", (req, res) => {
    const result = getWorkspaceFiles(ctx.db, req.params.id);
    if (!result) return res.status(404).json({ error: "Workspace not found" });
    res.json(result);
  });

  router.patch("/:id/context", (req, res) => {
    const goalId = req.body?.goalId === null
      ? null
      : typeof req.body?.goalId === "string" ? req.body.goalId.trim() : "";
    if (goalId === "") return res.status(400).json({ error: "goalId must be a string or null" });
    try {
      const workspace = selectWorkspaceGoal(ctx.db, req.params.id, goalId);
      ctx.broadcast("workspace:updated", {
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        activeGoalId: workspace.activeGoalId,
      });
      res.json(workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Workspace context update failed";
      const status = message === "Workspace not found" || message === "Goal not found in this project" ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.delete("/:id", (req, res) => {
    try {
      const workspace = archiveManualWorkspace(ctx.db, req.params.id, {
        confirmDirty: req.body?.confirmDirty === true,
      });
      ctx.broadcast("workspace:updated", {
        projectId: workspace.projectId,
        workspaceId: workspace.id,
        state: workspace.state,
      });
      ctx.broadcast("project:updated", { projectId: workspace.projectId });
      res.json(workspace);
    } catch (error) {
      if (error instanceof WorkspaceArchiveError) {
        return res.status(error.status).json({ error: error.code, message: error.message });
      }
      const message = error instanceof Error ? error.message : "Workspace archive failed";
      res.status(500).json({ error: "workspace_archive_failed", message });
    }
  });

  router.get("/:id", (req, res) => {
    const workspace = getWorkspace(ctx.db, req.params.id);
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    res.json(workspace);
  });

  return router;
}
