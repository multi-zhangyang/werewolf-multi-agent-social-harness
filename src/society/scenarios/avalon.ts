import { randomInt } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  PlayerActionSpec,
  ScenarioSummary,
  SocialChannel,
  SocialMessage,
  SocietyAgentContext,
  WorldActionCommit,
  WorldActivation,
  WorldSnapshot
} from "../contracts";
import { contextFromRunContext, scopedContext, SocialWorldBase } from "../world";
import { DiscussionDirector } from "../conversation";
import { SuspicionClimate } from "../suspicion";
import { boundedRounds, discussionPersonality, emitAction } from "./helpers";
import { roleHypothesisTool } from "../cognition";

type Role = "merlin" | "servant" | "assassin" | "mordred" | "minion";

function isEvilRole(role: Role | undefined): boolean {
  return role === "assassin" || role === "mordred" || role === "minion";
}

function isLoyalRole(role: Role | undefined): boolean {
  return role === "merlin" || role === "servant";
}

/**
 * Official quest team sizes by player count (The Resistance: Avalon
 * rulebook): the 5th entry is used for any quest beyond the table.
 */
export const QUEST_TEAM_SIZES: Record<number, number[]> = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5]
};

/** Official good/evil split decks: Merlin and the Assassin are always present. */
export function deckForPlayerCount(count: number): Role[] {
  const decks: Record<number, Role[]> = {
    5: ["merlin", "servant", "servant", "assassin", "minion"],
    6: ["merlin", "servant", "servant", "servant", "assassin", "minion"],
    7: ["merlin", "servant", "servant", "servant", "assassin", "minion", "mordred"],
    8: ["merlin", "servant", "servant", "servant", "servant", "assassin", "minion", "mordred"],
    9: ["merlin", "servant", "servant", "servant", "servant", "servant", "assassin", "minion", "mordred"],
    10: ["merlin", "servant", "servant", "servant", "servant", "servant", "assassin", "minion", "mordred", "minion"]
  };
  const deck = decks[count];
  if (!deck) throw new Error(`PLAYER_COUNT_INVALID: Avalon supports 5-10 seats, got ${count}.`);
  return deck;
}

/** Official rule: the fourth quest needs two fail cards at 7+ players. */
export function questFailsNeeded(playerCount: number, quest: number): number {
  return quest === 4 && playerCount >= 7 ? 2 : 1;
}
type Phase = "discussion" | "proposal" | "vote" | "quest" | "assassination";

interface QuestRecord {
  quest: number;
  leaderId: string;
  team: string[];
  teamVotes: Record<string, boolean>;
  outcome: "success" | "fail";
  failCount: number;
  text: string;
}

const MAX_REJECTIONS = 5; // five consecutive rejections hand evil the win
const ACCUSATION_LEXICON = /怀疑|是狼|内奸|刺客|莫德雷德|失败|黑票|出局|投|说谎|撒谎|骗|带节奏|站队|装好人|伪/;
const DEFENSE_LEXICON = /相信|支持|担保|信任|不是内奸|好人|没问题|我信/;

/**
 * Avalon (The Resistance), official 5-10 player tables: the good/evil split
 * and quest team sizes follow the rulebook (5P: 3v2, 6P: 4v2, 7P: 4v3,
 * 8P: 5v3, 9P: 6v3, 10P: 6v4). Merlin always sees the evil team except
 * Mordred; the Assassin is always present. The fourth quest needs two fail
 * cards at 7+ players, and five consecutive rejected teams hand evil the
 * win. Leaders propose teams, the table votes publicly, then team members
 * secretly choose success or failure. Three successes trigger the final
 * assassination: one shot at Merlin's identity.
 */
export class AvalonWorld extends SocialWorldBase {
  private readonly totalQuests: number;
  private readonly teamSizes: number[];
  private readonly roles = new Map<string, Role>();
  private readonly questHistory: QuestRecord[] = [];
  private readonly teamVotes = new Map<string, boolean>();
  private readonly questVotes = new Map<string, "succeed" | "fail">();
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private discussion: DiscussionDirector | null = null;
  private readonly suspicion = new SuspicionClimate();
  private quest = 1;
  private leaderId: string;
  private proposedTeam: string[] = [];
  private rejections = 0;
  private successes = 0;
  private failures = 0;
  private winners: string[] = [];
  private outcome = "";
  private assassinated = false;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    this.totalQuests = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    this.teamSizes = QUEST_TEAM_SIZES[profiles.length] ?? QUEST_TEAM_SIZES[5] ?? [2, 3, 2, 3, 3];
    const ids = shuffle(profiles.map((profile) => profile.id));
    const deck = deckForPlayerCount(profiles.length);
    ids.forEach((id, index) => this.roles.set(id, deck[index]));
    this.leaderId = profiles[0].id;
    this.discussion = this.createDiscussion();
    this.addLog("圆桌就座。忠臣要完成任务，内奸要暗中破坏；梅林看得见刺客，但看不见莫德雷德。", 1);
  }

  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.quest,
      totalTurns: this.totalQuests,
      phase: phaseLabel(this.phase),
      summary: this.summary(),
      details: {
        roles: Object.fromEntries(this.roles),
        leaderId: this.leaderId,
        proposedTeam: this.proposedTeam,
        pendingTeamVotes: Object.fromEntries(this.teamVotes),
        pendingQuestVotes: Object.fromEntries(this.questVotes),
        rejections: this.rejections,
        successes: this.successes,
        failures: this.failures,
        history: this.questHistory,
        winners: this.winners,
        outcome: this.outcome,
        ...(this.discussion ? { discussion: this.discussion.state() } : {}),
        suspicion: this.suspicion.snapshot()
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const role = this.roles.get(actorId)!;
    const evilAllies = isEvilRole(role)
      ? [...this.roles].filter(([id, candidate]) => id !== actorId && isEvilRole(candidate)).map(([id]) => id)
      : [];
    const knownEvil = role === "merlin"
      ? [...this.roles].filter(([, candidate]) => candidate === "assassin" || candidate === "minion").map(([id]) => id)
      : evilAllies;
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.quest,
      phase: this.phase,
      situation: `${situationFor(this.phase, this.quest, this.totalQuests, this.successes, this.failures)}\nPublic suspicion climate: ${this.suspicion.climateText((id) => this.profiles.get(id)?.displayName ?? id)}`,
      privateContext: [
        `Your hidden role: ${role}.`,
        `Your objective: ${roleObjective(role)}.`,
        knownEvil.length ? `Known evil identities: ${knownEvil.join(", ")}.` : "",
        role === "merlin" ? "Mordred is hidden even from you." : "",
        this.phase === "proposal" ? `Current leader: ${this.leaderId}. The proposed team: ${this.proposedTeam.join(", ") || "not yet proposed"}.` : "",
        `Your team vote: ${this.teamVotes.has(actorId) ? String(this.teamVotes.get(actorId)) : "not cast"}.`,
        `Your quest vote: ${this.questVotes.get(actorId) ?? "not cast"}.`,
        `Quest history: ${this.questHistory.map((record) => `Q${record.quest} team=[${record.team.join(",")}] ${record.outcome} (fails ${record.failCount})`).join("; ") || "none"}.`
      ].filter(Boolean).join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, role },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-40),
      availableActions: this.availableActions(actorId, role)
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    const tools: Tool<SocietyAgentContext>[] = [];
    const propose = tool({
      name: "propose_team",
      description: `As the current leader, nominate the quest team. The team must contain exactly ${this.teamSize(this.quest)} members and must include yourself. The team is announced publicly before the vote.`,
      parameters: z.object({
        memberIds: z.array(z.string().min(1)).min(2).max(6),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async ({ memberIds, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "propose_team", { memberIds, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    tools.push(propose as Tool<SocietyAgentContext>);
    const vote = tool({
      name: "cast_team_vote",
      description: "Vote publicly on the current proposed team: approve it or reject it. Votes stay hidden until every participant commits, then they are revealed together.",
      parameters: z.object({
        accept: z.boolean(),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async ({ accept, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "cast_team_vote", { accept, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    tools.push(vote as Tool<SocietyAgentContext>);
    const questChoice = tool({
      name: "cast_quest_vote",
      description: "As a member of the approved quest team, secretly decide the quest outcome: succeed or fail it. Loyal participants can only succeed; minions may choose either.",
      parameters: z.object({
        choice: z.enum(["succeed", "fail"]),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async ({ choice, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "cast_quest_vote", { choice, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    tools.push(questChoice as Tool<SocietyAgentContext>);
    if (role === "assassin") {
      const assassinate = tool({
        name: "assassinate_merlin",
        description: "In the final assassination, name the player you believe is Merlin. A correct kill wins the game for evil; a miss hands victory to the loyal side.",
        parameters: z.object({
          targetId: z.string().min(1),
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async ({ targetId, reason }, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "assassinate_merlin", { targetId, reason });
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(assassinate as Tool<SocietyAgentContext>);
    }
    return tools;
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    if (this.phase === "proposal" && this.leaderId === actorId && !this.proposedTeam.length) {
      return [{
        name: "propose_team",
        label: "提出队伍",
        description: `选择 ${this.teamSize(this.quest)} 名成员（必须包含自己）。`,
        kind: "team",
        field: "memberIds",
        min: this.teamSize(this.quest),
        max: this.teamSize(this.quest)
      }];
    }
    if (this.phase === "vote" && !this.teamVotes.has(actorId)) {
      return [{
        name: "cast_team_vote",
        label: "表决队伍",
        description: "表决结果在所有人提交后统一公开。",
        kind: "choice",
        field: "accept",
        options: [
          { value: "true", label: "赞成" },
          { value: "false", label: "反对" }
        ]
      }];
    }
    if (this.phase === "quest" && this.proposedTeam.includes(actorId) && !this.questVotes.has(actorId)) {
      const options = isLoyalRole(role)
        ? [{ value: "succeed", label: "任务成功" }]
        : [{ value: "succeed", label: "任务成功" }, { value: "fail", label: "任务失败" }];
      return [{
        name: "cast_quest_vote",
        label: "决定任务",
        description: "任务选择完全保密。",
        kind: "choice",
        field: "choice",
        options
      }];
    }
    if (this.phase === "assassination" && role === "assassin") {
      return [{
        name: "assassinate_merlin",
        label: "刺杀梅林",
        description: "指出你认为的梅林。",
        kind: "target",
        field: "targetId",
        targetFilter: "any-living"
      }];
    }
    return [];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    const value = recordPayload(payload);
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";

    if (action === "propose_team") {
      if (this.phase !== "proposal") throw new Error("PROPOSAL_NOT_OPEN: Wait for the proposal phase.");
      if (this.leaderId !== actorId) throw new Error("NOT_THE_LEADER: Only the current leader can propose a team.");
      if (this.proposedTeam.length) throw new Error("TEAM_ALREADY_PROPOSED: The current proposal is fixed.");
      const memberIds = Array.isArray(value.memberIds) ? [...new Set(value.memberIds.filter((entry): entry is string => typeof entry === "string"))] : [];
      const size = this.teamSize(this.quest);
      if (memberIds.length !== size) throw new Error(`TEAM_SIZE_INVALID: This quest requires exactly ${size} members.`);
      if (!memberIds.includes(actorId)) throw new Error("TEAM_MUST_INCLUDE_LEADER: Include yourself in the proposed team.");
      for (const id of memberIds) if (!this.profiles.has(id)) throw new Error(`TEAM_MEMBER_NOT_FOUND: '${id}' is not a participant.`);
      this.proposedTeam = [...memberIds];
      const leaderName = this.profiles.get(actorId)?.displayName ?? actorId;
      for (const id of this.profiles.keys()) {
        const memberName = this.profiles.get(id)?.displayName ?? id;
        if (memberIds.includes(id)) {
          this.pushEvent(id, {
            type: "included",
            actorId,
            targetId: id,
            detail: `Quest ${this.quest}: ${leaderName} chose you for the quest team.`
          });
        } else {
          this.pushEvent(id, {
            type: "excluded",
            actorId,
            targetId: id,
            detail: `Quest ${this.quest}: ${leaderName} left you off the quest team.`
          });
        }
      }
      this.phase = "vote";
      this.emitUpdate();
      return {
        action,
        detail: reason ? `${memberIds.join(", ")}; ${reason}` : memberIds.join(", "),
        result: { accepted: true, team: this.proposedTeam }
      };
    }

    if (action === "cast_team_vote") {
      if (this.phase !== "vote") throw new Error("VOTE_NOT_OPEN: Team voting is not open.");
      if (this.teamVotes.has(actorId)) throw new Error("VOTE_ALREADY_CAST: Your vote is fixed.");
      const accept = value.accept === true;
      this.teamVotes.set(actorId, accept);
      this.emitUpdate();
      return { action, detail: reason ? `${accept}; ${reason}` : String(accept), result: { accepted: true, accept } };
    }

    if (action === "cast_quest_vote") {
      if (this.phase !== "quest") throw new Error("QUEST_NOT_OPEN: Quest voting is not open.");
      if (!this.proposedTeam.includes(actorId)) throw new Error("NOT_ON_THE_QUEST: Only approved team members decide the quest.");
      if (this.questVotes.has(actorId)) throw new Error("QUEST_VOTE_ALREADY_CAST: Your quest choice is fixed.");
      const choice = value.choice;
      if (choice !== "succeed" && choice !== "fail") throw new Error("QUEST_CHOICE_INVALID: Choose succeed or fail.");
      if (choice === "fail" && isLoyalRole(role)) throw new Error("LOYAL_MUST_SUCCEED: Loyal participants cannot fail a quest.");
      this.questVotes.set(actorId, choice);
      this.emitUpdate();
      return { action, detail: reason ? `${choice}; ${reason}` : choice, result: { accepted: true, choice } };
    }

    if (action === "assassinate_merlin") {
      if (this.assassinated) throw new Error("ASSASSINATION_ALREADY_USED: The final shot has been taken.");
      if (this.phase !== "assassination") throw new Error("ASSASSINATION_NOT_OPEN: The assassination happens only after three successful quests.");
      if (role !== "assassin") throw new Error("ASSASSIN_ONLY: Only the assassin chooses the target.");
      if (typeof value.targetId !== "string" || !value.targetId) throw new Error("TARGET_REQUIRED: Name a loyal participant.");
      const targetId = value.targetId;
      if (!this.profiles.has(targetId)) throw new Error(`TARGET_NOT_FOUND: '${targetId}' is not a participant.`);
      const targetRole = this.roles.get(targetId)!;
      if (isEvilRole(targetRole)) throw new Error("TARGET_MUST_BE_LOYAL: The assassin must target a loyal participant.");
      const correct = targetRole === "merlin";
      this.assassinated = true;
      this.pushEvent(targetId, {
        type: "assassinated",
        targetId,
        facts: { correct, assassinId: actorId },
        detail: correct
          ? `The Assassin found you. Your identity as Merlin was your death — but the loyal cause fell with you.`
          : `The Assassin pointed at you, and missed. Your identity (${roleLabel(targetRole)}) stays your own.`
      });
      this.winners = correct ? this.factionMembers(["assassin", "mordred", "minion"]) : this.factionMembers(["merlin", "servant"]);
      this.outcome = correct
        ? `${this.profiles.get(actorId)?.displayName} identified ${this.profiles.get(targetId)?.displayName} as Merlin. The loyal cause falls; evil wins.`
        : `${this.profiles.get(actorId)?.displayName} missed — ${this.profiles.get(targetId)?.displayName} was not Merlin. The loyal side wins.`;
      for (const id of this.profiles.keys()) this.lastExperiences.set(id, `${this.outcome} Final roles: ${[...this.roles].map(([memberId, memberRole]) => `${memberId}=${memberRole}`).join(", ")}.`);
      this.addLog(this.outcome, this.quest, correct ? "win" : "misplay");
      this.finish();
      return { action, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, correct, targetId } };
    }

    throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    const ids = [...this.profiles.keys()];
    if (this.phase === "discussion") {
      if (!this.discussion) this.discussion = this.createDiscussion();
      const actors = this.discussion.nextWave();
      if (actors.length === 0) {
        this.discussion = null;
        this.phase = "proposal";
        this.emitUpdate();
        return this.proposalActivation();
      }
      const wave = this.discussion.waveNumber;
      return {
        id: `av:${this.quest}:discussion:${wave}`,
        label: wave === 1 ? `第 ${this.quest} 次任务讨论` : `第 ${this.quest} 次任务讨论 · 回应第 ${wave - 1} 轮`,
        actorIds: actors,
        mode: "sequential",
        instructionFor: (actorId) => wave === 1
          ? "Opening round at the round table. State your read of loyalties, ask sharp questions, or stay reserved — but do not propose a team or vote yet."
          : "The table is live and people have reacted. Answer questions directed at you, defend yourself if accused, test anyone dodging specifics, or stay silent if you have nothing new. Do not propose a team or vote yet."
      };
    }
    if (this.phase === "proposal") return this.proposalActivation();
    if (this.phase === "vote") {
      return {
        id: `av:${this.quest}:vote`,
        label: `第 ${this.quest} 次任务表决`,
        actorIds: ids,
        mode: "parallel",
        instructionFor: () => `The proposed team is [${this.proposedTeam.join(", ")}]. Call cast_team_vote exactly once: approve or reject. Rejecting too often hands evil a free quest failure.`
      };
    }
    if (this.phase === "quest") {
      return {
        id: `av:${this.quest}:quest`,
        label: `第 ${this.quest} 次任务执行`,
        actorIds: this.proposedTeam,
        mode: "parallel",
        instructionFor: () => "You are on the approved quest. Call cast_quest_vote exactly once. Loyal members must succeed; minions may fail the quest secretly."
      };
    }
    const assassin = [...this.roles].find(([, candidate]) => candidate === "assassin")?.[0];
    return {
      id: `av:${this.quest}:assassination`,
      label: "最终刺杀",
      actorIds: assassin ? [assassin] : [],
      mode: "sequential",
      instructionFor: () => "Three quests succeeded. As the Assassin, weigh every word spoken this game and call assassinate_merlin exactly once against the loyal player you believe is Merlin."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion")) {
      this.discussion?.endWave();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":proposal")) {
      if (this.proposedTeam.length) {
        this.phase = "vote";
        this.emitUpdate();
        return { completed: true, missingActorIds: [] };
      }
      return {
        completed: false,
        missingActorIds: [this.leaderId],
        retryInstruction: `The team has not been proposed. Call propose_team with exactly ${this.teamSize(this.quest)} members including yourself.`
      };
    }
    if (activation.id.endsWith(":vote")) {
      const missingActorIds = activation.actorIds.filter((id) => !this.teamVotes.has(id));
      if (missingActorIds.length) {
        return {
          completed: false,
          missingActorIds,
          retryInstruction: "Your team vote is missing. Call cast_team_vote now: approve or reject the proposed team."
        };
      }
      this.resolveTeamVote();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":quest")) {
      const missingActorIds = activation.actorIds.filter((id) => !this.questVotes.has(id));
      if (missingActorIds.length) {
        return {
          completed: false,
          missingActorIds,
          retryInstruction: "Your quest choice is missing. Call cast_quest_vote now: succeed or fail the quest."
        };
      }
      this.resolveQuest();
      return { completed: true, missingActorIds: [] };
    }
    if (this.assassinated) return { completed: true, missingActorIds: [] };
    if (this.phase !== "assassination") {
      return { completed: true, missingActorIds: [] };
    }
    return {
      completed: false,
      missingActorIds: activation.actorIds,
      retryInstruction: "The assassination is required. Call assassinate_merlin exactly once against a loyal participant."
    };
  }

  experienceFor(actorId: string): string | undefined {
    return this.lastExperiences.get(actorId);
  }

  async sendMessage(input: {
    senderId: string;
    channel: "public" | "private" | "team";
    text: string;
    recipientIds?: string[];
    replyTo?: string;
  }): Promise<SocialMessage> {
    if (input.channel === "team" && (!input.recipientIds || input.recipientIds.length === 0)) {
      input = {
        ...input,
        recipientIds: [...this.roles].filter(([id, role]) => id !== input.senderId && (role === "assassin" || role === "mordred")).map(([id]) => id)
      };
    }
    const message = await super.sendMessage(input);
    if (message.channel === "public" && this.phase === "discussion" && this.discussion) {
      this.discussion.onMessage({
        senderId: message.senderId,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {})
      });
      this.detectSocialActs(message);
    }
    return message;
  }

  /**
   * Read public speech for its social meaning: who was accused, who was
   * defended. These become appraisal events and suspicion pressure.
   */
  private detectSocialActs(message: SocialMessage): void {
    for (const [id] of this.roles) {
      if (id === message.senderId) continue;
      const name = this.profiles.get(id)?.displayName ?? id;
      const atName = message.text.indexOf(name);
      const atId = message.text.indexOf(id);
      if (atName === -1 && atId === -1) continue;
      const at = atName !== -1 ? atName : atId;
      const window = message.text.slice(Math.max(0, at - 16), at + 40);
      const snippet = message.text.slice(0, 120);
      if (ACCUSATION_LEXICON.test(window)) {
        this.suspicion.noteAccusation(this.quest, message.senderId, id);
        this.pushEvent(id, {
          type: "accused",
          actorId: message.senderId,
          targetId: id,
          detail: `Quest ${this.quest} discussion: ${message.senderName} accused you at the round table — "${snippet}"`
        });
      } else if (DEFENSE_LEXICON.test(window)) {
        this.pushEvent(id, {
          type: "defended",
          actorId: message.senderId,
          targetId: id,
          detail: `Quest ${this.quest} discussion: ${message.senderName} stood up for you at the round table — "${snippet}"`
        });
      }
    }
  }

  private proposalActivation(): WorldActivation {
    return {
      id: `av:${this.quest}:proposal`,
      label: `第 ${this.quest} 次任务组队`,
      actorIds: [this.leaderId],
      mode: "sequential",
      instructionFor: () => `You are the leader. Call propose_team with exactly ${this.teamSize(this.quest)} members including yourself. Consider every player's incentive to fail the quest and the suspicion climate: ${this.suspicion.climateText((id) => this.profiles.get(id)?.displayName ?? id)}.`
    };
  }

  protected currentTurn(): number {
    return this.quest;
  }

  protected currentPhase(): string {
    return this.phase;
  }

  protected isAlive(_actorId: string): boolean {
    return true;
  }

  protected observerRole(actorId: string): string | undefined {
    return roleLabel(this.roles.get(actorId));
  }

  protected roleVisibleTo(viewerId: string | undefined, subjectId: string, alive: boolean): boolean {
    if (viewerId === subjectId) return true;
    if (this.status === "finished") return true;
    const viewerRole = viewerId ? this.roles.get(viewerId) : undefined;
    const subjectRole = this.roles.get(subjectId);
    return Boolean(viewerRole && subjectRole && isEvilRole(viewerRole) && isEvilRole(subjectRole));
  }

  protected messageChannelsFor(actorId: string): SocialChannel[] {
    return isEvilRole(this.roles.get(actorId)) ? ["public", "private", "team"] : ["public", "private"];
  }

  protected redactDetails(details: Record<string, unknown>, actorId?: string): Record<string, unknown> {
    const next = super.redactDetails(details, actorId);
    const visibleRoles: Record<string, Role> = {};
    for (const [id, role] of this.roles) {
      if (this.roleVisibleTo(actorId, id, true)) visibleRoles[id] = role;
    }
    if (Object.keys(visibleRoles).length) next.roles = visibleRoles;
    return next;
  }

  protected validateMessage(senderId: string, channel: "public" | "private" | "team", recipientIds: string[]): void {
    if (channel === "private") {
      if (recipientIds.length === 0) throw new Error("RECIPIENT_REQUIRED: Private messages require recipientIds.");
      for (const id of recipientIds) this.requireProfile(id);
      return;
    }
    if (channel === "team") {
      if (!isEvilRole(this.roles.get(senderId))) throw new Error("TEAM_CHANNEL_FORBIDDEN: Only minions have access to the team channel.");
      if (recipientIds.some((id) => !isEvilRole(this.roles.get(id)))) {
        throw new Error("TEAM_RECIPIENT_INVALID: Team messages may only target fellow minions.");
      }
    }
  }

  private availableActions(actorId: string, role: Role): string[] {
    if (this.phase === "discussion") return ["communicate", "recall_memory", "reflect_on_social_situation", "update_inner_state"];
    if (this.phase === "proposal") return this.leaderId === actorId ? ["propose_team", "communicate"] : [];
    if (this.phase === "vote") return this.teamVotes.has(actorId) ? [] : ["cast_team_vote", "remember_experience"];
    if (this.phase === "quest") return this.proposedTeam.includes(actorId) && !this.questVotes.has(actorId) ? ["cast_quest_vote"] : [];
    if (this.phase === "assassination") return role === "assassin" ? ["assassinate_merlin"] : [];
    return [];
  }

  private resolveTeamVote(): void {
    const votes = Object.fromEntries(this.teamVotes);
    const approveCount = [...this.teamVotes.values()].filter(Boolean).length;
    const team = [...this.proposedTeam];
    this.teamVotes.clear();
    const approved = approveCount > this.profiles.size / 2;
    const text = approved
      ? `Quest ${this.quest}: the table approved team [${team.join(", ")}] with ${approveCount} votes.`
      : `Quest ${this.quest}: the table rejected team [${team.join(", ")}] with ${approveCount} approvals.`;
    this.addLog(text, this.quest, approved ? "alliance" : undefined);
    if (approved) {
      this.rejections = 0;
      this.phase = "quest";
      this.emitUpdate();
      return;
    }
    this.rejections += 1;
    if (this.rejections >= MAX_REJECTIONS) {
      this.winners = this.factionMembers(["assassin", "mordred", "minion"]);
      this.outcome = "连续五次组队被否决——圆桌无法达成任何共识，内奸阵营获胜。";
      this.addLog(this.outcome, this.quest, "win");
      this.endGame();
      return;
    }
    this.proposedTeam = [];
    this.rotateLeader();
    this.phase = "proposal";
    this.emitUpdate();
  }

  private resolveQuest(): void {
    const team = [...this.proposedTeam];
    const failCount = [...this.questVotes.values()].filter((choice) => choice === "fail").length;
    this.questVotes.clear();
    this.proposedTeam = [];
    this.teamVotes.clear();
    this.recordQuestFailure(team, {}, false, failCount);
  }

  /** The official team size for a quest at this table's player count. */
  private teamSize(quest: number): number {
    const sizes = this.teamSizes;
    return sizes[Math.min(quest, sizes.length) - 1];
  }

  /** Fails needed to sink a quest: the 4th quest needs two at 7+ players. */
  private failsNeededForQuest(): number {
    return questFailsNeeded(this.profiles.size, this.quest);
  }

  private recordQuestFailure(team: string[], teamVotes: Record<string, boolean>, rejected = false, failCount = 0): void {
    const failsNeeded = this.failsNeededForQuest();
    const outcome = rejected || failCount >= failsNeeded ? "fail" : "success";
    const text = rejected
      ? `Quest ${this.quest}: consecutive proposals were rejected, so the quest failed by deadlock.`
      : outcome === "fail"
        ? `Quest ${this.quest} failed with ${failCount} hidden failure vote(s) (${failsNeeded} needed).`
        : `Quest ${this.quest} succeeded.`;
    const record: QuestRecord = {
      quest: this.quest,
      leaderId: this.leaderId,
      team,
      teamVotes,
      outcome,
      failCount,
      text
    };
    this.questHistory.push(record);
    if (outcome === "fail") this.failures += 1;
    else this.successes += 1;
    for (const id of this.profiles.keys()) {
      this.lastExperiences.set(id, `${text} Quest ${this.quest} team: ${team.join(", ")}.`);
      const onTeam = team.includes(id);
      if (outcome === "fail") {
        if (onTeam) {
          this.suspicion.noteOutcome(this.quest, "quest", id);
          this.pushEvent(id, {
            type: "quest-failed",
            targetId: id,
            facts: { onTeam: true, evil: isEvilRole(this.roles.get(id)), failCount },
            detail: `Quest ${this.quest} failed with ${failCount} hidden failure vote(s) — and you were on the team.`
          });
        } else {
          this.pushEvent(id, {
            type: "quest-failed",
            targetId: id,
            facts: { onTeam: false, failCount },
            detail: `Quest ${this.quest} failed with ${failCount} hidden failure vote(s). The saboteurs are among: ${team.map((member) => this.profiles.get(member)?.displayName ?? member).join(", ")}.`
          });
        }
      } else {
        if (onTeam) this.suspicion.noteResolved(this.quest, id);
        this.pushEvent(id, {
          type: "quest-passed",
          targetId: id,
          facts: { onTeam },
          detail: onTeam
            ? `Quest ${this.quest} succeeded — you were on the winning team.`
            : `Quest ${this.quest} succeeded. The table's trust holds for now.`
        });
      }
    }
    this.addLog(text, this.quest, outcome === "fail" ? "betrayal" : "promise-kept");
    if (this.failures >= 2) {
      this.winners = this.factionMembers(["assassin", "mordred", "minion"]);
      this.outcome = "两次任务失败，内奸得逞，圆桌陷落。";
      this.endGame();
      return;
    }
    if (this.successes >= 3) {
      this.phase = "assassination";
      this.addLog("三次任务全部成功。刺客将进行最后一刺。", this.quest);
      this.emitUpdate();
      return;
    }
    if (this.quest >= this.totalQuests) {
      this.phase = "assassination";
      this.addLog(`全部 ${this.totalQuests} 次任务结束，进入最终刺杀。`, this.quest);
      this.emitUpdate();
      return;
    }
    this.quest += 1;
    this.suspicion.decay(0.8);
    this.rotateLeader();
    this.phase = "discussion";
    this.discussion = this.createDiscussion();
    this.emitUpdate();
  }

  private rotateLeader(): void {
    const ids = [...this.profiles.keys()];
    const index = ids.indexOf(this.leaderId);
    this.leaderId = ids[(index + 1) % ids.length];
  }

  private endGame(): void {
    this.addLog(this.outcome, this.quest);
    for (const id of this.profiles.keys()) {
      const won = this.winners.includes(id);
      this.pushEvent(id, {
        type: won ? "win" : "lose",
        targetId: id,
        detail: won ? `Game over: your faction won — ${this.outcome}` : `Game over: your faction lost — ${this.outcome}`
      });
    }
    this.finish();
  }

  protected messageWave(): number | undefined {
    return this.discussion?.waveNumber;
  }

  private createDiscussion(): DiscussionDirector {
    return new DiscussionDirector({
      actorIds: [...this.profiles.keys()],
      displayName: (id) => this.profiles.get(id)?.displayName ?? id,
      ...discussionPersonality(this.profiles)
    });
  }

  private factionMembers(roles: Role[]): string[] {
    return [...this.roles].filter(([, role]) => roles.includes(role)).map(([id]) => id);
  }

  private summary(): string {
    if (this.status === "finished") return this.outcome;
    return `任务 ${this.quest} / ${this.totalQuests} · 成功 ${this.successes} · 失败 ${this.failures} · ${phaseLabel(this.phase)}`;
  }
}

function roleObjective(role: Role): string {
  if (role === "merlin") return "Help three quests succeed while hiding your identity: the Assassin gets one shot at you if the quests are won. You know the Assassin's identity but not Mordred's.";
  if (role === "servant") return "Help three quests succeed. You know nothing at the start — trust must be built from behavior alone.";
  if (role === "assassin") return "Fail two quests through your team. If three quests succeed anyway, assassinate Merlin with your single, final guess.";
  if (role === "minion") return "Fail two quests through your team. You know your fellow minions and may play either a loud or a quiet saboteur.";
  return "Fail two quests through your team. Merlin cannot see you — exploit that blindness.";
}

function situationFor(phase: Phase, quest: number, totalQuests: number, successes: number, failures: number): string {
  if (phase === "discussion") return `Quest ${quest} of ${totalQuests} is forming. Successes: ${successes}, failures: ${failures}. Hidden loyalties are the only currency.`;
  if (phase === "proposal") return `The leader is assembling quest ${quest}'s team. Every proposal is a public signal.`;
  if (phase === "vote") return `The proposed team for quest ${quest} is being voted on. Everyone's vote will be revealed together.`;
  if (phase === "quest") return `Quest ${quest} is executing. Only approved members act, and their choices stay secret.`;
  return "Three quests succeeded. The Assassin is about to take the final shot at Merlin.";
}

function roleLabel(role: Role | undefined): string {
  if (role === "merlin") return "梅林";
  if (role === "servant") return "忠臣";
  if (role === "assassin") return "刺客";
  if (role === "mordred") return "莫德雷德";
  if (role === "minion") return "爪牙";
  return "未知";
}

function phaseLabel(phase: Phase): string {
  if (phase === "discussion") return "圆桌讨论";
  if (phase === "proposal") return "队长组队";
  if (phase === "vote") return "全体表决";
  if (phase === "quest") return "任务执行";
  return "最终刺杀";
}

function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}