import { describe, expect, it } from "vitest";
import type { AgentPendingAction } from "../src/core/pending";
import type { GameCommand, PlayerView } from "../src/core/types";
import { WerewolfAgentActor } from "../src/harness/actor";
import { arbitrateSocialTarget, planAction } from "../src/harness/policy";
import {
  addSocialBetrayal,
  addSocialCoalition,
  addSocialCommitment,
  addSocialGossip,
  addSocialNorm,
  addSocialNormSanction,
  addSocialTrustRepair,
  createAgentSocialState,
  pushGoal,
  updateRelationship,
  updateReputation,
  type EvidenceRef
} from "../src/harness/socialState";
import type { AgentHarnessState } from "../src/harness/types";

const relationshipEvidence: EvidenceRef = {
  artifact: "message",
  id: "msg-relationship",
  seq: 1,
  description: "public accusation and defense exchange"
};

const reputationEvidence: EvidenceRef = {
  artifact: "message",
  id: "msg-reputation",
  seq: 2,
  description: "observed contradiction"
};

const goalEvidence: EvidenceRef = {
  artifact: "observation",
  seq: 3,
  description: "active tactical goal"
};

const normEvidence: EvidenceRef = {
  artifact: "message",
  id: "msg-norm-pressure",
  seq: 4,
  description: "table norm invoked against target"
};

const commitmentEvidence: EvidenceRef = {
  artifact: "message",
  id: "msg-commitment-broken",
  seq: 5,
  description: "explicit commitment status evidence"
};

const gossipEvidence: EvidenceRef = {
  artifact: "message",
  id: "msg-negative-gossip",
  seq: 6,
  description: "explicit gossip subject evidence"
};

const sanctionEvidence: EvidenceRef = {
  artifact: "message",
  id: "msg-sanction-pressure",
  seq: 7,
  description: "explicit sanction target evidence"
};

const betrayalEvidence: EvidenceRef = {
  artifact: "message",
  id: "msg-betrayal-claim",
  seq: 8,
  description: "explicit betrayal actor evidence"
};

const coalitionEvidence: EvidenceRef = {
  artifact: "message",
  id: "msg-coalition-active",
  seq: 9,
  description: "explicit coalition membership evidence"
};

const repairEvidence: EvidenceRef = {
  artifact: "message",
  id: "msg-trust-repair",
  seq: 10,
  description: "explicit trust repair actor evidence"
};

describe("policy social action arbitration", () => {
  it("uses evidence-backed social state to change a legal vote target", () => {
    const action = voteAction("p1", ["p2", "p3"]);
    const view = viewFor(action);
    const baseAgent = agentState("p1", {
      p2: { wolfProb: 0.53, rationaleTags: ["slightly suspicious"] },
      p3: { wolfProb: 0.51, rationaleTags: ["slightly less suspicious"] }
    });
    const basePlan = planAction(view, action, baseAgent);

    expect(basePlan.command).toMatchObject({ type: "vote.cast", actorId: "p1", targetId: "p2" });
    expect(basePlan.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      objective: "suspect-werewolf",
      selectedTargetId: "p2"
    });

    const socialAgent = agentState("p1", {
      p2: { wolfProb: 0.53, rationaleTags: ["slightly suspicious"] },
      p3: { wolfProb: 0.51, rationaleTags: ["slightly less suspicious"] }
    });
    attachSocialPressure(socialAgent, "p3");
    const socialPlan = planAction(view, action, socialAgent);
    const p3Candidate = socialPlan.arbitration?.candidates.find((candidate) => candidate.targetId === "p3");
    const p2Candidate = socialPlan.arbitration?.candidates.find((candidate) => candidate.targetId === "p2");

    expect(socialPlan.command).toMatchObject({ type: "vote.cast", actorId: "p1", targetId: "p3" });
    expect(socialPlan.targetId).toBe("p3");
    expect(socialPlan.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      objective: "suspect-werewolf",
      selectedTargetId: "p3"
    });
    expect(p3Candidate?.finalScore).toBeGreaterThan(p2Candidate?.finalScore ?? 0);
    expect(p3Candidate?.socialDelta).toBeGreaterThan(0);
    expect(p3Candidate?.reasons).toEqual(
      expect.arrayContaining(["relationship:suspicion", "relationship:threat", "reputation:threat", "goal:tactical"])
    );
    expect(p3Candidate?.evidenceRefs).toEqual(expect.arrayContaining([relationshipEvidence, reputationEvidence, goalEvidence]));
    expect(socialPlan.arbitration?.candidates.map((candidate) => candidate.targetId)).toEqual(["p3", "p2"]);
  });

  it("uses evidence-backed active norms to change a legal vote target", () => {
    const action = voteAction("p1", ["p2", "p3"]);
    const view = viewFor(action);
    const baseAgent = agentState("p1", {
      p2: { wolfProb: 0.53, rationaleTags: ["slightly suspicious"] },
      p3: { wolfProb: 0.51, rationaleTags: ["slightly less suspicious"] }
    });
    const basePlan = planAction(view, action, baseAgent);

    expect(basePlan.command).toMatchObject({ type: "vote.cast", actorId: "p1", targetId: "p2" });

    const normAgent = agentState("p1", {
      p2: { wolfProb: 0.53, rationaleTags: ["slightly suspicious"] },
      p3: { wolfProb: 0.51, rationaleTags: ["slightly less suspicious"] }
    });
    normAgent.social = createAgentSocialState<PlayerView, AgentPendingAction, GameCommand>({
      agentId: normAgent.playerId,
      profile: {
        id: normAgent.profileId ?? normAgent.playerId,
        model: normAgent.model,
        temperature: normAgent.temperature,
        policyId: normAgent.policyName
      }
    });
    addSocialNorm(normAgent.social, {
      id: "norm-pressure-p3",
      kind: "prohibition",
      scope: "public-table",
      expectedBehavior: "do not coordinate unexplained vote pressure",
      source: "public-table",
      confidence: 1,
      status: "active",
      evidenceRefs: [normEvidence],
      metadata: { targetId: "p3" }
    }, { traceId: "trace-norm-pressure", turnIndex: 1, phase: "day_speech", day: 2 });

    const normPlan = planAction(view, action, normAgent);
    const p3Candidate = normPlan.arbitration?.candidates.find((candidate) => candidate.targetId === "p3");
    const p2Candidate = normPlan.arbitration?.candidates.find((candidate) => candidate.targetId === "p2");

    expect(normPlan.command).toMatchObject({ type: "vote.cast", actorId: "p1", targetId: "p3" });
    expect(normPlan.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      objective: "suspect-werewolf",
      selectedTargetId: "p3"
    });
    expect(p3Candidate?.finalScore).toBeGreaterThan(p2Candidate?.finalScore ?? 0);
    expect(p3Candidate?.socialDelta).toBe(0.04);
    expect(p3Candidate?.reasons).toEqual(["norm:prohibition"]);
    expect(p3Candidate?.evidenceRefs).toEqual([normEvidence]);
    expect(normPlan.arbitration?.candidates.map((candidate) => candidate.targetId)).toEqual(["p3", "p2"]);
  });

  it("uses explicit society ledgers to change village suspicion without parsing raw text", () => {
    const action = voteAction("p1", ["p2", "p3"]);
    const view = viewFor(action);
    const agent = agentState("p1", {
      p2: { wolfProb: 0.53, rationaleTags: ["slightly suspicious"] },
      p3: { wolfProb: 0.51, rationaleTags: ["slightly less suspicious"] }
    });
    attachSocietyLedgerSuspicion(agent, "p3");

    const plan = planAction(view, action, agent);
    const p3Candidate = plan.arbitration?.candidates.find((candidate) => candidate.targetId === "p3");
    const p2Candidate = plan.arbitration?.candidates.find((candidate) => candidate.targetId === "p2");

    expect(plan.command).toMatchObject({ type: "vote.cast", actorId: "p1", targetId: "p3" });
    expect(plan.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      objective: "suspect-werewolf",
      selectedTargetId: "p3"
    });
    expect(p3Candidate?.finalScore).toBeGreaterThan(p2Candidate?.finalScore ?? 0);
    expect(p3Candidate?.socialDelta).toBeGreaterThan(0);
    expect(p3Candidate?.reasons).toEqual(
      expect.arrayContaining([
        "commitment:broken",
        "gossip:negative",
        "normSanction:pressure",
        "normSanction:applied",
        "betrayal:deception",
        "betrayal:confirmed"
      ])
    );
    expect(p3Candidate?.evidenceRefs).toEqual(
      expect.arrayContaining([commitmentEvidence, gossipEvidence, sanctionEvidence, betrayalEvidence])
    );
    expect(JSON.stringify(plan.arbitration)).not.toContain(rawLedgerText());
  });

  it("uses social arbitration for public speech pressure targets", () => {
    const action = speechAction("p1", ["p2", "p3"]);
    const view = viewFor(action);
    const agent = agentState("p1", {
      p2: { wolfProb: 0.53, rationaleTags: ["slightly suspicious"] },
      p3: { wolfProb: 0.51, rationaleTags: ["slightly less suspicious"] }
    });
    attachSocialPressure(agent, "p3");

    const plan = planAction(view, action, agent);
    const p3Candidate = plan.arbitration?.candidates.find((candidate) => candidate.targetId === "p3");

    expect(plan.command).toMatchObject({ type: "speech.submit", actorId: "p1", pressureTargetId: "p3" });
    expect(plan.pressureTargetId).toBe("p3");
    expect(plan.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      objective: "suspect-werewolf",
      selectedTargetId: "p3"
    });
    expect(plan.arbitration?.candidates.map((candidate) => candidate.targetId)).toEqual(["p3", "p2"]);
    expect(p3Candidate?.reasons).toEqual(
      expect.arrayContaining(["relationship:suspicion", "relationship:threat", "reputation:threat", "goal:tactical"])
    );
    expect(p3Candidate?.evidenceRefs).toEqual(expect.arrayContaining([relationshipEvidence, reputationEvidence, goalEvidence]));
  });

  it("uses target-village arbitration for werewolf vote targets", () => {
    const action = voteAction("p1", ["p2", "p3"]);
    const view = werewolfViewFor(action);
    const baseAgent = wolfAgentState("p1", {
      p2: { wolfProb: 0.48, rationaleTags: ["likely village"] },
      p3: { wolfProb: 0.49, rationaleTags: ["slightly less village"] }
    });
    const basePlan = planAction(view, action, baseAgent);

    expect(basePlan.command).toMatchObject({ type: "vote.cast", actorId: "p1", targetId: "p2" });
    expect(basePlan.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      objective: "target-village",
      selectedTargetId: "p2"
    });

    const socialAgent = wolfAgentState("p1", {
      p2: { wolfProb: 0.48, rationaleTags: ["likely village"] },
      p3: { wolfProb: 0.49, rationaleTags: ["slightly less village"] }
    });
    socialAgent.social = createAgentSocialState<PlayerView, AgentPendingAction, GameCommand>({
      agentId: socialAgent.playerId,
      profile: {
        id: socialAgent.profileId ?? socialAgent.playerId,
        model: socialAgent.model,
        temperature: socialAgent.temperature,
        policyId: socialAgent.policyName
      }
    });
    updateRelationship(socialAgent.social.relationships, {
      targetId: "p3",
      deltas: { trust: 0.2, affinity: 0.2, respect: 0.2 },
      evidenceRefs: [relationshipEvidence],
      metadata: { reason: "credible village table presence" }
    });
    updateReputation(socialAgent.social.reputation, {
      subjectId: "p3",
      deltas: { honesty: 0.2, cooperation: 0.2 },
      evidenceRefs: [reputationEvidence],
      metadata: { reason: "credible cooperation signal" }
    });

    const socialPlan = planAction(view, action, socialAgent);
    const p3Candidate = socialPlan.arbitration?.candidates.find((candidate) => candidate.targetId === "p3");

    expect(socialPlan.command).toMatchObject({ type: "vote.cast", actorId: "p1", targetId: "p3" });
    expect(socialPlan.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      objective: "target-village",
      selectedTargetId: "p3"
    });
    expect(socialPlan.arbitration?.candidates.map((candidate) => candidate.targetId)).toEqual(["p3", "p2"]);
    expect(p3Candidate?.socialDelta).toBeGreaterThan(0);
    expect(p3Candidate?.reasons).toEqual(
      expect.arrayContaining(["relationship:trust", "relationship:affinity", "relationship:respect", "reputation:honesty", "reputation:cooperation"])
    );
    expect(p3Candidate?.evidenceRefs).toEqual(expect.arrayContaining([relationshipEvidence, reputationEvidence]));
  });

  it("uses explicit coalition and repair ledgers for werewolf target-village arbitration", () => {
    const action = voteAction("p1", ["p2", "p3"]);
    const view = werewolfViewFor(action);
    const agent = wolfAgentState("p1", {
      p2: { wolfProb: 0.48, rationaleTags: ["likely village"] },
      p3: { wolfProb: 0.49, rationaleTags: ["slightly less village"] }
    });
    attachSocietyLedgerVillageTarget(agent, "p3");

    const plan = planAction(view, action, agent);
    const p3Candidate = plan.arbitration?.candidates.find((candidate) => candidate.targetId === "p3");
    const p2Candidate = plan.arbitration?.candidates.find((candidate) => candidate.targetId === "p2");

    expect(plan.command).toMatchObject({ type: "vote.cast", actorId: "p1", targetId: "p3" });
    expect(plan.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      objective: "target-village",
      selectedTargetId: "p3"
    });
    expect(p3Candidate?.finalScore).toBeGreaterThan(p2Candidate?.finalScore ?? 0);
    expect(p3Candidate?.reasons).toEqual(
      expect.arrayContaining(["commitment:fulfilled", "coalition:active", "trustRepair:evidence_provided", "trustRepair:accepted"])
    );
    expect(p3Candidate?.evidenceRefs).toEqual(expect.arrayContaining([commitmentEvidence, coalitionEvidence, repairEvidence]));
    expect(JSON.stringify(plan.arbitration)).not.toContain(rawLedgerText());
  });

  it("keeps arbitration inside legal targets and records it as policy memory, not reasoner authority", () => {
    const action = voteAction("p1", ["p2", "p3"]);
    const actor = new WerewolfAgentActor(agentState("p1"));
    attachSocialPressure(actor.state, "p3");
    attachSocietyLedgerSuspicion(actor.state, "p4");
    updateRelationship(actor.state.social!.relationships, {
      targetId: "p4",
      deltas: { suspicion: 1, threat: 1 },
      evidenceRefs: [{ artifact: "message", id: "msg-illegal-target", seq: 4, description: "not a legal vote target" }]
    });

    actor.observe(viewFor(action), { traceId: "policy-arbitration:observe", turnIndex: 1 });
    const plan = actor.plan(action);
    actor.commitTurn(plan, "reasoner memo says to vote p4, but policy arbitration must remain authoritative", {
      traceId: "policy-arbitration:turn",
      turnIndex: 1,
      pendingAction: action
    });
    const command = actor.act(plan);
    const decisionMemory = actor.state.social?.memory.entries.find((entry) => entry.kind === "decision");

    expect(plan.arbitration?.selectedTargetId).toBe("p3");
    expect(plan.arbitration?.candidates.map((candidate) => candidate.targetId)).toEqual(["p3", "p2"]);
    expect(plan.arbitration?.candidates.some((candidate) => candidate.targetId === "p4")).toBe(false);
    expect(command).toMatchObject({ type: "vote.cast", actorId: "p1", targetId: "p3" });
    expect(decisionMemory?.metadata?.arbitration).toMatchObject({
      version: "policy.social-target-arbitration.v1",
      selectedTargetId: "p3"
    });
    expect(JSON.stringify(decisionMemory?.metadata?.arbitration)).toContain("msg-relationship");
  });

  it("can be called as a pure legal-target arbitration helper", () => {
    const agent = agentState("p1", {
      p2: { wolfProb: 0.55, rationaleTags: [] },
      p3: { wolfProb: 0.5, rationaleTags: [] },
      p4: { wolfProb: 0.1, rationaleTags: [] }
    });
    attachSocialPressure(agent, "p3");

    const result = arbitrateSocialTarget(agent, ["p2", "p3"], "suspect-werewolf");

    expect(result?.selectedTargetId).toBe("p3");
    expect(result?.candidates.map((candidate) => candidate.targetId)).toEqual(["p3", "p2"]);
    expect(result?.candidates.some((candidate) => candidate.targetId === "p4")).toBe(false);
  });
});

function attachSocialPressure(agent: AgentHarnessState, targetId: string): void {
  agent.social ??= createAgentSocialState<PlayerView, AgentPendingAction, GameCommand>({
    agentId: agent.playerId,
    profile: {
      id: agent.profileId ?? agent.playerId,
      model: agent.model,
      temperature: agent.temperature,
      policyId: agent.policyName
    }
  });
  updateRelationship(agent.social.relationships, {
    targetId,
    deltas: { suspicion: 0.8, threat: 0.3, trust: -0.2 },
    evidenceRefs: [relationshipEvidence],
    metadata: { reason: "observed pressure and contradiction" }
  });
  updateReputation(agent.social.reputation, {
    subjectId: targetId,
    deltas: { honesty: -0.3, threat: 0.4, cooperation: -0.2 },
    evidenceRefs: [reputationEvidence],
    metadata: { reason: "conflicting public claim" }
  });
  pushGoal(agent.social.goals, {
    id: `verify-${targetId}`,
    kind: "tactical",
    description: `verify ${targetId} before voting`,
    priority: 1,
    evidenceRefs: [goalEvidence],
    metadata: { targetId }
  });
}

function attachSocietyLedgerSuspicion(agent: AgentHarnessState, targetId: string): void {
  const social = ensureSocialState(agent);
  const rawText = rawLedgerText();
  addSocialCommitment(social, {
    id: `commitment-${targetId}`,
    actorId: targetId,
    audienceIds: [agent.playerId],
    visibility: "public",
    promisedAction: rawText,
    targetId: "p2",
    status: "broken",
    confidence: 1,
    evidenceRefs: [commitmentEvidence]
  }, { traceId: "trace-ledger-commitment", turnIndex: 1, phase: "day_speech", day: 2 });
  addSocialGossip(social, {
    id: `gossip-${targetId}`,
    speakerId: "p2",
    subjectId: targetId,
    audienceIds: [agent.playerId],
    visibility: "public",
    topic: rawText,
    claim: rawText,
    valence: "negative",
    confidence: 1,
    evidenceRefs: [gossipEvidence]
  }, { traceId: "trace-ledger-gossip", turnIndex: 1, phase: "day_speech", day: 2 });
  addSocialNormSanction(social, {
    id: `sanction-${targetId}`,
    normId: "norm-public-consistency",
    actorId: "p2",
    targetId,
    audienceIds: [agent.playerId],
    visibility: "public",
    kind: "pressure",
    status: "applied",
    reason: rawText,
    requestedRepair: rawText,
    confidence: 1,
    evidenceRefs: [sanctionEvidence]
  }, { traceId: "trace-ledger-sanction", turnIndex: 1, phase: "day_speech", day: 2 });
  addSocialBetrayal(social, {
    id: `betrayal-${targetId}`,
    actorId: targetId,
    targetId: "p2",
    audienceIds: [agent.playerId],
    visibility: "public",
    kind: "deception",
    status: "confirmed",
    claim: rawText,
    impact: rawText,
    confidence: 1,
    evidenceRefs: [betrayalEvidence]
  }, { traceId: "trace-ledger-betrayal", turnIndex: 1, phase: "day_speech", day: 2 });
}

function attachSocietyLedgerVillageTarget(agent: AgentHarnessState, targetId: string): void {
  const social = ensureSocialState(agent);
  const rawText = rawLedgerText();
  addSocialCommitment(social, {
    id: `fulfilled-commitment-${targetId}`,
    actorId: targetId,
    audienceIds: [agent.playerId],
    visibility: "public",
    promisedAction: rawText,
    status: "fulfilled",
    confidence: 1,
    evidenceRefs: [commitmentEvidence]
  }, { traceId: "trace-ledger-fulfilled-commitment", turnIndex: 1, phase: "day_speech", day: 2 });
  addSocialCoalition(social, {
    id: `coalition-${targetId}`,
    memberIds: [targetId, "p4"],
    visibility: "public",
    sharedGoal: rawText,
    status: "active",
    confidence: 1,
    formationEvidenceRefs: [coalitionEvidence]
  }, { traceId: "trace-ledger-coalition", turnIndex: 1, phase: "day_speech", day: 2 });
  addSocialTrustRepair(social, {
    id: `repair-${targetId}`,
    actorId: targetId,
    targetId: "p2",
    audienceIds: [agent.playerId],
    visibility: "public",
    kind: "evidence_provided",
    status: "accepted",
    reason: rawText,
    offeredRepair: rawText,
    confidence: 1,
    evidenceRefs: [repairEvidence]
  }, { traceId: "trace-ledger-repair", turnIndex: 1, phase: "day_speech", day: 2 });
}

function ensureSocialState(agent: AgentHarnessState): NonNullable<AgentHarnessState["social"]> {
  agent.social ??= createAgentSocialState<PlayerView, AgentPendingAction, GameCommand>({
    agentId: agent.playerId,
    profile: {
      id: agent.profileId ?? agent.playerId,
      model: agent.model,
      temperature: agent.temperature,
      policyId: agent.policyName
    }
  });
  return agent.social;
}

function rawLedgerText(): string {
  return "raw private society ledger text that policy arbitration must not persist";
}

function agentState(playerId: string, beliefs: AgentHarnessState["beliefs"] = {}): AgentHarnessState {
  return {
    playerId,
    profileId: `${playerId}-profile`,
    model: "deterministic-policy-test",
    temperature: 0,
    policyName: "village-analyst",
    turns: 0,
    observations: 0,
    beliefs,
    privateMemos: []
  };
}

function voteAction(actorId: string, legalTargetIds: string[]): Extract<AgentPendingAction, { kind: "vote" }> {
  return {
    kind: "vote",
    phase: "day_vote",
    actorId,
    legalTargetIds
  };
}

function speechAction(actorId: string, legalPressureTargetIds: string[]): Extract<AgentPendingAction, { kind: "speech" }> {
  return {
    kind: "speech",
    phase: "day_speech",
    actorId,
    legalPressureTargetIds
  };
}

function wolfAgentState(playerId: string, beliefs: AgentHarnessState["beliefs"] = {}): AgentHarnessState {
  return {
    ...agentState(playerId, beliefs),
    policyName: "wolf-deceiver"
  };
}

function werewolfViewFor(action: AgentPendingAction): PlayerView {
  const view = viewFor(action);
  return {
    ...view,
    you: {
      ...view.you,
      role: "werewolf",
      team: "werewolves"
    }
  };
}

function viewFor(action: AgentPendingAction): PlayerView {
  return {
    phase: action.phase,
    day: 2,
    you: {
      id: action.actorId,
      seat: 1,
      name: "Agent p1",
      role: "villager",
      team: "village",
      alive: true,
      ability: {
        witchSaveAvailable: false,
        witchPoisonAvailable: false,
        hunterShotAvailable: false
      }
    },
    publicPlayers: ["p1", "p2", "p3", "p4"].map((id, index) => ({
      id,
      seat: index + 1,
      name: `Agent ${id}`,
      alive: true,
      isSheriff: false
    })),
    privateInfo: {},
    speeches: [],
    votes: [],
    deaths: [],
    recentEvents: [],
    pendingAction: action
  };
}
