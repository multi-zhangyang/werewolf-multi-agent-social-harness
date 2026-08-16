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
import { contextFromRunContext, SocialWorldBase } from "../world";
import { boundedRounds, emitAction } from "./helpers";

type Role = "merlin" | "servant" | "assassin" | "mordred";
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

const TEAM_SIZES = [3, 4, 3, 4, 3];
const MAX_REJECTIONS = 4;

/**
 * Avalon (The Resistance). Six players: four loyal (Merlin + three servants)
 * against two minions (Assassin + Mordred, who is invisible to Merlin).
 * Leaders propose quest teams, everyone votes publicly, then team members
 * secretly choose success or failure. Three successful quests triggers the
 * final assassination: the Assassin has one shot at Merlin's identity.
 */
export class AvalonWorld extends SocialWorldBase {
  private readonly totalQuests: number;
  private readonly roles = new Map<string, Role>();
  private readonly questHistory: QuestRecord[] = [];
  private readonly teamVotes = new Map<string, boolean>();
  private readonly questVotes = new Map<string, "succeed" | "fail">();
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
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
    const ids = shuffle(profiles.map((profile) => profile.id));
    const deck: Role[] = ["merlin", "servant", "servant", "servant", "assassin", "mordred"];
    ids.forEach((id, index) => this.roles.set(id, deck[index]));
    this.leaderId = profiles[0].id;
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
        outcome: this.outcome
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const role = this.roles.get(actorId)!;
    const evilAllies = role === "assassin" || role === "mordred"
      ? [...this.roles].filter(([id, candidate]) => id !== actorId && (candidate === "assassin" || candidate === "mordred")).map(([id]) => id)
      : [];
    const knownEvil = role === "merlin"
      ? [...this.roles].filter(([, candidate]) => candidate === "assassin").map(([id]) => id)
      : evilAllies;
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.quest,
      phase: this.phase,
      situation: situationFor(this.phase, this.quest, this.totalQuests, this.successes, this.failures),
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
      description: `As the current leader, nominate the quest team. The team must contain exactly ${TEAM_SIZES[(this.quest - 1) % TEAM_SIZES.length]} members and must include yourself. The team is announced publicly before the vote.`,
      parameters: z.object({
        memberIds: z.array(z.string().min(1)).min(2).max(6),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async ({ memberIds, reason }, runContext) => {
        const context = contextFromRunContext(runContext);
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
        const context = contextFromRunContext(runContext);
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
        const context = contextFromRunContext(runContext);
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
          const context = contextFromRunContext(runContext);
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
        description: `选择 ${TEAM_SIZES[(this.quest - 1) % TEAM_SIZES.length]} 名成员（必须包含自己）。`,
        kind: "team",
        field: "memberIds",
        min: TEAM_SIZES[(this.quest - 1) % TEAM_SIZES.length],
        max: TEAM_SIZES[(this.quest - 1) % TEAM_SIZES.length]
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
      const options = role === "servant" || role === "merlin"
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
      const size = TEAM_SIZES[(this.quest - 1) % TEAM_SIZES.length];
      if (memberIds.length !== size) throw new Error(`TEAM_SIZE_INVALID: This quest requires exactly ${size} members.`);
      if (!memberIds.includes(actorId)) throw new Error("TEAM_MUST_INCLUDE_LEADER: Include yourself in the proposed team.");
      for (const id of memberIds) if (!this.profiles.has(id)) throw new Error(`TEAM_MEMBER_NOT_FOUND: '${id}' is not a participant.`);
      this.proposedTeam = [...memberIds];
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
      if (choice === "fail" && (role === "merlin" || role === "servant")) throw new Error("LOYAL_MUST_SUCCEED: Loyal participants cannot fail a quest.");
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
      if (targetRole === "assassin" || targetRole === "mordred") throw new Error("TARGET_MUST_BE_LOYAL: The assassin must target a loyal participant.");
      const correct = targetRole === "merlin";
      this.assassinated = true;
      this.winners = correct ? this.factionMembers(["assassin", "mordred"]) : this.factionMembers(["merlin", "servant"]);
      this.outcome = correct
        ? `${this.profiles.get(actorId)?.displayName} identified ${this.profiles.get(targetId)?.displayName} as Merlin. The loyal cause falls; evil wins.`
        : `${this.profiles.get(actorId)?.displayName} missed — ${this.profiles.get(targetId)?.displayName} was not Merlin. The loyal side wins.`;
      for (const id of this.profiles.keys()) this.lastExperiences.set(id, `${this.outcome} Final roles: ${[...this.roles].map(([memberId, memberRole]) => `${memberId}=${memberRole}`).join(", ")}.`);
      this.addLog(this.outcome, this.quest);
      this.finish();
      return { action, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, correct, targetId } };
    }

    throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    const ids = [...this.profiles.keys()];
    if (this.phase === "discussion") {
      return {
        id: `av:${this.quest}:discussion`,
        label: `第 ${this.quest} 次任务讨论`,
        actorIds: ids,
        mode: "sequential",
        instructionFor: () => "Speak once to the table. Build trust, question loyalties, or steer suspicion without revealing your hidden role unless it serves your cause. Do not propose or vote yet."
      };
    }
    if (this.phase === "proposal") {
      return {
        id: `av:${this.quest}:proposal`,
        label: `第 ${this.quest} 次任务组队`,
        actorIds: [this.leaderId],
        mode: "sequential",
        instructionFor: (actorId) => actorId === this.leaderId
          ? `You are the leader. Call propose_team with exactly ${TEAM_SIZES[(this.quest - 1) % TEAM_SIZES.length]} members including yourself. Consider every player's incentive to fail the quest.`
          : "The leader is choosing the team. You will vote next."
      };
    }
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
    if (activation.id.endsWith(":discussion")) {
      this.phase = "proposal";
      this.emitUpdate();
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
        retryInstruction: `The team has not been proposed. Call propose_team with exactly ${TEAM_SIZES[(this.quest - 1) % TEAM_SIZES.length]} members including yourself.`
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
    return super.sendMessage(input);
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
    return Boolean(viewerRole && subjectRole && (viewerRole === "assassin" || viewerRole === "mordred") && (subjectRole === "assassin" || subjectRole === "mordred"));
  }

  protected messageChannelsFor(actorId: string): SocialChannel[] {
    const role = this.roles.get(actorId);
    return role === "assassin" || role === "mordred" ? ["public", "private", "team"] : ["public", "private"];
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
      const role = this.roles.get(senderId);
      if (role !== "assassin" && role !== "mordred") throw new Error("TEAM_CHANNEL_FORBIDDEN: Only minions have access to the team channel.");
      if (recipientIds.some((id) => {
        const candidate = this.roles.get(id);
        return candidate !== "assassin" && candidate !== "mordred";
      })) {
        throw new Error("TEAM_RECIPIENT_INVALID: Team messages may only target your fellow minion.");
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
    this.addLog(text, this.quest);
    if (approved) {
      this.rejections = 0;
      this.phase = "quest";
      this.emitUpdate();
      return;
    }
    this.rejections += 1;
    if (this.rejections >= MAX_REJECTIONS) {
      this.recordQuestFailure(team, votes, true);
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

  private recordQuestFailure(team: string[], teamVotes: Record<string, boolean>, rejected = false, failCount = 0): void {
    const outcome = rejected || failCount > 0 ? "fail" : "success";
    const text = rejected
      ? `Quest ${this.quest}: four consecutive proposals were rejected, so the quest failed by deadlock.`
      : outcome === "fail"
        ? `Quest ${this.quest} failed with ${failCount} hidden failure vote(s).`
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
    }
    this.addLog(text, this.quest);
    if (this.failures >= 2) {
      this.winners = this.factionMembers(["assassin", "mordred"]);
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
    this.rotateLeader();
    this.phase = "discussion";
    this.emitUpdate();
  }

  private rotateLeader(): void {
    const ids = [...this.profiles.keys()];
    const index = ids.indexOf(this.leaderId);
    this.leaderId = ids[(index + 1) % ids.length];
  }

  private endGame(): void {
    this.addLog(this.outcome, this.quest);
    this.finish();
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