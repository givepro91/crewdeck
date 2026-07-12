// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// jsdom 은 localStorage 를 기본 노출하지 않는다 — api.ts / i18n index 최상단 접근용 최소 구현.
const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
  };
  return { executeTask: vi.fn() };
});

// api.orchestration.executeTask 만 mock — ApiError 등 나머지는 실제 구현.
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      orchestration: { ...actual.api.orchestration, executeTask: mocks.executeTask },
    },
  };
});

import "../i18n";
import { ApiError } from "../lib/api";
import { TaskList } from "./TaskList";

const AGENTS = [{ id: "a1", name: "Backend", status: "idle" as const, current_task_id: null }];
const TODO_TASK = {
  id: "task-1",
  title: "Wire the approval gate",
  description: "",
  status: "todo",
  assignee_id: "a1",
  goal_id: "goal-1",
  verification_id: null,
};

beforeEach(() => {
  mocks.executeTask.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("TaskList — spec_not_approved run gate", () => {
  it("surfaces the block reason + draft version + approval CTA and clears the running timer", async () => {
    mocks.executeTask.mockRejectedValue(
      new ApiError("Blueprint must be approved before execution", 409, "spec_not_approved", undefined, undefined, {
        goalId: "goal-1",
        specStatus: "draft",
        currentDraftVersion: 2,
      }),
    );
    const onOpenSpec = vi.fn();
    render(<TaskList tasks={[TODO_TASK]} agents={AGENTS} projectId="p1" onOpenSpec={onOpenSpec} />);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    // 차단 사유 + 현재 초안 버전 노출
    await waitFor(() => expect(screen.getByText(/blueprint not approved/i)).toBeTruthy());
    expect(screen.getByText(/Blueprint must be approved before execution/)).toBeTruthy();
    expect(screen.getByText(/Current draft v2/)).toBeTruthy();

    // 실행 타이머 종료 — 버튼이 다시 "Run" 으로 복귀(스피너/실행중 아님)
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" })).toBeTruthy());

    // 승인 CTA → task 의 goal_id 로 승인 화면을 여는 콜백 호출
    fireEvent.click(screen.getByRole("button", { name: "Open approval" }));
    expect(onOpenSpec).toHaveBeenCalledWith("goal-1");
  });

  it("does not show the block notice for a normal (non-409) run attempt", async () => {
    mocks.executeTask.mockResolvedValue({ status: "started", taskId: "task-1" });
    render(<TaskList tasks={[TODO_TASK]} agents={AGENTS} projectId="p1" onOpenSpec={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(mocks.executeTask).toHaveBeenCalledWith("task-1"));
    expect(screen.queryByText(/blueprint not approved/i)).toBeNull();
  });
});
