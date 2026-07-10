/**
 * LLM 출력에서 JSON을 견고하게 추출하는 유틸.
 *
 * 배경: 모델은 요청한 JSON 형식 대신 산문을 반환하거나, 산문 속에 대괄호
 * 평문(예: `[증거→주장, verification]`)을 섞어 넣기도 한다. 순진한 greedy
 * 정규식 `/(\[[\s\S]*\])/`는 그런 평문을 붙잡아 `JSON.parse` 크래시를 낸다
 * (`Unexpected token '증' ...`). 여기서는 문자열 리터럴을 존중하는 balanced
 * 스캔으로 "실제 배열로 파싱되는 첫 후보"만 채택한다.
 */

/**
 * `raw[start]` 가 여는 괄호(`open`)라고 가정하고, 문자열 리터럴을 존중하며
 * 괄호 균형이 0으로 돌아오는 지점까지의 부분 문자열을 반환한다. 균형이 맞지
 * 않으면(잘린 입력) null.
 */
function sliceBalanced(raw: string, start: number, open: "[" | "{"): string | null {
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * LLM 출력에서 최상위 JSON 배열을 추출한다.
 *
 * 전략:
 *   1. ```json 펜스 블록이 있으면 그 안을 먼저 시도.
 *   2. 각 `[` 위치에서 balanced 슬라이스를 잘라 JSON.parse — 배열로 파싱되는
 *      첫 후보를 반환. (프로즈 대괄호는 파싱에 실패해 자연히 건너뛰어진다.)
 *   3. 전체 raw를 마지막으로 시도.
 * 어느 것도 배열로 파싱되지 않으면 null (호출부가 우아하게 degrade).
 */
export function extractJsonArray(raw: string): unknown[] | null {
  if (!raw) return null;

  const tryParse = (s: string): unknown[] | null => {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  // 1. ```json 펜스 블록 우선
  const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) {
    const arr = tryParse(fenced[1].trim());
    if (arr) return arr;
  }

  // 2. 각 '[' 에서 balanced 배열 슬라이스 시도
  for (let start = raw.indexOf("["); start !== -1; start = raw.indexOf("[", start + 1)) {
    const slice = sliceBalanced(raw, start, "[");
    if (!slice) continue;
    const arr = tryParse(slice);
    if (arr) return arr;
  }

  // 3. 마지막 수단 — 전체 raw
  return tryParse(raw.trim());
}
