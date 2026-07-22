import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createGenericExperimentForkLineage,
  createGenericExperimentProvenance,
  GENERIC_EXPERIMENT_SPEC_VERSION,
  normalizeGenericExperimentSpec,
  validateGenericExperimentForkLineage,
  validateGenericExperimentProvenance,
  validateGenericExperimentSpec,
  type GenericExperimentSpecV1
} from "../src/harness/generic";
import type { SocialDomainAdapterManifest } from "../src/harness/domainAdapter";

const ledgerAdapter: SocialDomainAdapterManifest = {
  schemaVersion: "harness.domain-adapter.v1",
  domainId: "ledger",
  adapterId: "ledger.social",
  adapterVersion: "1",
  semanticHash: "ledger-adapter-hash-v1",
  components: [
    { kind: "agent_state_schema", id: "ledger.agent-state", version: "1", semanticHash: "agent-state-hash" },
    { kind: "command_codec", id: "ledger.command", version: "1", semanticHash: "command-hash" },
    { kind: "environment", id: "ledger.environment", version: "1", semanticHash: "environment-hash" },
    { kind: "observation_projection", id: "ledger.observation", version: "1", semanticHash: "observation-hash" },
    { kind: "scheduler", id: "ledger.scheduler", version: "1", semanticHash: "scheduler-hash" }
  ]
};

function tournamentSpec(): GenericExperimentSpecV1 {
  return {
    version: GENERIC_EXPERIMENT_SPEC_VERSION,
    id: "ledger-screen",
    kind: "tournament",
    domainId: "ledger",
    domainAdapter: ledgerAdapter,
    seed: "ledger-seed",
    episodeCount: 3,
    actorCount: 3,
    schedulerMode: "aec-batched-decision",
    profiles: [
      { id: "analyst", version: "1", policyId: "ledger.policy.analyst", reasonerId: "reasoner.standard", temperature: 0.3 },
      { id: "deterministic", version: "1", policyId: "ledger.policy.rule" }
    ],
    modelAssignments: [{ profileId: "analyst", modelId: "provider/model:research" }],
    assignmentPolicy: {
      id: "ledger.assignment.rotating",
      version: "1",
      configuration: {
        seats: { b: "deterministic", a: "analyst" },
        roleOrder: ["writer", "reviewer"]
      }
    },
    maxTransitions: 12,
    timeoutPolicy: {
      id: "harness.timeout.bounded",
      version: "1",
      runTimeoutMs: 60_000,
      decisionTimeoutMs: 15_000
    },
    retryPolicy: { id: "harness.retry.bounded", version: "1", maxAttempts: 2, backoffMs: 25 },
    evaluatorIds: ["ledger.consistency.v1", "harness.social.v1"],
    artifactPolicy: { id: "harness.artifact.research", version: "1", visibility: "research-full" },
    checkpointPolicy: { id: "harness.checkpoint.final", version: "1", mode: "final" },
    providerPolicy: { id: "openai-compatible.streaming", version: "1", stream: true },
    continueOnError: true,
    domainConfig: {
      alphabet: ["a", "b", "c"],
      rules: { allowOverwrite: false, requiredEntries: 3 }
    }
  };
}

describe("generic normalized experiment spec", () => {
  it("normalizes a portable non-Werewolf tournament and produces stable JSON data", () => {
    const input = tournamentSpec();
    const normalized = normalizeGenericExperimentSpec(input);

    expect(normalized).toMatchObject({
      version: "harness.experiment.v1",
      id: "ledger-screen",
      kind: "tournament",
      domainId: "ledger",
      seed: "ledger-seed",
      episodeCount: 3,
      actorCount: 3,
      schedulerMode: "aec-batched-decision",
      maxTransitions: 12,
      continueOnError: true
    });
    expect(normalized.modelAssignments).toEqual([{ profileId: "analyst", modelId: "provider/model:research" }]);
    expect(normalized.evaluatorIds).toEqual(["harness.social.v1", "ledger.consistency.v1"]);
    expect(Object.keys(normalized.assignmentPolicy.configuration?.seats ?? {})).toEqual(["a", "b"]);
    expect(validateGenericExperimentSpec(normalized)).toEqual([]);
    expect(normalizeGenericExperimentSpec(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized);

    input.profiles?.[0] && (input.profiles[0].policyId = "mutated-after-normalization");
    if (input.domainConfig) input.domainConfig.alphabet = ["mutated"];
    expect(normalized.profiles[0]?.policyId).toBe("ledger.policy.analyst");
    expect(normalized.domainConfig.alphabet).toEqual(["a", "b", "c"]);
  });

  it("supports a deterministic episode with no model or provider assignment", () => {
    const spec = tournamentSpec();
    const normalized = normalizeGenericExperimentSpec({
      ...spec,
      id: "ledger-deterministic",
      kind: "episode",
      episodeCount: 1,
      schedulerMode: "aec",
      profiles: [{ id: "local", version: "1", policyId: "ledger.policy.rule" }],
      modelAssignments: [],
      providerPolicy: undefined
    });

    expect(normalized.modelAssignments).toEqual([]);
    expect(normalized).not.toHaveProperty("providerPolicy");
    expect(normalized.kind).toBe("episode");
  });

  it("binds normalized specs to stable hashes and caller-declared fork changes", () => {
    const parent = createGenericExperimentProvenance(tournamentSpec());
    expect(validateGenericExperimentProvenance(parent)).toEqual([]);
    expect(parent).toMatchObject({
      schemaVersion: "harness.experiment-provenance.v2",
      executionAttestationRequired: true
    });
    const missingV2AttestationMarker = structuredClone(parent);
    delete missingV2AttestationMarker.executionAttestationRequired;
    expect(validateGenericExperimentProvenance(missingV2AttestationMarker).join(" ")).toMatch(
      /executionAttestationRequired is required by harness\.experiment-provenance\.v2/i
    );
    const legacyMetadata = structuredClone(parent);
    legacyMetadata.schemaVersion = "harness.experiment-provenance.v1";
    delete legacyMetadata.executionAttestationRequired;
    expect(validateGenericExperimentProvenance(legacyMetadata)).toEqual([]);
    expect(createGenericExperimentProvenance(JSON.parse(JSON.stringify(parent.spec)))).toEqual(parent);

    const child = createGenericExperimentProvenance({
      ...tournamentSpec(),
      id: "ledger-screen-fork",
      seed: "ledger-child-seed",
      schedulerMode: "parallel",
      profiles: [
        { id: "analyst", version: "2", policyId: "ledger.policy.analyst.v2", reasonerId: "reasoner.standard", temperature: 0.2 },
        { id: "deterministic", version: "1", policyId: "ledger.policy.rule" }
      ],
      modelAssignments: [{ profileId: "analyst", modelId: "provider/model:counterfactual" }],
      domainConfig: { alphabet: ["c", "b", "a"], rules: { allowOverwrite: true, requiredEntries: 3 } }
    });
    const lineage = createGenericExperimentForkLineage({
      parent,
      child,
      // Deliberately unsorted: the caller names semantics and the builder
      // canonicalizes the resulting audit record.
      changedFields: [
        { field: "seed", reason: "counterfactual seed" },
        { field: "profiles" },
        { field: "modelAssignments" },
        { field: "schedulerMode" },
        { field: "domainConfig" },
        { field: "id" }
      ]
    });

    expect(lineage.changedFields.map(({ field }) => field)).toEqual([
      "domainConfig",
      "id",
      "modelAssignments",
      "profiles",
      "schedulerMode",
      "seed"
    ]);
    expect(validateGenericExperimentForkLineage(lineage)).toEqual([]);
    expect(() =>
      createGenericExperimentForkLineage({ parent, child, changedFields: [{ field: "seed" }] })
    ).toThrow(/explicitly and exactly declare/i);

    const forged = JSON.parse(JSON.stringify(lineage)) as typeof lineage;
    forged.changedFields[0]!.childValueHash = "forged-domain-config-hash";
    expect(validateGenericExperimentForkLineage(forged).join(" ")).toMatch(/childValueHash does not match/i);
    const noncanonicalReason = JSON.parse(JSON.stringify(lineage)) as typeof lineage;
    const reasoned = noncanonicalReason.changedFields.find(({ field }) => field === "seed");
    if (!reasoned) throw new Error("seed lineage fixture is missing");
    reasoned.reason = " counterfactual seed ";
    expect(validateGenericExperimentForkLineage(noncanonicalReason).join(" ")).toMatch(/reason must be canonical/i);

    const forgedSpec = JSON.parse(JSON.stringify(parent)) as typeof parent;
    forgedSpec.spec.seed = "tampered-without-rehash";
    expect(validateGenericExperimentProvenance(forgedSpec).join(" ")).toMatch(/specHash does not match/i);

    const timestampA = createGenericExperimentProvenance({
      ...tournamentSpec(),
      domainConfig: { createdAt: "2026-07-22T01:00:00.000Z" }
    });
    const timestampB = createGenericExperimentProvenance({
      ...tournamentSpec(),
      domainConfig: { createdAt: "2026-07-22T02:00:00.000Z" }
    });
    expect(timestampA.specHash).not.toBe(timestampB.specHash);
  });

  it("applies explicit fields over safe defaults without retaining runtime objects", () => {
    const defaults = tournamentSpec();
    const normalized = normalizeGenericExperimentSpec(
      {
        id: "ledger-override",
        seed: "override-seed",
        episodeCount: 2,
        schedulerMode: "parallel"
      },
      defaults
    );

    expect(normalized).toMatchObject({
      id: "ledger-override",
      seed: "override-seed",
      episodeCount: 2,
      schedulerMode: "parallel",
      domainId: "ledger"
    });
    expect(JSON.stringify(normalized)).not.toMatch(/abortSignal|createEnvironment|restoreActors|providerClient/);
  });

  it("rejects invalid identity, lifecycle, assignment, and policy contracts", () => {
    const base = tournamentSpec();
    expect(() => normalizeGenericExperimentSpec({ ...base, version: "werewolf.experiment.v1" })).toThrow(/version/);
    expect(() => normalizeGenericExperimentSpec({ ...base, extra: true })).toThrow(/unknown field/i);
    expect(() => normalizeGenericExperimentSpec({ ...base, domainId: "other" })).toThrow(/must match domainId/);
    expect(() => normalizeGenericExperimentSpec({ ...base, episodeCount: 0 })).toThrow(/positive integer/);
    expect(() => normalizeGenericExperimentSpec({ ...base, kind: "episode", episodeCount: 2 })).toThrow(/equal to 1/);
    expect(() => normalizeGenericExperimentSpec({ ...base, actorCount: 0 })).toThrow(/actorCount/);
    expect(() => normalizeGenericExperimentSpec({ ...base, schedulerMode: "simultaneous-batch" })).toThrow(/schedulerMode/);
    expect(() => normalizeGenericExperimentSpec({ ...base, maxTransitions: -1 })).toThrow(/maxTransitions/);
    expect(() => normalizeGenericExperimentSpec({ ...base, profiles: [...(base.profiles ?? []), base.profiles![0]!] })).toThrow(
      /profile id must be unique/
    );
    expect(() =>
      normalizeGenericExperimentSpec({ ...base, modelAssignments: [{ profileId: "missing", modelId: "model" }] })
    ).toThrow(/unknown profile/);
    expect(() => normalizeGenericExperimentSpec({ ...base, providerPolicy: { id: "p", version: "1", stream: false } })).toThrow(
      /stream must be true/
    );
    expect(() => normalizeGenericExperimentSpec({ ...base, timeoutPolicy: { id: "t", version: "1", runTimeoutMs: 0 } })).toThrow(
      /positive integer/
    );
  });

  it("fails closed on endpoint, credential, max-token, and raw provider data", () => {
    const base = tournamentSpec();
    expect(() =>
      normalizeGenericExperimentSpec({
        ...base,
        providerPolicy: { id: "p", version: "1", stream: true, endpoint: "https://provider.invalid/v1" }
      })
    ).toThrow(/unknown field/);
    expect(() => normalizeGenericExperimentSpec({ ...base, domainConfig: { apiKey: "must-not-persist" } })).toThrow(/not allowed/);
    expect(() => normalizeGenericExperimentSpec({ ...base, domainConfig: { api_key_value: "fake-placeholder" } })).toThrow(/not allowed/);
    expect(() => normalizeGenericExperimentSpec({ ...base, domainConfig: { serviceAuthorizationHeader: "fake" } })).toThrow(/not allowed/);
    expect(() => normalizeGenericExperimentSpec({ ...base, domainConfig: { provider_endpoint_url: "local-name" } })).toThrow(/not allowed/);
    expect(() => normalizeGenericExperimentSpec({ ...base, domainConfig: { nested: { max_completion_tokens: 10 } } })).toThrow(
      /not allowed/
    );
    expect(() =>
      normalizeGenericExperimentSpec({
        ...base,
        assignmentPolicy: {
          id: "assignment",
          version: "1",
          configuration: { providerOptions: { retries: 2 } }
        }
      })
    ).toThrow(/not allowed/);
    expect(() => normalizeGenericExperimentSpec({ ...base, domainConfig: { innocuous: "https://provider.invalid/v1" } })).toThrow(
      /endpoint URL/
    );
    expect(() => normalizeGenericExperimentSpec({ ...base, domainConfig: { innocuous: "endpoint is https://provider.invalid/v1" } })).toThrow(
      /endpoint URL/
    );
    expect(() => normalizeGenericExperimentSpec({ ...base, domainConfig: { factory: () => ({}) } })).toThrow(/portable JSON/);
  });

  it("keeps the implementation and generic barrel free of Werewolf/core imports", () => {
    for (const relativePath of ["../src/harness/experimentSpec.ts", "../src/harness/generic.ts"]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/core|\.\/environment|\.\/artifacts|\.\/werewolfAdapter|\.\/experiment)["']/);
    }
  });
});
