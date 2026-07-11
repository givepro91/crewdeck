import { describe, it, expect } from "vitest";
import { createDatabase, migrate } from "../db/schema.js";
import { flushVerificationBroadcastOutbox } from "../core/quality-gate/outbox.js";
import type Database from "better-sqlite3";

/**
 * 실제 수신자 없이도 outbox가 delivered로 확정해버리던 버그의 회귀 테스트.
 * server/index.ts의 실제 broadcast는 인증된 client가 없으면 아무 작업 없이
 * 반환하므로(과거 시그니처는 void), 이를 "성공"으로 오인하면 dashboard 미연결
 * 상태에서 발생한 판정 이벤트가 영구히 재전송되지 않는다.
 */

function createTestDb(): Database.Database {
  const db = createDatabase(":memory:");
  migrate(db);
  return db;
}

function seedPendingVerification(db: Database.Database): string {
  db.prepare("INSERT INTO projects (id, name, source) VALUES ('p1', 'test', 'new')").run();
  db.prepare("INSERT INTO goals (id, project_id, description) VALUES ('g1', 'p1', 'goal')").run();
  db.prepare("INSERT INTO agents (id, project_id, name, role) VALUES ('a1', 'p1', 'dev', 'coder')").run();
  db.prepare(
    "INSERT INTO tasks (id, goal_id, project_id, title, status, assignee_id) VALUES ('t1', 'g1', 'p1', 'task', 'in_review', 'a1')",
  ).run();
  db.prepare("INSERT INTO verifications (id, task_id, verdict) VALUES ('v1', 't1', 'pass')").run();
  db.prepare(`
    INSERT INTO verification_broadcast_outbox (verification_id, event_type, payload)
    VALUES ('v1', 'verification:result', ?)
  `).run(JSON.stringify({ id: "v1", taskId: "t1", verdict: "pass" }));
  return "v1";
}

describe("검증 결과 broadcast outbox — 실제 전달 확인", () => {
  it("broadcast가 수신자 수를 보고하지 않으면(과거 void 시그니처) delivered로 확정하지 않는다", () => {
    const db = createTestDb();
    const verificationId = seedPendingVerification(db);

    const delivered = flushVerificationBroadcastOutbox(db, () => {});

    expect(delivered).toBe(0);
    const row = db.prepare(
      "SELECT delivered_at, attempts, last_error FROM verification_broadcast_outbox WHERE verification_id = ?",
    ).get(verificationId) as { delivered_at: string | null; attempts: number; last_error: string | null };
    expect(row.delivered_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBeTruthy();
  });

  it("broadcast가 0명 수신을 명시적으로 보고해도 delivered로 확정하지 않는다", () => {
    const db = createTestDb();
    const verificationId = seedPendingVerification(db);

    const delivered = flushVerificationBroadcastOutbox(db, () => 0);

    expect(delivered).toBe(0);
    const row = db.prepare(
      "SELECT delivered_at, attempts FROM verification_broadcast_outbox WHERE verification_id = ?",
    ).get(verificationId) as { delivered_at: string | null; attempts: number };
    expect(row.delivered_at).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it("broadcast가 1명 이상 수신을 보고하면 delivered로 확정한다", () => {
    const db = createTestDb();
    const verificationId = seedPendingVerification(db);

    const delivered = flushVerificationBroadcastOutbox(db, () => 1);

    expect(delivered).toBe(1);
    const row = db.prepare(
      "SELECT delivered_at, attempts, last_error FROM verification_broadcast_outbox WHERE verification_id = ?",
    ).get(verificationId) as { delivered_at: string | null; attempts: number; last_error: string | null };
    expect(row.delivered_at).not.toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBeNull();
  });
});
