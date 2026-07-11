import { describe, it, expect } from "vitest";
import { parseVerificationResult, validateStructuredEvaluation } from "../core/quality-gate/evaluator.js";
import { extractJsonBlock } from "../core/agent/stream-parser.js";

const dimensionJudgements = [
  { dimension: "functionality", verdict: "pass", evidence: "npm test 통과" },
  { dimension: "dataFlow", verdict: "pass", evidence: "저장/조회 경로 확인" },
  { dimension: "designAlignment", verdict: "pass", evidence: "기존 adapter 패턴과 일치" },
  { dimension: "craft", verdict: "pass", evidence: "typecheck 통과" },
  { dimension: "edgeCases", verdict: "pass", evidence: "빈 입력 테스트 통과" },
];

const structuredIssue = {
  dimension: "functionality",
  severity: "critical",
  file: "a.ts",
  line: 5,
  message: "null 입력에서 crash",
  reproCommand: "npm test -- null-case",
  expectedResult: "오류 응답 반환",
  actualResult: "TypeError 발생",
  fixInstruction: "null guard를 추가한다",
};

function evaluation(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "pass",
    severity: "auto-resolve",
    dimensionJudgements,
    issues: [],
    ...overrides,
  };
}

function fenced(payload: unknown): string {
  return `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

describe("validateStructuredEvaluation", () => {
  it("rejects legacy output without the structured contract", () => {
    const v = validateStructuredEvaluation({ verdict: "pass", severity: "auto-resolve", issues: [] });
    expect(v.structured).toBe(true);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("dimensionJudgements"))).toBe(true);
  });

  it("requires all five dimensions exactly once", () => {
    const one = validateStructuredEvaluation(evaluation({ dimensionJudgements: dimensionJudgements.slice(0, 1) }));
    const duplicate = validateStructuredEvaluation(evaluation({
      dimensionJudgements: [...dimensionJudgements.slice(0, 4), dimensionJudgements[0]],
    }));
    expect(one.ok).toBe(false);
    expect(one.errors).toContain("dimensionJudgements missing dimension: dataFlow");
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("rejects invalid verdict/dimension/severity enums", () => {
    const v = validateStructuredEvaluation(evaluation({
      verdict: "maybe",
      issues: [{ ...structuredIssue, dimension: "wat", severity: "urgent" }],
    }));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.startsWith("verdict invalid enum"))).toBe(true);
    expect(v.errors.some((e) => e.includes("dimension invalid enum"))).toBe(true);
    expect(v.errors.some((e) => e.includes("severity invalid enum"))).toBe(true);
  });

  it.each([
    ["message", { ...structuredIssue, message: "" }],
    ["reproCommand", { ...structuredIssue, reproCommand: "   " }],
    ["expectedResult", { ...structuredIssue, expectedResult: undefined }],
    ["actualResult", { ...structuredIssue, actualResult: undefined }],
    ["fixInstruction", { ...structuredIssue, fixInstruction: undefined }],
  ])("rejects missing/empty issue field %s", (field, issue) => {
    const v = validateStructuredEvaluation(evaluation({ verdict: "fail", severity: "hard-block", issues: [issue] }));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes(String(field)))).toBe(true);
  });

  it("rejects mixed structured and legacy issues", () => {
    const v = validateStructuredEvaluation(evaluation({
      verdict: "fail",
      severity: "hard-block",
      issues: [structuredIssue, { severity: "high", message: "legacy" }],
    }));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.startsWith("issues[1].dimension"))).toBe(true);
  });

  it("accepts a complete five-dimension evaluation", () => {
    expect(validateStructuredEvaluation(evaluation({
      verdict: "fail",
      severity: "hard-block",
      issues: [structuredIssue],
    }))).toEqual({ structured: true, ok: true, errors: [] });
  });

  it("rejects verdict pass with a critical issue still present", () => {
    const v = validateStructuredEvaluation(evaluation({
      verdict: "pass",
      issues: [structuredIssue],
    }));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("critical"))).toBe(true);
  });

  it("rejects verdict pass with a high severity issue still present", () => {
    const v = validateStructuredEvaluation(evaluation({
      verdict: "pass",
      issues: [{ ...structuredIssue, severity: "high" }],
    }));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("high"))).toBe(true);
  });

  it("rejects verdict fail with no issues (no repro for the fix loop)", () => {
    const v = validateStructuredEvaluation(evaluation({
      verdict: "fail",
      severity: "hard-block",
      issues: [],
    }));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes("requires at least one issue"))).toBe(true);
  });
});

describe("parseVerificationResult", () => {
  it("invalid structured output becomes evaluator_error", () => {
    const r = parseVerificationResult("t1", fenced({ verdict: "pass", issues: [] }), "lite", "e1", "code");
    expect(r.verdict).toBe("fail");
    expect(r.terminationReason).toBe("evaluator_error");
    expect(r.issues.some((i) => i.id === "issue-evaluator-error")).toBe(true);
  });

  it("preserves dimension judgements and structured issue fields", () => {
    const r = parseVerificationResult(
      "t1",
      fenced(evaluation({ verdict: "fail", severity: "hard-block", issues: [structuredIssue] })),
      "full",
      "e1",
      "code",
    );
    expect(r.verdict).toBe("fail");
    expect(r.dimensionJudgements).toEqual(dimensionJudgements);
    expect(r.dimensions.functionality).toEqual({ value: 10, notes: "npm test 통과" });
    expect(r.issues[0]).toMatchObject({
      dimension: "functionality",
      reproCommand: "npm test -- null-case",
      expectedResult: "오류 응답 반환",
      actualResult: "TypeError 발생",
      fixInstruction: "null guard를 추가한다",
    });
    expect(r.terminationReason).toBe("hard_blocked");
  });

  it("valid pass records passed termination reason", () => {
    const r = parseVerificationResult("t1", fenced(evaluation()), "lite", "e1", "code");
    expect(r.verdict).toBe("pass");
    expect(r.terminationReason).toBe("passed");
    expect(r.issues).toEqual([]);
  });

  it("content threshold failure creates a structured issue for the fix loop", () => {
    const r = parseVerificationResult("t1", fenced(evaluation({
      dimensions: {
        completeness: { value: 3 },
        consistency: { value: 3 },
        clarity: { value: 3 },
      },
    })), "standard", "e1", "content");
    expect(r.verdict).toBe("fail");
    expect(r.terminationReason).toBeNull();
    expect(r.issues).toEqual([expect.objectContaining({
      id: "issue-content-threshold",
      dimension: "craft",
      severity: "high",
      reproCommand: "Crewdeck Quality Gate 재검증: task=t1, type=content",
      expectedResult: expect.stringContaining("6.0 이상"),
      actualResult: expect.stringContaining("average=3.0"),
      fixInstruction: expect.stringContaining("동일 Quality Gate"),
    })]);
  });

  it("config threshold failure creates a structured issue for the fix loop", () => {
    const r = parseVerificationResult("t2", fenced(evaluation({
      dimensions: {
        validity: { value: 9 },
        security: { value: 7 },
      },
    })), "standard", "e2", "config");
    expect(r.verdict).toBe("fail");
    expect(r.terminationReason).toBeNull();
    expect(r.issues).toEqual([expect.objectContaining({
      id: "issue-config-threshold",
      dimension: "craft",
      severity: "high",
      reproCommand: "Crewdeck Quality Gate 재검증: task=t2, type=config",
      expectedResult: expect.stringContaining("모두 8.0 이상"),
      actualResult: "validity=9, security=7",
      fixInstruction: expect.stringContaining("동일 Quality Gate"),
    })]);
  });

  it("garbage returns parse-error signal", () => {
    const r = parseVerificationResult("t1", "no json here", "lite", "e1", "code");
    expect(r.verdict).toBe("fail");
    expect(r.terminationReason).toBe("evaluator_error");
    expect(r.issues.some((i) => i.id === "issue-parse-error")).toBe(true);
  });
});

describe("extractJsonBlock", () => {
  it("prefers fenced json block", () => {
    expect(extractJsonBlock('prefix ```json\n{"verdict":"pass"}\n``` suffix')).toBe('{"verdict":"pass"}');
  });

  it("falls back to bare verdict object", () => {
    expect(extractJsonBlock('noise {"verdict":"fail","x":1} tail')).toBe('{"verdict":"fail","x":1}');
  });

  it("returns null when no json", () => {
    expect(extractJsonBlock("no json here")).toBeNull();
    expect(extractJsonBlock("")).toBeNull();
  });

  it("does not truncate at a code fence embedded inside a JSON string field", () => {
    // Evaluator writes fixInstruction/reproCommand in Korean prose that often
    // embeds a ```bash snippet. A non-greedy fence matcher stops at that inner
    // ``` and truncates the JSON → "evaluator did not return valid JSON".
    const payload = {
      verdict: "fail",
      severity: "hard-block",
      dimensionJudgements,
      issues: [{ ...structuredIssue, fixInstruction: "실행: ```bash\nnpm test\n``` 후 확인" }],
    };
    const out = "리뷰 결과입니다.\n\n```json\n" + JSON.stringify(payload) + "\n```";
    const extracted = extractJsonBlock(out);
    expect(extracted).not.toBeNull();
    expect(() => JSON.parse(extracted!)).not.toThrow();
    expect(JSON.parse(extracted!).verdict).toBe("fail");
  });

  it("does not truncate at a ```json fence embedded inside a JSON string field", () => {
    const out = '```json\n{"verdict":"pass","note":"see ```json X``` above","issues":[]}\n```';
    const extracted = extractJsonBlock(out);
    expect(extracted).not.toBeNull();
    expect(JSON.parse(extracted!)).toMatchObject({ verdict: "pass" });
  });
});
