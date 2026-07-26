import type { GameCommand } from "../../core/types";
import type { SocialMessage, SocialSpeechAct } from "../social";
import type { ReasonerSocialSpeechActDraft } from "../types";
import type { WerewolfMessageDraftInput } from "./adapterTypes";

export function createWerewolfMessageDrafts(input: WerewolfMessageDraftInput): Array<Omit<SocialMessage, "id" | "seq" | "createdAt">> {
  const messages: Array<Omit<SocialMessage, "id" | "seq" | "createdAt">> = [];
  const publicRecipientIds = input.players.filter((player) => player.id !== input.actorId).map((player) => player.id);
  // The team channel is durable topology, not a claim that every original
  // wolf remains a live recipient.  Build this message's immutable audience
  // from the acting wolf's scoped view: private ally knowledge identifies the
  // team and public state supplies the current alive boundary.  Do not derive
  // a later audience from initial PlayerState or a later environment snapshot.
  const alivePublicPlayerIds = new Set(input.observation.publicPlayers.filter((player) => player.alive).map((player) => player.id));
  const liveWolfAudienceIds =
    input.observation.you.team === "werewolves"
      ? [...new Set([input.actorId, ...(input.observation.privateInfo.werewolfAllies ?? [])])]
          .filter((playerId) => alivePublicPlayerIds.has(playerId))
          .sort()
      : [];
  const baseMetadata = {
    traceId: input.traceId,
    turnIndex: input.turnIndex,
    actionKind: input.pendingAction.kind,
    commandType: input.command.type
  };

  if (input.command.type === "speech.submit") {
    messages.push({
      channelId: "table",
      senderId: input.actorId,
      recipientIds: publicRecipientIds,
      visibility: "public",
      content: input.command.text,
      speechActs: werewolfSpeechActsForMessage(input),
      metadata: {
        ...baseMetadata,
        kind: "public-speech",
        day: input.observation.day,
        claimedRole: input.command.claimedRole,
        pressureTargetId: input.command.pressureTargetId,
        strategyTags: input.command.strategyTags ?? []
      }
    });
  }

  if (input.command.type === "lastWords.submit") {
    messages.push({
      channelId: "table",
      senderId: input.actorId,
      recipientIds: publicRecipientIds,
      visibility: "public",
      content: input.command.text,
      speechActs: werewolfSpeechActsForMessage(input),
      metadata: {
        ...baseMetadata,
        kind: "public-last-words",
        day: input.observation.day
      }
    });
  }

  if (input.command.type === "sheriff.vote") {
    messages.push({
      channelId: "table",
      senderId: input.actorId,
      recipientIds: publicRecipientIds,
      visibility: "public",
      content: input.command.abstain
        ? `${input.actorId} abstained from the sheriff election.`
        : `${input.actorId} voted for ${input.command.targetId} in the sheriff election.`,
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
      metadata: {
        ...baseMetadata,
        kind: "public-sheriff-vote",
        day: input.observation.day,
        targetId: input.command.targetId,
        abstain: Boolean(input.command.abstain)
      }
    });
  }

  if (input.command.type === "vote.cast") {
    messages.push({
      channelId: "table",
      senderId: input.actorId,
      recipientIds: publicRecipientIds,
      visibility: "public",
      content: input.command.abstain ? `${input.actorId} abstained from the day vote.` : `${input.actorId} voted for ${input.command.targetId}.`,
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
      metadata: {
        ...baseMetadata,
        kind: "public-vote",
        day: input.observation.day,
        targetId: input.command.targetId,
        abstain: Boolean(input.command.abstain)
      }
    });
  }

  if (input.command.type === "hunter.shoot") {
    messages.push({
      channelId: "table",
      senderId: input.actorId,
      recipientIds: publicRecipientIds,
      visibility: "public",
      content: input.command.targetId ? `${input.actorId} shot ${input.command.targetId}.` : `${input.actorId} declined to shoot.`,
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
      metadata: {
        ...baseMetadata,
        kind: "public-hunter-shot",
        targetId: input.command.targetId
      }
    });
  }

  if (input.command.type === "werewolf.killVote") {
    messages.push({
      channelId: "werewolf-team",
      senderId: input.actorId,
      recipientIds: liveWolfAudienceIds.filter((wolfId) => wolfId !== input.actorId),
      runtimeAudienceIds: liveWolfAudienceIds,
      visibility: "team",
      content: `${input.actorId} selected ${input.command.targetId} as the night kill target.`,
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
      metadata: {
        ...baseMetadata,
        kind: "werewolf-kill-vote",
        targetId: input.command.targetId
      }
    });
  }

  if (input.command.type === "werewolf.whisper") {
    messages.push({
      channelId: "werewolf-team",
      senderId: input.actorId,
      recipientIds: liveWolfAudienceIds.filter((wolfId) => wolfId !== input.actorId),
      runtimeAudienceIds: liveWolfAudienceIds,
      visibility: "team",
      content: input.command.text,
      speechActs: werewolfSpeechActsForMessage(input),
      metadata: {
        ...baseMetadata,
        kind: "werewolf-whisper",
        day: input.observation.day,
        strategyTags: input.command.strategyTags ?? []
      }
    });
  }

  if (input.command.type === "seer.inspect") {
    messages.push({
      channelId: `private-${input.actorId}`,
      senderId: input.actorId,
      recipientIds: [input.actorId],
      visibility: "private",
      content: `${input.actorId} inspected ${input.command.targetId}.`,
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
      metadata: {
        ...baseMetadata,
        kind: "private-seer-inspect",
        targetId: input.command.targetId
      }
    });
  }

  if (input.command.type === "witch.act") {
    messages.push({
      channelId: `private-${input.actorId}`,
      senderId: input.actorId,
      recipientIds: [input.actorId],
      visibility: "private",
      content: `${input.actorId} submitted witch action.`,
      speechActs: werewolfSpeechActsForCommand(input.command, input.actorId),
      metadata: {
        ...baseMetadata,
        kind: "private-witch-action",
        saveTargetId: input.command.saveTargetId,
        poisonTargetId: input.command.poisonTargetId
      }
    });
  }

  if (input.reasonerOutput.content) {
    const cognitionSource = input.reasonerOutput.cognitionSource ?? "reasoner";
    messages.push({
      channelId: `private-${input.actorId}`,
      senderId: input.actorId,
      recipientIds: [input.actorId],
      visibility: "private",
      content: input.reasonerOutput.content,
      metadata: {
        ...baseMetadata,
        kind: cognitionSource === "policy" ? "private-policy-memo" : "private-reasoner-memo",
        cognitionSource,
        latencyMs: input.reasonerOutput.latencyMs,
        promptTokens: input.reasonerOutput.promptTokens,
        completionTokens: input.reasonerOutput.completionTokens,
        attempts: input.reasonerOutput.attempts
      }
    });
  }

  return messages;
}

function werewolfSpeechActsForCommand(command: GameCommand, actorId: string): SocialSpeechAct[] | undefined {
  const evidenceRefs: SocialSpeechAct["evidenceRefs"] = [];

  if (command.type === "speech.submit") {
    const acts: SocialSpeechAct[] = [];
    if (command.claimedRole) {
      acts.push({
        id: "",
        kind: "role_claim",
        subjectId: actorId,
        value: command.claimedRole,
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.claimedRole", messageKind: "public-speech" }
      });
    }
    if (command.pressureTargetId) {
      acts.push({
        id: "",
        kind: "accusation",
        subjectId: actorId,
        targetId: command.pressureTargetId,
        value: "pressure_target",
        confidence: 0.8,
        evidenceRefs,
        metadata: { source: "metadata.pressureTargetId", messageKind: "public-speech" }
      });
    }
    return acts.length ? acts : undefined;
  }

  if (command.type === "lastWords.submit") {
    return [
      {
        id: "",
        kind: "statement",
        subjectId: actorId,
        value: "last_words",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "last_words", messageKind: "public-last-words" }
      }
    ];
  }

  if (command.type === "sheriff.vote") {
    return [
      {
        id: "",
        kind: "vote_intent",
        subjectId: actorId,
        targetId: command.targetId,
        value: command.abstain ? "sheriff.vote.abstain" : "sheriff.vote",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.targetId", abstain: Boolean(command.abstain), messageKind: "public-sheriff-vote" }
      }
    ];
  }

  if (command.type === "vote.cast") {
    return [
      {
        id: "",
        kind: "vote_intent",
        subjectId: actorId,
        targetId: command.targetId,
        value: command.abstain ? "vote.abstain" : "vote.cast",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.targetId", abstain: Boolean(command.abstain), messageKind: "public-vote" }
      }
    ];
  }

  if (command.type === "hunter.shoot") {
    return [
      {
        id: "",
        kind: "role_action",
        subjectId: actorId,
        targetId: command.targetId,
        value: "hunter.shoot",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.targetId", messageKind: "public-hunter-shot" }
      }
    ];
  }

  if (command.type === "werewolf.killVote") {
    return [
      {
        id: "",
        kind: "coalition_signal",
        subjectId: actorId,
        targetId: command.targetId,
        value: "werewolf.killVote",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.targetId", messageKind: "werewolf-kill-vote" }
      }
    ];
  }

  if (command.type === "werewolf.whisper") {
    return [
      {
        id: "",
        kind: "coalition_signal",
        subjectId: actorId,
        value: "werewolf.whisper",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "werewolf.whisper", messageKind: "werewolf-whisper" }
      }
    ];
  }

  if (command.type === "seer.inspect") {
    return [
      {
        id: "",
        kind: "role_action",
        subjectId: actorId,
        targetId: command.targetId,
        value: "seer.inspect",
        confidence: 1,
        evidenceRefs,
        metadata: { source: "metadata.targetId", messageKind: "private-seer-inspect" }
      }
    ];
  }

  if (command.type === "witch.act") {
    return [
      {
        id: "",
        kind: "role_action",
        subjectId: actorId,
        targetId: command.poisonTargetId ?? command.saveTargetId,
        value: "witch.act",
        confidence: 1,
        evidenceRefs,
        metadata: {
          source: "metadata.kind",
          messageKind: "private-witch-action",
          hasSave: Boolean(command.saveTargetId),
          hasPoison: Boolean(command.poisonTargetId)
        }
      }
    ];
  }

  return undefined;
}

/**
 * Turn a reasoner's bounded social-intent drafts into message candidates only
 * after domain-policy validation. The model cannot choose sender, audience,
 * visibility, evidence ids, or arbitrary metadata; the communication bus
 * assigns durable ids/evidence and performs the final channel validation.
 */
function werewolfSpeechActsForMessage(input: WerewolfMessageDraftInput): SocialSpeechAct[] | undefined {
  const commandActs = werewolfSpeechActsForCommand(input.command, input.actorId) ?? [];
  if (
    input.command.type !== "speech.submit" &&
    input.command.type !== "lastWords.submit" &&
    input.command.type !== "werewolf.whisper"
  ) {
    return commandActs.length ? commandActs : undefined;
  }
  const draftedActs = validateReasonerSocialSpeechActDrafts(input);
  const acts = [...commandActs, ...draftedActs];
  return acts.length ? acts : undefined;
}

function validateReasonerSocialSpeechActDrafts(input: WerewolfMessageDraftInput): SocialSpeechAct[] {
  const drafts = Array.isArray(input.reasonerOutput.speechActDrafts)
    ? input.reasonerOutput.speechActDrafts.slice(0, 4)
    : [];
  if (!drafts.length || input.reasonerOutput.cognitionSource === "policy") return [];

  const visibleActorIds = new Set(input.observation.publicPlayers.map((player) => player.id));
  visibleActorIds.add(input.actorId);
  const coalitionMemberIds = input.command.type === "werewolf.whisper"
    ? new Set([input.actorId, ...(input.observation.privateInfo.werewolfAllies ?? [])])
    : visibleActorIds;
  const accepted: SocialSpeechAct[] = [];
  const semanticKeys = new Set<string>();

  for (const draft of drafts) {
    if (!isReasonerSocialSpeechActDraft(draft)) continue;
    const targetId = draft.targetId?.trim();
    const value = draft.value?.trim();
    const memberIds = [...new Set((draft.memberIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (targetId && !visibleActorIds.has(targetId)) continue;
    if (memberIds.some((id) => !coalitionMemberIds.has(id))) continue;
    if ((draft.kind === "claim" || draft.kind === "agreement" || draft.kind === "disagreement") && !targetId) continue;
    if ((draft.kind === "claim" || draft.kind === "commitment") && !value) continue;
    if ((draft.kind === "request" || draft.kind === "threat" || draft.kind === "trust_repair") && !targetId) continue;
    if (draft.kind === "coalition_signal" && (!value || !memberIds.length)) continue;

    const normalizedMembers = draft.kind === "coalition_signal"
      ? [...new Set([input.actorId, ...memberIds])].sort()
      : [];
    if (draft.kind === "coalition_signal" && normalizedMembers.length < 2) continue;
    const semanticKey = JSON.stringify([draft.kind, targetId ?? null, value ?? null, normalizedMembers]);
    if (semanticKeys.has(semanticKey)) continue;
    semanticKeys.add(semanticKey);

    const metadata: Record<string, unknown> = {
      source: "reasoner.social-intent",
      messageKind:
        input.command.type === "werewolf.whisper"
          ? "werewolf-whisper"
          : input.command.type === "lastWords.submit"
          ? "public-last-words"
          : "public-speech"
    };
    if (draft.kind === "claim") metadata.topic = "reasoner_claim";
    if (draft.kind === "commitment") {
      metadata.promisedAction = value;
      metadata.commitmentId = `${input.traceId}:reasoner-social-intent:${accepted.length + 1}:commitment`;
      if (value === "vote.cast" || value === "vote.abstain") {
        metadata.deadlinePhase = "day_vote";
        metadata.deadlineDay = input.observation.day;
      } else if (value === "sheriff.vote" || value === "sheriff.vote.abstain") {
        metadata.deadlinePhase = "sheriff_vote";
        metadata.deadlineDay = input.observation.day;
      }
    }
    if (draft.kind === "coalition_signal") {
      metadata.memberIds = normalizedMembers;
      metadata.sharedGoal = value;
    }
    accepted.push({
      id: "",
      kind: draft.kind,
      subjectId: draft.kind === "claim" ? targetId : input.actorId,
      targetId,
      value,
      confidence: draft.confidence ?? 0.5,
      evidenceRefs: [],
      metadata
    });
  }
  return accepted;
}

function isReasonerSocialSpeechActDraft(value: unknown): value is ReasonerSocialSpeechActDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<ReasonerSocialSpeechActDraft>;
  if (
    draft.kind !== "claim" &&
    draft.kind !== "request" &&
    draft.kind !== "agreement" &&
    draft.kind !== "disagreement" &&
    draft.kind !== "commitment" &&
    draft.kind !== "coalition_signal" &&
    draft.kind !== "threat" &&
    draft.kind !== "trust_repair"
  ) return false;
  if (draft.targetId !== undefined && (typeof draft.targetId !== "string" || !draft.targetId.trim() || draft.targetId.length > 120)) return false;
  if (draft.value !== undefined && (typeof draft.value !== "string" || !draft.value.trim() || draft.value.length > 240)) return false;
  if (draft.confidence !== undefined && (!Number.isFinite(draft.confidence) || draft.confidence < 0 || draft.confidence > 1)) return false;
  return draft.memberIds === undefined || (
    Array.isArray(draft.memberIds) &&
    draft.memberIds.length <= 12 &&
    draft.memberIds.every((id) => typeof id === "string" && Boolean(id.trim()) && id.length <= 120)
  );
}
