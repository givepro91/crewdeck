// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Workspace } from "../../../shared/types";

const mocks = vi.hoisted(() => {
  const storage = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  };
  return {
    listWorkspaces: vi.fn(),
    archiveWorkspace: vi.fn(),
    projectActivity: vi.fn(),
  };
});

vi.mock("../lib/api", () => ({
  getApiKey: () => null,
  api: {
    projects: {
      activity: mocks.projectActivity,
      create: vi.fn(),
      list: vi.fn(),
    },
    workspaces: {
      list: mocks.listWorkspaces,
      create: vi.fn(),
      archive: mocks.archiveWorkspace,
    },
    agents: { suggestAndCreate: vi.fn() },
  },
}));

vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./DirectoryPicker", () => ({ DirectoryPicker: () => null }));

import "../i18n";
import { Sidebar } from "./Sidebar";
import { useStore } from "../stores/useStore";

const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: "w1",
  projectId: "p1",
  goalId: null,
  activeGoalId: null,
  name: "Manual",
  kind: "manual",
  state: "ready",
  worktreePath: "/tmp/manual",
  worktreeBranch: "workspace/manual",
  baseRef: "main",
  setupStep: "ready",
  setupProgress: 100,
  error: null,
  pathExists: true,
  dirty: false,
  sessionCount: 0,
  activeSessionCount: 0,
  terminalSessionCount: 0,
  activeTerminalSessionCount: 0,
  createdAt: "2026-07-15 00:00:00",
  updatedAt: "2026-07-15 00:00:00",
  archivedAt: null,
  ...overrides,
});

beforeEach(() => {
  mocks.projectActivity.mockResolvedValue({});
  mocks.archiveWorkspace.mockResolvedValue(workspace({ state: "archived" }));
  useStore.setState({
    projects: [{
      id: "p1",
      name: "Project",
      mission: "",
      source: "new",
      status: "active",
      workdir: "/tmp/project",
      created_at: "2026-07-15",
    }],
    currentProjectId: "p1",
    workspaces: [],
    agents: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Sidebar Workspace lifecycle", () => {
  it("requires confirmation and forwards dirty consent before ending a manual Workspace", async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace({ dirty: true })]);
    render(<Sidebar />);

    const endButton = await screen.findByRole("button", { name: "End Workspace: Manual" });
    fireEvent.click(endButton);
    expect(screen.getByText(/unsaved changes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(mocks.archiveWorkspace).toHaveBeenCalledWith("w1", { confirmDirty: true }));
    expect(useStore.getState().workspaces).toEqual([]);
  });

  it("disables ending while the Workspace has an active terminal", async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace({ activeTerminalSessionCount: 1 })]);
    render(<Sidebar />);

    const endButton = await screen.findByRole("button", { name: "End Workspace: Manual" }) as HTMLButtonElement;
    expect(endButton.disabled).toBe(true);
    expect(endButton.title).toBe("End active sessions first");
  });

  it("does not expose direct ending for a goal-owned Workspace", async () => {
    mocks.listWorkspaces.mockResolvedValue([workspace({ kind: "goal", goalId: "g1", name: "Goal" })]);
    render(<Sidebar />);

    await screen.findByText("Goal");
    expect(screen.queryByRole("button", { name: "End Workspace: Goal" })).toBeNull();
  });
});
