import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "../core/agent/adapters/claude-code.js";

let dir: string | null = null;
const originalPath = process.env.PATH;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  process.env.PATH = originalPath;
});

type ResumeFailureMode =
  /** 실측 CLI 2.1.x 문구 */
  | "no-conversation"
  /** 문구가 완전히 다른 미래 판 — 문구 매칭으로는 못 잡는다 */
  | "unknown-phrase"
  /** 한도 소진 — fresh 재시도가 아니라 failover 로 가야 한다 */
  | "rate-limit"
  /** 대화가 시작된 뒤 끊김 — 재개 자체는 성공했으므로 fresh 재시도 대상이 아니다 */
  | "mid-turn";

/**
 * `--resume` 이 오면 지정한 방식으로 실패하고, resume 없이 오면 성공하는 스텁 CLI.
 * 호출마다 argv 를 파일에 누적해 재시도 여부를 관측한다.
 */
function installResumeFailingCli(workdir: string, mode: ResumeFailureMode): string {
  const binDir = join(workdir, "bin");
  mkdirSync(binDir);
  const callLog = join(workdir, "calls.log");
  const executable = join(binDir, "claude");
  writeFileSync(executable, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callLog)}, args.join(" ") + "\\n");
const mode = ${JSON.stringify(mode)};
const resumeIdx = args.indexOf("--resume");
if (resumeIdx !== -1) {
  const id = args[resumeIdx + 1];
  if (mode === "mid-turn") {
    process.stdout.write(JSON.stringify({
      type: "assistant", session_id: id,
      message: { content: [{ type: "text", text: "partial" }] },
    }) + "\\n");
    process.stderr.write("stream closed unexpectedly\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "error_during_execution", duration_ms: 0,
    is_error: true, num_turns: 0, session_id: id, total_cost_usd: 0,
  }) + "\\n");
  const stderrByMode = {
    "no-conversation": "No conversation found with session ID: " + id,
    "unknown-phrase": "conversation store rejected the handle (code 7)",
    "rate-limit": "Claude usage limit reached. Try again later.",
  };
  process.stderr.write(stderrByMode[mode] + "\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  type: "assistant", session_id: "fresh-session",
  message: { content: [{ type: "text", text: "[{\\"title\\":\\"ok\\"}]" }] },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "fresh-session",
}) + "\\n");
process.exit(0);
`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  return callLog;
}

const STALE_ID = "169ef004-c05c-417b-a074-7e9de2101b23";

async function runWithStaleResume(mode: ResumeFailureMode) {
  dir = mkdtempSync(join(tmpdir(), `crewdeck-resume-${mode}-`));
  const callLog = installResumeFailingCli(dir, mode);
  const session = createClaudeCodeAdapter().spawn({
    workdir: dir,
    systemPrompt: "test",
    sessionBehavior: "resume-or-new",
    resumeSessionId: STALE_ID,
  });
  const result = await session.send("test");
  session.cleanup();
  return { result, calls: readFileSync(callLog, "utf-8").trim().split("\n") };
}

describe("claude adapter stale --resume 복구", () => {
  it('실측 문구("No conversation found")면 fresh 세션으로 재시도해 성공한다', async () => {
    const { result, calls } = await runWithStaleResume("no-conversation");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(`--resume ${STALE_ID}`);
    expect(calls[1]).not.toContain("--resume");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  }, 20_000);

  it("문구를 몰라도 턴이 0이면 fresh 세션으로 재시도한다 (문구 독립)", async () => {
    const { result, calls } = await runWithStaleResume("unknown-phrase");

    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain("--resume");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  }, 20_000);

  it("rate limit 은 fresh 재시도하지 않고 호출자로 올린다 (failover 담당)", async () => {
    const { result, calls } = await runWithStaleResume("rate-limit");

    expect(calls).toHaveLength(1);
    expect(result.exitCode).not.toBe(0);
  }, 20_000);

  it("대화가 시작된 뒤 끊긴 실패는 fresh 재시도하지 않는다", async () => {
    const { result, calls } = await runWithStaleResume("mid-turn");

    expect(calls).toHaveLength(1);
    expect(result.exitCode).not.toBe(0);
  }, 20_000);
});
