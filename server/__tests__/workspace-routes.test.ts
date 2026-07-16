import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, migrate } from "../db/schema.js";
import { createWorkspaceRoutes } from "../api/routes/workspaces.js";
import { recoverOnStartup } from "../core/recovery.js";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "crewdeck-workspace-route-"));
  tempDirs.push(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@crewdeck.local");
  git("config", "user.name", "Crewdeck Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".gitignore"), ".crewdeck-worktrees/\n.claude/worktrees/\n");
  writeFileSync(join(repo, "README.md"), "# base\n");
  git("add", ".");
  git("commit", "-m", "base");
  return repo;
}

async function startApi(workdir = "") {
  const db = createDatabase(":memory:");
  migrate(db);
  db.exec(`
    INSERT INTO projects (id, name, source) VALUES ('p1', 'One', 'new'), ('p2', 'Two', 'new');
    INSERT INTO workspaces (
      id, project_id, name, kind, state, worktree_path, worktree_branch, base_ref, setup_progress
    ) VALUES
      ('w1', 'p1', 'Ready', 'goal', 'ready', '/missing/worktree', 'agent/ready', 'main', 100),
      ('w2', 'p2', 'Other', 'manual', 'pending', NULL, NULL, 'main', 0);
  `);
  db.prepare("UPDATE projects SET workdir = ? WHERE id = 'p1'").run(workdir);
  const app = express();
  app.use(express.json());
  app.use("/api/workspaces", createWorkspaceRoutes({ db, broadcast: () => {} } as any));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { db, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("workspace read routes", () => {
  it("lists project-scoped read models and exposes path health", async () => {
    const { baseUrl, db } = await startApi();
    const before = db.prepare("SELECT total_changes() AS changes").get() as { changes: number };
    const response = await fetch(`${baseUrl}/api/workspaces?projectId=p1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([expect.objectContaining({
      id: "w1",
      projectId: "p1",
      state: "ready",
      worktreePath: "/missing/worktree",
      worktreeBranch: "agent/ready",
      pathExists: false,
      dirty: null,
      sessionCount: 0,
      activeSessionCount: 0,
      terminalSessionCount: 0,
      activeTerminalSessionCount: 0,
    })]);
    const after = db.prepare("SELECT total_changes() AS changes").get() as { changes: number };
    expect(after.changes).toBe(before.changes);
  });

  it("returns one workspace and a stable 404", async () => {
    const { baseUrl } = await startApi();
    const found = await fetch(`${baseUrl}/api/workspaces/w2`);
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ id: "w2", projectId: "p2", kind: "manual" });

    const missing = await fetch(`${baseUrl}/api/workspaces/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Workspace not found" });
  });

  it("selects a project goal as the active terminal context", async () => {
    const { baseUrl, db } = await startApi();
    db.exec(`
      INSERT INTO goals (id, project_id, title, description) VALUES
        ('g1', 'p1', 'Selected Goal', ''),
        ('g2', 'p2', 'Wrong Project Goal', '');
    `);

    const selected = await fetch(`${baseUrl}/api/workspaces/w1/context`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId: "g1" }),
    });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ id: "w1", activeGoalId: "g1" });

    const wrongProject = await fetch(`${baseUrl}/api/workspaces/w1/context`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goalId: "g2" }),
    });
    expect(wrongProject.status).toBe(404);
    expect(await wrongProject.json()).toEqual({ error: "Goal not found in this project" });
  });

  it("creates a manual worktree, exposes its files/diff, and preserves it on restart", async () => {
    const repo = createGitRepo();
    const { baseUrl, db } = await startApi(repo);
    const createdResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "p1", name: "Terminal Session" }),
    });
    expect(createdResponse.status).toBe(201);
    const workspace = await createdResponse.json() as {
      id: string;
      state: string;
      kind: string;
      worktreePath: string;
      worktreeBranch: string;
      pathExists: boolean;
    };
    expect(workspace).toMatchObject({
      state: "ready",
      kind: "manual",
      pathExists: true,
    });
    expect(workspace.worktreeBranch).toMatch(/^workspace\/terminal-session-/);
    expect(existsSync(workspace.worktreePath)).toBe(true);

    writeFileSync(join(workspace.worktreePath, "README.md"), "# changed in terminal Workspace\n");
    writeFileSync(join(workspace.worktreePath, "terminal-proof.md"), "# untracked proof\n");
    const diff = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/diff`);
    const diffBody = await diff.json() as { diff: string };
    expect(diffBody.diff).toContain("changed in terminal Workspace");
    expect(diffBody.diff).toContain("terminal-proof.md");
    expect(diffBody.diff).toContain("untracked proof");
    const files = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files`);
    expect(await files.json()).toMatchObject({ files: expect.arrayContaining(["README.md"]) });
    expect(readFileSync(join(workspace.worktreePath, "README.md"), "utf-8")).toContain("changed");

    recoverOnStartup(db);
    expect(existsSync(workspace.worktreePath)).toBe(true);
  });

  it("keeps an inspectable error row when the base ref cannot create a worktree", async () => {
    const repo = createGitRepo();
    const { baseUrl } = await startApi(repo);
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "p1", name: "Broken", baseRef: "missing-branch" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      state: "error",
      setupStep: "worktree_failed",
      error: { code: "worktree_create_failed" },
    });
  });

  it("requires explicit confirmation before archiving a dirty manual Workspace", async () => {
    const repo = createGitRepo();
    const { baseUrl } = await startApi(repo);
    const createdResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "p1", name: "Disposable" }),
    });
    const workspace = await createdResponse.json() as {
      id: string;
      worktreePath: string;
      worktreeBranch: string;
    };
    writeFileSync(join(workspace.worktreePath, "unsaved.txt"), "not applied\n");

    const blocked = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "workspace_dirty_confirmation_required" });
    expect(existsSync(workspace.worktreePath)).toBe(true);

    const archivedResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmDirty: true }),
    });
    expect(archivedResponse.status).toBe(200);
    expect(await archivedResponse.json()).toMatchObject({
      id: workspace.id,
      state: "archived",
      worktreePath: null,
      worktreeBranch: null,
      pathExists: null,
      dirty: null,
      archivedAt: expect.any(String),
    });
    expect(existsSync(workspace.worktreePath)).toBe(false);
    const branches = execFileSync("git", ["branch", "--list", workspace.worktreeBranch], {
      cwd: repo,
      encoding: "utf-8",
    });
    expect(branches.trim()).toBe("");

    const listed = await fetch(`${baseUrl}/api/workspaces?projectId=p1`);
    expect(await listed.json()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: workspace.id }),
    ]));
    const archived = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`);
    expect(await archived.json()).toMatchObject({ id: workspace.id, state: "archived" });
  });

  it("blocks archiving while a terminal session is active", async () => {
    const repo = createGitRepo();
    const { baseUrl, db } = await startApi(repo);
    const createdResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "p1", name: "Busy" }),
    });
    const workspace = await createdResponse.json() as { id: string; worktreePath: string };
    db.prepare(`
      INSERT INTO terminal_sessions (id, workspace_id, project_id, shell, cwd)
      VALUES ('term-active', ?, 'p1', '/bin/sh', ?)
    `).run(workspace.id, workspace.worktreePath);

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmDirty: true }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "workspace_active_sessions" });
    expect(existsSync(workspace.worktreePath)).toBe(true);
  });

  it("does not allow goal-owned Workspaces to be archived directly", async () => {
    const { baseUrl } = await startApi();
    const response = await fetch(`${baseUrl}/api/workspaces/w1`, { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "workspace_goal_owned" });
  });

  it("refuses cleanup when the stored path is outside the managed Workspace root", async () => {
    const repo = createGitRepo();
    const { baseUrl, db } = await startApi(repo);
    const outside = join(repo, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    db.prepare(`
      UPDATE workspaces
         SET state = 'ready', worktree_path = ?, worktree_branch = 'workspace/outside', setup_progress = 100
       WHERE id = 'w2'
    `).run(outside);
    db.prepare("UPDATE workspaces SET project_id = 'p1' WHERE id = 'w2'").run();

    const response = await fetch(`${baseUrl}/api/workspaces/w2`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmDirty: true }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "workspace_cleanup_refused" });
    expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("keep\n");
  });
});
