import type { AgentBelief, PlayerView } from "../core/types";

export function updateBeliefs(view: PlayerView, previous: Record<string, AgentBelief>): Record<string, AgentBelief> {
  const beliefs: Record<string, AgentBelief> = {};
  const aliveUnknown = view.publicPlayers.filter((player) => player.alive && player.id !== view.you.id);
  const knownWolfIds = new Set<string>();
  const knownVillageIds = new Set<string>();

  if (view.you.team === "werewolves") {
    for (const id of view.privateInfo.werewolfAllies ?? []) knownWolfIds.add(id);
  } else {
    knownVillageIds.add(view.you.id);
  }

  if (view.privateInfo.lastInspection) {
    if (view.privateInfo.lastInspection.resultTeam === "werewolves") knownWolfIds.add(view.privateInfo.lastInspection.targetId);
    else knownVillageIds.add(view.privateInfo.lastInspection.targetId);
  }

  for (const player of view.publicPlayers) {
    if (player.revealedRole === "werewolf") knownWolfIds.add(player.id);
    if (player.revealedRole && player.revealedRole !== "werewolf") knownVillageIds.add(player.id);
  }

  for (const player of view.publicPlayers) {
    const prior = previous[player.id]?.wolfProb ?? baseWolfProbability(view, player.id, aliveUnknown.length);
    let wolfProb = prior;
    const tags = new Set(previous[player.id]?.rationaleTags ?? []);

    if (knownWolfIds.has(player.id)) {
      wolfProb = 1;
      tags.add("已知狼人");
    } else if (knownVillageIds.has(player.id)) {
      wolfProb = 0;
      tags.add("已知好人");
    } else {
      wolfProb = applyVoteEvidence(view, player.id, wolfProb, tags);
      wolfProb = applySpeechEvidence(view, player.id, wolfProb, tags);
      wolfProb = applySurvivalEvidence(view, player.id, wolfProb, tags);
    }

    beliefs[player.id] = {
      wolfProb: clamp(round2(wolfProb), 0, 1),
      roleGuess: previous[player.id]?.roleGuess,
      rationaleTags: [...tags].slice(-8)
    };
  }

  return beliefs;
}

export function topWolfCandidates(beliefs: Record<string, AgentBelief>, legalTargetIds: string[]): string[] {
  return [...legalTargetIds].sort((a, b) => (beliefs[b]?.wolfProb ?? 0.5) - (beliefs[a]?.wolfProb ?? 0.5));
}

export function topVillageTargets(beliefs: Record<string, AgentBelief>, legalTargetIds: string[]): string[] {
  return [...legalTargetIds].sort((a, b) => (beliefs[a]?.wolfProb ?? 0.5) - (beliefs[b]?.wolfProb ?? 0.5));
}

function baseWolfProbability(view: PlayerView, playerId: string, aliveUnknownCount: number): number {
  if (playerId === view.you.id) return view.you.team === "werewolves" ? 1 : 0;
  if (view.privateInfo.werewolfAllies?.includes(playerId)) return 1;
  const totalWolves = Math.max(1, view.publicPlayers.length <= 9 ? 2 : Math.floor(view.publicPlayers.length / 3));
  const knownWolves = view.privateInfo.werewolfAllies?.length ?? 0;
  if (aliveUnknownCount <= 0) return 0.5;
  return clamp((totalWolves - knownWolves) / aliveUnknownCount, 0.08, 0.82);
}

function applyVoteEvidence(view: PlayerView, playerId: string, wolfProb: number, tags: Set<string>): number {
  const revealed = new Map(view.publicPlayers.filter((player) => player.revealedRole).map((player) => [player.id, player.revealedRole]));
  const playerVotes = view.votes.filter((vote) => vote.voterId === playerId && vote.targetId);
  for (const vote of playerVotes.slice(-4)) {
    if (revealed.get(vote.targetId!) === "werewolf") {
      wolfProb -= 0.08;
      tags.add("投过明狼");
    } else if (revealed.has(vote.targetId!)) {
      wolfProb += 0.08;
      tags.add("投过明好人");
    }
  }
  return wolfProb;
}

function applySpeechEvidence(view: PlayerView, playerId: string, wolfProb: number, tags: Set<string>): number {
  const speeches = view.speeches.filter((speech) => speech.playerId === playerId).slice(-3);
  for (const speech of speeches) {
    if (speech.claimedRole === "seer" || speech.claimedRole === "witch") {
      wolfProb -= 0.03;
      tags.add("有身份声明");
    }
    if (speech.strategyTags.includes("倒钩") || speech.strategyTags.includes("抗推")) {
      wolfProb += 0.06;
      tags.add("高风险话术");
    }
    if (speech.pressureTargetId) tags.add("主动施压");
  }
  return wolfProb;
}

function applySurvivalEvidence(view: PlayerView, playerId: string, wolfProb: number, tags: Set<string>): number {
  if (view.day >= 3 && view.publicPlayers.find((player) => player.id === playerId)?.alive) {
    wolfProb += 0.03;
    tags.add("中后期存活");
  }
  return wolfProb;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
