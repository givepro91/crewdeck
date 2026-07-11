import type { Database } from "better-sqlite3";

// 실제 서버 broadcast는 인증된 client에게 보낸 수(number)를 보고한다.
// (구) void 시그니처 호출자는 전달 여부를 보고할 수 없으므로 미전달로 취급한다.
type Broadcast = (event: string, data: unknown) => number | void;

type PendingVerificationBroadcast = {
  id: string;
  event_type: string;
  payload: string;
};

/**
 * Deliver committed Quality Gate events with at-least-once semantics.
 *
 * The outbox row is inserted by evaluator.ts in the same transaction as the
 * verification and audit activity. A process exit or broadcast exception
 * therefore leaves the row pending for the next verification or server start.
 */
export function flushVerificationBroadcastOutbox(
  db: Database,
  broadcast: Broadcast,
): number {
  const pending = db.prepare(`
    SELECT id, event_type, payload
    FROM verification_broadcast_outbox
    WHERE delivered_at IS NULL
    ORDER BY created_at ASC, rowid ASC
  `).all() as PendingVerificationBroadcast[];

  let delivered = 0;
  for (const item of pending) {
    try {
      const recipients = broadcast(item.event_type, JSON.parse(item.payload));
      // 실제로 최소 1명에게 전달됐다고 보고된 경우에만 delivered로 확정한다.
      // 인증된 client가 없으면(dashboard 미연결) recipients는 0 또는 미보고(void)다 —
      // 이때 delivered로 확정하면 이후 연결에서 재전송되지 않아 이벤트가 유실된다.
      if (typeof recipients !== "number" || recipients <= 0) {
        db.prepare(`
          UPDATE verification_broadcast_outbox
          SET attempts = attempts + 1, last_error = ?
          WHERE id = ? AND delivered_at IS NULL
        `).run("broadcast reached no connected clients", item.id);
        break;
      }
      db.prepare(`
        UPDATE verification_broadcast_outbox
        SET delivered_at = datetime('now'), attempts = attempts + 1, last_error = NULL
        WHERE id = ? AND delivered_at IS NULL
      `).run(item.id);
      delivered++;
    } catch (err) {
      db.prepare(`
        UPDATE verification_broadcast_outbox
        SET attempts = attempts + 1, last_error = ?
        WHERE id = ? AND delivered_at IS NULL
      `).run(err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500), item.id);
      break;
    }
  }

  return delivered;
}
