import { Router } from "express";
import type { AppContext } from "../../index.js";
import { normalizeSeverity } from "../../utils/severity.js";

export function createVerificationRoutes(ctx: AppContext): Router {
  const router = Router();
  const { db, broadcast } = ctx;

  // List verifications for a task
  router.get("/", (req, res) => {
    const taskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

    const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 200;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 200;

    let verifications;
    if (taskId) {
      verifications = db.prepare(
        "SELECT * FROM verifications WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
      ).all(taskId, limit);
    } else if (projectId) {
      verifications = db.prepare(`
        SELECT v.*, t.title AS task_title FROM verifications v
        JOIN tasks t ON v.task_id = t.id
        WHERE t.project_id = ?
        ORDER BY v.created_at DESC LIMIT ?
      `).all(projectId, limit);
    } else {
      return res.status(400).json({ error: "taskId or projectId query param required" });
    }

    // Parse JSON fields safely — malformed JSON returns empty defaults
    const parsed = (verifications as any[]).map((v) => {
      let dimensions = {};
      let issues: unknown[] = [];
      try { dimensions = JSON.parse(v.dimensions); } catch { /* invalid JSON */ }
      try { issues = JSON.parse(v.issues); } catch { /* invalid JSON */ }
      return { ...v, dimensions, issues };
    });

    res.json(parsed);
  });

  // Aggregated verification stats for a project
  router.get("/stats", (req, res) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    if (!projectId) {
      return res.status(400).json({ error: "projectId query param required" });
    }

    const verdictRow = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN v.verdict = 'pass' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN v.verdict = 'conditional' THEN 1 ELSE 0 END) as conditional,
        SUM(CASE WHEN v.verdict = 'fail' THEN 1 ELSE 0 END) as failed
      FROM verifications v
      JOIN tasks t ON v.task_id = t.id
      WHERE t.project_id = ?
    `).get(projectId) as { total: number; passed: number; conditional: number; failed: number };

    const retryRow = db.prepare(`
      SELECT AVG(retry_count) as avg_retries
      FROM tasks
      WHERE project_id = ? AND status = 'done'
    `).get(projectId) as { avg_retries: number | null };

    const total = verdictRow.total ?? 0;
    const passed = verdictRow.passed ?? 0;
    const conditional = verdictRow.conditional ?? 0;
    const failed = verdictRow.failed ?? 0;
    const passRate = total > 0 ? Math.round(((passed + conditional) / total) * 100) : null;
    const avgRetries = retryRow.avg_retries != null ? Math.round(retryRow.avg_retries * 10) / 10 : null;

    res.json({ total, passed, conditional, failed, passRate, avgRetries });
  });

  // Create verification result
  router.post("/", (req, res) => {
    const { task_id, verdict, scope = "standard", dimensions, issues = [], severity, evaluator_session_id } = req.body;

    if (!task_id || !verdict) {
      return res.status(400).json({ error: "task_id and verdict are required" });
    }

    // severity를 CHECK 허용값(auto-resolve/soft-block/hard-block)으로 정규화.
    // 외부에서 critical/high 등 enum 밖 값이 들어와도 INSERT가 throw되지 않도록.
    const normSeverity = normalizeSeverity(severity, verdict);

    const result = db.prepare(`
      INSERT INTO verifications (task_id, verdict, scope, dimensions, issues, severity, evaluator_session_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      task_id,
      verdict,
      scope,
      JSON.stringify(dimensions ?? {}),
      JSON.stringify(issues),
      normSeverity,
      evaluator_session_id ?? null,
    );

    const verification = db.prepare("SELECT * FROM verifications WHERE rowid = ?").get(result.lastInsertRowid) as any;

    // Update task with verification result
    db.prepare("UPDATE tasks SET verification_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(verification.id, task_id);

    // If hard-block, set task to blocked + broadcast task status change
    if (normSeverity === "hard-block") {
      db.prepare("UPDATE tasks SET status = 'blocked', updated_at = datetime('now') WHERE id = ?")
        .run(task_id);
      const blockedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as any;
      if (blockedTask) broadcast("task:updated", blockedTask);
    }

    // Log activity
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task_id) as any;
    if (task) {
      db.prepare(`
        INSERT INTO activities (project_id, type, message, metadata)
        VALUES (?, ?, ?, ?)
      `).run(
        task.project_id,
        verdict === "pass" ? "verification_pass" : "verification_fail",
        `Task "${task.title}" verification: ${verdict.toUpperCase()}`,
        JSON.stringify({ taskId: task_id, verdict, severity: normSeverity }),
      );
    }

    let parsedDimensions: unknown = {};
    let parsedIssues: unknown[] = [];
    try { parsedDimensions = JSON.parse(verification.dimensions); } catch { /* invalid JSON */ }
    try {
      const p = JSON.parse(verification.issues);
      parsedIssues = Array.isArray(p) ? p : [];
    } catch { /* invalid JSON */ }

    const payload = { ...verification, dimensions: parsedDimensions, issues: parsedIssues };
    broadcast("verification:result", payload);
    res.status(201).json(payload);
  });

  // Create a fix task from a failed verification
  router.post("/:id/create-fix-task", (req, res) => {
    const { id } = req.params;

    const verification = db.prepare("SELECT * FROM verifications WHERE id = ?").get(id) as any;
    if (!verification) return res.status(404).json({ error: "Verification not found" });

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(verification.task_id) as any;
    if (!task) return res.status(404).json({ error: "Original task not found" });

    let issues: any[] = [];
    try {
      issues = JSON.parse(verification.issues);
    } catch {
      // fallback to empty
    }

    const issueSummary = issues.length > 0
      ? issues.map((i: any) => i.message ?? String(i)).join("; ").slice(0, 120)
      : "verification issues";

    const title = `Fix: ${issueSummary}`;
    const description = issues.length > 0
      ? `Issues found during verification of "${task.title}":\n\n` +
        issues.map((i: any) =>
          `- [${i.severity ?? "issue"}] ${i.file ? `${i.file}:${i.line ?? ""} — ` : ""}${i.message ?? i}${i.suggestion ? `\n  Suggestion: ${i.suggestion}` : ""}`,
        ).join("\n")
      : `Fix issues found in task "${task.title}".`;

    const result = db.prepare(`
      INSERT INTO tasks (goal_id, project_id, title, description, assignee_id, status)
      VALUES (?, ?, ?, ?, ?, 'todo')
    `).run(task.goal_id, task.project_id, title, description, task.assignee_id ?? null);

    const newTask = db.prepare("SELECT * FROM tasks WHERE rowid = ?").get(result.lastInsertRowid) as any;

    broadcast("task:updated", { ...newTask, action: "created" });

    db.prepare(`
      INSERT INTO activities (project_id, type, message, metadata)
      VALUES (?, 'task_created', ?, ?)
    `).run(
      task.project_id,
      `Fix task created: "${title}"`,
      JSON.stringify({ sourceVerificationId: id, sourceTaskId: task.id }),
    );

    res.status(201).json(newTask);
  });

  return router;
}
