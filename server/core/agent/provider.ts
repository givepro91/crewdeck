/**
 * 에이전트 실행 백엔드(provider) 해석 + 전역 설정 로드.
 *
 * 해석 순서(시작 백엔드): agent.provider → project.default_provider → 전역 기본(config.defaultProvider ?? "claude").
 * failover는 이 해석과 독립(직교) — config.codexFailover 전역 토글이 관장한다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentProvider } from "./adapters/backend.js";

const VALID: AgentProvider[] = ["claude", "codex"];

export type ProviderResolutionSource = "agent" | "project" | "global";

export interface ProviderResolution {
  provider: AgentProvider;
  source: ProviderResolutionSource;
}

function coerce(v: unknown, fallback: AgentProvider): AgentProvider {
  return VALID.includes(v as AgentProvider) ? (v as AgentProvider) : fallback;
}

function isValidProvider(v: unknown): v is AgentProvider {
  return VALID.includes(v as AgentProvider);
}

export function resolveProviderTrace(
  agent: { provider?: string | null },
  project: { default_provider?: string | null },
  config: { defaultProvider?: string },
): ProviderResolution {
  const globalDefault = coerce(config.defaultProvider, "claude");
  if (agent?.provider) {
    return isValidProvider(agent.provider)
      ? { provider: agent.provider, source: "agent" }
      : { provider: globalDefault, source: "global" };
  }
  if (project?.default_provider) {
    return isValidProvider(project.default_provider)
      ? { provider: project.default_provider, source: "project" }
      : { provider: globalDefault, source: "global" };
  }
  return { provider: globalDefault, source: "global" };
}

export function resolveProvider(
  agent: { provider?: string | null },
  project: { default_provider?: string | null },
  config: { defaultProvider?: string },
): AgentProvider {
  return resolveProviderTrace(agent, project, config).provider;
}

export interface ProviderConfig {
  defaultProvider: AgentProvider;
  codexFailover: boolean;
  codexModelMap: Record<string, string>;
}

/** ~/.crewdeck/config.json에서 provider 관련 설정을 로드 (미설정 시 하위호환 기본값). */
export function loadProviderConfig(): ProviderConfig {
  let raw: any = {};
  try {
    const p = join(homedir(), ".crewdeck", "config.json");
    if (existsSync(p)) raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    // 기본값 사용
  }
  return {
    defaultProvider: coerce(raw.defaultProvider, "claude"),
    codexFailover: raw.codexFailover !== false, // 기본 true
    codexModelMap: (raw.codexModelMap ?? {}) as Record<string, string>,
  };
}
