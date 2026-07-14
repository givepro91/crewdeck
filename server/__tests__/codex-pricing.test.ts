import { describe, it, expect } from "vitest";
import {
  estimateCodexCostUsd,
  rateForCodexModel,
} from "../core/agent/adapters/codex-pricing.js";
import { parseCodexJson } from "../core/agent/adapters/codex-stream-parser.js";

describe("codex-pricing", () => {
  it("gpt-5 계열 모델은 공개 단가로 추정한다", () => {
    // input은 cached를 포함 → uncached=800k 정가, cached=200k 캐시단가, output=500k 정가
    const { costUsd, priced } = estimateCodexCostUsd("gpt-5.6-sol", {
      inputTokens: 1_000_000,
      cacheReadTokens: 200_000,
      outputTokens: 500_000,
    });
    expect(priced).toBe(true);
    // (800000*1.25 + 200000*0.125 + 500000*10)/1e6 = 6.025
    expect(costUsd).toBeCloseTo(6.025, 6);
  });

  it("gpt-5.4 / gpt-5-codex 등 gpt-5* 도 계열 단가로 매칭된다", () => {
    expect(rateForCodexModel("gpt-5.4")).not.toBeNull();
    expect(rateForCodexModel("gpt-5-codex")).not.toBeNull();
  });

  it("알 수 없는 모델·undefined는 추정하지 않는다(fabrication 금지)", () => {
    expect(estimateCodexCostUsd("claude-opus", { inputTokens: 100, cacheReadTokens: 0, outputTokens: 100 })).toEqual({ costUsd: 0, priced: false });
    expect(estimateCodexCostUsd(undefined, { inputTokens: 100, cacheReadTokens: 0, outputTokens: 100 })).toEqual({ costUsd: 0, priced: false });
  });

  it("cached가 input보다 커도 uncached는 음수로 내려가지 않는다", () => {
    const { costUsd } = estimateCodexCostUsd("gpt-5", {
      inputTokens: 100,
      cacheReadTokens: 500,
      outputTokens: 0,
    });
    // uncached=0, cached는 실제 cacheReadTokens(500) 그대로 과금
    expect(costUsd).toBeCloseTo((500 * 0.125) / 1_000_000, 9);
  });
});

describe("parseCodexJson × 비용 역산", () => {
  const stream = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1000000,"cached_input_tokens":200000,"output_tokens":500000}}',
  ].join("\n");

  it("모델이 주어지면 추정 비용을 채우고 costEstimated=true, costUsdReported=false", () => {
    const parsed = parseCodexJson(stream, { model: "gpt-5.6-sol" });
    expect(parsed.usage).not.toBeNull();
    expect(parsed.usage!.totalCostUsd).toBeCloseTo(6.025, 6);
    expect(parsed.usage!.costEstimated).toBe(true);
    expect(parsed.usage!.costUsdReported).toBe(false); // CLI 실보고 아님 — 추정치
    expect(parsed.usage!.tokenUsageReported).toBe(true);
  });

  it("모델이 없으면 비용 0 · costEstimated=false (기존 동작 유지)", () => {
    const parsed = parseCodexJson(stream);
    expect(parsed.usage!.totalCostUsd).toBe(0);
    expect(parsed.usage!.costEstimated).toBe(false);
  });
});
