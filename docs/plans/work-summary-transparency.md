# 작업 요약 투명성 구현 계획 (Before/After 서사 + 스크린샷)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (권장) 또는 superpowers:executing-plans로 task 단위 구현. 스텝은 `- [ ]` 체크박스.

**Goal:** goal 완료(squash 승인 게이트)에 "작업 전 → 한 일 → 결과" 서사 요약을 붙이고, 작업 중 이미 생성된 스크린샷이 있으면 곁들여, 사람이 5초에 맡길지 판단하게 한다.

**Architecture:** squash 상태머신(`triggerGoalSquash`)은 **append-only**로만 건드린다. 스크린샷 스캔(빠름·fs-only)은 인라인으로 `goal:squash_ready`에 실어 즉시 표시하고, LLM 서사 요약(느림)은 **fire-and-forget 비동기**로 돌려 완료 시 `goal:work_report` 후속 이벤트로 채운다. 큐를 막지 않고 게이트도 블로킹하지 않는다.

**Tech Stack:** TypeScript, Express 5, better-sqlite3, Claude Code CLI subprocess(요약 LLM = `sessionManager.spawnAgent`→`session.send`→`parseStreamJson`, evaluator.ts 패턴 재사용), React + Zustand + i18next, vitest.

## Global Constraints

- Node >= 20. `better-sqlite3` 네이티브 — 재빌드 금지 사유 없음.
- **typecheck PASS 없이 커밋 금지** — 서버 `npm run typecheck`, 대시보드 `cd dashboard && npx tsc -b`. pre-commit hook이 강제.
- `window.confirm/alert/prompt` 금지 (eslint error). 다이얼로그는 기존 컴포넌트 패턴.
- **UX 용어**: 사용자 노출 문자열은 비개발자 친화 한국어 (`.claude/rules/ux-terminology.md`). "커밋/머지/브랜치" 등 직접 노출 지양.
- **DB i18n 규칙**: 고정 라벨 = 프론트 i18n 키, 생성된 서사 본문 = 콘텐츠 데이터(생성 언어=한국어)로 저장. (`feedback_i18n_db`)
- **DB 직접 수정 금지** — 이 기능은 서버 내부(engine/route)에서 broadcast와 함께 쓰므로 OK. 외부 도구로 DB 만지지 말 것.
- 브랜치: `feat/work-summary-transparency` (main 직접 금지). 로컬 커밋만, **push·main 머지는 사용자 명시 요청 시에만.**
- 데이터 디렉토리는 `dirname(db.name)`로 얻는다 (env fallback은 launchd에서 어긋남).

## 공유 타입/인터페이스 (모든 task 공통)

`server/core/orchestration/work-report.ts`가 정의·export (Task 2에서 생성):

```ts
export interface ScreenshotRef { file: string; label: string; taskId?: string | null; }
export interface WorkReport {
  before: string | null;
  changed: string | null;
  after: string | null;
  notes: string | null;
  summaryStatus: "pending" | "ready" | "failed";
  screenshots: ScreenshotRef[];
}
```

WS/대시보드는 이 `WorkReport`를 JSON으로 주고받는다. 프론트는 `dashboard/src/lib/api.ts` 근처에 동일 형태 타입을 둔다(서버 타입 직접 import 안 함 — 별 패키지).

---

## Task 1: DB 마이그레이션 — `goals.work_report` 컬럼

**Files:**
- Modify: `server/db/schema.ts` (goalColsLate 블록, 약 :405-433)
- Test: `server/__tests__/work-report-schema.test.ts`

**Interfaces:**
- Produces: `goals.work_report TEXT`(nullable) 컬럼.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// server/__tests__/work-report-schema.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";

describe("goals.work_report migration", () => {
  it("adds work_report column and is idempotent", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // 두 번 호출해도 안전
    const cols = db.prepare("PRAGMA table_info(goals)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "work_report")).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- work-report-schema` → FAIL (컬럼 없음)

- [ ] **Step 3: migrate()에 컬럼 추가** — `schema.ts`의 `goalColsLate` 블록(기존 `squash_status` 추가부 근처, 약 :421 뒤)에 삽입:

```ts
  if (!goalColsLate.some((c) => c.name === "work_report")) {
    db.exec("ALTER TABLE goals ADD COLUMN work_report TEXT");
  }
```

(주의: `goalColsLate`는 이미 선언돼 있음 — 재선언 말고 기존 배열 재사용. 새 PRAGMA 조회가 필요하면 별도 변수명 `goalColsWR`로.)

- [ ] **Step 4: 통과 확인** — `npm test -- work-report-schema` → PASS

- [ ] **Step 5: 커밋** — `git add server/db/schema.ts server/__tests__/work-report-schema.test.ts && git commit -m "feat(work-report): goals.work_report 컬럼 추가"`

---

## Task 2: 스크린샷 수집 + 유틸 모듈

**Files:**
- Create: `server/core/orchestration/work-report.ts`
- Test: `server/__tests__/work-report.test.ts`

**Interfaces:**
- Consumes: 없음(순수 fs).
- Produces:
  - `artifactsDirForGoal(db, goalId): string`
  - `collectScreenshots(worktreePath: string, destDir: string): ScreenshotRef[]`
  - `extractWrapUp(text: string, maxLen: number): string`
  - `initialWorkReport(screenshots: ScreenshotRef[]): WorkReport`
  - 위 공유 타입들.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// server/__tests__/work-report.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectScreenshots, extractWrapUp, initialWorkReport } from "../core/orchestration/work-report.js";

let work: string, dest: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "wt-"));
  dest = mkdtempSync(join(tmpdir(), "art-"));
});
afterEach(() => { rmSync(work, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }); });

describe("collectScreenshots", () => {
  it("collects images from .playwright-mcp and .cc-shots, ignores non-images", () => {
    mkdirSync(join(work, ".playwright-mcp"), { recursive: true });
    mkdirSync(join(work, ".cc-shots"), { recursive: true });
    writeFileSync(join(work, ".playwright-mcp", "page-1.png"), "x");
    writeFileSync(join(work, ".playwright-mcp", "page.yml"), "x"); // 비이미지 무시
    writeFileSync(join(work, ".cc-shots", "after.jpg"), "x");
    const refs = collectScreenshots(work, dest);
    expect(refs.length).toBe(2);
    expect(readdirSync(dest).length).toBe(2);
    expect(refs.every((r) => /\.(png|jpe?g)$/i.test(r.file))).toBe(true);
  });
  it("returns empty when no capture dirs exist", () => {
    expect(collectScreenshots(work, dest)).toEqual([]);
  });
  it("caps the number collected", () => {
    mkdirSync(join(work, ".cc-shots"), { recursive: true });
    for (let i = 0; i < 30; i++) writeFileSync(join(work, ".cc-shots", `s${i}.png`), "x");
    expect(collectScreenshots(work, dest).length).toBeLessThanOrEqual(12);
  });
});

describe("extractWrapUp", () => {
  it("returns tail trimmed to a boundary within maxLen", () => {
    const t = "첫 문단.\n\n중간 작업 로그 여러 줄...\n\n마무리: 로그인 폼을 추가하고 검증을 붙였습니다.";
    const s = extractWrapUp(t, 60);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s).toContain("마무리");
  });
  it("handles empty", () => { expect(extractWrapUp("", 100)).toBe(""); });
});

describe("initialWorkReport", () => {
  it("starts pending with given screenshots", () => {
    const wr = initialWorkReport([{ file: "a.png", label: "a" }]);
    expect(wr.summaryStatus).toBe("pending");
    expect(wr.before).toBeNull();
    expect(wr.screenshots.length).toBe(1);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- work-report` → FAIL (모듈 없음)

- [ ] **Step 3: 모듈 구현**

```ts
// server/core/orchestration/work-report.ts
import { existsSync, readdirSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import type Database from "better-sqlite3";

export interface ScreenshotRef { file: string; label: string; taskId?: string | null; }
export interface WorkReport {
  before: string | null;
  changed: string | null;
  after: string | null;
  notes: string | null;
  summaryStatus: "pending" | "ready" | "failed";
  screenshots: ScreenshotRef[];
}

const CAPTURE_DIRS = [".playwright-mcp", ".cc-shots"];
const IMAGE_EXT = /\.(png|jpe?g)$/i;
const MAX_SHOTS = 12;
const MAX_SHOT_BYTES = 5_000_000; // 5MB/장 상한

/** sqlite가 실제 연 DB 경로 기준 canonical dataDir → artifacts/goals/<id>. */
export function artifactsDirForGoal(db: Database.Database, goalId: string): string {
  const dataDir = dirname(db.name);
  return join(dataDir, "artifacts", "goals", goalId);
}

/** worktree의 알려진 캡쳐 디렉토리에서 이미지를 모아 destDir로 복사. best-effort, throw 안 함. */
export function collectScreenshots(worktreePath: string, destDir: string): ScreenshotRef[] {
  const refs: ScreenshotRef[] = [];
  try {
    for (const dir of CAPTURE_DIRS) {
      const abs = join(worktreePath, dir);
      if (!existsSync(abs)) continue;
      const entries = walkImages(abs);
      for (const src of entries) {
        if (refs.length >= MAX_SHOTS) break;
        try {
          if (statSync(src).size > MAX_SHOT_BYTES) continue;
          const safe = sanitizeName(`${dir.replace(/^\./, "")}-${basename(src)}`);
          mkdirSync(destDir, { recursive: true });
          copyFileSync(src, join(destDir, safe));
          refs.push({ file: safe, label: basename(src), taskId: null });
        } catch { /* skip one file */ }
      }
    }
  } catch { /* best effort */ }
  return refs;
}

function walkImages(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) out.push(...walkImages(p));
      else if (IMAGE_EXT.test(name)) out.push(p);
    }
  } catch { /* ignore */ }
  return out;
}

/** 서빙/파일명 안전화: 영숫자·._- 만 허용. */
export function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

/** 에이전트 최종 텍스트의 마무리 꼬리를 문단 경계로 잘라 담는다 (LLM 콜 없음). */
export function extractWrapUp(text: string, maxLen: number): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  const tail = t.slice(-maxLen);
  const nl = tail.indexOf("\n");
  return (nl > 0 && nl < maxLen / 2 ? tail.slice(nl + 1) : tail).trim();
}

export function initialWorkReport(screenshots: ScreenshotRef[]): WorkReport {
  return { before: null, changed: null, after: null, notes: null, summaryStatus: "pending", screenshots };
}
```

- [ ] **Step 4: 통과 확인** — `npm test -- work-report` → PASS

- [ ] **Step 5: 커밋** — `git add server/core/orchestration/work-report.ts server/__tests__/work-report.test.ts && git commit -m "feat(work-report): 스크린샷 수집 + wrap-up 유틸"`

---

## Task 3: LLM 서사 합성 (`synthesizeNarrative`, `generateGoalWorkReport`)

**Files:**
- Modify: `server/core/orchestration/work-report.ts`
- Test: `server/__tests__/work-report-narrative.test.ts`

**Interfaces:**
- Consumes: `SessionManager`(evaluator.ts와 동일 — `spawnAgent(agentId, workdir, sessionKey)` → `session.send(prompt)` → `{stdout}`), `parseStreamJson`.
- Produces:
  - `parseNarrativeJson(text: string): {before,changed,after,notes} | null`
  - `synthesizeNarrative(deps): Promise<{before,changed,after,notes} | null>`
  - `generateGoalWorkReport(db, broadcast, sessionManager, goal, worktreePath, tasks, filesChanged, screenshots): Promise<void>` (persist + broadcast `goal:work_report`, throw 안 함)

- [ ] **Step 1: 실패 테스트 (파서 단위 — LLM은 목)**

```ts
// server/__tests__/work-report-narrative.test.ts
import { describe, it, expect } from "vitest";
import { parseNarrativeJson } from "../core/orchestration/work-report.js";

describe("parseNarrativeJson", () => {
  it("parses a fenced json block", () => {
    const out = parseNarrativeJson('설명...\n```json\n{"before":"a","changed":"b","after":"c","notes":""}\n```');
    expect(out).toEqual({ before: "a", changed: "b", after: "c", notes: "" });
  });
  it("returns null on garbage", () => {
    expect(parseNarrativeJson("죄송합니다 JSON이 없어요")).toBeNull();
  });
  it("returns null when required keys missing", () => {
    expect(parseNarrativeJson('```json\n{"before":"a"}\n```')).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- work-report-narrative` → FAIL

- [ ] **Step 3: 구현 추가** (`work-report.ts`에 append)

```ts
import { parseStreamJson } from "../agent/adapters/stream-parser.js";
import type { SessionManager } from "../agent/session.js";

export interface WorkNarrative { before: string; changed: string; after: string; notes: string; }

const MAX_TASK_SUMMARY = 300;
const MAX_FILES_IN_PROMPT = 40;
const SUMMARY_SESSION_TIMEOUT_HINT = "요약";

export function parseNarrativeJson(text: string): WorkNarrative | null {
  if (!text) return null;
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : (text.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (typeof o.before !== "string" || typeof o.changed !== "string" || typeof o.after !== "string") return null;
    return { before: o.before, changed: o.changed, after: o.after, notes: typeof o.notes === "string" ? o.notes : "" };
  } catch { return null; }
}

function buildNarrativePrompt(
  goal: { title?: string | null; description?: string | null },
  tasks: { title: string; result_summary: string | null }[],
  filesChanged: string[],
): string {
  const taskLines = tasks.map((t) => `- ${t.title}: ${(t.result_summary ?? "").slice(0, MAX_TASK_SUMMARY)}`).join("\n");
  const files = filesChanged.slice(0, MAX_FILES_IN_PROMPT).join("\n");
  return `당신은 방금 완료된 작업 묶음을 **비개발자도 5초에 이해**하도록 요약합니다.
아래 정보를 바탕으로 **오직 \`\`\`json 블록 하나만** 출력하세요. 코드 라인·파일 경로 나열 금지, 기능·화면·동작 단위로.

## 목표
${goal.title ?? ""}
${goal.description ?? ""}

## 완료된 작업
${taskLines || "(요약 없음)"}

## 변경된 파일
${files || "(없음)"}

형식:
\`\`\`json
{"before":"작업 전 상황/문제 (1-2문장)","changed":"무엇을 했는지 (2-4문장)","after":"지금 어떻게 달라졌는지·사용자가 보게 될 차이 (1-2문장)","notes":"주의점·미해결 (없으면 빈 문자열)"}
\`\`\``;
}

/** 요약 전용 시스템 에이전트를 재사용/생성하고 세션에서 1콜. 실패 시 null. */
export async function synthesizeNarrative(
  db: Database.Database,
  sessionManager: SessionManager,
  goal: { id: string; project_id: string; title?: string | null; description?: string | null },
  worktreePath: string,
  tasks: { title: string; result_summary: string | null }[],
  filesChanged: string[],
): Promise<WorkNarrative | null> {
  db.prepare(
    "INSERT OR IGNORE INTO agents (project_id, name, role, system_prompt) VALUES (?, '[Nova] Summarizer', 'reviewer', ?)",
  ).run(goal.project_id, "You write concise, human-friendly before/after work summaries in Korean. Output only the requested JSON.");
  const agent = db.prepare(
    "SELECT id FROM agents WHERE project_id = ? AND name = '[Nova] Summarizer' LIMIT 1",
  ).get(goal.project_id) as { id: string } | undefined;
  if (!agent) return null;

  const sessionKey = `summary-${goal.id}`;
  try {
    const session = sessionManager.spawnAgent(agent.id, worktreePath, sessionKey);
    const result = await session.send(buildNarrativePrompt(goal, tasks, filesChanged));
    const parsed = parseStreamJson(result.stdout);
    return parseNarrativeJson(parsed.text ?? "");
  } catch {
    return null;
  } finally {
    try { sessionManager.killSession(sessionKey); } catch { /* ignore */ }
  }
}

/** 비동기 요약 파이프라인: 서사 생성 → work_report 병합·persist → goal:work_report broadcast. throw 안 함. */
export async function generateGoalWorkReport(
  db: Database.Database,
  broadcast: (event: string, data: unknown) => void,
  sessionManager: SessionManager,
  goal: { id: string; project_id: string; title?: string | null; description?: string | null },
  worktreePath: string,
  tasks: { title: string; result_summary: string | null }[],
  filesChanged: string[],
  screenshots: ScreenshotRef[],
): Promise<void> {
  let narrative: WorkNarrative | null = null;
  try {
    narrative = await synthesizeNarrative(db, sessionManager, goal, worktreePath, tasks, filesChanged);
  } catch { narrative = null; }

  const report: WorkReport = narrative
    ? { ...narrative, summaryStatus: "ready", screenshots }
    : { before: null, changed: null, after: null, notes: null, summaryStatus: "failed", screenshots };

  try {
    db.prepare("UPDATE goals SET work_report = ? WHERE id = ?").run(JSON.stringify(report), goal.id);
  } catch { /* best effort */ }
  broadcast("goal:work_report", { goalId: goal.id, workReport: report });
}
```

(주의: `SUMMARY_SESSION_TIMEOUT_HINT`은 미사용이면 넣지 말 것 — placeholder 금지. 위 스텁에서 제거하고 실제 사용하는 상수만 남긴다.)

- [ ] **Step 4: 통과 확인** — `npm test -- work-report-narrative` → PASS. `npm run typecheck` → PASS.

- [ ] **Step 5: 커밋** — `git add server/core/orchestration/work-report.ts server/__tests__/work-report-narrative.test.ts && git commit -m "feat(work-report): LLM before/after 서사 합성 + 비동기 파이프라인"`

---

## Task 4: 오케스트레이터 배선 — sessionManager 스레딩 + squash 지점 호출

**Files:**
- Modify: `server/core/orchestration/engine.ts`
  - `checkAndTriggerGoalSquash` 시그니처 + 호출부 4곳 (:917, :996, :1007, :1064)
  - `triggerGoalSquash` 시그니처 + 호출부 1곳 (:2007)
  - squash-ready 블록 (:2172-2189): 스크린샷 인라인 + broadcast에 workReport + 비동기 요약 kick-off
  - task result_summary 저장 (:853-855): `extractWrapUp` 사용

**Interfaces:**
- Consumes: Task 2/3의 `artifactsDirForGoal`, `collectScreenshots`, `initialWorkReport`, `generateGoalWorkReport`, `extractWrapUp`.
- Produces: `goal:squash_ready` payload에 `workReport: WorkReport` 필드; 신규 `goal:work_report` 이벤트.

- [ ] **Step 1: import 추가** — engine.ts 상단 import 그룹에:

```ts
import { artifactsDirForGoal, collectScreenshots, initialWorkReport, generateGoalWorkReport, extractWrapUp } from "./work-report.js";
```

- [ ] **Step 2: task result_summary 캡쳐 교체** (:853-855)

```ts
// Sprint 6: result_summary 저장 — 마무리 텍스트를 문단 경계로 (mid-sentence 잘림 방지)
const summary = extractWrapUp(implParsed.text ?? "", MAX_SUMMARY_LEN);
db.prepare("UPDATE tasks SET result_summary = ? WHERE id = ?").run(summary, task.id);
```

(컨텍스트 체인 :726의 `.slice(0, 200)` 소비는 그대로 동작 — 길이만 다름.)

- [ ] **Step 3: `checkAndTriggerGoalSquash`에 sessionManager 파라미터 추가** (:1969)

```ts
async function checkAndTriggerGoalSquash(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  sessionManager: SessionManager,
  goalId: string,
  worktreePath: string,
): Promise<void> {
```

그리고 내부 `triggerGoalSquash` 호출(:2007)을 `await triggerGoalSquash(db, broadcast, sessionManager, goal, worktreePath);`로.

- [ ] **Step 4: 호출부 4곳 갱신** (:917, :996, :1007, :1064) — 각각 `sessionManager`를 3번째 인자로 삽입:

```ts
await checkAndTriggerGoalSquash(db, broadcast, sessionManager, task.goal_id, effectiveWorkdir);
```

- [ ] **Step 5: `triggerGoalSquash` 시그니처 + squash-ready 블록** (:2026, :2172-2189)

시그니처:
```ts
async function triggerGoalSquash(
  db: Database,
  broadcast: (event: string, data: unknown) => void,
  sessionManager: SessionManager,
  goal: GoalRow,
  worktreePath: string,
): Promise<void> {
```

`doneTasks` 쿼리(:2173)를 `title, result_summary` 조회로 확장하고, broadcast 직전에 스크린샷 인라인 + workReport 포함, broadcast 직후 비동기 요약:

```ts
  const doneTasks = db.prepare(
    "SELECT title, result_summary FROM tasks WHERE goal_id = ? AND status = 'done' AND parent_task_id IS NULL ORDER BY sort_order ASC",
  ).all(goal.id) as { title: string; result_summary: string | null }[];
  const commitMessage = buildSquashCommitMessage(goal, doneTasks.map((t) => t.title));

  // 스크린샷 인라인 수집 (fs-only·best-effort) — 게이트에 즉시 실린다
  let workReport = initialWorkReport([]);
  try {
    const destDir = artifactsDirForGoal(db, goal.id);
    workReport = initialWorkReport(collectScreenshots(worktreePath, destDir));
    db.prepare("UPDATE goals SET work_report = ? WHERE id = ?").run(JSON.stringify(workReport), goal.id);
  } catch (e: any) {
    log.warn(`Screenshot collect failed for goal ${goal.id}: ${e.message}`);
  }

  db.prepare("UPDATE goals SET squash_status = 'pending_approval' WHERE id = ?").run(goal.id);

  broadcast("goal:squash_ready", {
    goalId: goal.id,
    commitMessage,
    filesChanged,
    acceptanceOutput: "",
    workReport,
  });

  // LLM 서사 요약은 비동기 (큐/게이트 블로킹 금지) — 완료 시 goal:work_report 후속 이벤트
  void generateGoalWorkReport(
    db, broadcast, sessionManager, goal, worktreePath, doneTasks, filesChanged, workReport.screenshots,
  ).catch((e) => log.warn(`Work report generation failed for goal ${goal.id}: ${e.message}`));

  log.info(`Goal ${goal.id} squash ready — pending_approval`);
```

- [ ] **Step 6: 검증** — `npm run typecheck` → PASS. `npm test` → 전체 그린(기존 회귀 없음).

- [ ] **Step 7: 커밋** — `git add server/core/orchestration/engine.ts && git commit -m "feat(work-report): squash 게이트에 스크린샷+비동기 서사 요약 배선"`

---

## Task 5: 아티팩트 서빙 라우트 + squash-preview에 work_report

**Files:**
- Modify: `server/api/routes/goals.ts`
- Test: `server/__tests__/artifact-path.test.ts` (경로 안전성 단위)

**Interfaces:**
- Consumes: `artifactsDirForGoal`, `sanitizeName` (Task 2).
- Produces: `GET /api/goals/:goalId/artifacts/:name` (이미지 스트림, /api 마운트로 Bearer 보호); `squash-preview` 응답에 `workReport` 추가.

- [ ] **Step 1: 경로 안전성 실패 테스트**

```ts
// server/__tests__/artifact-path.test.ts
import { describe, it, expect } from "vitest";
import { resolveArtifactPath } from "../api/routes/goals.js";

describe("resolveArtifactPath", () => {
  it("resolves a safe name inside the dir", () => {
    const p = resolveArtifactPath("/data/artifacts/goals/g1", "cc-shots-after.png");
    expect(p).toBe("/data/artifacts/goals/g1/cc-shots-after.png");
  });
  it("rejects traversal", () => {
    expect(resolveArtifactPath("/data/artifacts/goals/g1", "../../secret")).toBeNull();
    expect(resolveArtifactPath("/data/artifacts/goals/g1", "a/b.png")).toBeNull();
  });
});
```

- [ ] **Step 2: 실패 확인** — `npm test -- artifact-path` → FAIL

- [ ] **Step 3: 라우트 + 헬퍼 구현** — `goals.ts`에:

```ts
import { existsSync } from "node:fs";      // 이미 있으면 재사용
import { join, resolve, basename } from "node:path";
import { artifactsDirForGoal } from "../../core/orchestration/work-report.js";

/** 화이트리스트 basename만, dir 밖 이탈 차단. 안전하면 절대경로, 아니면 null. */
export function resolveArtifactPath(dir: string, name: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const p = resolve(dir, name);
  if (p !== join(dir, basename(name)) || !p.startsWith(resolve(dir) + "/")) return null;
  return p;
}
```

`createGoalRoutes` 내부에 라우트 추가(다른 `/:goalId/...` 라우트 근처):

```ts
  router.get("/:goalId/artifacts/:name", (req, res) => {
    const dir = artifactsDirForGoal(db, req.params.goalId);
    const filePath = resolveArtifactPath(dir, req.params.name);
    if (!filePath || !existsSync(filePath)) return res.status(404).json({ error: "Not found" });
    res.sendFile(filePath);
  });
```

`squash-preview`(:657-697) 응답 객체에 `workReport` 추가:

```ts
    const wrRaw = (goal as any).work_report as string | null;
    let workReport = null;
    try { workReport = wrRaw ? JSON.parse(wrRaw) : null; } catch { workReport = null; }
    res.json({
      goalId: goal.id,
      squashStatus: goal.squash_status,
      commitMessage,
      filesChanged,
      acceptanceScript: goal.acceptance_script ?? null,
      workReport,
    });
```

- [ ] **Step 4: 통과 확인** — `npm test -- artifact-path` → PASS. `npm run typecheck` → PASS.

- [ ] **Step 5: 커밋** — `git add server/api/routes/goals.ts server/__tests__/artifact-path.test.ts && git commit -m "feat(work-report): 인증된 아티팩트 서빙 + preview에 work_report"`

---

## Task 6: 대시보드 WS/상태 배선

**Files:**
- Modify: `dashboard/src/hooks/useWebSocket.ts` (:168-182 + 신규 case)
- Modify: `dashboard/src/components/ProjectHome.tsx` (:673 상태 타입, :824 핸들러, :846 fallback, :1396 props)
- Modify: `dashboard/src/lib/api.ts` (:168 squashPreview 타입 + 아티팩트 blob 헬퍼)

**Interfaces:**
- Consumes: 서버 `goal:squash_ready`(+workReport), `goal:work_report`, `squash-preview`(+workReport).
- Produces: `squashPayloadByGoalId[goalId].workReport` 채움; 다이얼로그에 전달.

- [ ] **Step 1: `api.ts` — 프론트 WorkReport 타입 + squashPreview 확장 + blob 헬퍼**

```ts
export interface WorkReport {
  before: string | null; changed: string | null; after: string | null; notes: string | null;
  summaryStatus: "pending" | "ready" | "failed";
  screenshots: { file: string; label: string; taskId?: string | null }[];
}
```
`squashPreview` 반환 타입에 `workReport: WorkReport | null` 추가. 그리고 인증 blob 헬퍼(같은 base+key 재사용):

```ts
  fetchArtifact: async (goalId: string, name: string): Promise<string> => {
    const res = await fetch(`${API_BASE}/goals/${goalId}/artifacts/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    if (!res.ok) throw new Error(`artifact ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },
```
(`API_BASE`/`getApiKey`는 api.ts 내부 기존 심볼에 맞춰 사용 — request()가 쓰는 것과 동일한 것으로.)

- [ ] **Step 2: `useWebSocket.ts` — 페이로드 확장 + 신규 case** (:168)

`goal:squash_ready` case에서 `workReport`도 destructure하고 CustomEvent detail에 포함:
```ts
    const { goalId, commitMessage, filesChanged, acceptanceOutput, workReport } = msg.payload;
    // ...
    window.dispatchEvent(new CustomEvent("nova:goal-squash-ready", {
      detail: { goalId, commitMessage, filesChanged, acceptanceOutput, workReport },
    }));
```
그 아래(sibling case들 사이)에 신규 case:
```ts
  case "goal:work_report":
    window.dispatchEvent(new CustomEvent("nova:goal-work-report", { detail: msg.payload }));
    break;
```

- [ ] **Step 3: `ProjectHome.tsx` — 상태 타입 확장** (:673)

```ts
const [squashPayloadByGoalId, setSquashPayloadByGoalId] = useState<
  Record<string, { commitMessage?: string; filesChanged?: string[]; acceptanceOutput?: string; workReport?: WorkReport | null }>
>({});
```
(파일 상단에서 `import { ..., type WorkReport } from "../lib/api";`)

- [ ] **Step 4: squash-ready 핸들러에 workReport 저장** (:824)

```ts
    const { goalId, commitMessage, filesChanged, acceptanceOutput, workReport } = (e as CustomEvent).detail;
    setSquashPayloadByGoalId((prev) => ({ ...prev, [goalId]: { commitMessage, filesChanged, acceptanceOutput, workReport } }));
```

- [ ] **Step 5: 신규 work-report 핸들러 (별도 useEffect)**

```ts
useEffect(() => {
  const handler = (e: Event) => {
    const { goalId, workReport } = (e as CustomEvent).detail;
    setSquashPayloadByGoalId((prev) => ({ ...prev, [goalId]: { ...prev[goalId], workReport } }));
  };
  window.addEventListener("nova:goal-work-report", handler);
  return () => window.removeEventListener("nova:goal-work-report", handler);
}, []);
```

- [ ] **Step 6: fallback 재조회에 workReport 반영** (:846) — preview에서 `workReport`도 저장:

```ts
      setSquashPayloadByGoalId((prev) => ({
        ...prev,
        [squashApprovalGoalId]: { ...prev[squashApprovalGoalId], commitMessage: preview.commitMessage, filesChanged: preview.filesChanged, workReport: preview.workReport },
      }));
```
그리고 재조회 가드 조건(`?.commitMessage` 있으면 skip)은 그대로 — workReport는 이후 이벤트로도 갱신되므로 문제 없음.

- [ ] **Step 7: 다이얼로그에 prop 전달** (:1396) — `workReport={payload.workReport}` 추가.

- [ ] **Step 8: 검증** — `cd dashboard && npx tsc -b` → PASS.

- [ ] **Step 9: 커밋** — `git add dashboard/src/hooks/useWebSocket.ts dashboard/src/components/ProjectHome.tsx dashboard/src/lib/api.ts && git commit -m "update(dashboard): work_report WS/상태 배선"`

---

## Task 7: 승인 다이얼로그 UI — 작업 요약 섹션 + 스크린샷

**Files:**
- Modify: `dashboard/src/components/GoalSquashApprovalDialog.tsx`
- Modify: `dashboard/src/i18n/ko.ts` (:790 뒤), `dashboard/src/i18n/en.ts` (:789 뒤)

**Interfaces:**
- Consumes: `WorkReport`(api.ts), `api.goals.fetchArtifact`.

- [ ] **Step 1: i18n 키 추가** — ko.ts (goalSquashDialogAcceptance 뒤):

```ts
goalSquashDialogWorkReport: "작업 요약",
goalSquashDialogBefore: "작업 전",
goalSquashDialogChanged: "한 일",
goalSquashDialogAfter: "결과",
goalSquashDialogNotes: "참고",
goalSquashDialogScreenshots: "화면",
goalSquashDialogSummaryPending: "요약 생성 중…",
goalSquashDialogSummaryFailed: "요약을 만들지 못했어요",
```
en.ts (병렬):
```ts
goalSquashDialogWorkReport: "Work Summary",
goalSquashDialogBefore: "Before",
goalSquashDialogChanged: "What changed",
goalSquashDialogAfter: "After",
goalSquashDialogNotes: "Notes",
goalSquashDialogScreenshots: "Screens",
goalSquashDialogSummaryPending: "Generating summary…",
goalSquashDialogSummaryFailed: "Couldn't generate summary",
```

- [ ] **Step 2: props 확장** — 인터페이스(:4-17)에 `workReport?: WorkReport | null;` 추가, `import { type WorkReport, api } from "../lib/api";` (실제 export 경로에 맞게), 구조분해에 `workReport` 추가.

- [ ] **Step 3: 스크린샷 blob 로딩 훅** — 컴포넌트 내부:

```tsx
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!workReport?.screenshots?.length) return;
    const urls: string[] = [];
    let alive = true;
    (async () => {
      for (const s of workReport.screenshots) {
        try {
          const u = await api.goals.fetchArtifact(goal.id, s.file);
          if (!alive) { URL.revokeObjectURL(u); return; }
          urls.push(u);
          setShotUrls((prev) => ({ ...prev, [s.file]: u }));
        } catch { /* skip */ }
      }
    })();
    return () => { alive = false; urls.forEach(URL.revokeObjectURL); };
  }, [workReport, goal.id]);
```

- [ ] **Step 4: 렌더 — acceptanceOutput 블록(:129) 뒤, body `</div>`(:130) 앞에 삽입**

```tsx
          {/* 작업 요약 */}
          {workReport && (
            <div>
              <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
                {t("goalSquashDialogWorkReport")}
              </span>
              {workReport.summaryStatus === "ready" ? (
                <div className="space-y-2 text-xs text-gray-700 dark:text-gray-300">
                  {([["goalSquashDialogBefore", workReport.before], ["goalSquashDialogChanged", workReport.changed], ["goalSquashDialogAfter", workReport.after], ["goalSquashDialogNotes", workReport.notes]] as const)
                    .filter(([, v]) => v && v.trim())
                    .map(([k, v]) => (
                      <div key={k}>
                        <span className="font-semibold text-gray-500 dark:text-gray-400">{t(k)}</span>
                        <p className="mt-0.5 whitespace-pre-wrap leading-relaxed">{v}</p>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-xs text-gray-400 dark:text-gray-500 italic">
                  {workReport.summaryStatus === "failed" ? t("goalSquashDialogSummaryFailed") : t("goalSquashDialogSummaryPending")}
                </p>
              )}

              {workReport.screenshots.length > 0 && (
                <div className="mt-3">
                  <span className="text-[11px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider block mb-1">
                    {t("goalSquashDialogScreenshots")} ({workReport.screenshots.length})
                  </span>
                  <div className="grid grid-cols-2 gap-2">
                    {workReport.screenshots.map((s) =>
                      shotUrls[s.file] ? (
                        <a key={s.file} href={shotUrls[s.file]} target="_blank" rel="noreferrer">
                          <img src={shotUrls[s.file]} alt={s.label} className="w-full h-auto rounded border border-gray-200 dark:border-gray-700" />
                        </a>
                      ) : (
                        <div key={s.file} className="aspect-video rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
                      ),
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
```

- [ ] **Step 5: 검증** — `cd dashboard && npx tsc -b` → PASS. (실행 검증은 Task 9)

- [ ] **Step 6: 커밋** — `git add dashboard/src/components/GoalSquashApprovalDialog.tsx dashboard/src/i18n/ko.ts dashboard/src/i18n/en.ts && git commit -m "update(dashboard): 승인창 작업 요약 섹션 + 스크린샷"`

---

## Task 8: 태스크 상세에 마무리 요약 노출 (경량)

**Files:**
- Modify: `dashboard/src/components/TaskDetail.tsx`

**Interfaces:**
- Consumes: task의 `result_summary`(이미 API로 내려옴 — 없으면 task 조회에 포함하도록 서버 라우트 확인).

- [ ] **Step 1: TaskDetail에 result_summary 블록** — 태스크 메타 영역에, `task.result_summary`가 있을 때만 접힘 가능한 요약 섹션 추가(다이얼로그 acceptance 블록과 유사 스타일). 라벨은 기존/신규 i18n 키(`taskSummaryLabel: "작업 요약"`) 사용.

- [ ] **Step 2: 검증** — `cd dashboard && npx tsc -b` → PASS.

- [ ] **Step 3: 커밋** — `git add dashboard/src/components/TaskDetail.tsx dashboard/src/i18n/*.ts && git commit -m "update(dashboard): 태스크 상세 마무리 요약 노출"`

---

## Task 9: 통합 검증 (실행 테스트)

**Files:** 없음(검증 전용).

- [ ] **Step 1: 전체 빌드** — 루트에서 `npm run build` (⚠ `build:server` 단독 금지 — postbuild 미실행). typecheck·번들 PASS 확인.
- [ ] **Step 2: 유닛 전체** — `npm test` → 전 그린. `cd dashboard && npx tsc -b` → PASS.
- [ ] **Step 3: 실제 goal 관통** — dev/격리 데이터로 UI 작업이 포함된 goal 1개를 완주시켜(또는 기존 pending_approval goal 재현) 승인창에 (a) 요약 "생성 중" → "ready" 전환, (b) 스크린샷 있으면 썸네일, 없으면 섹션 생략을 **Playwright로 캡쳐 검증**. 캡쳐는 `/tmp` 또는 `.cc-shots`에만(레포 오염 금지).
- [ ] **Step 4: degrade 경로** — 요약 LLM 강제 실패(예: summarizer 프롬프트 목/네트워크 차단) 시 승인창이 "요약을 만들지 못했어요"로 뜨고 **승인 자체는 정상**인지 확인.
- [ ] **Step 5: 별도 검증 패스** — `code-reviewer` 또는 `verifier` 에이전트로 자가승인 아닌 리뷰 1회(특히 engine.ts squash 회귀·아티팩트 경로 안전성·blob URL revoke 누수).

---

## Self-Review (계획 ↔ 스펙 대조)

- **스펙 §1 before/after 서사** → Task 3(합성)+4(배선)+7(UI). ✅
- **스펙 §2 태스크 요약(콜 0)** → Task 4 Step2(extractWrapUp)+8(노출). ✅
- **스펙 §3 스크린샷 있으면** → Task 2(수집)+4(인라인)+5(서빙)+7(그리드). ✅
- **스펙 데이터모델(work_report 컬럼, artifacts 디렉토리, 서빙 엔드포인트)** → Task 1+5. ✅
- **스펙 API/WS(squash_ready+workReport, acceptanceOutput 인접개선은 선택)** → Task 4+6. acceptanceOutput 채우기는 범위서 제외(선택). ✅
- **스펙 오류/degrade(게이트 블로킹 금지, 없으면 생략)** → Task 3(failed)+4(try/catch)+7(pending/failed 표시)+9 Step4. ✅
- **스펙 i18n(라벨=키, 본문=데이터)** → Task 7. ✅
- **범위 밖(자동렌더·diff뷰어·의무화)** → 어느 task도 안 함. ✅
- **타입 일관성**: `WorkReport`/`ScreenshotRef` 서버(work-report.ts)·프론트(api.ts) 동일 형태. `summaryStatus` 유니온 3값 일관. ✅
- **placeholder**: Task 3의 `SUMMARY_SESSION_TIMEOUT_HINT` 미사용 상수 = 제거 지시 명시. ✅
