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

  it("keeps an explicit team assignment and delegates unknown profile references to the server", () => {
    const draft = {
      profiles: [{ id: "wolf", model: "fixture-wolf", policyName: "wolf-deceiver" as const }],
      assignment: {
        strategy: "team" as const,
        teams: { werewolves: "wolf", village: "unknown-profile" },
        fallback: "error" as const
      }
    };
    expect(buildCockpitExperimentRequest(draft).assignment).toEqual(draft.assignment);
    expect(validateCockpitExperimentDraft(draft, ["fixture-wolf"])).toBeUndefined();
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
  });
});
