// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.hoisted(() => {
  const storage = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  };
});

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  generateSpec: vi.fn(),
  suggest: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: { goals: mocks },
}));

import "../i18n";
import { WorkspaceGoalComposer } from "./WorkspaceGoalComposer";

beforeEach(() => {
  mocks.create.mockResolvedValue({ id: "g1", title: "Ship terminal flow", autopilotHandled: false });
  mocks.generateSpec.mockResolvedValue({ status: "generating" });
  mocks.suggest.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceGoalComposer", () => {
  it("creates a goal and starts its blueprint by default", async () => {
    const onCreated = vi.fn();
    render(<WorkspaceGoalComposer projectId="p1" onCreated={onCreated} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText("Goal Title"), { target: { value: "Ship terminal flow" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Connect the selected goal" } });
    fireEvent.click(screen.getByRole("button", { name: "Create goal and start planning" }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      project_id: "p1",
      title: "Ship terminal flow",
      description: "Connect the selected goal",
    })));
    expect(mocks.generateSpec).toHaveBeenCalledWith("g1");
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }), true);
  });

  it("uses an AI suggestion to prefill a goal", async () => {
    mocks.suggest.mockResolvedValue([{
      title: "Suggested objective",
      description: "Suggested details",
      priority: "high",
      reason: "Matches the pasted request",
    }]);
    render(<WorkspaceGoalComposer projectId="p1" onCreated={() => {}} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText("Request or reference material"), { target: { value: "Connect Crewdeck" } });
    fireEvent.click(screen.getByRole("button", { name: "Suggest goals with AI" }));
    fireEvent.click(await screen.findByRole("button", { name: /Suggested objective/ }));

    expect(screen.getByLabelText("Goal Title")).toHaveProperty("value", "Suggested objective");
    expect(screen.getByLabelText("Description")).toHaveProperty("value", "Suggested details");
  });
});
