import { describe, it, expect } from "vitest";
import { extractJsonArray } from "../utils/llm-json.js";

/**
 * Regression tests for LLM JSON-array extraction.
 *
 * The reported crash: goal suggestion (`goals.ts`) and team design
 * (`team-designer.ts`) used a greedy `/(\[[\s\S]*\])/` fallback. When the
 * model answered with prose containing bracketed Korean text like
 * `[증거→주장, verification]` and no real JSON array, the greedy regex fed
 * that prose to JSON.parse → `Unexpected token '증' ... is not valid JSON`,
 * an unhandled SyntaxError that surfaced in the "목표 추가" dialog.
 */
describe("extractJsonArray", () => {
  it("parses a clean top-level array", () => {
    const arr = extractJsonArray('[{"title":"A"},{"title":"B"}]');
    expect(arr).toEqual([{ title: "A" }, { title: "B" }]);
  });

  it("parses an array inside a ```json fence", () => {
    const raw = "Here you go:\n```json\n[{\"title\":\"A\"}]\n```\nDone.";
    expect(extractJsonArray(raw)).toEqual([{ title: "A" }]);
  });

  it("REGRESSION: skips prose brackets and finds the real array", () => {
    const raw =
      "다음은 목표입니다 [증거→주장, verification 흐름 개선] 아래 JSON 참고:\n" +
      '[\n  {"title":"검증 강화","priority":"high"}\n]';
    expect(extractJsonArray(raw)).toEqual([
      { title: "검증 강화", priority: "high" },
    ]);
  });

  it("REGRESSION: returns null (not a crash) when there is only prose", () => {
    const raw = "죄송합니다. [증거→주장, verification]에 대한 제안을 드릴 수 없습니다.";
    expect(extractJsonArray(raw)).toBeNull();
  });

  it("respects bracket characters inside string values", () => {
    const raw = '[{"description":"handle [증거→주장] flow","title":"T"}]';
    expect(extractJsonArray(raw)).toEqual([
      { description: "handle [증거→주장] flow", title: "T" },
    ]);
  });

  it("does not over-capture when trailing prose contains a ]", () => {
    const raw = '[{"title":"A"}]\n\n추가 설명 [참고] 끝.';
    expect(extractJsonArray(raw)).toEqual([{ title: "A" }]);
  });

  it("returns null on a truncated / unterminated array", () => {
    const raw = '[{"title":"A"}, {"title":"B"';
    expect(extractJsonArray(raw)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractJsonArray("")).toBeNull();
  });

  it("ignores a non-array fence and falls back to the bracket scan", () => {
    const raw = '```json\n{"not":"array"}\n```\n[{"title":"A"}]';
    expect(extractJsonArray(raw)).toEqual([{ title: "A" }]);
  });
});
