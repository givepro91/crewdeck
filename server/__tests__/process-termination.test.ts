import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "../core/agent/adapters/claude-code.js";
import { createCodexAdapter } from "../core/agent/adapters/codex.js";
import type { AgentSession } from "../core/agent/adapters/backend.js";
import { processGroupHasLiveMembers, terminateProcessGroupSync } from "../core/agent/process-identity.js";

let processId: number | null = null;
let dir: string | null = null;
const originalPath = process.env.PATH;

afterEach(() => {
  if (processId) {
    try { process.kill(-processId, "SIGKILL"); } catch { /* already gone */ }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  processId = null;
  dir = null;
  process.env.PATH = originalPath;
});

async function waitForProcessId(path: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const value = Number(readFileSync(path, "utf-8"));
      if (Number.isInteger(value) && value > 0) return value;
    } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process fixture did not become ready: ${path}`);
}

function installIgnoringCli(name: "claude" | "codex", workdir: string, emitOutput = false): string {
  const binDir = join(workdir, "bin");
  mkdirSync(binDir);
  const executable = join(binDir, name);
  writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
writeFileSync(join(process.cwd(), "leader-ready"), String(process.pid));
writeFileSync(join(process.cwd(), "descendant-ready"), String(descendant.pid));
${emitOutput ? 'process.stdout.write("ready\\n");' : ""}
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  return join(workdir, "descendant-ready");
}

describe("adapter process group termination", () => {
  it("SIGTERM을 무시하는 group을 timeout 후 SIGKILL로 종료한다", async () => {
    dir = mkdtempSync(join(tmpdir(), "crewdeck-kill-test-"));
    const ready = join(dir, "ready");
    const child = spawn(process.execPath, [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`,
    ], { detached: true, stdio: "ignore" });
    if (!child.pid) throw new Error("termination fixture did not spawn");
    processId = child.pid;

    expect(await waitForProcessId(ready)).toBe(processId);

    terminateProcessGroupSync(processId, 100);
    expect(processGroupHasLiveMembers(processId)).toBe(false);
    processId = null;
  });

  it.each(["claude", "codex"] as const)("%s adapter kill은 SIGTERM 무시 descendant까지 종료한 뒤 반환한다", async (provider) => {
    dir = mkdtempSync(join(tmpdir(), `crewdeck-${provider}-kill-test-`));
    const descendantReady = installIgnoringCli(provider, dir);
    const session: AgentSession = provider === "claude"
      ? createClaudeCodeAdapter().spawn({
          workdir: dir,
          systemPrompt: "test",
          sessionBehavior: "new",
        })
      : createCodexAdapter().spawn({
          workdir: dir,
          systemPrompt: "test",
          sessionBehavior: "new",
        });

    const resultPromise = session.send("test");
    processId = await waitForProcessId(join(dir, "leader-ready"));
    const descendantId = await waitForProcessId(descendantReady);
    expect(processGroupHasLiveMembers(processId)).toBe(true);

    session.kill();

    expect(processGroupHasLiveMembers(processId)).toBe(false);
    expect(() => process.kill(descendantId, 0)).toThrow();
    expect(session.process).toBeNull();
    expect(session.status).toBe("idle");
    processId = null;
    await resultPromise;
    session.cleanup();
  }, 20_000);

  it.each(["claude", "codex"] as const)("%s hard timeout은 SIGTERM 무시 descendant까지 종료한다", async (provider) => {
    dir = mkdtempSync(join(tmpdir(), `crewdeck-${provider}-timeout-test-`));
    const descendantReady = installIgnoringCli(provider, dir);
    const runtime = { taskTimeoutMs: 200, sigkillTimeoutMs: 100 };
    const session: AgentSession = provider === "claude"
      ? createClaudeCodeAdapter(runtime).spawn({
          workdir: dir,
          systemPrompt: "test",
          sessionBehavior: "new",
        })
      : createCodexAdapter(runtime).spawn({
          workdir: dir,
          systemPrompt: "test",
          sessionBehavior: "new",
        });

    const resultPromise = session.send("test");
    processId = await waitForProcessId(join(dir, "leader-ready"));
    const descendantId = await waitForProcessId(descendantReady);
    let groupWasGoneAtTimeout = false;
    session.on("crewdeck:error", () => {
      groupWasGoneAtTimeout = processGroupHasLiveMembers(processId!) === false;
    });
    let groupWasGoneAtFailure = false;
    session.on("status", (status) => {
      if (status === "failed") groupWasGoneAtFailure = processGroupHasLiveMembers(processId!) === false;
    });
    const result = await resultPromise;

    expect(result.exitCode).not.toBe(0);
    expect(groupWasGoneAtTimeout).toBe(true);
    expect(groupWasGoneAtFailure).toBe(true);
    expect(processGroupHasLiveMembers(processId)).toBe(false);
    expect(() => process.kill(descendantId, 0)).toThrow();
    processId = null;
    session.cleanup();
  }, 20_000);

  it("claude idle timeout은 SIGTERM 무시 descendant까지 종료한다", async () => {
    dir = mkdtempSync(join(tmpdir(), "crewdeck-claude-idle-timeout-test-"));
    const descendantReady = installIgnoringCli("claude", dir, true);
    const session = createClaudeCodeAdapter({ taskTimeoutMs: 200, sigkillTimeoutMs: 100 }).spawn({
      workdir: dir,
      systemPrompt: "test",
      sessionBehavior: "new",
    });

    const resultPromise = session.send("test");
    processId = await waitForProcessId(join(dir, "leader-ready"));
    const descendantId = await waitForProcessId(descendantReady);
    let groupWasGoneAtTimeout = false;
    session.on("crewdeck:error", () => {
      groupWasGoneAtTimeout = processGroupHasLiveMembers(processId!) === false;
    });
    let groupWasGoneAtFailure = false;
    session.on("status", (status) => {
      if (status === "failed") groupWasGoneAtFailure = processGroupHasLiveMembers(processId!) === false;
    });
    const result = await resultPromise;

    expect(result.exitCode).not.toBe(0);
    expect(groupWasGoneAtTimeout).toBe(true);
    expect(groupWasGoneAtFailure).toBe(true);
    expect(processGroupHasLiveMembers(processId)).toBe(false);
    expect(() => process.kill(descendantId, 0)).toThrow();
    processId = null;
    session.cleanup();
  }, 20_000);
});
