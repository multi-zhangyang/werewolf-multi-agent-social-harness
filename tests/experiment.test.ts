import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createGame } from "../src/core/engine";
import {
  mergeExperimentOverrides,
  normalizeTournamentExperimentSpec,
  TOURNAMENT_EXPERIMENT_VERSION
} from "../src/harness/experiment";
import { describeResolvedAssignments, resolveAgentConfigs } from "../src/harness/profiles";

describe("tournament experiment spec", () => {
  it("normalizes the checked-in wolf-vs-village spec and pins profiles by team", async () => {
    const raw = JSON.parse(await readFile("experiments/wolf-vs-village.json", "utf8")) as unknown;
    const experiment = normalizeTournamentExperimentSpec(raw);
    const state = createGame({ id: "spec-team-assignment", seed: experiment.seed });
    const agents = resolveAgentConfigs(state.players, experiment.profiles, 0, experiment.temperature, experiment.assignment);
    const resolved = describeResolvedAssignments(state.players, agents);

    expect(experiment).toMatchObject({
      version: TOURNAMENT_EXPERIMENT_VERSION,
      id: "wolf-vs-village",
      kind: "tournament",
      seed: "wolf-vs-village-smoke",
      games: 3,
      maxTransitions: 24,
      jointPhaseScheduler: "aec-batched-decision",
      timeoutMs: 300000,
      temperature: 0.7,
      json: "summary",
      continueOnError: true
    });
    expect(experiment).not.toHaveProperty("timeout");
    expect(experiment.models).toEqual(["model-wolf", "model-village-a", "model-village-b"]);
    expect(experiment.profiles).toEqual([
      {
        id: "wolf-profile",
        model: "model-wolf",
        policyName: "wolf-deceiver",
        temperature: 0.7
      },
      {
        id: "village-profile-a",
        model: "model-village-a",
        policyName: "village-analyst",
        temperature: 0.35
      },
      {
        id: "village-profile-b",
        model: "model-village-b",
        policyName: "seer-information",
        temperature: 0.3
      }
    ]);
    expect(experiment.assignment).toEqual({
      strategy: "team",
      teams: {
        werewolves: "wolf-profile",
        village: ["village-profile-a", "village-profile-b"]
      },
      fallback: "error"
    });
    expect(resolved.filter((agent) => agent.team === "werewolves").every((agent) => agent.profileId === "wolf-profile")).toBe(true);
    expect(new Set(resolved.filter((agent) => agent.team === "village").map((agent) => agent.profileId))).toEqual(
      new Set(["village-profile-a", "village-profile-b"])
    );
  });

  it("merges CLI/API style overrides over spec defaults and env defaults under spec", () => {
    const spec = {
      version: TOURNAMENT_EXPERIMENT_VERSION,
      id: "base",
      kind: "tournament",
      seed: "base-seed",
      games: 3,
      timeout: "5m",
      profiles: [{ id: "base-profile", model: "base-model", temperature: 0.4 }]
    };
    const experiment = normalizeTournamentExperimentSpec(
      mergeExperimentOverrides(spec, {
        games: "1",
        maxTransitions: "2",
        timeout: "90s",
        seed: "override-seed"
      }),
      {
        models: "env-model",
        games: 9,
        timeout: "10m"
      }
    );

    expect(experiment).toMatchObject({
      version: TOURNAMENT_EXPERIMENT_VERSION,
      id: "base",
      kind: "tournament",
      temperature: 0.7,
      json: "summary",
      continueOnError: true
    });
    expect(experiment.seed).toBe("override-seed");
    expect(experiment.games).toBe(1);
    expect(experiment.maxTransitions).toBe(2);
    expect(experiment.timeoutMs).toBe(90000);
    expect(experiment.profiles).toHaveLength(1);
    expect(experiment.profiles[0]).toMatchObject({ id: "base-profile", model: "base-model", temperature: 0.4 });
    expect(experiment.models).toEqual(["base-model"]);
  });

  it("allows zero maxTransitions for no-model smoke runs", () => {
    const experiment = normalizeTournamentExperimentSpec({
      models: "alpha,beta",
      games: 1,
      maxTransitions: 0
    });

    expect(experiment.maxTransitions).toBe(0);
    expect(() => normalizeTournamentExperimentSpec({ models: "alpha", maxTransitions: -1 })).toThrow(/maxTransitions/);
  });

  it("records the joint-phase scheduler as an experiment condition and rejects an unreachable parallel condition", () => {
    const parallel = normalizeTournamentExperimentSpec({
      models: ["alpha", "beta"],
      games: 1,
      maxTransitions: 4,
      jointPhaseScheduler: "parallel"
    });
    const defaulted = normalizeTournamentExperimentSpec({ models: ["alpha"], games: 1, maxTransitions: 0 });

    expect(parallel.jointPhaseScheduler).toBe("parallel");
    expect(defaulted.jointPhaseScheduler).toBe("aec-batched-decision");
    expect(() =>
      normalizeTournamentExperimentSpec({
        models: ["alpha"],
        games: 1,
        maxTransitions: 3,
        jointPhaseScheduler: "parallel"
      })
    ).toThrow(/parallel requires maxTransitions >= 4/);
    expect(() => normalizeTournamentExperimentSpec({ models: ["alpha"], jointPhaseScheduler: "unknown" })).toThrow(
      /jointPhaseScheduler/
    );
  });

  it("keeps provider-qualified model ids intact in string model lists", () => {
    const experiment = normalizeTournamentExperimentSpec({
      models: "tencent/hy3:free openrouter/vendor:model,local-model",
      games: 1,
      maxTransitions: 2
    });

    expect(experiment.models).toEqual(["tencent/hy3:free", "openrouter/vendor:model", "local-model"]);
    expect(experiment.profiles.map((profile) => profile.model)).toEqual(experiment.models);
  });

  it("derives normalized models from explicit profiles instead of stale top-level models", () => {
    const experiment = normalizeTournamentExperimentSpec({
      models: ["stale-model"],
      profiles: [
        { id: "profile-a", model: "profile-model-a", temperature: 0.4 },
        { id: "profile-b", model: "profile-model-b", temperature: 0.6 },
        { id: "profile-c", model: "profile-model-a", temperature: 0.8 }
      ],
      games: 1
    });

    expect(experiment.models).toEqual(["profile-model-a", "profile-model-b"]);
    expect(experiment.models).not.toContain("stale-model");
    expect(experiment.profiles.map((profile) => profile.model)).toEqual(["profile-model-a", "profile-model-b", "profile-model-a"]);
  });

  it("rejects invalid experiment shape early", () => {
    expect(() => normalizeTournamentExperimentSpec({ version: "bad.version" })).toThrow(/version/);
    expect(() => normalizeTournamentExperimentSpec({ kind: "match" })).toThrow(/kind/);
    expect(() => normalizeTournamentExperimentSpec({ models: [], profiles: [], games: 0 })).toThrow(/model or profile|games/);
    expect(() => normalizeTournamentExperimentSpec({ models: ["opaque/model"], config: { sheriff: "invalid" as never } }))
      .toThrow(/sheriff/i);
    expect(() => normalizeTournamentExperimentSpec({ models: ["opaque/model"], config: { maxDays: 0 } }))
      .toThrow(/maxDays/i);
    expect(normalizeTournamentExperimentSpec({ models: ["vendor/model.v2:free"], games: 1 }).models)
      .toEqual(["vendor/model.v2:free"]);
  });
});
