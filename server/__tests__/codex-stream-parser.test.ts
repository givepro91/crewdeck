import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCodexJson } from "../core/agent/adapters/codex-stream-parser.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dir, "fixtures/codex-exec-basic.jsonl"), "utf-8");

describe("parseCodexJson", () => {
  it("agent_message item.text를 최종 텍스트로 추출", () => {
    const r = parseCodexJson(fixture);
    expect(r.text).toBe("작업을 완료했습니다.");
  });
  it("thread.started.thread_id를 sessionId로 추출", () => {
    expect(parseCodexJson(fixture).sessionId).toBe("019f45ac-d922-7b23-a938-a7df3b4f54d6");
  });
  it("turn.completed.usage에서 토큰 집계 (Codex는 cost 미보고 → 0)", () => {
    const u = parseCodexJson(fixture).usage!;
    expect(u.inputTokens).toBe(18041);
    expect(u.outputTokens).toBe(22);
    expect(u.cacheReadTokens).toBe(4992);
    expect(u.totalCostUsd).toBe(0);
  });
  it("item.type=='error'는 치명 실패로 보지 않는다(비치명 경고)", () => {
    expect(parseCodexJson(fixture).errors).toHaveLength(0);
  });
  it("빈/비JSONL 입력에 방어적", () => {
    expect(parseCodexJson("").text).toBe("");
    expect(parseCodexJson("not json\n{bad").text).toBe("");
  });
});
