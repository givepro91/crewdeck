import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { createLogger } from "../../utils/logger.js";
import { ensureGitIdentity } from "./git-workflow.js";

const log = createLogger("worktree");

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface WorktreeRecoveryState {
  status: "safe" | "manual_action_required";
  registered: boolean;
  branch: string | null;
  headSha: string | null;
  dirty: boolean;
  diffHash: string | null;
  reasons: string[];
}

interface GitReadResult {
  status: number | null;
  stdout: string;
}

function runGitReadOnly(cwd: string, args: string[]): GitReadResult {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "pipe",
    timeout: 10_000,
    encoding: "utf-8",
  });
  return { status: result.status, stdout: result.stdout?.toString() ?? "" };
}

/**
 * Recovery checkpoint와 대조할 수 있는 안정적인 dirty snapshot hash.
 * tracked diff와 untracked file object id를 모두 포함하며 Git 상태를 변경하지 않는다.
 */
export function getWorktreeDiffHash(worktreePath: string): string | null {
  const status = runGitReadOnly(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.status !== 0) return null;
  if (!status.stdout) return null;

  const diff = runGitReadOnly(worktreePath, ["diff", "--binary", "HEAD", "--"]);
  if (diff.status !== 0) return null;
  const untracked = runGitReadOnly(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.status !== 0) return null;

  const hash = createHash("sha256");
  hash.update(status.stdout);
  hash.update("\0tracked-diff\0");
  hash.update(diff.stdout ?? "");

  const paths = (untracked.stdout ?? "").split("\0").filter(Boolean).sort();
  for (const path of paths) {
    const object = runGitReadOnly(worktreePath, ["hash-object", "--no-filters", "--", path]);
    if (object.status !== 0) return null;
    hash.update("\0untracked\0");
    hash.update(path);
    hash.update("\0");
    hash.update(object.stdout.trim());
  }
  return hash.digest("hex");
}

/**
 * 재시작 시 DB checkpoint의 worktree/branch/dirty 증거와 대조할 Git 상태를
 * read-only로 수집한다. 불일치나 손상은 자동 checkout/reset하지 않고 수동 조치로 차단한다.
 */
export function inspectWorktreeRecoveryState(
  worktreePath: string,
  expectedBranch: string,
  expectedDirty?: boolean,
  expectedDiffHash?: string | null,
  expectedHeadSha?: string | null,
): WorktreeRecoveryState {
  const reasons: string[] = [];
  if (!existsSync(worktreePath)) {
    return {
      status: "manual_action_required",
      registered: false,
      branch: null,
      headSha: null,
      dirty: false,
      diffHash: null,
      reasons: ["worktree path does not exist"],
    };
  }

  const list = runGitReadOnly(worktreePath, ["worktree", "list", "--porcelain"]);
  const canonicalExpected = (() => {
    try { return realpathSync(worktreePath); } catch { return resolve(worktreePath); }
  })();
  const registered = list.status === 0 && (list.stdout ?? "")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some((line) => {
      const candidate = line.slice("worktree ".length);
      try { return realpathSync(candidate) === canonicalExpected; } catch { return resolve(candidate) === canonicalExpected; }
    });
  if (!registered) reasons.push("worktree is not registered in Git metadata");

  const branchResult = runGitReadOnly(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() || null : null;
  if (branch !== expectedBranch) reasons.push(`worktree branch mismatch: expected ${expectedBranch}, got ${branch ?? "detached"}`);

  const headResult = runGitReadOnly(worktreePath, ["rev-parse", "--verify", "HEAD"]);
  const headSha = headResult.status === 0 ? headResult.stdout.trim() || null : null;
  if (!headSha) reasons.push("worktree HEAD is unavailable");
  if (expectedHeadSha !== undefined && (expectedHeadSha ?? null) !== headSha) {
    reasons.push(`worktree HEAD mismatch: expected ${expectedHeadSha ?? "none"}, got ${headSha ?? "none"}`);
  }

  const statusResult = runGitReadOnly(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (statusResult.status !== 0) reasons.push("worktree status is unavailable");
  const dirty = statusResult.status === 0 && !!statusResult.stdout;
  const diffHash = dirty ? getWorktreeDiffHash(worktreePath) : null;
  if (dirty && !diffHash) reasons.push("dirty worktree diff hash is unavailable");
  if (expectedDirty !== undefined && dirty !== expectedDirty) {
    reasons.push(`dirty state mismatch: expected ${expectedDirty}, got ${dirty}`);
  }
  if (expectedDiffHash !== undefined && (expectedDiffHash ?? null) !== diffHash) {
    reasons.push("dirty worktree diff hash mismatch");
  }

  return {
    status: reasons.length === 0 ? "safe" : "manual_action_required",
    registered,
    branch,
    headSha,
    dirty,
    diffHash,
    reasons,
  };
}

/**
 * Add `.crewdeck-worktrees/` (and `.claude/worktrees/`) to the project's
 * `.gitignore` if not already present. Idempotent — safe to call every
 * time a worktree is created. Prevents the parent repo from tracking
 * worktree HEAD pointers as gitlink noise.
 */
function ensureGitignoreHasWorktreeExcludes(projectWorkdir: string): void {
  const gitignorePath = join(projectWorkdir, ".gitignore");
  const requiredLines = [".crewdeck-worktrees/", ".claude/worktrees/"];
  try {
    let current = "";
    if (existsSync(gitignorePath)) {
      current = readFileSync(gitignorePath, "utf-8");
    }
    const lines = current.split(/\r?\n/).map((l) => l.trim());
    const missing = requiredLines.filter((req) => !lines.includes(req));
    if (missing.length === 0) return;

    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    const block = `${prefix}\n# Crewdeck — agent worktrees (do not commit)\n${missing.join("\n")}\n`;
    if (existsSync(gitignorePath)) {
      appendFileSync(gitignorePath, block);
    } else {
      writeFileSync(gitignorePath, block.replace(/^\n/, ""));
    }
    log.info(`Added worktree excludes to .gitignore: ${missing.join(", ")}`);
  } catch (err: any) {
    log.warn(`Could not update .gitignore at ${projectWorkdir}: ${err.message}`);
  }
}

/**
 * 에이전트별 독립 worktree 생성.
 *
 * 구조: {projectWorkdir}/.crewdeck-worktrees/{agentSlug}-{taskSlug}-{uid}/
 * Branch: agent/{agentSlug}/{taskSlug}-{uid}
 *
 * Fallback: git repo가 아니면 null 반환 → 호출자가 직접 실행 모드로 전환
 */
export function createWorktree(
  projectWorkdir: string,
  agentName: string,
  taskSlug: string,
): WorktreeInfo | null {
  // git repo 확인
  if (!existsSync(join(projectWorkdir, ".git"))) {
    log.info("Not a git repo — skipping worktree isolation");
    return null;
  }

  // Ensure .gitignore excludes the worktree directory so agent tasks don't
  // accidentally commit worktree HEAD pointers as gitlink noise.
  ensureGitignoreHasWorktreeExcludes(projectWorkdir);

  // HEAD에 커밋이 있는지 확인 (빈 repo에서 worktree 생성 불가)
  const headCheck = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 5_000,
  });
  if (headCheck.status !== 0) {
    log.warn("No commits in repo — skipping worktree isolation");
    return null;
  }

  const agentSlug = slugify(agentName).slice(0, 50) || "agent";
  const safeTaskSlug = slugify(taskSlug).slice(0, 40) || "task";
  const uid = randomBytes(4).toString("hex"); // 유일성 보장 — slug 충돌 방지
  const branch = `agent/${agentSlug}/${safeTaskSlug}-${uid}`;
  const worktreePath = join(projectWorkdir, ".crewdeck-worktrees", `${agentSlug}-${safeTaskSlug}-${uid}`);

  // uid가 유일성을 보장하므로 충돌 없음 — 직접 생성
  const result = spawnSync("git", ["worktree", "add", "-b", branch, worktreePath], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 30_000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    // Only retry if the error is branch-related (already exists)
    if (stderr.includes("already exists")) {
      const retryResult = spawnSync("git", ["worktree", "add", worktreePath, branch], {
        cwd: projectWorkdir,
        stdio: "pipe",
        timeout: 30_000,
      });
      if (retryResult.status !== 0) {
        log.error(`Failed to create worktree (retry): ${retryResult.stderr?.toString()}`);
        return null;
      }
    } else {
      log.error(`Failed to create worktree: ${stderr}`);
      return null;
    }
  }

  log.info(`Created worktree: ${worktreePath} (branch: ${branch})`);
  return { path: worktreePath, branch };
}

/**
 * Worktree 디렉토리 + branch 정리.
 * branch 파라미터가 있으면 worktree 제거 후 branch도 삭제.
 *
 * @returns worktree 디렉토리가 실제로 제거됐으면 true.
 *   이전엔 `spawnSync` status를 확인하지 않아 locked worktree 제거 실패를
 *   성공(`Removed worktree`)으로 보고했다 — 실제 디렉토리 존재로 결과를 검증한다.
 */
export function removeWorktree(projectWorkdir: string, worktreePath: string, branch?: string): boolean {
  // 1. worktree 제거 — status를 반드시 확인하고, 결과는 디렉토리 존재로 최종 검증한다.
  let removeErr = "";
  try {
    // locked worktree는 `--force` 1회를 거부한다(git: "use 'remove -f -f'").
    // 실패 시 `--force` 2회로 강제 제거를 재시도한다.
    let result = spawnSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: projectWorkdir,
      stdio: "pipe",
      timeout: 15_000,
    });
    if (result.status !== 0) {
      result = spawnSync("git", ["worktree", "remove", "--force", "--force", worktreePath], {
        cwd: projectWorkdir,
        stdio: "pipe",
        timeout: 15_000,
      });
    }
    if (result.status !== 0) {
      removeErr = result.stderr?.toString().trim() || `exit ${result.status}`;
    }
  } catch (err: any) {
    removeErr = err.message;
  }

  // git이 디렉토리를 지우지 못했으면 파일시스템에서 직접 제거 후 prune으로
  // git 메타데이터를 정리한다 — DELETE가 success로 보고했는데 디렉토리가 남던 문제 방지.
  // (locked worktree는 prune이 스킵하므로 unlock을 먼저 시도)
  if (existsSync(worktreePath)) {
    spawnSync("git", ["worktree", "unlock", worktreePath], { cwd: projectWorkdir, stdio: "pipe", timeout: 10_000 });
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch (err: any) {
      log.warn(`Filesystem removal of worktree failed: ${err.message}`);
    }
    spawnSync("git", ["worktree", "prune"], { cwd: projectWorkdir, stdio: "pipe", timeout: 10_000 });
  }

  const removed = !existsSync(worktreePath);
  if (removed) {
    log.info(`Removed worktree: ${worktreePath}`);
  } else {
    log.warn(`Failed to remove worktree ${worktreePath}: ${removeErr || "directory still present"}`);
  }

  // 2. branch 정리 — 재시도 시 새 브랜치를 생성하므로 실패 브랜치도 강제 삭제
  if (branch) {
    try {
      const result = spawnSync("git", ["branch", "-D", branch], {
        cwd: projectWorkdir,
        stdio: "pipe",
        timeout: 10_000,
      });
      if (result.status === 0) {
        log.info(`Deleted branch: ${branch}`);
      } else {
        log.warn(`Failed to delete branch ${branch}: ${result.stderr?.toString()}`);
      }
    } catch (err: any) {
      log.warn(`Failed to delete branch ${branch}: ${err.message}`);
    }
  }

  return removed;
}

/**
 * 서버 시작 시 잔존 worktree + agent branch 일괄 정리.
 * recovery.ts에서 호출.
 *
 * @param excludePaths - 제외할 worktree 경로 목록 (Goal-as-Unit: squash_status != 'merged'인 goal worktree)
 */
export function cleanupStaleWorktrees(projectWorkdir: string, excludePaths: string[] = []): number {
  if (!existsSync(join(projectWorkdir, ".git"))) return 0;

  // macOS maps /var to /private/var. `git worktree list` reports the
  // canonical path while SQLite may contain the original alias, so raw string
  // comparison can delete an active goal worktree (and its WIP) on restart.
  const canonicalPath = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  let cleaned = 0;
  const worktrees = listWorktrees(projectWorkdir);
  const mainWorktree = canonicalPath(projectWorkdir);
  const excludeSet = new Set(excludePaths.map(canonicalPath));

  for (const wt of worktrees) {
    const canonicalWorktree = canonicalPath(wt);
    if (canonicalWorktree === mainWorktree) continue; // main worktree는 건드리지 않음
    if (excludeSet.has(canonicalWorktree)) {
      log.info(`Skipping active goal worktree: ${wt}`);
      continue; // Goal-as-Unit: 진행 중 goal worktree는 보존
    }
    if (wt.includes(".crewdeck-worktrees")) {
      removeWorktree(projectWorkdir, wt);
      cleaned++;
    }
  }

  // 잔존 agent/* branch 정리 (goal/* 브랜치는 Goal-as-Unit squash 후 제거하므로 여기서는 제외)
  try {
    const result = spawnSync("git", ["branch", "--list", "agent/*"], {
      cwd: projectWorkdir,
      stdio: "pipe",
      timeout: 10_000,
    });
    if (result.status === 0) {
      const branches = result.stdout.toString().split("\n")
        .map(b => b.trim())
        .filter(b => b && b.startsWith("agent/"));
      for (const b of branches) {
        // 재시도 시 새 브랜치를 생성하므로 stale agent 브랜치는 모두 강제 삭제
        const delResult = spawnSync("git", ["branch", "-D", b], { cwd: projectWorkdir, stdio: "pipe", timeout: 5_000 });
        if (delResult.status === 0) {
          log.info(`Cleaned up stale branch: ${b}`);
          cleaned++;
        } else {
          log.warn(`Failed to clean up stale branch: ${b}`);
        }
      }
    }
  } catch { /* best effort */ }

  // checkpoint stash는 재시작 후 dirty/WIP 복구 증거다. 소유 goal과
  // 저장 checkpoint를 대조하기 전에는 stale로 간주해 일괄 삭제하지 않는다.
  // 정상 성공/롤백 경로는 dropCheckpoint/restoreCheckpoint가 개별 정리한다.

  if (cleaned > 0) log.info(`Cleaned up ${cleaned} stale worktrees/branches in ${projectWorkdir}`);
  return cleaned;
}

export function listWorktrees(projectWorkdir: string): string[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 10_000,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.replace("worktree ", ""));
}

/**
 * Goal 단위 공유 worktree 생성 (Goal-as-Unit 모델).
 *
 * 구조: {projectWorkdir}/.crewdeck-worktrees/goal-{goalSlug}-{uid}/
 * Branch: goal/{goalSlug}-{uid}
 *
 * 태스크마다 새 worktree를 만드는 기존 createWorktree()와 달리,
 * Goal 실행 시작 시 1회만 호출하여 해당 Goal의 모든 태스크가 공유한다.
 */
export function createGoalWorktree(
  projectWorkdir: string,
  goalSlug: string,
): WorktreeInfo | null {
  if (!existsSync(join(projectWorkdir, ".git"))) {
    log.info("Not a git repo — skipping goal worktree isolation");
    return null;
  }

  // 커밋 identity 폴백 보장 — worktree는 메인 repo config를 공유하므로,
  // 에이전트/crewdeck의 git commit이 identity 미설정으로 실패하지 않게 한다.
  ensureGitIdentity(projectWorkdir);
  ensureGitignoreHasWorktreeExcludes(projectWorkdir);

  const headCheck = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 5_000,
  });
  if (headCheck.status !== 0) {
    log.warn("No commits in repo — skipping goal worktree isolation");
    return null;
  }

  const safeSlug = slugify(goalSlug).slice(0, 50) || "goal";
  const uid = randomBytes(4).toString("hex");
  const branch = `goal/${safeSlug}-${uid}`;
  const worktreePath = join(projectWorkdir, ".crewdeck-worktrees", `goal-${safeSlug}-${uid}`);

  const result = spawnSync("git", ["worktree", "add", "-b", branch, worktreePath], {
    cwd: projectWorkdir,
    stdio: "pipe",
    timeout: 30_000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    log.error(`Failed to create goal worktree: ${stderr}`);
    return null;
  }

  log.info(`Created goal worktree: ${worktreePath} (branch: ${branch})`);
  return { path: worktreePath, branch };
}

/**
 * 태스크 시작 전 stash 체크포인트 생성.
 * 중복 push 방지: 동일 taskId stash가 이미 있으면 false 반환.
 * 변경사항이 없으면 false 반환.
 */
export function stashCheckpoint(worktreePath: string, taskId: string): boolean {
  const label = `crewdeck-checkpoint-${taskId}`;

  // 중복 체크
  const listResult = spawnSync("git", ["stash", "list"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 10_000,
    encoding: "utf-8",
  });
  if (listResult.status === 0 && listResult.stdout.includes(label)) {
    log.info(`Stash checkpoint already exists for task ${taskId} — skipping`);
    return false;
  }

  // -u: untracked 포함 — 실패 롤백(clean -fd) 후에도 pre-task untracked 를 복원할 수 있어야 한다
  const pushResult = spawnSync("git", ["stash", "push", "-u", "-m", label], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 15_000,
    encoding: "utf-8",
  });

  if (pushResult.status !== 0) {
    log.warn(`stashCheckpoint failed for task ${taskId}: ${pushResult.stderr?.toString()}`);
    return false;
  }

  // "No local changes to save" 처리
  if (pushResult.stdout?.toString().includes("No local changes")) {
    return false;
  }

  // 스냅샷은 롤백용 백업일 뿐 — 작업 트리는 즉시 원상 복구해 goal WIP 를 유지한다.
  // push 만 하고 두면 이전 태스크들의 미커밋 산출물이 사라진 트리에서 다음 태스크가 실행되고,
  // 성공 시 dropCheckpoint 가 stash 를 지우면서 goal 작업물이 영구 소실된다.
  const applyResult = spawnSync("git", ["stash", "apply", "--index", "stash@{0}"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 15_000,
    encoding: "utf-8",
  });
  if (applyResult.status !== 0) {
    // push 직후의 클린 트리라 충돌 여지가 없지만, 만일 실패하면 pop 으로 원복해 WIP 소실을 막는다
    log.warn(`stashCheckpoint apply-back failed for task ${taskId} — popping to restore WIP: ${applyResult.stderr?.toString()}`);
    spawnSync("git", ["stash", "pop", "--index", "stash@{0}"], {
      cwd: worktreePath,
      stdio: "pipe",
      timeout: 15_000,
    });
    return false;
  }

  log.info(`Stash checkpoint created for task ${taskId} (tree preserved)`);
  return true;
}

/**
 * 태스크 실패(blocked) 시 stash 체크포인트 복원.
 * stash 목록에서 taskId를 찾아 `git stash pop --index stash@{N}` 수행.
 * 충돌 시 git checkout -- . + git stash drop 후 false 반환.
 */
export function restoreCheckpoint(worktreePath: string, taskId: string): boolean {
  const label = `crewdeck-checkpoint-${taskId}`;

  const listResult = spawnSync("git", ["stash", "list"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 10_000,
    encoding: "utf-8",
  });

  if (listResult.status !== 0) {
    log.warn(`restoreCheckpoint: git stash list failed for task ${taskId}`);
    return false;
  }

  const lines = listResult.stdout.split("\n").filter(Boolean);
  const idx = lines.findIndex((line) => line.includes(label));

  // 실패한 태스크가 남긴 변경을 먼저 폐기한다 — checkpoint 는 pre-task 스냅샷이다.
  // (stashCheckpoint 가 apply 로 트리를 유지하므로, pop 전에 트리를 비워야 충돌하지 않는다)
  const discardTaskChanges = () => {
    spawnSync("git", ["checkout", "--", "."], { cwd: worktreePath, stdio: "pipe", timeout: 10_000 });
    spawnSync("git", ["clean", "-fd"], { cwd: worktreePath, stdio: "pipe", timeout: 10_000 });
  };

  if (idx === -1) {
    // 스냅샷 없음 = pre-task 트리가 깨끗했음 → 실패 태스크의 변경만 폐기하면 복원 완료
    log.info(`restoreCheckpoint: no checkpoint for task ${taskId} — pre-task tree was clean, discarding task changes`);
    discardTaskChanges();
    return true;
  }

  discardTaskChanges();
  const stashRef = `stash@{${idx}}`;
  const popResult = spawnSync("git", ["stash", "pop", "--index", stashRef], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 15_000,
    encoding: "utf-8",
  });

  if (popResult.status !== 0) {
    // 충돌 발생 — 강제 복구
    log.warn(`restoreCheckpoint conflict for task ${taskId} — forcing checkout`);
    spawnSync("git", ["checkout", "--", "."], { cwd: worktreePath, stdio: "pipe", timeout: 10_000 });
    spawnSync("git", ["stash", "drop", stashRef], { cwd: worktreePath, stdio: "pipe", timeout: 10_000 });
    return false;
  }

  log.info(`Restored stash checkpoint for task ${taskId}`);
  return true;
}

/**
 * 태스크 성공 시 stash 체크포인트 제거.
 * 실패는 무시 (best-effort).
 */
export function dropCheckpoint(worktreePath: string, taskId: string): void {
  const label = `crewdeck-checkpoint-${taskId}`;

  const listResult = spawnSync("git", ["stash", "list"], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 10_000,
    encoding: "utf-8",
  });

  if (listResult.status !== 0) return;

  const lines = listResult.stdout.split("\n").filter(Boolean);
  const idx = lines.findIndex((line) => line.includes(label));
  if (idx === -1) return;

  const stashRef = `stash@{${idx}}`;
  spawnSync("git", ["stash", "drop", stashRef], {
    cwd: worktreePath,
    stdio: "pipe",
    timeout: 10_000,
  });

  log.info(`Dropped stash checkpoint for task ${taskId}`);
}

/**
 * 웹 세션 워크스페이스 턴 경계 체크포인트 — 작업 트리를 **비파괴**로 스냅샷한다(Phase 4b).
 *
 * stashCheckpoint(git stash push)와 근본적으로 다른 방법이다: git stash는 작업 트리를 실제로
 * 비웠다가 되돌리므로, chat/소환 세션이 도는 **실제 프로젝트 레포**에서 쓰면 사용자의 미커밋
 * 작업을 덮을 위험이 있다. 여기서는 임시 인덱스(GIT_INDEX_FILE)에 현재 작업 트리를 stage 해
 * write-tree → commit-tree 로 커밋 객체만 만든다 — 작업 트리·실제 인덱스·stash 스택을 전혀
 * 건드리지 않는다(캡처는 순수 read). provider 무관(순수 git, workdir 기준).
 *
 * @returns { commit, tree } SHA. git repo 아님/빈 repo/실패 시 null.
 */
export function snapshotWorkdir(workdir: string): { commit: string; tree: string } | null {
  if (!existsSync(join(workdir, ".git"))) return null;

  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: workdir, stdio: "pipe", timeout: 5_000, encoding: "utf-8",
  });
  if (head.status !== 0) return null; // 커밋 없는 빈 repo — 스냅샷할 부모가 없음

  const tmpIndex = join(tmpdir(), `crewdeck-snap-${randomBytes(6).toString("hex")}.idx`);
  // commit-tree는 committer identity가 필요 — repo config에 의존하지 않도록 고정 신원을 env로 준다.
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "crewdeck", GIT_AUTHOR_EMAIL: "crewdeck@local",
    GIT_COMMITTER_NAME: "crewdeck", GIT_COMMITTER_EMAIL: "crewdeck@local",
  };
  try {
    // 빈 임시 인덱스에서 add -A → 현재 작업 트리 스냅샷과 동일(.gitignore 존중, node_modules 등 제외).
    const add = spawnSync("git", ["add", "-A"], { cwd: workdir, stdio: "pipe", timeout: 30_000, env });
    if (add.status !== 0) {
      log.warn(`snapshotWorkdir: git add failed: ${add.stderr?.toString()}`);
      return null;
    }
    const writeTree = spawnSync("git", ["write-tree"], { cwd: workdir, stdio: "pipe", timeout: 15_000, encoding: "utf-8", env });
    if (writeTree.status !== 0) return null;
    const tree = writeTree.stdout.trim();
    const commitTree = spawnSync("git", ["commit-tree", tree, "-p", head.stdout.trim(), "-m", "crewdeck-checkpoint"], {
      cwd: workdir, stdio: "pipe", timeout: 15_000, encoding: "utf-8", env,
    });
    if (commitTree.status !== 0) {
      log.warn(`snapshotWorkdir: commit-tree failed: ${commitTree.stderr?.toString()}`);
      return null;
    }
    return { commit: commitTree.stdout.trim(), tree };
  } finally {
    try { rmSync(tmpIndex, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * "코드만 되돌리기"(Phase 4b) — 작업 트리를 스냅샷 시점 내용으로 되돌린다.
 *
 * `git restore --source=<snap> --worktree -- .` : 스냅샷에 있던 파일을 그 내용으로 복원한다.
 * **안전 우선** — (1) 작업 트리만 복원하고 인덱스(staged)는 건드리지 않는다, (2) 스냅샷 이후
 * "새로 생성된" 파일은 삭제하지 않는다(파일을 지우지 않음). 즉 편집 되돌림엔 강하고, 신규 파일
 * 정리는 사용자 몫으로 남긴다 — Bolt Try-to-Fix 안티패턴("되돌리기 우선")의 안전한 최소 구현.
 *
 * @returns 성공 여부.
 */
export function restoreWorkdirSnapshot(workdir: string, snapCommit: string): boolean {
  if (!existsSync(join(workdir, ".git"))) return false;
  const result = spawnSync("git", ["restore", "--source", snapCommit, "--worktree", "--", "."], {
    cwd: workdir, stdio: "pipe", timeout: 30_000, encoding: "utf-8",
  });
  if (result.status !== 0) {
    log.warn(`restoreWorkdirSnapshot failed for ${snapCommit.slice(0, 8)}: ${result.stderr?.toString()}`);
    return false;
  }
  log.info(`Restored workdir to snapshot ${snapCommit.slice(0, 8)}`);
  return true;
}

// 한글 보존 slug — engine.ts goalSlug와 동일 문자 클래스 (D-3: 한글 제목이 통째로 소거돼
// goal-goal-xxx 무의미 이름이 되던 문제). NFC 정규화로 macOS NFD 입력도 흡수.
function slugify(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
