import type { AgentProvider, ProviderFailoverReasonCode } from "../types";

export const REASON_LABEL_KEYS: Record<ProviderFailoverReasonCode, string> = {
  rate_limit: "failoverReasonRateLimit",
  session_exhausted: "failoverReasonSessionExhausted",
  env_error: "failoverReasonEnvError",
};

export function providerEngineName(provider: AgentProvider | null): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  return "—";
}
