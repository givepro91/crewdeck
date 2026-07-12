import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

export interface ProcessIdentity {
  startToken: string;
  executable: string;
  parentProcessId: number;
  processGroupId: number;
}

/** Crewdeck adapter가 subprocess 환경에 주입한 per-session ownership token. */
export function readProcessOwnerToken(processId: number): string | null {
  try {
    if (process.platform === "linux") {
      const entry = readFileSync(`/proc/${processId}/environ`, "utf-8")
        .split("\0")
        .find((value) => value.startsWith("CREWDECK_AGENT_ID="));
      return entry?.slice("CREWDECK_AGENT_ID=".length) || null;
    }
    const commandAndEnvironment = execFileSync(
      "ps",
      ["eww", "-p", String(processId), "-o", "command="],
      { encoding: "utf-8" },
    );
    return commandAndEnvironment.match(/(?:^|\s)CREWDECK_AGENT_ID=([^\s]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function readPsField(processId: number, field: string): string | null {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(processId)], {
      encoding: "utf-8",
    }).trim() || null;
  } catch {
    return null;
  }
}

/** PID reuse를 구분하고 process-group 소유권을 검증하기 위한 OS identity. */
export function readProcessIdentity(processId: number): ProcessIdentity | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${processId}/stat`, "utf-8");
      const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const parentProcessId = Number(afterCommand[1]);
      const processGroupId = Number(afterCommand[2]);
      const startToken = afterCommand[19];
      const executable = readlinkSync(`/proc/${processId}/exe`);
      if (!startToken || !executable || !Number.isInteger(parentProcessId) || !Number.isInteger(processGroupId)) return null;
      return { startToken, executable, parentProcessId, processGroupId };
    }

    const startToken = readPsField(processId, "lstart")?.replace(/\s+/g, " ");
    const executable = readPsField(processId, "comm");
    const parentProcessIdRaw = readPsField(processId, "ppid");
    const processGroupIdRaw = readPsField(processId, "pgid");
    if (!startToken || !executable || !parentProcessIdRaw || !processGroupIdRaw) return null;
    const parentProcessId = Number(parentProcessIdRaw);
    const processGroupId = Number(processGroupIdRaw);
    if (!Number.isInteger(parentProcessId) || !Number.isInteger(processGroupId)) return null;
    return { startToken, executable, parentProcessId, processGroupId };
  } catch {
    return null;
  }
}

/** PID reuse를 구분하기 위한 OS process start identity. */
export function readProcessStartIdentity(processId: number): string | null {
  return readProcessIdentity(processId)?.startToken ?? null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function processGroupHasLiveMembers(processGroupId: number): boolean | null {
  try {
    const rows = execFileSync("ps", ["-axo", "pgid=,state="], { encoding: "utf-8" });
    return rows.split("\n").some((row) => {
      const match = row.trim().match(/^(\d+)\s+(\S+)/);
      return match?.[1] === String(processGroupId) && !match[2].startsWith("Z");
    });
  } catch {
    return null;
  }
}

function targetIsAlive(processId: number): boolean {
  if (process.platform !== "win32") {
    const groupState = processGroupHasLiveMembers(processId);
    if (groupState !== null) return groupState;
  }
  try {
    process.kill(process.platform === "win32" ? processId : -processId, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(processId: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (targetIsAlive(processId)) {
    if (Date.now() >= deadline) return false;
    sleepSync(25);
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExitAsync(processId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (targetIsAlive(processId)) {
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(25, deadline - Date.now()));
  }
  return true;
}

/** Timer callback에서 이벤트 루프를 막지 않고 detached process group을 종료한다. */
export async function terminateProcessGroup(processId: number, sigkillTimeoutMs: number): Promise<void> {
  const target = process.platform === "win32" ? processId : -processId;
  try {
    process.kill(target, "SIGTERM");
  } catch (error: any) {
    if (error?.code !== "ESRCH") throw error;
    return;
  }
  if (await waitForExitAsync(processId, sigkillTimeoutMs)) return;
  try {
    process.kill(target, "SIGKILL");
  } catch (error: any) {
    if (error?.code !== "ESRCH") throw error;
    return;
  }
  if (!await waitForExitAsync(processId, sigkillTimeoutMs)) {
    throw new Error(`Process group ${processId} remained alive after SIGKILL`);
  }
}

/**
 * detached CLI process group에 SIGTERM을 보내고, timeout 후 SIGKILL로 승격한다.
 * 반환 시점에는 group 종료를 확인했으며, SIGKILL 후에도 살아 있으면 실패한다.
 */
export function terminateProcessGroupSync(processId: number, sigkillTimeoutMs: number): void {
  const target = process.platform === "win32" ? processId : -processId;
  try {
    process.kill(target, "SIGTERM");
  } catch (error: any) {
    if (error?.code !== "ESRCH") throw error;
    return;
  }
  if (waitForExit(processId, sigkillTimeoutMs)) return;
  try {
    process.kill(target, "SIGKILL");
  } catch (error: any) {
    if (error?.code !== "ESRCH") throw error;
    return;
  }
  if (!waitForExit(processId, sigkillTimeoutMs)) {
    throw new Error(`Process group ${processId} remained alive after SIGKILL`);
  }
}
