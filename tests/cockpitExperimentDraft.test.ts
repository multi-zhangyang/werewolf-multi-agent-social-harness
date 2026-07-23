import { describe, expect, it } from "vitest";

import {
  buildCockpitExperimentRequest,
  createCockpitExperimentDraft,
  validateCockpitExperimentDraft
} from "../src/components/cockpit/experimentDraft";

describe("Cockpit experiment control-plane draft", () => {
  it("submits a heterogeneous profile roster with only its existing API contract fields", () => {
    const request = buildCockpitExperimentRequest({
      profiles: [
        { id: "wolves", model: "fixture-wolf", temperature: 0.2, policyName: "wolf-deceiver" },
        { id: "village", model: "fixture-village", temperature: 0.8, policyName: "village-analyst" },
        { id: "seer", model: "fixture-village", temperature: 0.4, policyName: "seer-information" }
      ],
      assignment: {
        strategy: "role",
        roles: { werewolf: "wolves", villager: "village", seer: "seer" },
        fallback: "error"
      }
    });

    expect(request).toEqual({
      models: ["fixture-wolf", "fixture-village"],
      profiles: [
        { id: "wolves", model: "fixture-wolf", temperature: 0.2, policyName: "wolf-deceiver" },
        { id: "village", model: "fixture-village", temperature: 0.8, policyName: "village-analyst" },
        { id: "seer", model: "fixture-village", temperature: 0.4, policyName: "seer-information" }
      ],
      assignment: {
        strategy: "role",
        roles: { werewolf: "wolves", villager: "village", seer: "seer" },
        fallback: "error"
      }
    });
    expect(Object.keys(request).sort()).toEqual(["assignment", "models", "profiles"]);
    expect(JSON.stringify(request)).not.toMatch(/resolvedAssignments|winner|artifact|finalState|seed|roleSeat/i);
  });

  it("rejects an explicit team assignment that references an unknown profile before the request is sent", () => {
    const draft = {
      profiles: [{ id: "wolf", model: "fixture-wolf", policyName: "wolf-deceiver" as const }],
      assignment: {
        strategy: "team" as const,
        teams: { werewolves: "wolf", village: "unknown-profile" },
        fallback: "error" as const
      }
    };
    expect(buildCockpitExperimentRequest(draft).assignment).toEqual(draft.assignment);
    expect(validateCockpitExperimentDraft(draft, ["fixture-wolf"])).toContain("unknown-profile");
  });

  it("rejects dangling active seat, role, and team assignment references with the harness contract", () => {
    const profiles = [
      { id: "wolf", model: "fixture-wolf", policyName: "wolf-deceiver" as const },
      { id: "village", model: "fixture-village", policyName: "village-analyst" as const }
    ];
    const drafts = [
      {
        profiles,
        assignment: { strategy: "seat" as const, seats: { "1": "missing-seat-profile" }, fallback: "error" as const },
        missing: "missing-seat-profile"
      },
      {
        profiles,
        assignment: { strategy: "role" as const, roles: { werewolf: "missing-role-profile" }, fallback: "error" as const },
        missing: "missing-role-profile"
      },
      {
        profiles,
        assignment: { strategy: "team" as const, teams: { werewolves: ["wolf", "missing-team-profile"] }, fallback: "error" as const },
        missing: "missing-team-profile"
      }
    ];

    for (const draft of drafts) {
      expect(validateCockpitExperimentDraft(draft, ["fixture-wolf", "fixture-village"])).toContain(draft.missing);
    }
  });

  it("uses configured defaults without flattening them to one selected model", () => {
    const draft = createCockpitExperimentDraft({
      selectedModel: "fixture-default",
      defaultProfiles: [
        { id: "wolf", model: "fixture-wolf", policyName: "wolf-deceiver" },
        { id: "village", model: "fixture-village", policyName: "village-analyst" }
      ]
    });
    expect(buildCockpitExperimentRequest(draft).models).toEqual(["fixture-wolf", "fixture-village"]);
    expect(draft.assignment).toEqual({ strategy: "profile-rotation", fallback: "error" });
  });
});
