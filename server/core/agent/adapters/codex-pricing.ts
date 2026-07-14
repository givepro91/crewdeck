/**
 * Codex 비용 추정 — `codex exec --json` 스트림은 cost를 보고하지 않고(claude와 달리
 * total_cost_usd가 없다), 토큰만 준다. 그래서 토큰 사용량 × 공개 단가로 비용을 역산한다.
 *
 * ⚠ 이 값은 항상 "추정치(estimate)"다. 실제 청구가 아니다:
 *  - crewdeck는 Codex를 `-m` 없이 spawn하므로 세션이 쓴 모델 = `~/.codex/config.toml`의
 *    기본 모델(예: gpt-5.6-sol). 이 내부 모델명은 공개 가격표에 없어, 같은 gpt-5 계열의
 *    공개 API 단가를 proxy로 쓴다.
 *  - Codex를 구독으로 쓰면 한계비용은 사실상 0이다. 이 추정치는 claude 어댑터가 보고하는
 *    total_cost_usd(구독이어도 notional API 환산가)와 같은 기준(notional)으로 맞춰,
 *    대시보드의 멀티백엔드 비용 비교가 Codex만 $0으로 깨지지 않게 하는 용도다.
 *  - reasoning tokens는 파서가 집계하지 않으므로 비용에서 제외된다(보수적 과소추정).
 * 따라서 이 비용은 `costUsdReported=false`(CLI 실보고 아님) + `costEstimated=true`로만 기록하고,
 * UI에서 실측 비용과 구분(≈)한다.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageInfo } from "./stream-parser.js";

/** USD per 1M tokens. OpenAI gpt-5 공개 API 정가(2025) — gpt-5.x 계열 proxy. 계열 단가가 바뀌면 여기만 조정. */
const GPT5_FAMILY_RATE = { input: 1.25, cachedInput: 0.125, output: 10.0 };

/**
 * 모델명 → 단가. 알 수 없는 모델은 null(추정 안 함 — $0 유지, fabrication 금지).
 * gpt-5 계열은 전부 gpt-5 공개 단가를 proxy로 적용한다(gpt-5.4 / gpt-5.6-sol / gpt-5-codex 등).
 */
export function rateForCodexModel(model: string | undefined): typeof GPT5_FAMILY_RATE | null {
  if (!model) return null;
  if (model.startsWith("gpt-5")) return GPT5_FAMILY_RATE;
  return null;
}

/**
 * usage 토큰으로 추정 비용(USD)을 계산한다. 알 수 없는 모델이면 { costUsd: 0, priced: false }.
 * input_tokens는 cached_input_tokens를 포함한다고 가정(OpenAI usage 규약)하여
 * uncached만 정가, cached는 캐시 단가로 나눠 청구한다.
 */
export function estimateCodexCostUsd(
  model: string | undefined,
  usage: Pick<UsageInfo, "inputTokens" | "outputTokens" | "cacheReadTokens">,
): { costUsd: number; priced: boolean } {
  const rate = rateForCodexModel(model);
  if (!rate) return { costUsd: 0, priced: false };
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
  const costUsd =
    (uncachedInput * rate.input +
      usage.cacheReadTokens * rate.cachedInput +
      usage.outputTokens * rate.output) /
    1_000_000;
  return { costUsd, priced: true };
}

/** 해석된 codex 모델 캐시(프로세스 1회 파일 읽기). */
let cachedCodexModel: { value: string | undefined } | null = null;

/**
 * 이 머신의 Codex가 실제로 쓸 모델을 해석한다. crewdeck는 `-m` 없이 spawn하므로
 * `~/.codex/config.toml`의 `model = "..."` 기본값이 세션이 쓰는 모델이다.
 * 없으면 undefined(→ 추정 안 함). 결과는 프로세스 수명 동안 캐시한다.
 */
export function resolveCodexModel(): string | undefined {
  if (cachedCodexModel) return cachedCodexModel.value;
  let value: string | undefined;
  try {
    const p = join(homedir(), ".codex", "config.toml");
    if (existsSync(p)) {
      // 최상위 `model = "..."`만 읽는다(프로필/서브테이블의 model은 무시).
      for (const line of readFileSync(p, "utf-8").split("\n")) {
        const m = line.match(/^\s*model\s*=\s*"([^"]+)"/);
        if (m) {
          value = m[1];
          break;
        }
      }
    }
  } catch {
    value = undefined;
  }
  cachedCodexModel = { value };
  return value;
}

/** 테스트용 — 캐시 리셋. */
export function __resetCodexModelCache(): void {
  cachedCodexModel = null;
}
