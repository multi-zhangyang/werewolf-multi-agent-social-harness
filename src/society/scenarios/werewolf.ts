import { randomInt } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  ScenarioSummary,
  SocialMessage,
  SocietyAgentContext,
  WorldActivation,
  WorldSnapshot
} from "../contracts";
import { contextFromRunContext, SocialWorldBase } from "../world";
import { boundedRounds, emitAction } from "./helpers";

type Role = "wolf" | "seer" | "jester" | "villager";
type Phase = "day-discussion" | "day-vote" | "night";

interface DayRecord {
  day: number;
  votes: Record<string, string>;
  eliminatedId?: string;
  eliminatedRole?: Role;
  nightTargetId?: string;
  nightTargetRole?: Role;
}

export class WerewolfWorld extends SocialWorldBase {
  private readonly maxDays: number;
  private readonly roles = new Map<string, Role>();
  private readonly alive = new Set<string>();
  private readonly votes = new Map<string, string>();
  private readonly wolfTargets = new Map<string, string>();
  private readonly seerKnowledge = new Map<string, Map<string, Role>>();
  private readonly seerTargets = new Map<string, string>();
  private readonly history: DayRecord[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private winners: string[] = [];
  private outcome = "";
  private phase: Phase = "day-discussion";
  private day = 1;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    if (profiles.length !== scenario.players) throw new Error(`PLAYER_COUNT_INVALID: ${scenario.name} requires ${scenario.players} participants.`);
    this.maxDays = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    const shuffledIds = shuffle(profiles.map((profile) => profile.id));
    const deck: Role[] = ["wolf", "wolf", "seer", "jester", "villager", "villager"];
    shuffledIds.forEach((id, index) => {
      this.roles.set(id, deck[index]);
      this.alive.add(id);
      if (deck[index] === "seer") this.seerKnowledge.set(id, new Map());
    });
    this.addStory("第一天", "身份已经分配。公开讨论开始，所有承诺都可能是策略。", "neutral", 1);
  }

  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.day,
      totalTurns: this.maxDays,
      phase: phaseLabel(this.phase),
      summary: this.summary(),
      details: {
        roles: Object.fromEntries(this.roles),
        aliveIds: [...this.alive],
        pendingVotes: Object.fromEntries(this.votes),
        pendingNightTargets: Object.fromEntries(this.wolfTargets),
        history: this.history,
        winners: this.winners,
        outcome: this.outcome
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const role = this.roles.get(actorId)!;
    const teammates = role === "wolf"
      ? [...this.roles].filter(([id, candidateRole]) => id !== actorId && candidateRole === "wolf").map(([id]) => id)
      : [];
    const knowledge = role === "seer" ? Object.fromEntries(this.seerKnowledge.get(actorId) ?? []) : {};
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.day,
      phase: this.phase,
      situation: situationFor(this.phase, role, this.alive.size, this.wolvesAlive().length),
      privateContext: [
        `Your hidden role: ${role}.`,
        `Your objective: ${roleObjective(role)}.`,
        teammates.length ? `Wolf teammates: ${teammates.join(", ")}.` : "",
        role === "seer" ? `Private investigations: ${Object.entries(knowledge).map(([id, knownRole]) => `${id}=${knownRole}`).join(", ") || "none"}.` : "",
        `Your vote: ${this.votes.get(actorId) ?? "not cast"}.`,
        `You are ${this.alive.has(actorId) ? "alive" : "eliminated"}.`
      ].filter(Boolean).join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: this.alive.has(actorId), role },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: this.alive.has(profile.id),
        status: this.statuses.get(profile.id) ?? "idle",
        ...(!this.alive.has(profile.id) ? { visibleRole: this.roles.get(profile.id) } : {})
      })),
      recentMessages: this.visibleMessages(actorId).slice(-42),
      availableActions: this.availableActions(actorId, role)
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    const vote = tool({
      name: "cast_day_vote",
      description: "Cast your binding daytime vote against one living participant. Votes remain hidden until every living participant commits and cannot be changed.",
      parameters: z.object({ targetId: z.string().min(1), reason: z.string().min(1).max(600) }).strict(),
      execute: async ({ targetId, reason }, runContext) => {
        const context = contextFromRunContext(runContext);
        if (this.phase !== "day-vote") throw new Error("VOTE_NOT_OPEN: cast_day_vote is only valid during the daytime vote phase.");
        this.assertActiveActor(actorId);
        this.assertLivingTarget(targetId);
        if (this.votes.has(actorId)) throw new Error("VOTE_ALREADY_CAST: Your daytime vote is fixed.");
        this.votes.set(actorId, targetId);
        emitAction(context, "cast_day_vote", `${targetId}; ${reason}`);
        this.emitUpdate();
        return { accepted: true, targetId, waitingFor: [...this.alive].filter((id) => !this.votes.has(id)) };
      }
    });
    const tools: Tool<SocietyAgentContext>[] = [vote as Tool<SocietyAgentContext>];
    if (role === "wolf") {
      const eliminate = tool({
        name: "choose_night_target",
        description: "As a living wolf at night, nominate one living non-wolf participant for elimination. Each wolf submits a target; the pack's majority decides.",
        parameters: z.object({ targetId: z.string().min(1), reason: z.string().min(1).max(600) }).strict(),
        execute: async ({ targetId, reason }, runContext) => {
          const context = contextFromRunContext(runContext);
          if (this.phase !== "night") throw new Error("NIGHT_ACTION_NOT_OPEN: choose_night_target is only valid at night.");
          this.assertActiveActor(actorId);
          this.assertLivingTarget(targetId);
          if (this.roles.get(targetId) === "wolf") throw new Error("INVALID_WOLF_TARGET: Choose a living non-wolf participant.");
          if (this.wolfTargets.has(actorId)) throw new Error("NIGHT_TARGET_ALREADY_CHOSEN: Your nomination is fixed.");
          this.wolfTargets.set(actorId, targetId);
          emitAction(context, "choose_night_target", `${targetId}; ${reason}`);
          this.emitUpdate();
          return { accepted: true, targetId };
        }
      });
      tools.push(eliminate as Tool<SocietyAgentContext>);
    }
    if (role === "seer") {
      const investigate = tool({
        name: "investigate_identity",
        description: "As the living seer at night, inspect one other living participant. The exact hidden role is returned privately and remains available in future observations.",
        parameters: z.object({ targetId: z.string().min(1), reason: z.string().min(1).max(600) }).strict(),
        execute: async ({ targetId, reason }, runContext) => {
          const context = contextFromRunContext(runContext);
          if (this.phase !== "night") throw new Error("INVESTIGATION_NOT_OPEN: investigate_identity is only valid at night.");
          this.assertActiveActor(actorId);
          this.assertLivingTarget(targetId);
          if (targetId === actorId) throw new Error("INVALID_INVESTIGATION_TARGET: Choose another living participant.");
          if (this.seerTargets.has(actorId)) throw new Error("INVESTIGATION_ALREADY_USED: Your investigation for tonight is fixed.");
          this.seerTargets.set(actorId, targetId);
          const targetRole = this.roles.get(targetId)!;
          this.seerKnowledge.get(actorId)?.set(targetId, targetRole);
          emitAction(context, "investigate_identity", `${targetId}; ${reason}`);
          this.emitUpdate();
          return { targetId, role: targetRole };
        }
      });
      tools.push(investigate as Tool<SocietyAgentContext>);
    }
    return tools;
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    const aliveIds = [...this.alive];
    if (this.phase === "day-discussion") {
      return {
        id: `ww:${this.day}:discussion`,
        label: `第 ${this.day} 天讨论`,
        actorIds: aliveIds,
        mode: "sequential",
        instructionFor: () => "Speak once to the living group. Advance your hidden objective through truthful claims, selective disclosure, questioning, coalition building, or deception. Do not cast a vote yet."
      };
    }
    if (this.phase === "day-vote") {
      return {
        id: `ww:${this.day}:vote`,
        label: `第 ${this.day} 天投票`,
        actorIds: aliveIds,
        mode: "parallel",
        instructionFor: () => "The discussion is closed. You must call cast_day_vote exactly once against a living participant. Consider not only hidden roles but how every faction benefits from being suspected or eliminated."
      };
    }
    const wolves = this.wolvesAlive();
    const seers = [...this.alive].filter((id) => this.roles.get(id) === "seer");
    return {
      id: `ww:${this.day}:night`,
      label: `第 ${this.day} 夜`,
      actorIds: [...wolves, ...seers],
      mode: "sequential",
      instructionFor: (actorId) => this.roles.get(actorId) === "wolf"
        ? "Use the private team channel if coordination is useful, then call choose_night_target exactly once against a living non-wolf."
        : "Call investigate_identity exactly once on another living participant. Keep the result private unless revealing it later serves your strategy."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.endsWith(":discussion")) {
      this.phase = "day-vote";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":vote")) {
      const missingActorIds = activation.actorIds.filter((id) => !this.votes.has(id));
      if (missingActorIds.length) {
        return { completed: false, missingActorIds, retryInstruction: "Your vote is missing. Call cast_day_vote now against one living participant." };
      }
      this.resolveVote();
      return { completed: true, missingActorIds: [] };
    }
    const missingActorIds = activation.actorIds.filter((id) => {
      const role = this.roles.get(id);
      return role === "wolf" ? !this.wolfTargets.has(id) : role === "seer" ? !this.seerTargets.has(id) : false;
    });
    if (missingActorIds.length) {
      return {
        completed: false,
        missingActorIds,
        retryInstruction: "Your required night action is missing. Call the role-specific tool exactly once now: wolves must call choose_night_target; the seer must call investigate_identity."
      };
    }
    this.resolveNight();
    return { completed: true, missingActorIds: [] };
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
        recipientIds: [...this.alive].filter((id) => id !== input.senderId && this.roles.get(id) === "wolf")
      };
    }
    return super.sendMessage(input);
  }

  protected currentTurn(): number {
    return this.day;
  }

  protected currentPhase(): string {
    return this.phase;
  }

  protected isAlive(actorId: string): boolean {
    return this.alive.has(actorId);
  }

  protected observerRole(actorId: string): string | undefined {
    return roleLabel(this.roles.get(actorId));
  }

  protected validateMessage(senderId: string, channel: "public" | "private" | "team", recipientIds: string[]): void {
    if (!this.alive.has(senderId)) throw new Error("ACTOR_ELIMINATED: Eliminated participants cannot communicate.");
    if (channel === "private") {
      if (recipientIds.length === 0) throw new Error("RECIPIENT_REQUIRED: Private messages require recipientIds.");
      for (const id of recipientIds) this.assertLivingTarget(id);
      return;
    }
    if (channel === "team") {
      if (this.roles.get(senderId) !== "wolf") throw new Error("TEAM_CHANNEL_FORBIDDEN: Only wolves have access to this team channel.");
      if (recipientIds.some((id) => this.roles.get(id) !== "wolf" || !this.alive.has(id))) {
        throw new Error("TEAM_RECIPIENT_INVALID: Team messages may only target living wolf teammates.");
      }
    }
  }

  private availableActions(actorId: string, role: Role): string[] {
    if (!this.alive.has(actorId)) return [];
    if (this.phase === "day-discussion") return ["communicate", "recall_memory", "reflect_on_social_situation", "update_social_model"];
    if (this.phase === "day-vote") return ["cast_day_vote", "remember_experience"];
    if (role === "wolf") return ["communicate:team", "choose_night_target"];
    if (role === "seer") return ["investigate_identity", "remember_experience"];
    return [];
  }

  private resolveVote(): void {
    const tally = tallyTargets(this.votes);
    const ranked = [...tally].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const hasTie = ranked.length > 1 && ranked[0][1] === ranked[1][1];
    const eliminatedId = hasTie ? undefined : ranked[0]?.[0];
    const eliminatedRole = eliminatedId ? this.roles.get(eliminatedId) : undefined;
    if (eliminatedId) this.alive.delete(eliminatedId);
    const record: DayRecord = { day: this.day, votes: Object.fromEntries(this.votes), ...(eliminatedId ? { eliminatedId, eliminatedRole } : {}) };
    this.history.push(record);
    const voteText = eliminatedId
      ? `${this.profiles.get(eliminatedId)?.displayName} was eliminated by vote and revealed as ${roleLabel(eliminatedRole)}.`
      : "The vote tied. Nobody was eliminated.";
    for (const id of this.profiles.keys()) this.lastExperiences.set(id, `Day ${this.day} vote: ${voteText} Votes: ${[...this.votes].map(([voter, target]) => `${voter}->${target}`).join(", ")}.`);
    this.addStory(`第 ${this.day} 天投票`, voteText, eliminatedId ? "warning" : "neutral", this.day);
    this.votes.clear();
    if (eliminatedRole === "jester") {
      this.endGame([eliminatedId!], "小丑被白天投票出局，第三阵营获胜。", "complete");
      return;
    }
    if (this.wolvesAlive().length === 0) {
      this.endGame(this.factionMembers(["seer", "villager"]), "所有狼人都已出局，村庄阵营获胜。", "complete");
      return;
    }
    if (this.wolvesHaveParity()) {
      this.endGame(this.factionMembers(["wolf"]), "狼人已经控制投票数量，狼人阵营获胜。", "danger");
      return;
    }
    this.phase = "night";
    this.emitUpdate();
  }

  private resolveNight(): void {
    const targetId = pluralityTarget(this.wolfTargets);
    if (targetId) this.alive.delete(targetId);
    const record = this.history.at(-1);
    if (record && record.day === this.day && targetId) {
      record.nightTargetId = targetId;
      record.nightTargetRole = this.roles.get(targetId);
    }
    const nightText = targetId
      ? `${this.profiles.get(targetId)?.displayName} was eliminated during the night and revealed as ${roleLabel(this.roles.get(targetId))}.`
      : "The night ended without an elimination.";
    for (const id of this.profiles.keys()) {
      const privateResult = this.roles.get(id) === "seer" && this.seerTargets.has(id)
        ? ` Your investigation: ${this.seerTargets.get(id)} is ${this.roles.get(this.seerTargets.get(id)!)}.`
        : "";
      this.lastExperiences.set(id, `Night ${this.day}: ${nightText}${privateResult}`);
    }
    this.addStory(`第 ${this.day} 夜`, nightText, targetId ? "danger" : "neutral", this.day);
    this.wolfTargets.clear();
    this.seerTargets.clear();
    if (this.wolvesAlive().length === 0) {
      this.endGame(this.factionMembers(["seer", "villager"]), "所有狼人都已出局，村庄阵营获胜。", "complete");
      return;
    }
    if (this.wolvesHaveParity()) {
      this.endGame(this.factionMembers(["wolf"]), "狼人已经控制剩余局面，狼人阵营获胜。", "danger");
      return;
    }
    if (this.day >= this.maxDays) {
      this.endGame(this.factionMembers(["wolf"]), "村庄未能在期限内找出狼人，狼人阵营获胜。", "danger");
      return;
    }
    this.day += 1;
    this.phase = "day-discussion";
    this.emitUpdate();
  }

  private endGame(winners: string[], outcome: string, tone: "complete" | "danger"): void {
    this.winners = winners;
    this.outcome = outcome;
    this.addStory("对局结束", outcome, tone, this.day);
    this.finish();
  }

  private wolvesAlive(): string[] {
    return [...this.alive].filter((id) => this.roles.get(id) === "wolf");
  }

  private wolvesHaveParity(): boolean {
    const wolves = this.wolvesAlive().length;
    return wolves > 0 && wolves >= this.alive.size - wolves;
  }

  private factionMembers(roles: Role[]): string[] {
    return [...this.roles].filter(([, role]) => roles.includes(role)).map(([id]) => id);
  }

  private assertActiveActor(actorId: string): void {
    if (!this.alive.has(actorId)) throw new Error("ACTOR_ELIMINATED: You cannot act after elimination.");
  }

  private assertLivingTarget(targetId: string): void {
    if (!this.profiles.has(targetId)) throw new Error(`TARGET_NOT_FOUND: '${targetId}' is not a participant.`);
    if (!this.alive.has(targetId)) throw new Error(`TARGET_INACTIVE: '${targetId}' is already eliminated.`);
  }

  private summary(): string {
    if (this.status === "finished") return this.outcome;
    return `第 ${this.day} / ${this.maxDays} 天 · ${this.alive.size} 人存活 · ${phaseLabel(this.phase)}`;
  }
}

function roleObjective(role: Role): string {
  if (role === "wolf") return "Keep at least one wolf alive until wolves control the vote. Conceal the pack and redirect suspicion.";
  if (role === "seer") return "Identify wolves with private investigations and help the village eliminate every wolf without exposing yourself too early.";
  if (role === "jester") return "Get yourself eliminated by the daytime vote. Looking deliberately suspicious can expose your objective, so manage how others model your incentives.";
  return "Find and eliminate every wolf while avoiding the jester's attempt to be voted out.";
}

function situationFor(phase: Phase, role: Role, aliveCount: number, wolvesAlive: number): string {
  if (phase === "day-discussion") return `${aliveCount} participants remain. Hidden objectives conflict, and public behavior may not reveal private strategy. Your role is ${role}.`;
  if (phase === "day-vote") return `Discussion is closed. Every living participant is choosing one binding vote. ${wolvesAlive} wolves remain, known only to the pack and observer.`;
  return role === "wolf" ? "Night phase: coordinate privately with the pack and choose a non-wolf target." : role === "seer" ? "Night phase: privately investigate one living participant." : "Night phase: you have no domain action and will not be activated.";
}

function roleLabel(role: Role | undefined): string {
  if (role === "wolf") return "狼人";
  if (role === "seer") return "预言家";
  if (role === "jester") return "小丑";
  if (role === "villager") return "村民";
  return "未知";
}

function phaseLabel(phase: Phase): string {
  if (phase === "day-discussion") return "白天讨论";
  if (phase === "day-vote") return "白天投票";
  return "夜晚行动";
}

function tallyTargets(votes: Map<string, string>): Map<string, number> {
  const tally = new Map<string, number>();
  for (const target of votes.values()) tally.set(target, (tally.get(target) ?? 0) + 1);
  return tally;
}

function pluralityTarget(votes: Map<string, string>): string | undefined {
  return [...tallyTargets(votes)].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}
