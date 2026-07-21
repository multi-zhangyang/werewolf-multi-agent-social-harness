import { topWolfCandidates } from "./belief";
import type { AgentHarnessState, PolicyArbitrationObjective, PolicyArbitrationSummary, PolicyName, PolicyPlan } from "./types";
import type { AgentPendingAction } from "../core/pending";
import type { PlayerView, Role } from "../core/types";
import type {
  BetrayalRecord,
  CoalitionRecord,
  CommitmentRecord,
  EvidenceRef,
  GoalRecord,
  GossipRecord,
  NormRecord,
  NormSanctionRecord,
  RelationshipEdge,
  ReputationRecord,
  TrustRepairRecord
} from "./socialState";

interface PolicyParameters {
  villageVoteThreshold: number;
  witchPoisonThreshold: number;
  hunterShootThreshold: number;
  seerClaimDay: number;
  witchClaimDay: number;
  wolfFakeClaimDay: number;
  wolfRoleThreatWeight: number;
}

const POLICY_PARAMETERS: Record<PolicyName, PolicyParameters> = {
  balanced: {
    villageVoteThreshold: 0.58,
    witchPoisonThreshold: 0.78,
    hunterShootThreshold: 0.7,
    seerClaimDay: 2,
    witchClaimDay: 3,
    wolfFakeClaimDay: 3,
    wolfRoleThreatWeight: 0.28
  },
  "wolf-deceiver": {
    villageVoteThreshold: 0.45,
    witchPoisonThreshold: 0.82,
    hunterShootThreshold: 0.72,
    seerClaimDay: 2,
    witchClaimDay: 3,
    wolfFakeClaimDay: 2,
    wolfRoleThreatWeight: 0.5
  },
  "village-analyst": {
    villageVoteThreshold: 0.5,
    witchPoisonThreshold: 0.74,
    hunterShootThreshold: 0.62,
    seerClaimDay: 2,
    witchClaimDay: 3,
    wolfFakeClaimDay: 4,
    wolfRoleThreatWeight: 0.22
  },
  "seer-information": {
    villageVoteThreshold: 0.48,
    witchPoisonThreshold: 0.76,
    hunterShootThreshold: 0.64,
    seerClaimDay: 1,
    witchClaimDay: 3,
    wolfFakeClaimDay: 4,
    wolfRoleThreatWeight: 0.24
  },
  "witch-conservative": {
    villageVoteThreshold: 0.56,
    witchPoisonThreshold: 0.86,
    hunterShootThreshold: 0.72,
    seerClaimDay: 2,
    witchClaimDay: 4,
    wolfFakeClaimDay: 4,
    wolfRoleThreatWeight: 0.2
  },
  "hunter-punisher": {
    villageVoteThreshold: 0.52,
    witchPoisonThreshold: 0.76,
    hunterShootThreshold: 0.58,
    seerClaimDay: 2,
    witchClaimDay: 3,
    wolfFakeClaimDay: 3,
    wolfRoleThreatWeight: 0.26
  }
};

export function policyForRole(role: Role): PolicyName {
  if (role === "werewolf") return "wolf-deceiver";
  if (role === "seer") return "seer-information";
  if (role === "witch") return "witch-conservative";
  if (role === "hunter") return "hunter-punisher";
  return "village-analyst";
}

export function planAction(view: PlayerView, action: AgentPendingAction, agent: AgentHarnessState): PolicyPlan {
  const parameters = POLICY_PARAMETERS[agent.policyName];
  if (action.kind === "inspect") {
    const targetId = chooseInfoTarget(action.legalTargetIds, agent);
    return {
      policyName: agent.policyName,
      command: { type: "seer.inspect", actorId: action.actorId, targetId },
      targetId,
      intent: `查验 ${targetId} 获取最大信息增益`,
      confidence: confidenceFor(agent, targetId),
      strategyTags: ["信息增益", "查验链"]
    };
  }

  if (action.kind === "kill") {
    const targetId = chooseWolfKillTarget(view, action.legalTargetIds, agent, parameters);
    return {
      policyName: agent.policyName,
      command: { type: "werewolf.killVote", actorId: action.actorId, targetId },
      targetId,
      intent: `夜刀 ${targetId}，压制疑似神职或高影响好人`,
      confidence: 0.68,
      strategyTags: ["夜刀", "压制神职", "狼队协作"]
    };
  }

  if (action.kind === "whisper") {
    const targetId = chooseWolfKillTarget(
      view,
      view.publicPlayers.filter((player) => player.alive && !action.teamActorIds.includes(player.id)).map((player) => player.id),
      agent,
      parameters
    );
    return {
      policyName: agent.policyName,
      command: {
        type: "werewolf.whisper",
        actorId: action.actorId,
        text: "",
        strategyTags: ["狼队密谈", "夜刀预案"]
      },
      targetId,
      intent: targetId ? `向狼队私下建议关注 ${targetId}，同步夜刀与白天伪装预案` : "向狼队私下同步当前夜晚风险与白天伪装预案",
      confidence: targetId ? confidenceFor(agent, targetId) : 0.56,
      strategyTags: ["狼队密谈", "夜刀预案"]
    };
  }

  if (action.kind === "witch") {
    const highWolf = topWolfCandidates(agent.beliefs, action.legalPoisonTargetIds)[0];
    const highWolfProb = highWolf ? agent.beliefs[highWolf]?.wolfProb ?? 0 : 0;
    if (action.canSave && action.nightVictimId && shouldWitchSave(view, action.nightVictimId)) {
      return {
        policyName: agent.policyName,
        command: { type: "witch.act", actorId: action.actorId, saveTargetId: action.nightVictimId },
        targetId: action.nightVictimId,
        intent: `救 ${action.nightVictimId} 保住夜晚死亡信息`,
        confidence: 0.74,
        strategyTags: ["解药", "保轮次"]
      };
    }
    if (action.canPoison && highWolf && highWolfProb >= parameters.witchPoisonThreshold) {
      return {
        policyName: agent.policyName,
        command: { type: "witch.act", actorId: action.actorId, poisonTargetId: highWolf },
        targetId: highWolf,
        intent: `毒杀 ${highWolf}，其狼概率达到 ${Math.round(highWolfProb * 100)}%`,
        confidence: highWolfProb,
        strategyTags: ["毒药", "高置信找狼"]
      };
    }
    return {
      policyName: agent.policyName,
      command: { type: "witch.act", actorId: action.actorId },
      intent: "女巫暂不交药，保留关键资源",
      confidence: 0.58,
      strategyTags: ["留药", "资源管理"]
    };
  }

  if (action.kind === "speech") {
    const pressureArbitration = arbitrateSocialTarget(
      agent,
      action.legalPressureTargetIds,
      view.you.team === "werewolves" ? "target-village" : "suspect-werewolf"
    );
    const pressureTargetId = pressureArbitration?.selectedTargetId;
    const pressureConfidence = pressureTargetId ? confidenceFromArbitration(agent, pressureTargetId, pressureArbitration) : 0.52;
    const claimedRole = claimRoleFor(view, agent, parameters);
    return {
      policyName: agent.policyName,
      command: {
        type: "speech.submit",
        actorId: action.actorId,
        text: "",
        claimedRole,
        pressureTargetId,
        strategyTags: speechTags(view.you.role)
      },
      pressureTargetId,
      claimedRole,
      intent: pressureTargetId ? `公开施压 ${pressureTargetId} 并观察跟票关系` : "补充公开逻辑并观察票型",
      confidence: pressureConfidence,
      strategyTags: speechTags(view.you.role),
      arbitration: pressureArbitration
    };
  }

  if (action.kind === "last_words") {
    return {
      policyName: agent.policyName,
      command: {
        type: "lastWords.submit",
        actorId: action.actorId,
        text: "",
        strategyTags: ["遗言", "公开复盘"]
      },
      intent: "发表仅一次的公开遗言，保留可审计的判断与线索",
      confidence: 0.6,
      strategyTags: ["遗言", "公开复盘"]
    };
  }

  if (action.kind === "sheriff_vote") {
    const arbitration = arbitrateSocialTarget(agent, action.legalTargetIds, view.you.team === "werewolves" ? "target-village" : "suspect-werewolf");
    const targetId = arbitration?.selectedTargetId ?? action.legalTargetIds[0];
    return {
      policyName: agent.policyName,
      command: targetId
        ? { type: "sheriff.vote", actorId: action.actorId, targetId }
        : { type: "sheriff.vote", actorId: action.actorId, abstain: true },
      targetId,
      intent: targetId ? `警长竞选投给 ${targetId}，以公开影响力和当前社会判断加权` : "没有合法警长候选，弃票",
      confidence: targetId ? confidenceFromArbitration(agent, targetId, arbitration) : 0.2,
      strategyTags: view.you.team === "werewolves" ? ["警长竞选", "影响力争夺"] : ["警长竞选", "公开授权"],
      arbitration
    };
  }

  if (action.kind === "vote") {
    const arbitration = arbitrateSocialTarget(agent, action.legalTargetIds, view.you.team === "werewolves" ? "target-village" : "suspect-werewolf");
    const targetId = arbitration?.selectedTargetId;
    const targetScore = targetId ? scoreForTarget(arbitration, targetId) ?? 0 : 0;
    const shouldAbstain = view.you.team === "village" && targetId !== undefined && targetScore < parameters.villageVoteThreshold;
    return {
      policyName: agent.policyName,
      command:
        targetId && !shouldAbstain
          ? { type: "vote.cast", actorId: action.actorId, targetId }
          : { type: "vote.cast", actorId: action.actorId, abstain: true },
      targetId: shouldAbstain ? undefined : targetId,
      intent:
        targetId && !shouldAbstain
          ? `投票给 ${targetId}，符合当前阵营目标和信念排序`
          : targetId
            ? `仲裁分 ${Math.round(targetScore * 100)}% 低于 ${Math.round(parameters.villageVoteThreshold * 100)}% 阈值，弃票保留票型信息`
            : "没有合法目标，弃票",
      confidence: targetId ? confidenceFromArbitration(agent, targetId, arbitration) : 0.2,
      strategyTags: view.you.team === "werewolves" ? ["误导投票", "抗推好人"] : ["放逐", "找狼"],
      arbitration
    };
  }

  const targetId = topWolfCandidates(agent.beliefs, action.legalTargetIds)[0];
  const prob = targetId ? agent.beliefs[targetId]?.wolfProb ?? 0 : 0;
  if (targetId && prob >= parameters.hunterShootThreshold) {
    return {
      policyName: agent.policyName,
      command: { type: "hunter.shoot", actorId: action.actorId, targetId },
      targetId,
      intent: `猎人开枪带走 ${targetId}`,
      confidence: prob,
      strategyTags: ["猎人开枪", "高置信"]
    };
  }
  return {
    policyName: agent.policyName,
    command: { type: "hunter.shoot", actorId: action.actorId },
    intent: "猎人不开枪，避免低置信误伤",
    confidence: 0.5,
    strategyTags: ["不开枪", "降低误伤"]
  };
}

export function attachSpeech(plan: PolicyPlan, speech: string): PolicyPlan {
  if (plan.command.type === "lastWords.submit") {
    return {
      ...plan,
      command: {
        ...plan.command,
        text: speech,
        strategyTags: plan.strategyTags
      }
    };
  }
  if (plan.command.type === "werewolf.whisper") {
    return {
      ...plan,
      command: {
        ...plan.command,
        text: speech,
        strategyTags: plan.strategyTags
      }
    };
  }
  if (plan.command.type !== "speech.submit") return plan;
  return {
    ...plan,
    command: {
      ...plan.command,
      text: speech,
      claimedRole: plan.claimedRole,
      pressureTargetId: plan.pressureTargetId,
      strategyTags: plan.strategyTags
    }
  };
}

function chooseInfoTarget(legalTargetIds: string[], agent: AgentHarnessState): string {
  return [...legalTargetIds].sort((a, b) => infoScore(agent, b) - infoScore(agent, a))[0];
}

function chooseWolfKillTarget(
  view: PlayerView,
  legalTargetIds: string[],
  agent: AgentHarnessState,
  parameters: PolicyParameters
): string {
  return [...legalTargetIds].sort((a, b) => wolfKillScore(view, b, agent, parameters) - wolfKillScore(view, a, agent, parameters))[0];
}

function infoScore(agent: AgentHarnessState, playerId: string): number {
  const prob = agent.beliefs[playerId]?.wolfProb ?? 0.5;
  return 1 - Math.abs(0.5 - prob);
}

function wolfKillScore(view: PlayerView, playerId: string, agent: AgentHarnessState, parameters: PolicyParameters): number {
  const speeches = view.speeches.filter((speech) => speech.playerId === playerId);
  const latestClaim = speeches.findLast((speech) => speech.claimedRole)?.claimedRole;
  const roleThreat =
    latestClaim === "seer" ? parameters.wolfRoleThreatWeight : latestClaim === "witch" ? parameters.wolfRoleThreatWeight * 0.72 : latestClaim === "hunter" ? -0.2 : 0;
  const influence = Math.min(0.25, speeches.length * 0.04);
  const likelyVillage = 1 - (agent.beliefs[playerId]?.wolfProb ?? 0.5);
  return likelyVillage + roleThreat + influence;
}

function shouldWitchSave(view: PlayerView, victimId: string): boolean {
  if (view.day <= 1) return true;
  const victim = view.publicPlayers.find((player) => player.id === victimId);
  return Boolean(victim?.alive);
}

function claimRoleFor(view: PlayerView, agent: AgentHarnessState, parameters: PolicyParameters): Role | undefined {
  if (view.you.role === "werewolf") {
    return view.day >= parameters.wolfFakeClaimDay ? "seer" : undefined;
  }
  if (view.you.role === "seer") return view.day >= parameters.seerClaimDay || Boolean(view.privateInfo.lastInspection) ? "seer" : undefined;
  if (view.you.role === "witch") return view.day >= parameters.witchClaimDay ? "witch" : undefined;
  return undefined;
}

function speechTags(role: Role): string[] {
  if (role === "werewolf") return ["伪装视角", "带票", "制造冲突"];
  if (role === "seer") return ["查验链", "站边", "警徽流"];
  if (role === "witch") return ["药量管理", "保神"];
  if (role === "hunter") return ["威慑", "找狼"];
  return ["票型", "发言矛盾", "找狼"];
}

function confidenceFor(agent: AgentHarnessState, targetId: string): number {
  return Math.max(0.35, Math.min(0.95, agent.beliefs[targetId]?.wolfProb ?? 0.5));
}

export function arbitrateSocialTarget(
  agent: AgentHarnessState,
  legalTargetIds: string[],
  objective: PolicyArbitrationObjective
): PolicyArbitrationSummary | undefined {
  if (!legalTargetIds.length) return undefined;
  const candidates = legalTargetIds
    .map((targetId) => {
      const baseScore = objective === "suspect-werewolf" ? agent.beliefs[targetId]?.wolfProb ?? 0.5 : 1 - (agent.beliefs[targetId]?.wolfProb ?? 0.5);
      const social = socialTargetScore(agent, targetId, objective);
      const finalScore = clamp01(baseScore + social.delta);
      return {
        targetId,
        baseScore: round3(baseScore),
        socialDelta: round3(finalScore - baseScore),
        finalScore: round3(finalScore),
        reasons: social.reasons,
        evidenceRefs: social.evidenceRefs
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore || b.baseScore - a.baseScore || a.targetId.localeCompare(b.targetId));
  return {
    version: "policy.social-target-arbitration.v1",
    objective,
    selectedTargetId: candidates[0]?.targetId,
    candidates
  };
}

function socialTargetScore(
  agent: AgentHarnessState,
  targetId: string,
  objective: PolicyArbitrationObjective
): { delta: number; reasons: string[]; evidenceRefs: EvidenceRef[] } {
  const social = agent.social;
  if (!social) return { delta: 0, reasons: [], evidenceRefs: [] };
  const evidenceRefs: EvidenceRef[] = [];
  const reasons: string[] = [];
  let delta = 0;
  const edge = social.relationships.edges[targetId];
  if (edge) {
    const contribution = relationshipContribution(edge, objective);
    delta += contribution.delta;
    reasons.push(...contribution.reasons);
    evidenceRefs.push(...edge.evidenceRefs);
  }
  const reputation = social.reputation.records[targetId];
  if (reputation) {
    const contribution = reputationContribution(reputation, objective);
    delta += contribution.delta;
    reasons.push(...contribution.reasons);
    evidenceRefs.push(...reputation.evidenceRefs);
  }
  for (const goal of social.goals.goals.filter((item) => item.status === "active" && targetMatchesMetadata(item, targetId))) {
    const signedPriority = goal.kind === "commitment" && objective === "target-village" ? -goal.priority : goal.priority;
    delta += signedPriority * 0.08;
    reasons.push(`goal:${goal.kind}`);
    evidenceRefs.push(...goal.evidenceRefs);
  }
  for (const norm of Object.values(social.norms.norms).filter((item) => item.status === "active" && targetMatchesMetadata(item, targetId))) {
    delta += objective === "suspect-werewolf" ? norm.confidence * 0.04 : -norm.confidence * 0.04;
    reasons.push(`norm:${norm.kind}`);
    evidenceRefs.push(...norm.evidenceRefs);
  }
  for (const commitment of Object.values(social.commitments?.records ?? {}).filter((item) => commitmentTargets(item, targetId))) {
    const contribution = commitmentContribution(commitment, objective);
    delta += contribution.delta;
    reasons.push(...contribution.reasons);
    evidenceRefs.push(...contribution.evidenceRefs);
  }
  for (const coalition of Object.values(social.coalitions?.records ?? {}).filter((item) => coalitionTargets(item, targetId))) {
    const contribution = coalitionContribution(coalition, targetId, objective);
    delta += contribution.delta;
    reasons.push(...contribution.reasons);
    evidenceRefs.push(...contribution.evidenceRefs);
  }
  for (const gossip of Object.values(social.gossip?.records ?? {}).filter((item) => gossipTargets(item, targetId))) {
    const contribution = gossipContribution(gossip, objective);
    delta += contribution.delta;
    reasons.push(...contribution.reasons);
    evidenceRefs.push(...contribution.evidenceRefs);
  }
  for (const sanction of Object.values(social.normSanctions?.records ?? {}).filter((item) => normSanctionTargets(item, targetId))) {
    const contribution = normSanctionContribution(sanction, objective);
    delta += contribution.delta;
    reasons.push(...contribution.reasons);
    evidenceRefs.push(...contribution.evidenceRefs);
  }
  for (const repair of Object.values(social.trustRepairs?.records ?? {}).filter((item) => trustRepairTargets(item, targetId))) {
    const contribution = trustRepairContribution(repair, objective);
    delta += contribution.delta;
    reasons.push(...contribution.reasons);
    evidenceRefs.push(...contribution.evidenceRefs);
  }
  for (const betrayal of Object.values(social.betrayals?.records ?? {}).filter((item) => betrayalTargets(item, targetId))) {
    const contribution = betrayalContribution(betrayal, objective);
    delta += contribution.delta;
    reasons.push(...contribution.reasons);
    evidenceRefs.push(...contribution.evidenceRefs);
  }
  return {
    delta,
    reasons: uniqueStrings(reasons),
    evidenceRefs: uniqueEvidenceRefs(evidenceRefs)
  };
}

function relationshipContribution(edge: RelationshipEdge, objective: PolicyArbitrationObjective): { delta: number; reasons: string[] } {
  if (objective === "target-village") {
    return {
      delta: edge.trust * 0.18 + edge.affinity * 0.08 + edge.respect * 0.08 + edge.influence * 0.04 - edge.suspicion * 0.18 - edge.threat * 0.12,
      reasons: [
        edge.trust !== 0 ? "relationship:trust" : undefined,
        edge.affinity !== 0 ? "relationship:affinity" : undefined,
        edge.respect !== 0 ? "relationship:respect" : undefined,
        edge.influence !== 0 ? "relationship:influence" : undefined,
        edge.suspicion !== 0 ? "relationship:suspicion" : undefined,
        edge.threat !== 0 ? "relationship:threat" : undefined
      ].filter((reason): reason is string => Boolean(reason))
    };
  }
  return {
    delta: edge.suspicion * 0.22 + edge.threat * 0.18 + edge.influence * 0.04 - edge.trust * 0.18 - edge.affinity * 0.08 - edge.respect * 0.06,
    reasons: [
      edge.suspicion !== 0 ? "relationship:suspicion" : undefined,
      edge.threat !== 0 ? "relationship:threat" : undefined,
      edge.influence !== 0 ? "relationship:influence" : undefined,
      edge.trust !== 0 ? "relationship:trust" : undefined,
      edge.affinity !== 0 ? "relationship:affinity" : undefined,
      edge.respect !== 0 ? "relationship:respect" : undefined
    ].filter((reason): reason is string => Boolean(reason))
  };
}

function reputationContribution(record: ReputationRecord, objective: PolicyArbitrationObjective): { delta: number; reasons: string[] } {
  if (objective === "target-village") {
    return {
      delta: record.honesty * 0.14 + record.cooperation * 0.1 + record.competence * 0.08 - record.threat * 0.12 + record.normCompliance * 0.06,
      reasons: reputationReasons(record)
    };
  }
  return {
    delta: record.threat * 0.15 - record.honesty * 0.14 - record.cooperation * 0.08 - record.normCompliance * 0.06,
    reasons: reputationReasons(record)
  };
}

function reputationReasons(record: ReputationRecord): string[] {
  return [
    record.honesty !== 0 ? "reputation:honesty" : undefined,
    record.competence !== 0 ? "reputation:competence" : undefined,
    record.cooperation !== 0 ? "reputation:cooperation" : undefined,
    record.threat !== 0 ? "reputation:threat" : undefined,
    record.normCompliance !== 0 ? "reputation:normCompliance" : undefined
  ].filter((reason): reason is string => Boolean(reason));
}

function commitmentContribution(
  record: CommitmentRecord,
  objective: PolicyArbitrationObjective
): { delta: number; reasons: string[]; evidenceRefs: EvidenceRef[] } {
  const weights =
    objective === "suspect-werewolf"
      ? { active: -0.03, fulfilled: -0.08, broken: 0.12, expired: 0.03, withdrawn: 0.06 }
      : { active: 0.04, fulfilled: 0.08, broken: -0.1, expired: -0.03, withdrawn: -0.05 };
  return categoricalSocialContribution(record.status, record.confidence, weights, "commitment", record.evidenceRefs);
}

function coalitionContribution(
  record: CoalitionRecord,
  targetId: string,
  objective: PolicyArbitrationObjective
): { delta: number; reasons: string[]; evidenceRefs: EvidenceRef[] } {
  const isMember = record.memberIds.includes(targetId);
  const isPressureTarget = record.targetId === targetId || metadataTargets(record.metadata, targetId);
  let weights: Partial<Record<CoalitionRecord["status"], number>> = {};
  if (objective === "target-village" && isMember) {
    weights = { forming: 0.03, active: 0.08, fulfilled: 0.08, dissolved: -0.03, betrayed: -0.05 };
  } else if (objective === "suspect-werewolf" && isPressureTarget) {
    weights = { forming: 0.04, active: 0.06, fulfilled: 0.04, dissolved: 0.02, betrayed: 0.08 };
  } else if (objective === "target-village" && isPressureTarget) {
    weights = { forming: -0.03, active: -0.05, fulfilled: -0.04, betrayed: -0.06 };
  } else if (objective === "suspect-werewolf" && isMember) {
    weights = { active: -0.02, fulfilled: -0.02, betrayed: 0.05, dissolved: 0.02 };
  }
  return categoricalSocialContribution(record.status, record.confidence, weights, "coalition", record.evidenceRefs);
}

function gossipContribution(
  record: GossipRecord,
  objective: PolicyArbitrationObjective
): { delta: number; reasons: string[]; evidenceRefs: EvidenceRef[] } {
  const weights =
    objective === "suspect-werewolf"
      ? { positive: -0.08, negative: 0.1, mixed: 0.04 }
      : { positive: 0.08, negative: -0.1, mixed: -0.03 };
  return categoricalSocialContribution(record.valence, record.confidence, weights, "gossip", record.evidenceRefs);
}

function normSanctionContribution(
  record: NormSanctionRecord,
  objective: PolicyArbitrationObjective
): { delta: number; reasons: string[]; evidenceRefs: EvidenceRef[] } {
  const kindWeights =
    objective === "suspect-werewolf"
      ? { warning: 0.04, pressure: 0.07, reputation: 0.07, exclusion: 0.09, punishment: 0.11, repair_request: 0.05, reward: -0.08 }
      : { warning: -0.04, pressure: -0.07, reputation: -0.07, exclusion: -0.09, punishment: -0.11, repair_request: -0.05, reward: 0.08 };
  const statusWeights =
    objective === "suspect-werewolf"
      ? { proposed: 0.03, applied: 0.05, repaired: -0.04, withdrawn: -0.04, expired: -0.02 }
      : { proposed: -0.03, applied: -0.05, repaired: 0.04, withdrawn: 0.04, expired: 0.02 };
  return combineSocialContributions([
    categoricalSocialContribution(record.kind, record.confidence, kindWeights, "normSanction", record.evidenceRefs),
    categoricalSocialContribution(record.status, record.confidence, statusWeights, "normSanction", record.evidenceRefs)
  ]);
}

function trustRepairContribution(
  record: TrustRepairRecord,
  objective: PolicyArbitrationObjective
): { delta: number; reasons: string[]; evidenceRefs: EvidenceRef[] } {
  const kindWeights =
    objective === "suspect-werewolf"
      ? { apology: -0.02, explanation: -0.02, evidence_provided: -0.04, correction: -0.04, public_clarification: -0.03 }
      : { apology: 0.02, explanation: 0.02, evidence_provided: 0.04, correction: 0.04, public_clarification: 0.03 };
  const statusWeights =
    objective === "suspect-werewolf"
      ? { proposed: -0.01, attempted: -0.02, accepted: -0.08, in_progress: -0.03, completed: -0.08, rejected: 0.08, failed: 0.08, withdrawn: 0.03, expired: 0.02 }
      : { proposed: 0.01, attempted: 0.02, accepted: 0.08, in_progress: 0.03, completed: 0.08, rejected: -0.08, failed: -0.08, withdrawn: -0.03, expired: -0.02 };
  return combineSocialContributions([
    categoricalSocialContribution(record.kind, record.confidence, kindWeights, "trustRepair", record.evidenceRefs),
    categoricalSocialContribution(record.status, record.confidence, statusWeights, "trustRepair", record.evidenceRefs)
  ]);
}

function betrayalContribution(
  record: BetrayalRecord,
  objective: PolicyArbitrationObjective
): { delta: number; reasons: string[]; evidenceRefs: EvidenceRef[] } {
  const kindWeights =
    objective === "suspect-werewolf"
      ? {
          commitment_broken: 0.09,
          coalition_betrayal: 0.09,
          information_leak: 0.08,
          vote_flip: 0.08,
          attack: 0.07,
          abandonment: 0.06,
          deception: 0.11,
          other: 0.04
        }
      : {
          commitment_broken: -0.09,
          coalition_betrayal: -0.09,
          information_leak: -0.08,
          vote_flip: -0.08,
          attack: -0.07,
          abandonment: -0.06,
          deception: -0.11,
          other: -0.04
        };
  const statusWeights =
    objective === "suspect-werewolf"
      ? { alleged: 0.06, acknowledged: 0.08, contested: 0.03, confirmed: 0.12, repaired: -0.04, withdrawn: -0.06 }
      : { alleged: -0.06, acknowledged: -0.08, contested: -0.03, confirmed: -0.12, repaired: 0.04, withdrawn: 0.06 };
  return combineSocialContributions([
    categoricalSocialContribution(record.kind, record.confidence, kindWeights, "betrayal", record.evidenceRefs),
    categoricalSocialContribution(record.status, record.confidence, statusWeights, "betrayal", record.evidenceRefs)
  ]);
}

function categoricalSocialContribution<TValue extends string>(
  value: TValue,
  confidence: number,
  weights: Partial<Record<TValue, number>>,
  reasonPrefix: string,
  evidenceRefs: EvidenceRef[]
): { delta: number; reasons: string[]; evidenceRefs: EvidenceRef[] } {
  const weight = weights[value];
  if (typeof weight !== "number" || !Number.isFinite(weight)) return { delta: 0, reasons: [], evidenceRefs: [] };
  const delta = clamp01(confidence) * weight;
  if (delta === 0) return { delta: 0, reasons: [], evidenceRefs: [] };
  return {
    delta,
    reasons: [`${reasonPrefix}:${value}`],
    evidenceRefs
  };
}

function combineSocialContributions(contributions: Array<{ delta: number; reasons: string[]; evidenceRefs: EvidenceRef[] }>): {
  delta: number;
  reasons: string[];
  evidenceRefs: EvidenceRef[];
} {
  return {
    delta: contributions.reduce((sum, contribution) => sum + contribution.delta, 0),
    reasons: uniqueStrings(contributions.flatMap((contribution) => contribution.reasons)),
    evidenceRefs: uniqueEvidenceRefs(contributions.flatMap((contribution) => contribution.evidenceRefs))
  };
}

function targetMatchesMetadata(record: GoalRecord | NormRecord, targetId: string): boolean {
  const metadata = record.metadata;
  return metadata?.targetId === targetId || metadata?.subjectId === targetId || metadata?.playerId === targetId;
}

function commitmentTargets(record: CommitmentRecord, targetId: string): boolean {
  return record.actorId === targetId || metadataTargets(record.metadata, targetId);
}

function coalitionTargets(record: CoalitionRecord, targetId: string): boolean {
  return record.memberIds.includes(targetId) || record.targetId === targetId || metadataTargets(record.metadata, targetId);
}

function gossipTargets(record: GossipRecord, targetId: string): boolean {
  return record.subjectId === targetId || metadataTargets(record.metadata, targetId);
}

function normSanctionTargets(record: NormSanctionRecord, targetId: string): boolean {
  return record.targetId === targetId || metadataTargets(record.metadata, targetId);
}

function trustRepairTargets(record: TrustRepairRecord, targetId: string): boolean {
  return record.actorId === targetId || metadataTargets(record.metadata, targetId);
}

function betrayalTargets(record: BetrayalRecord, targetId: string): boolean {
  return record.actorId === targetId || metadataTargets(record.metadata, targetId);
}

function metadataTargets(metadata: Record<string, unknown> | undefined, targetId: string): boolean {
  if (!metadata) return false;
  return (
    metadata.targetId === targetId ||
    metadata.subjectId === targetId ||
    metadata.playerId === targetId ||
    (Array.isArray(metadata.targetIds) && metadata.targetIds.some((item) => item === targetId))
  );
}

function confidenceFromArbitration(agent: AgentHarnessState, targetId: string, arbitration?: PolicyArbitrationSummary): number {
  const score = scoreForTarget(arbitration, targetId);
  if (score === undefined) return confidenceFor(agent, targetId);
  return Math.max(0.35, Math.min(0.95, score));
}

function scoreForTarget(arbitration: PolicyArbitrationSummary | undefined, targetId: string): number | undefined {
  return arbitration?.candidates.find((candidate) => candidate.targetId === targetId)?.finalScore;
}

function uniqueEvidenceRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const unique: EvidenceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.artifact}:${ref.id ?? ""}:${ref.seq ?? ""}:${ref.traceId ?? ""}:${ref.description ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cloneJson(ref));
  }
  return unique;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
