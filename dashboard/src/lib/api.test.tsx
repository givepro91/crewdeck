import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Goal Spec API response guard", () => {
  it("accepts the common state wrapper and rejects the legacy shape", async () => {
    const { parseGoalSpecState } = await import("./api");
    const missing = {
      goal_id: "g1",
      status: "missing",
      generation_status: "idle",
      generation_error: null,
      execution_spec_version_id: null,
      versions: [],
    };

    expect(parseGoalSpecState(missing)).toEqual({
      goal_id: "g1",
      status: "missing",
      execution_spec_version_id: null,
      versions: [],
    });
    expect(() => parseGoalSpecState({ prd_summary: {}, feature_specs: [] })).toThrow("Invalid blueprint response");
  });

  it("projects version snapshots without unknown server fields", async () => {
    const { parseGoalSpecState } = await import("./api");
    const parsed = parseGoalSpecState({
      goal_id: "g1",
      status: "draft",
      execution_spec_version_id: null,
      versions: [{
        id: "v1",
        version: 1,
        state: "draft",
        scope: "scope",
        out_of_scope: "out",
        acceptance_criteria: ["accepted"],
        expected_tasks: ["task"],
        verification_methods: ["test"],
        created_at: "2026-07-12T00:00:00.000Z",
        approved_at: null,
        secret_extra: "must not reach the store",
      }],
    });

    expect(parsed.versions[0]).toEqual({
      id: "v1",
      version: 1,
      state: "draft",
      scope: "scope",
      out_of_scope: "out",
      acceptance_criteria: ["accepted"],
      expected_tasks: ["task"],
      verification_methods: ["test"],
      created_at: "2026-07-12T00:00:00.000Z",
      approved_at: null,
    });
    expect(parsed.versions[0]).not.toHaveProperty("secret_extra");
  });

  it("surfaces the actionable validation message and field location", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_spec",
      message: "scope is required",
      location: "scope",
    }), { status: 400, headers: { "content-type": "application/json" } })));
    const { api } = await import("./api");

    await expect(api.goals.saveSpec("g1", {
      scope: "",
      out_of_scope: "",
      acceptance_criteria: [],
      expected_tasks: [],
      verification_methods: [],
    })).rejects.toMatchObject({
      message: "scope is required",
      code: "invalid_spec",
      location: "scope",
    });
  });

  it("rejects a response for a different goal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      goal_id: "other-goal",
      status: "missing",
      execution_spec_version_id: null,
      versions: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const { api } = await import("./api");

    await expect(api.goals.getSpec("requested-goal")).rejects.toThrow("Blueprint response goal_id mismatch");
  });
});
