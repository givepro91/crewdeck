import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { removeWorktree } from "../core/project/worktree.js";

/**
 * removeWorktree — locked worktree 제거 실패를 성공으로 보고하던 회귀
 * (Smart Resume round 3 검증에서 발견).
 *
 * 이전 결함: `git worktree remove --force` 의 non-zero status 를 확인하지 않아,
 * `git worktree lock` 된 worktree 제거가 실패했는데도 `Removed worktree` 로그를
 * 남기고 디렉토리를 그대로 둔 채 성공으로 반환했다 (DELETE API 는 200/success:true).
 */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "crewdeck-wt-lock-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "test@crewdeck.local");
  git(repo, "config", "user.name", "crewdeck-test");
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-m", "base");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("removeWorktree — locked worktree", () => {
  it("locked worktree 를 실제로 제거하고 true 를 반환한다", () => {
    const branch = "goal/lock-x";
    const worktreePath = join(repo, ".crewdeck-worktrees", "lock-x");
    mkdirSync(join(repo, ".crewdeck-worktrees"), { recursive: true });
    git(repo, "worktree", "add", "-b", branch, worktreePath, "main");
    // 검증 재현: worktree 를 lock 하면 단일 --force 제거가 거부된다.
    git(repo, "worktree", "lock", worktreePath);

    const removed = removeWorktree(repo, worktreePath, branch);

    expect(removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    // git 메타데이터/브랜치도 정리됐는지 확인
    expect(git(repo, "worktree", "list")).not.toContain(worktreePath);
    expect(git(repo, "branch", "--list", branch).trim()).toBe("");
  });

  it("일반(unlocked) worktree 제거는 그대로 동작한다", () => {
    const branch = "goal/plain-x";
    const worktreePath = join(repo, ".crewdeck-worktrees", "plain-x");
    mkdirSync(join(repo, ".crewdeck-worktrees"), { recursive: true });
    git(repo, "worktree", "add", "-b", branch, worktreePath, "main");

    const removed = removeWorktree(repo, worktreePath, branch);

    expect(removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("이미 사라진 worktree 경로는 true 로 보고한다 (idempotent)", () => {
    const worktreePath = join(repo, ".crewdeck-worktrees", "gone-x");
    // 존재하지 않는 경로 — 제거할 것이 없으므로 성공으로 간주
    expect(removeWorktree(repo, worktreePath)).toBe(true);
  });
});
