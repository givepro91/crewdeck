import type { Database } from "better-sqlite3";

/**
 * fix task의 "근본 원본 태스크" id를 찾는다. taskId가 fix task가 아니면 null.
 * issue→verification→task 체인을 non-fix 원본에 도달할 때까지 거슬러 올라간다(중첩 fix 대응).
 * engine.ts resolveRootTaskTitle과 같은 관계 그래프를 걷지만, 이쪽은 API 직렬화용으로
 * 제목이 아니라 root id를 돌려준다(대시보드가 fix를 원본 밑에 그룹핑하는 데 씀). 루프 가드 10.
 */
export function resolveRootOriginTaskId(db: Database, taskId: string): string | null {
  const isFixTask = db.prepare(
    "SELECT 1 AS x FROM verification_issue_tasks WHERE task_id = ? AND relation = 'fix' LIMIT 1",
  );
  if (!isFixTask.get(taskId)) return null;

  const parentOf = db.prepare(`
    SELECT v.task_id AS id
    FROM verification_issue_tasks vit
    JOIN verification_issues vi ON vi.id = vit.issue_id
    JOIN verifications v ON v.id = vi.verification_id
    WHERE vit.task_id = ? AND vit.relation = 'fix'
    ORDER BY (SELECT rowid FROM tasks WHERE id = v.task_id) ASC
    LIMIT 1
  `);

  let cur = taskId;
  let root: string | null = null;
  for (let i = 0; i < 10 && isFixTask.get(cur); i++) {
    const parent = parentOf.get(cur) as { id: string } | undefined;
    if (!parent || parent.id === cur) break;
    root = parent.id;
    cur = parent.id;
  }
  return root;
}
