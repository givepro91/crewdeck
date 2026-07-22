import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDatabase, migrate } from "../db/schema.js";

const spawnCalls = vi.hoisted(() => [] as Array<{ workdir: string; resumeSessionId: string | null }>);

vi.mock("../core/agent/adapters/backend.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBackend: () => ({
      spawn: (config: { workdir: string; resumeSessionId?: string | null }) => {
        spawnCalls.push({ workdir: config.workdir, resumeSessionId: config.resumeSessionId ?? null });
        return Object.assign(new EventEmitter(), {
          id: "runtime-session",
          status: "idle",
          process: null,
          lastSessionId: null,
          send: vi.fn(),
          kill: vi.fn(),
          cleanup: vi.fn(),
        });
      },
    }),
  };
});

import { createSessionManager } from "../core/agent/session.js";
import { resolveChatSession } from "../core/agent/chat-session.js";

const ROOT = "/tmp/crewdeck-resume-root";
const WORKTREE = "/tmp/crewdeck-resume-root/.crewdeck-worktrees/goal-abc";

function insertCompletedSession(
  db: Database.Database,
  runtimeSessionId: string,
  workdir: string | null,
  endedAt: string,
) {
  db.prepare(`
    INSERT INTO sessions (agent_id, status, provider, runtime_session_id, workdir, ended_at)
    VALUES ('a1', 'completed', 'claude', ?, ?, ?)
  `).run(runtimeSessionId, workdir, endedAt);
}

/** 채팅처럼 과거 대화 재개를 opt-in 한 경로 */
const RESUME_OPT_IN = { resumeFromHistory: true } as const;

describe("과거 대화 재개는 opt-in 이고, 후보는 같은 workdir 로 제한된다", () => {
  let db: Database.Database;

  beforeEach(() => {
    spawnCalls.length = 0;
    db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'test', 'new', ?)").run(ROOT);
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'agent', 'backend')").run();
  });

  it("단발 호출(opt-in 없음)은 재개 가능한 대화가 있어도 fresh 로 시작한다", () => {
    insertCompletedSession(db, "conv-root", ROOT, "2026-07-14 12:00:00");

    createSessionManager(db).spawnAgent("a1", ROOT, "suggest-1");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].resumeSessionId).toBeNull();
  });

  it("worktree 에서 돈 대화 id 를 프로젝트 루트 spawn 에 넘기지 않는다", () => {
    // worktree 세션이 더 최근 — workdir 필터가 없으면 이게 뽑혀 CLI 가 즉사한다(실측 회귀).
    insertCompletedSession(db, "conv-root", ROOT, "2026-07-14 12:00:00");
    insertCompletedSession(db, "conv-worktree", WORKTREE, "2026-07-14 13:00:00");

    createSessionManager(db).spawnAgent("a1", ROOT, "chat-a1", null, undefined, RESUME_OPT_IN);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].resumeSessionId).toBe("conv-root");
  });

  it("worktree 에서 다시 spawn 하면 그 worktree 의 대화를 재개한다", () => {
    insertCompletedSession(db, "conv-root", ROOT, "2026-07-14 13:00:00");
    insertCompletedSession(db, "conv-worktree", WORKTREE, "2026-07-14 12:00:00");

    createSessionManager(db).spawnAgent("a1", WORKTREE, "chat-a1", null, undefined, RESUME_OPT_IN);

    expect(spawnCalls[0].resumeSessionId).toBe("conv-worktree");
  });

  it("workdir 이 NULL 인 legacy 행은 후보에서 제외한다", () => {
    insertCompletedSession(db, "conv-legacy", null, "2026-07-14 13:00:00");

    createSessionManager(db).spawnAgent("a1", ROOT, "chat-a1", null, undefined, RESUME_OPT_IN);

    expect(spawnCalls[0].resumeSessionId).toBeNull();
  });

  it("forceNewSession 은 opt-in 을 무시하고 fresh 로 간다", () => {
    insertCompletedSession(db, "conv-root", ROOT, "2026-07-14 12:00:00");

    createSessionManager(db).spawnAgent("a1", ROOT, "gen-1", null, undefined, {
      ...RESUME_OPT_IN,
      forceNewSession: true,
    });

    expect(spawnCalls[0].resumeSessionId).toBeNull();
  });

  it("새 세션의 workdir 을 어댑터 cwd 와 같은 정규화로 기록한다", () => {
    createSessionManager(db).spawnAgent("a1", `${ROOT}/sub/..`, "suggest-3");

    const row = db.prepare(
      "SELECT workdir FROM sessions WHERE session_key = 'suggest-3'",
    ).get() as { workdir: string };
    expect(row.workdir).toBe(ROOT);
    expect(spawnCalls[0].workdir).toBe(`${ROOT}/sub/..`);
  });
});

describe("채팅 경로는 재개를 opt-in 한다", () => {
  it("resolveChatSession 의 새 spawn 은 resumeFromHistory 를 넘긴다", () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const deps = {
      getSession: () => undefined,
      spawnAgent: (
        _agentId: string,
        _workdir: string,
        _key: string,
        _taskId?: string | null,
        _ctx?: unknown,
        promptOptions?: Record<string, unknown>,
      ) => {
        calls.push(promptOptions);
        return { status: "idle" };
      },
    };

    resolveChatSession(deps, "a1", ROOT);
    resolveChatSession(deps, "a1", ROOT, null, "ws1");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ resumeFromHistory: true });
    expect(calls[1]).toMatchObject({ resumeFromHistory: true });
  });
});

describe("workdir 컬럼 마이그레이션", () => {
  it("컬럼이 없는 기존 sessions 테이블에 workdir 을 추가하고 기존 행은 NULL 로 둔다", () => {
    // 컬럼 도입 직전의 실제 DB 형태를 재현한다 — 완성 스키마에서 workdir 만 되돌린다.
    const db = createDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO projects (id, name, source, workdir) VALUES ('p1', 'test', 'new', ?)").run(ROOT);
    db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'agent', 'backend')").run();
    db.prepare("INSERT INTO sessions (agent_id, status) VALUES ('a1', 'completed')").run();
    db.exec("ALTER TABLE sessions DROP COLUMN workdir");
    expect(
      (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name),
    ).not.toContain("workdir");

    migrate(db);

    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("workdir");
    const row = db.prepare("SELECT workdir FROM sessions").get() as { workdir: string | null };
    expect(row.workdir).toBeNull();
  });
});
