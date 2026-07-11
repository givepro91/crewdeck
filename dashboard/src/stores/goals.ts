import { create } from "zustand";
import {
  api,
  type GoalActivityEvent,
  type GoalStatus,
  type GoalStatusResponse,
  type VerificationTimelineResponse,
} from "../lib/api";

export type { GoalActivityEvent, GoalStatus, GoalStatusResponse, VerificationTimelineResponse };

interface GoalStatusStore {
  byGoalId: Record<string, GoalStatusResponse | undefined>;
  loadingByGoalId: Record<string, boolean | undefined>;
  approvingByGoalId: Record<string, boolean | undefined>;
  errorByGoalId: Record<string, string | undefined>;
  timelineByGoalId: Record<string, VerificationTimelineResponse | undefined>;
  timelineLoadingByGoalId: Record<string, boolean | undefined>;
  timelineErrorByGoalId: Record<string, string | undefined>;
  setGoalStatus: (status: GoalStatusResponse) => void;
  clearGoalStatus: (goalId: string) => void;
  fetchGoalStatus: (goalId: string) => Promise<GoalStatusResponse>;
  fetchVerificationTimeline: (goalId: string) => Promise<VerificationTimelineResponse>;
  approveGoal: (goalId: string) => Promise<GoalStatusResponse>;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Request failed";
}

export const useGoalStatusStore = create<GoalStatusStore>((set, get) => ({
  byGoalId: {},
  loadingByGoalId: {},
  approvingByGoalId: {},
  errorByGoalId: {},
  timelineByGoalId: {},
  timelineLoadingByGoalId: {},
  timelineErrorByGoalId: {},

  setGoalStatus: (status) =>
    set((state) => ({
      byGoalId: { ...state.byGoalId, [status.goal_id]: status },
      errorByGoalId: { ...state.errorByGoalId, [status.goal_id]: undefined },
    })),

  clearGoalStatus: (goalId) =>
    set((state) => {
      const byGoalId = { ...state.byGoalId };
      const loadingByGoalId = { ...state.loadingByGoalId };
      const approvingByGoalId = { ...state.approvingByGoalId };
      const errorByGoalId = { ...state.errorByGoalId };
      const timelineByGoalId = { ...state.timelineByGoalId };
      const timelineLoadingByGoalId = { ...state.timelineLoadingByGoalId };
      const timelineErrorByGoalId = { ...state.timelineErrorByGoalId };
      delete byGoalId[goalId];
      delete loadingByGoalId[goalId];
      delete approvingByGoalId[goalId];
      delete errorByGoalId[goalId];
      delete timelineByGoalId[goalId];
      delete timelineLoadingByGoalId[goalId];
      delete timelineErrorByGoalId[goalId];
      return {
        byGoalId,
        loadingByGoalId,
        approvingByGoalId,
        errorByGoalId,
        timelineByGoalId,
        timelineLoadingByGoalId,
        timelineErrorByGoalId,
      };
    }),

  fetchGoalStatus: async (goalId) => {
    set((state) => ({
      loadingByGoalId: { ...state.loadingByGoalId, [goalId]: true },
      errorByGoalId: { ...state.errorByGoalId, [goalId]: undefined },
    }));
    try {
      const status = await api.goals.getStatus(goalId);
      get().setGoalStatus(status);
      return status;
    } catch (error) {
      const message = getErrorMessage(error);
      set((state) => ({
        errorByGoalId: { ...state.errorByGoalId, [goalId]: message },
      }));
      throw error;
    } finally {
      set((state) => ({
        loadingByGoalId: { ...state.loadingByGoalId, [goalId]: false },
      }));
    }
  },

  fetchVerificationTimeline: async (goalId) => {
    set((state) => ({
      timelineLoadingByGoalId: { ...state.timelineLoadingByGoalId, [goalId]: true },
      timelineErrorByGoalId: { ...state.timelineErrorByGoalId, [goalId]: undefined },
    }));
    try {
      const timeline = await api.goals.getVerificationTimeline(goalId);
      set((state) => ({
        timelineByGoalId: { ...state.timelineByGoalId, [goalId]: timeline },
      }));
      return timeline;
    } catch (error) {
      const message = getErrorMessage(error);
      set((state) => ({
        timelineErrorByGoalId: { ...state.timelineErrorByGoalId, [goalId]: message },
      }));
      throw error;
    } finally {
      set((state) => ({
        timelineLoadingByGoalId: { ...state.timelineLoadingByGoalId, [goalId]: false },
      }));
    }
  },

  approveGoal: async (goalId) => {
    set((state) => ({
      approvingByGoalId: { ...state.approvingByGoalId, [goalId]: true },
      errorByGoalId: { ...state.errorByGoalId, [goalId]: undefined },
    }));
    try {
      const result = await api.goals.squashApprove(goalId);
      if (result.error) throw new Error(result.error);
      return await get().fetchGoalStatus(goalId);
    } catch (error) {
      const message = getErrorMessage(error);
      set((state) => ({
        errorByGoalId: { ...state.errorByGoalId, [goalId]: message },
      }));
      throw error;
    } finally {
      set((state) => ({
        approvingByGoalId: { ...state.approvingByGoalId, [goalId]: false },
      }));
    }
  },
}));
