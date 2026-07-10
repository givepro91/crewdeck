import { create } from "zustand";
import { api } from "../lib/api";
import type {
  ActivityLogEntry,
  AgentProvider,
  ProviderActivityDetails,
  ProviderActivityEvent,
  ProviderActivityPayload,
  ProviderFailoverReasonCode,
  ProviderResolutionSource,
} from "../types";

interface ActivityStore {
  activities: ActivityLogEntry[];
  loading: boolean;
  activeProjectId: string | null;
  setActivities: (activities: unknown[]) => void;
  loadActivities: (projectId: string) => Promise<void>;
  prependActivity: (activity: unknown) => void;
  ingestWsEvent: (eventType: string, payload: unknown) => void;
  clear: () => void;
}

let localActivityId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "true";
}

function asProvider(value: unknown): AgentProvider | null {
  return value === "claude" || value === "codex" ? value : null;
}

function asResolutionSource(value: unknown): ProviderResolutionSource | null {
  return value === "agent" || value === "project" || value === "global" ? value : null;
}

function asFailoverReason(value: unknown): ProviderFailoverReasonCode | null {
  return value === "rate_limit" || value === "session_exhausted" || value === "env_error" ? value : null;
}

function asProviderEvent(value: unknown): ProviderActivityEvent | null {
  return value === "provider:resolved" || value === "provider:failover" || value === "provider:redispatched"
    ? value
    : null;
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function providerName(provider: AgentProvider | null | undefined): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  return "알 수 없음";
}

function reasonLabel(reasonCode: ProviderFailoverReasonCode | null | undefined): string {
  switch (reasonCode) {
    case "rate_limit":
      return "사용량 한도";
    case "session_exhausted":
      return "세션 소진";
    case "env_error":
      return "실행 환경 오류";
    default:
      return "전환 사유";
  }
}

function providerEventFromActivity(type: string, metadata: Record<string, unknown> | null): ProviderActivityEvent | null {
  const metadataEvent = asProviderEvent(metadata?.event);
  if (metadataEvent) return metadataEvent;

  switch (type) {
    case "provider_resolved":
      return "provider:resolved";
    case "provider_failover":
    case "provider_failover_decision":
      return "provider:failover";
    case "provider_redispatched":
    case "provider_redispatch_result":
      return "provider:redispatched";
    default:
      return null;
  }
}

function normalizeProviderPayload(value: Record<string, unknown>): ProviderActivityPayload {
  const event = asProviderEvent(value.event);
  return {
    ...(event ? { event } : {}),
    projectId: asString(value.projectId),
    taskId: asString(value.taskId),
    agentId: asNullableString(value.agentId),
    taskTitle: asString(value.taskTitle),
    sessionId: asNullableString(value.sessionId),
    resolvedProvider: asProvider(value.resolvedProvider),
    resolutionSource: asResolutionSource(value.resolutionSource),
    failoverOverride: asBoolean(value.failoverOverride),
    reasonCode: asFailoverReason(value.reasonCode),
    userMessage: asNullableString(value.userMessage),
    fromProvider: asProvider(value.fromProvider),
    toProvider: asProvider(value.toProvider),
    redispatched: asBoolean(value.redispatched),
    loopGuardBlocked: asBoolean(value.loopGuardBlocked),
    originalSessionId: asNullableString(value.originalSessionId),
    redispatchedSessionId: asNullableString(value.redispatchedSessionId),
  };
}

function transitionText(payload: ProviderActivityPayload): string | null {
  if (!payload.fromProvider && !payload.toProvider) return null;
  return `${providerName(payload.fromProvider)} → ${providerName(payload.toProvider)}`;
}

function appendUnique(segments: string[], value: string | null | undefined): void {
  const trimmed = value?.trim();
  if (!trimmed || segments.includes(trimmed)) return;
  segments.push(trimmed);
}

function providerEventMessage(
  eventType: ProviderActivityEvent,
  payload: ProviderActivityPayload,
  fallbackMessage = "",
): string {
  if (eventType === "provider:resolved") {
    if (payload.userMessage) return payload.userMessage;
    const provider = providerName(payload.resolvedProvider);
    return payload.failoverOverride
      ? `실행 엔진 선택: ${provider} (자동 전환)`
      : `실행 엔진 선택: ${provider}`;
  }

  if (eventType === "provider:redispatched") {
    const segments = ["재실행 시작"];
    appendUnique(segments, transitionText(payload));
    if (payload.reasonCode) {
      appendUnique(segments, `${reasonLabel(payload.reasonCode)} (reasonCode=${payload.reasonCode})`);
    }
    appendUnique(segments, payload.userMessage ?? fallbackMessage);
    return segments.join(" · ");
  }

  const reasonCode = payload.reasonCode ?? null;
  const segments = ["실행 엔진 자동 전환"];
  appendUnique(segments, transitionText(payload));
  appendUnique(segments, `${reasonLabel(reasonCode)} (reasonCode=${reasonCode ?? "unknown"})`);
  appendUnique(segments, payload.userMessage ?? fallbackMessage);
  appendUnique(
    segments,
    payload.loopGuardBlocked
      ? "추가 전환 차단 (왕복 방지)"
      : payload.redispatched
        ? "대체 실행 엔진으로 다시 실행합니다"
        : "쿨다운 후 자동 재시도합니다",
  );
  return segments.join(" · ");
}

function providerPayloadFromActivity(activity: ActivityLogEntry): {
  event: ProviderActivityEvent;
  payload: ProviderActivityPayload;
} | null {
  const event = providerEventFromActivity(activity.type, activity.metadata);
  if (!event || !activity.metadata) return null;
  return { event, payload: normalizeProviderPayload(activity.metadata) };
}

export function getProviderActivityDetails(activity: ActivityLogEntry): ProviderActivityDetails | null {
  const providerActivity = providerPayloadFromActivity(activity);
  if (!providerActivity) return null;
  const { event, payload } = providerActivity;
  return {
    event,
    reasonCode: payload.reasonCode ?? null,
    userMessage: payload.userMessage ?? null,
    fromProvider: payload.fromProvider ?? null,
    toProvider: payload.toProvider ?? null,
    resolvedProvider: payload.resolvedProvider ?? null,
    redispatched: payload.redispatched === true,
    loopGuardBlocked: payload.loopGuardBlocked === true,
  };
}

function normalizeActivity(value: unknown): ActivityLogEntry | null {
  if (!isRecord(value)) return null;
  const projectId = asString(value.projectId, asString(value.project_id));
  const agentId = asNullableString(value.agentId) ?? asNullableString(value.agent_id);
  const createdAt = asString(value.createdAt, asString(value.created_at, new Date().toISOString()));
  const idValue = typeof value.id === "number" ? value.id : Number(value.id);
  const id = Number.isFinite(idValue) ? idValue : --localActivityId;
  const metadata = parseMetadata(value.metadata);

  const activity: ActivityLogEntry = {
    id,
    project_id: projectId,
    projectId,
    agent_id: agentId,
    agentId,
    type: asString(value.type, "activity"),
    message: asString(value.message, ""),
    metadata,
    created_at: createdAt,
    createdAt,
  };

  const providerActivity = providerPayloadFromActivity(activity);
  if (providerActivity) {
    activity.message = providerEventMessage(providerActivity.event, providerActivity.payload, activity.message);
  }
  return activity;
}

function activityFromWsEvent(eventType: string, payload: unknown): ActivityLogEntry | null {
  if (eventType === "activity:created") {
    const normalized = normalizeActivity(payload);
    // provider_* 활동은 typed provider:* 이벤트로도 broadcast되므로(서버가 recordActivity
    // 직후 provider:*를 쏨) 중복을 피한다 — provider 항목은 더 풍부한 메시지를 만드는
    // provider:* 경로가 소유한다. 그 외 recordActivity 활동은 이 경로로 반영.
    if (normalized && normalized.type.startsWith("provider_")) return null;
    return normalized;
  }
  if (!isRecord(payload)) return null;

  if (!eventType.startsWith("provider:")) return null;
  const providerEvent = asProviderEvent(eventType);
  if (!providerEvent) return null;
  const providerPayload = normalizeProviderPayload(payload);
  const projectId = asString(providerPayload.projectId);
  return normalizeActivity({
    id: --localActivityId,
    projectId,
    project_id: projectId,
    agentId: providerPayload.agentId ?? null,
    agent_id: providerPayload.agentId ?? null,
    type: eventType.replace(":", "_"),
    message: providerEventMessage(providerEvent, providerPayload),
    metadata: { event: eventType, ...payload },
    createdAt: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  activities: [],
  loading: false,
  activeProjectId: null,
  setActivities: (activities) => {
    set({ activities: activities.map(normalizeActivity).filter((a): a is ActivityLogEntry => a !== null) });
  },
  loadActivities: async (projectId) => {
    set({ activeProjectId: projectId, loading: true });
    try {
      const activities = await api.activities.list(projectId);
      if (get().activeProjectId !== projectId) return;
      get().setActivities(activities);
    } catch {
      if (get().activeProjectId === projectId) set({ activities: [] });
    } finally {
      if (get().activeProjectId === projectId) set({ loading: false });
    }
  },
  prependActivity: (activity) => {
    const normalized = normalizeActivity(activity);
    if (!normalized) return;
    const activeProjectId = get().activeProjectId;
    if (activeProjectId && normalized.projectId && normalized.projectId !== activeProjectId) return;
    set((state) => ({
      activities: [normalized, ...state.activities.filter((a) => a.id !== normalized.id)].slice(0, 50),
    }));
  },
  ingestWsEvent: (eventType, payload) => {
    const activity = activityFromWsEvent(eventType, payload);
    if (activity) get().prependActivity(activity);
  },
  clear: () => set({ activities: [], activeProjectId: null }),
}));
