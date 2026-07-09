import { describe, it, expect } from "vitest";
import { autoDetectScope } from "../core/quality-gate/evaluator.js";

// 조건부 검증: "항상 경량, UI/위험만 풀"
describe("autoDetectScope (conditional depth)", () => {
  it("UI target files (.tsx) → full (browser repro)", () => {
    expect(autoDetectScope({ title: "버튼 추가", description: "", target_files: '["src/ui/Panel.tsx"]' })).toBe("full");
    expect(autoDetectScope({ title: "스타일", description: "", target_files: '["a.css"]' })).toBe("full");
  });

  it("plain logic, small → lite", () => {
    expect(autoDetectScope({ title: "유틸 함수 추가", description: "", target_files: '["src/lib/util.ts"]' })).toBe("lite");
  });

  it("high-risk keyword → full even without UI", () => {
    expect(autoDetectScope({ title: "auth 토큰 갱신", description: "", target_files: '["src/auth.ts"]' })).toBe("full");
  });

  it("missing/invalid target_files → falls back safely (lite)", () => {
    expect(autoDetectScope({ title: "메모 정리", description: "", target_files: null })).toBe("lite");
    expect(autoDetectScope({ title: "메모 정리", description: "", target_files: "not-json" })).toBe("lite");
  });

  it("valid JSON but non-array target_files → no throw, safe lite", () => {
    // '"a.tsx"' → 문자열, '{}' → 객체 — .some 호출 전 Array.isArray 가드로 throw 방지
    expect(autoDetectScope({ title: "메모", description: "", target_files: '"a.tsx"' })).toBe("lite");
    expect(autoDetectScope({ title: "메모", description: "", target_files: "{}" })).toBe("lite");
  });
});
