/**
 * Public reputation (信誉对账): the world-falsified claims and violated
 * commitments, aggregated per character. It reaches agents as plain
 * observation context — never as a mechanical belief edit — and the causality
 * panel renders the same aggregation.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { socialReferenceContext } from "../../src/society/social/context-refs";
import { reputationEntries } from "../../src/components/society/causality-panel";
import type { SocialCausalityProjection } from "../../src/society/social/contracts";


function projection(overrides: {
  propositions?: Array<{ propositionId: string; truthStatus?: string }>;
  socialActs?: Array<{ actorCharacterId: string; propositionIds: string[] }>;
  commitments?: Array<{ promisorCharacterId: string; state?: string }>;
}): SocialCausalityProjection {
  return {
    schemaVersion: 1,
    lastSequence: 0,
    events: [],
    beliefUpdates: [],
    actorModels: [],
    evidence: [],
    directedRelationships: [],
    relationshipDeltas: [],
    outcomeReconciliations: [],
    deceptions: [],
    propositions: (overrides.propositions ?? []).map((entry) => ({
      propositionId: entry.propositionId,
      kind: "past-action",
      predicate: `predicate-${entry.propositionId}`,
      truthStatus: (entry.truthStatus ?? "unknown") as "true",
      groundTruthVisibility: "public",
      sourceEventIds: [],
      schemaVersion: 1
    })),
    socialActs: (overrides.socialActs ?? []).map((act) => ({
      socialActId: `act-${act.actorCharacterId}-${act.propositionIds.join("-")}`,
      kind: "assertion",
      actorCharacterId: act.actorCharacterId,
      actorId: act.actorCharacterId,
      audienceActorIds: [],
      targetActorIds: [],
      propositionIds: act.propositionIds,
      confidence: 1,
      extractionMethod: "explicit-tool",
      logicalTime: 1,
      sourceEventId: "event-1"
    })),
    commitments: (overrides.commitments ?? []).map((commitment) => ({
      commitmentId: `commitment-${commitment.promisorCharacterId}`,
      promisorActorId: commitment.promisorCharacterId,
      promisorCharacterId: commitment.promisorCharacterId,
      audienceActorIds: [],
      propositionId: "prop-0",
      proposition: "承诺文本",
      promisedAction: { actionType: "cooperate" },
      state: (commitment.state ?? "violated") as "violated",
      acceptedByActorIds: [],
      acceptedByCommandIds: [],
      createdAtLogical: 1
    }))
  } as unknown as SocialCausalityProjection;
}

it("reputation aggregates falsified claims and broken commitments per character", () => {
  const value = projection({
    propositions: [
      { propositionId: "p1", truthStatus: "false" },
      { propositionId: "p2", truthStatus: "false" },
      { propositionId: "p3", truthStatus: "true" },
      { propositionId: "p4", truthStatus: "unknown" }
    ],
    socialActs: [
      { actorCharacterId: "char-liar", propositionIds: ["p1", "p2"] },
      { actorCharacterId: "char-honest", propositionIds: ["p3"] }
    ],
    commitments: [
      { promisorCharacterId: "char-liar", state: "violated" },
      { promisorCharacterId: "char-keeper", state: "fulfilled" }
    ]
  });

  const entries = reputationEntries(value);
  const liar = entries.find((entry) => entry.characterId === "char-liar")!;
  assert.equal(liar.falsifiedClaims, 2, "both falsified propositions count against their author");
  assert.equal(liar.brokenCommitments, 1, "the violated commitment counts too");
  assert.ok(!entries.some((entry) => entry.characterId === "char-honest"), "a truthful, kept record earns no reputation entry");
  assert.ok(!entries.some((entry) => entry.characterId === "char-keeper"), "a fulfilled commitment is not a reputation hit");
});

it("an unknown truth status never counts as falsified", () => {
  const value = projection({
    propositions: [{ propositionId: "p4", truthStatus: "unknown" }],
    socialActs: [{ actorCharacterId: "char-a", propositionIds: ["p4"] }]
  });
  assert.deepEqual(reputationEntries(value), []);
});

it("agents see the reputation line as observation context, not as a belief edit", () => {
  const value = projection({
    propositions: [{ propositionId: "p1", truthStatus: "false" }],
    socialActs: [{ actorCharacterId: "char-liar", propositionIds: ["p1"] }],
    commitments: [{ promisorCharacterId: "char-liar", state: "violated" }]
  });
  const lines = socialReferenceContext(value as SocialCausalityProjection);
  const reputation = lines.find((line) => line.startsWith("Publicly settled reputation"));
  assert.ok(reputation, "the reputation line is part of the reference context");
  assert.match(reputation, /char-liar: 1 falsified claim and 1 broken commitment/);
  assert.match(reputation, /weigh it yourself/);
});

it("a clean ledger injects no reputation line at all", () => {
  const lines = socialReferenceContext(projection({}));
  assert.ok(!lines.some((line) => line.includes("Publicly settled reputation")));
});
