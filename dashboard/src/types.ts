export type AgentProvider = "claude" | "codex";
export type ProviderResolutionSource = "agent" | "project" | "global";
export type ProviderFailoverReasonCode = "rate_limit" | "session_exhausted" | "env_error";
export type ProviderActivityEvent = "provider:resolved" | "provider:failover" | "provider:redispatched";

export interface ActivityLogEntry {
  id: number;
  project_id: string;
  projectId: string;
  agent_id: string | null;
  agentId: string | null;
  type: string;
  message: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  createdAt: string;
}

export interface ProviderActivityPayload {
  event?: ProviderActivityEvent;
  projectId?: string;
  taskId?: string;
  agentId?: string | null;
  taskTitle?: string;
  sessionId?: string | null;
  resolvedProvider?: AgentProvider | null;
  resolutionSource?: ProviderResolutionSource | null;
  failoverOverride?: boolean;
  reasonCode?: ProviderFailoverReasonCode | null;
  userMessage?: string | null;
  fromProvider?: AgentProvider | null;
  toProvider?: AgentProvider | null;
  redispatched?: boolean;
  loopGuardBlocked?: boolean;
  originalSessionId?: string | null;
  redispatchedSessionId?: string | null;
}

export interface ProviderActivityDetails {
  event: ProviderActivityEvent;
  reasonCode: ProviderFailoverReasonCode | null;
  userMessage: string | null;
  fromProvider: AgentProvider | null;
  toProvider: AgentProvider | null;
  resolvedProvider: AgentProvider | null;
  redispatched: boolean;
  loopGuardBlocked: boolean;
}
