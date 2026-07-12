import { create } from "zustand";
import type { SpecFields } from "../../../shared/types";
import { api, type GoalSpecState } from "../lib/api";

interface GoalSpecStore {
  byGoalId: Record<string, GoalSpecState | undefined>;
  loadingByGoalId: Record<string, boolean | undefined>;
  savingByGoalId: Record<string, boolean | undefined>;
  approvingByGoalId: Record<string, boolean | undefined>;
  errorByGoalId: Record<string, string | undefined>;
  setGoalSpec: (spec: GoalSpecState) => void;
  clearGoalSpec: (goalId: string) => void;
  fetchGoalSpec: (goalId: string) => Promise<GoalSpecState>;
  saveGoalSpec: (goalId: string, fields: SpecFields) => Promise<GoalSpecState>;
  approveGoalSpec: (goalId: string, versionId: string) => Promise<GoalSpecState>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function assertRequestedGoal(spec: GoalSpecState, goalId: string): void {
  if (spec.goal_id !== goalId) throw new Error("Blueprint response goal_id mismatch");
}

export const useGoalSpecStore = create<GoalSpecStore>((set, get) => ({
  byGoalId: {},
  loadingByGoalId: {},
  savingByGoalId: {},
  approvingByGoalId: {},
  errorByGoalId: {},

  setGoalSpec: (spec) => set((state) => ({
    byGoalId: { ...state.byGoalId, [spec.goal_id]: spec },
    errorByGoalId: { ...state.errorByGoalId, [spec.goal_id]: undefined },
  })),

  clearGoalSpec: (goalId) => set((state) => {
    const byGoalId = { ...state.byGoalId };
    const loadingByGoalId = { ...state.loadingByGoalId };
    const savingByGoalId = { ...state.savingByGoalId };
    const approvingByGoalId = { ...state.approvingByGoalId };
    const errorByGoalId = { ...state.errorByGoalId };
    delete byGoalId[goalId];
    delete loadingByGoalId[goalId];
    delete savingByGoalId[goalId];
    delete approvingByGoalId[goalId];
    delete errorByGoalId[goalId];
    return { byGoalId, loadingByGoalId, savingByGoalId, approvingByGoalId, errorByGoalId };
  }),

  fetchGoalSpec: async (goalId) => {
    set((state) => ({
      loadingByGoalId: { ...state.loadingByGoalId, [goalId]: true },
      errorByGoalId: { ...state.errorByGoalId, [goalId]: undefined },
    }));
    try {
      const spec = await api.goals.getSpec(goalId);
      assertRequestedGoal(spec, goalId);
      get().setGoalSpec(spec);
      return spec;
    } catch (error) {
      set((state) => ({ errorByGoalId: { ...state.errorByGoalId, [goalId]: errorMessage(error) } }));
      throw error;
    } finally {
      set((state) => ({ loadingByGoalId: { ...state.loadingByGoalId, [goalId]: false } }));
    }
  },

  saveGoalSpec: async (goalId, fields) => {
    set((state) => ({
      savingByGoalId: { ...state.savingByGoalId, [goalId]: true },
      errorByGoalId: { ...state.errorByGoalId, [goalId]: undefined },
    }));
    try {
      const spec = await api.goals.saveSpec(goalId, fields);
      assertRequestedGoal(spec, goalId);
      get().setGoalSpec(spec);
      return spec;
    } catch (error) {
      set((state) => ({ errorByGoalId: { ...state.errorByGoalId, [goalId]: errorMessage(error) } }));
      throw error;
    } finally {
      set((state) => ({ savingByGoalId: { ...state.savingByGoalId, [goalId]: false } }));
    }
  },

  approveGoalSpec: async (goalId, versionId) => {
    set((state) => ({
      approvingByGoalId: { ...state.approvingByGoalId, [goalId]: true },
      errorByGoalId: { ...state.errorByGoalId, [goalId]: undefined },
    }));
    try {
      const spec = await api.goals.approveSpec(goalId, versionId);
      assertRequestedGoal(spec, goalId);
      get().setGoalSpec(spec);
      return spec;
    } catch (error) {
      set((state) => ({ errorByGoalId: { ...state.errorByGoalId, [goalId]: errorMessage(error) } }));
      throw error;
    } finally {
      set((state) => ({ approvingByGoalId: { ...state.approvingByGoalId, [goalId]: false } }));
    }
  },
}));
