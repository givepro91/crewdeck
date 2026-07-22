import type { ExecutionSessionContext, SessionOwnership, SessionPromptOptions } from "./session.js";

/**
 * 채팅 세션 keep-alive 해석. 오케스트레이션 경로와 달리 턴마다 killSession 하지
 * 않고 chat-{agentId} 키로 세션을 유지해, session.send()가 --resume으로 이어지게 한다.
 */
export interface ChatSessionLike { status: string }
export interface ChatSessionDeps {
  getSession(key: string): ChatSessionLike | undefined;
  spawnAgent(
    agentId: string,
    workdir: string,
    sessionKey: string,
    taskId?: string | null,
    executionContext?: ExecutionSessionContext,
    promptOptions?: SessionPromptOptions,
    ownership?: SessionOwnership,
  ): ChatSessionLike;
}

/** 채팅 세션 키(단일 소스). */
export function chatSessionKey(agentId: string, workspaceId?: string | null): string {
  return workspaceId ? `workspace-${workspaceId}-chat-${agentId}` : `chat-${agentId}`;
}

/**
 * 채팅 세션을 확보한다.
 * - 없으면 spawn (reused=false)
 * - idle이면 재사용 (reused=true → 호출부가 send()로 resume)
 * - working이면 { busy: true } (Phase 1은 큐 없음)
 */
export function resolveChatSession(
  deps: ChatSessionDeps,
  agentId: string,
  workdir: string,
  taskId?: string | null,
  workspaceId?: string | null,
): { session: ChatSessionLike; reused: boolean } | { busy: true } {
  const key = chatSessionKey(agentId, workspaceId);
  const existing = deps.getSession(key);
  if (existing) {
    if (existing.status === "working") return { busy: true };
    return { session: existing, reused: true };
  }
  // 새 spawn 시에만 taskId를 전달 → session.ts가 소환 컨텍스트를 시스템 프롬프트에 주입.
  // resumeFromHistory: 채팅은 연속성이 곧 기능이라 과거 대화 재개를 opt-in 한다(단발
  // 오케스트레이션 호출은 기본 fresh). keep-alive 가 살아 있는 동안은 위에서 재사용되므로,
  // 이 플래그가 실제로 쓰이는 건 세션이 끊긴 뒤(서버 재시작 등) 첫 턴이다.
  const session = workspaceId
    ? deps.spawnAgent(
        agentId,
        workdir,
        key,
        taskId,
        undefined,
        { resumeFromHistory: true },
        { workspaceId, origin: "terminal" },
      )
    : deps.spawnAgent(agentId, workdir, key, taskId, undefined, { resumeFromHistory: true });
  return { session, reused: false };
}
