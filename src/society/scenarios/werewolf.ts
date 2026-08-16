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

const ACCUSATION_LEXICON = /怀疑|是狼|狼人|铁狼|出局|投|说谎|撒谎|骗|小丑|查杀|金水|装好人|带节奏|站队|伪/;
const DEFENSE_LEXICON = /相信|支持|担保|信任|不是狼|好人|别投|我信|没问题/;

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
  private discussion: DiscussionDirector | null = null;
  private readonly suspicion = new SuspicionClimate();
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
    this.discussion = this.createDiscussion();
    this.addLog("身份已经分配。公开讨论开始，所有承诺都可能是策略。", 1);
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
        outcome: this.outcome,
        ...(this.discussion ? { discussion: this.discussion.state() } : {}),
        suspicion: this.suspicion.snapshot()
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
      situation: `${situationFor(this.phase, role, this.alive.size, this.wolvesAlive().length)}\nPublic suspicion climate: ${this.suspicion.climateText((id) => this.profiles.get(id)?.displayName ?? id)}`,
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
      parameters: z.object({ targetId: z.string().min(1), reason: z.string().min(1).max(2_000) }).strict(),
      execute: async ({ targetId, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "cast_day_vote", { targetId, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const tools: Tool<SocietyAgentContext>[] = [vote as Tool<SocietyAgentContext>];
    if (role === "wolf") {
      const eliminate = tool({
        name: "choose_night_target",
        description: "As a living wolf at night, nominate one living non-wolf participant for elimination. Each wolf submits a target; the pack's majority decides.",
        parameters: z.object({ targetId: z.string().min(1), reason: z.string().min(1).max(2_000) }).strict(),
        execute: async ({ targetId, reason }, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "choose_night_target", { targetId, reason });
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(eliminate as Tool<SocietyAgentContext>);
    }
    if (role === "seer") {
      const investigate = tool({
        name: "investigate_identity",
        description: "As the living seer at night, inspect one other living participant. The exact hidden role is returned privately and remains available in future observations.",
        parameters: z.object({ targetId: z.string().min(1), reason: z.string().min(1).max(2_000) }).strict(),
        execute: async ({ targetId, reason }, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "investigate_identity", { targetId, reason });
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(investigate as Tool<SocietyAgentContext>);
    }
    return tools;
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    if (!this.alive.has(actorId)) return [];
    if (this.phase === "day-vote" && !this.votes.has(actorId)) {
      return [{
        name: "cast_day_vote",
        label: "提交投票",
        description: "投票在所有存活玩家提交后统一公开。",
        kind: "target",
        field: "targetId",
        targetFilter: "any-living"
      }];
    }
    if (this.phase === "night" && role === "wolf" && !this.wolfTargets.has(actorId)) {
      return [{
        name: "choose_night_target",
        label: "选择夜袭目标",
        description: "提名一名存活的非狼人玩家。",
        kind: "target",
        field: "targetId",
        targetFilter: "non-wolf"
      }];
    }
    if (this.phase === "night" && role === "seer" && !this.seerTargets.has(actorId)) {
      return [{
        name: "investigate_identity",
        label: "查验身份",
        description: "查验另一名存活玩家；结果仅你可见。",
        kind: "target",
        field: "targetId",
        targetFilter: "other-living"
      }];
    }
    return [];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    const value = recordPayload(payload);
    if (typeof value.targetId !== "string" || !value.targetId) {
      throw new Error("TARGET_REQUIRED: Select a participant.");
    }
    const targetId = value.targetId;
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    this.assertActiveActor(actorId);
    this.assertLivingTarget(targetId);
    if (action === "cast_day_vote") {
      if (this.phase !== "day-vote") throw new Error("VOTE_NOT_OPEN: Daytime voting is not open.");
      if (this.votes.has(actorId)) throw new Error("VOTE_ALREADY_CAST: Your vote is fixed.");
      this.votes.set(actorId, targetId);
      this.emitUpdate();
      return {
        action,
        detail: reason ? `${targetId}; ${reason}` : targetId,
        result: { accepted: true, targetId }
      };
    }
    if (action === "choose_night_target") {
      if (this.phase !== "night" || role !== "wolf") throw new Error("NIGHT_ACTION_FORBIDDEN: Only a living wolf can choose this target at night.");
      if (this.roles.get(targetId) === "wolf") throw new Error("INVALID_WOLF_TARGET: Choose a living non-wolf participant.");
      if (this.wolfTargets.has(actorId)) throw new Error("NIGHT_TARGET_ALREADY_CHOSEN: Your nomination is fixed.");
      this.wolfTargets.set(actorId, targetId);
      this.emitUpdate();
      return {
        action,
        detail: reason ? `${targetId}; ${reason}` : targetId,
        result: { accepted: true, targetId }
      };
    }
    if (action === "investigate_identity") {
      if (this.phase !== "night" || role !== "seer") throw new Error("INVESTIGATION_FORBIDDEN: Only a living seer can investigate at night.");
      if (targetId === actorId) throw new Error("INVALID_INVESTIGATION_TARGET: Choose another living participant.");
      if (this.seerTargets.has(actorId)) throw new Error("INVESTIGATION_ALREADY_USED: Your investigation is fixed for tonight.");
      const targetRole = this.roles.get(targetId)!;
      this.seerTargets.set(actorId, targetId);
      this.seerKnowledge.get(actorId)?.set(targetId, targetRole);
      this.emitUpdate();
      return {
        action,
        detail: reason ? `${targetId}; ${reason}` : targetId,
        result: { accepted: true, targetId, role: targetRole }
      };
    }
    throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    const aliveIds = [...this.alive];
    if (this.phase === "day-discussion") {
      // A discussion is not "everyone speaks once": the director opens with a
      // full round, then keeps activating whoever has response pressure until
      // the conversation naturally runs out of steam.
      if (!this.discussion) this.discussion = this.createDiscussion();
      const actors = this.discussion.nextWave();
      if (actors.length === 0) {
        this.discussion = null;
        this.phase = "day-vote";
        this.emitUpdate();
        return this.voteActivation();
      }
      const wave = this.discussion.waveNumber;
      return {
        id: `ww:${this.day}:discussion:${wave}`,
        label: wave === 1 ? `第 ${this.day} 天讨论` : `第 ${this.day} 天讨论 · 回应第 ${wave - 1} 轮`,
        actorIds: actors,
        mode: "sequential",
        instructionFor: (actorId) => wave === 1
          ? "Opening round of the day. Share your read of the situation: what you observed, who you trust or suspect, what you want to know. Ask questions, test others, or stay reserved — but do not cast a vote yet."
          : "The discussion is live and people have reacted. Respond to what was actually said: answer questions directed at you, defend yourself if accused, challenge weak claims, support allies, or expose contradictions. You may also stay silent if you have nothing new to add. Do not cast a vote yet."
      };
    }
    if (this.phase === "day-vote") return this.voteActivation();
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

  private voteActivation(): WorldActivation {
    return {
      id: `ww:${this.day}:vote`,
      label: `第 ${this.day} 天投票`,
      actorIds: [...this.alive],
      mode: "parallel",
      instructionFor: () => "The discussion is closed. You must call cast_day_vote exactly once against a living participant. Consider not only hidden roles but how every faction benefits from being suspected or eliminated."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion")) {
      // Close the wave: pressure decays, then the next activation() decides
      // whether anyone still has a reason to speak.
      this.discussion?.endWave();
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
    const message = await super.sendMessage(input);
    if (message.channel === "public" && this.phase === "day-discussion" && this.discussion) {
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
   * defended. These become appraisal events so the target's emotions and
   * relationships react — an accusation is not just a line of text.
   */
  private detectSocialActs(message: SocialMessage): void {
    for (const id of this.alive) {
      if (id === message.senderId) continue;
      const name = this.profiles.get(id)?.displayName ?? id;
      const atName = message.text.indexOf(name);
      const atId = message.text.indexOf(id);
      if (atName === -1 && atId === -1) continue;
      const at = atName !== -1 ? atName : atId;
      const window = message.text.slice(Math.max(0, at - 16), at + 40);
      const snippet = message.text.slice(0, 120);
      if (ACCUSATION_LEXICON.test(window)) {
        this.suspicion.noteAccusation(this.day, message.senderId, id);
        this.pushEvent(id, {
          type: "accused",
          actorId: message.senderId,
          targetId: id,
          detail: `Day ${this.day} discussion: ${message.senderName} accused you in public — "${snippet}"`
        });
      } else if (DEFENSE_LEXICON.test(window)) {
        this.pushEvent(id, {
          type: "defended",
          actorId: message.senderId,
          targetId: id,
          detail: `Day ${this.day} discussion: ${message.senderName} stood up for you in public — "${snippet}"`
        });
      }
    }
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

  protected roleVisibleTo(viewerId: string | undefined, subjectId: string, alive: boolean): boolean {
    if (!alive || viewerId === subjectId) return true;
    return Boolean(viewerId && this.roles.get(viewerId) === "wolf" && this.roles.get(subjectId) === "wolf");
  }

  protected messageChannelsFor(actorId: string): SocialChannel[] {
    return this.roles.get(actorId) === "wolf" ? ["public", "private", "team"] : ["public", "private"];
  }

  protected redactDetails(details: Record<string, unknown>, actorId?: string): Record<string, unknown> {
    const next = super.redactDetails(details, actorId);
    const visibleRoles: Record<string, Role> = {};
    for (const [id, role] of this.roles) {
      if (this.roleVisibleTo(actorId, id, this.alive.has(id))) visibleRoles[id] = role;
    }
    if (Object.keys(visibleRoles).length) next.roles = visibleRoles;
    if (actorId && this.roles.get(actorId) === "seer") {
      next.investigations = Object.fromEntries(this.seerKnowledge.get(actorId) ?? []);
    }
    return next;
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
    if (this.phase === "day-discussion") return ["communicate", "recall_memory", "reflect_on_social_situation", "update_inner_state"];
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
    this.addLog(voteText, this.day);

    // Appraisal events: every vote is a social act, every elimination a loss.
    for (const [voterId, targetId] of this.votes) {
      const voterName = this.profiles.get(voterId)?.displayName ?? voterId;
      const targetName = this.profiles.get(targetId)?.displayName ?? targetId;
      this.pushEvent(voterId, {
        type: "vote-cast",
        actorId: voterId,
        targetId,
        detail: `Day ${this.day}: you voted to eliminate ${targetName}.`
      });
      this.pushEvent(targetId, {
        type: "vote-against",
        actorId: voterId,
        targetId,
        detail: `Day ${this.day} vote: ${voterName} voted against you.`
      });
      for (const [otherVoter, otherTarget] of this.votes) {
        if (otherVoter !== voterId && otherTarget === targetId) {
          const allyName = this.profiles.get(otherVoter)?.displayName ?? otherVoter;
          this.pushEvent(voterId, {
            type: "voted-with",
            actorId: otherVoter,
            targetId,
            detail: `Day ${this.day} vote: ${allyName} voted for the same target as you.`
          });
        }
      }
    }
    if (eliminatedId) {
      const satisfied = eliminatedRole === "jester";
      this.pushEvent(eliminatedId, {
        type: "eliminated",
        targetId: eliminatedId,
        facts: { by: "vote", satisfied },
        detail: satisfied
          ? `Day ${this.day}: you were eliminated by the village vote — exactly as you planned, and the crowd finally saw the joke.`
          : `Day ${this.day}: you were eliminated by the village vote and revealed as ${roleLabel(eliminatedRole)}.`
      });
      for (const id of this.profiles.keys()) {
        if (id === eliminatedId) continue;
        this.pushEvent(id, {
          type: "eliminated-other",
          targetId: eliminatedId,
          facts: {
            role: roleLabel(eliminatedRole),
            iVoted: this.votes.get(id) === eliminatedId,
            ally: this.isVillageFaction(this.roles.get(id)) && eliminatedRole !== "jester" && eliminatedRole !== "wolf"
          },
          detail: `Day ${this.day}: ${this.profiles.get(eliminatedId)?.displayName ?? eliminatedId} was eliminated by vote and revealed as ${roleLabel(eliminatedRole)}${this.votes.get(id) === eliminatedId ? " — you voted for them." : ""}`
        });
      }
    }

    for (const [voterId, targetId] of this.votes) this.suspicion.noteVote(this.day, voterId, targetId);
    if (eliminatedId) this.suspicion.noteResolved(this.day, eliminatedId);
    this.votes.clear();
    if (eliminatedRole === "jester") {
      this.endGame([eliminatedId!], "小丑被白天投票出局，第三阵营获胜。");
      return;
    }
    if (this.wolvesAlive().length === 0) {
      this.endGame(this.factionMembers(["seer", "villager"]), "所有狼人都已出局，村庄阵营获胜。");
      return;
    }
    if (this.wolvesHaveParity()) {
      this.endGame(this.factionMembers(["wolf"]), "狼人已经控制投票数量，狼人阵营获胜。");
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
    this.addLog(nightText, this.day);

    if (targetId) {
      this.pushEvent(targetId, {
        type: "eliminated",
        targetId,
        facts: { by: "night" },
        detail: `Night ${this.day}: the wolves took you in the dark. You were revealed as ${roleLabel(this.roles.get(targetId))}.`
      });
      for (const id of this.profiles.keys()) {
        if (id === targetId) continue;
        if (this.roles.get(id) === "wolf") {
          this.pushEvent(id, {
            type: "night-kill",
            targetId,
            facts: { role: roleLabel(this.roles.get(targetId)) },
            detail: `Night ${this.day}: the pack moved as one and eliminated ${this.profiles.get(targetId)?.displayName ?? targetId} (${roleLabel(this.roles.get(targetId))}).`
          });
        } else {
          this.pushEvent(id, {
            type: "eliminated-other",
            targetId,
            facts: {
              role: roleLabel(this.roles.get(targetId)),
              iVoted: false,
              ally: this.isVillageFaction(this.roles.get(id)) && this.isVillageFaction(this.roles.get(targetId))
            },
            detail: `Night ${this.day}: ${this.profiles.get(targetId)?.displayName ?? targetId} was eliminated by the wolves and revealed as ${roleLabel(this.roles.get(targetId))}.`
          });
        }
      }
    }
    for (const [seerId, target] of this.seerTargets) {
      this.pushEvent(seerId, {
        type: "investigation",
        actorId: seerId,
        targetId: target,
        facts: { role: roleLabel(this.roles.get(target)) },
        detail: `Night ${this.day}: your investigation shows ${this.profiles.get(target)?.displayName ?? target} is ${roleLabel(this.roles.get(target))}.`
      });
    }

    this.wolfTargets.clear();
    this.seerTargets.clear();
    if (this.wolvesAlive().length === 0) {
      this.endGame(this.factionMembers(["seer", "villager"]), "所有狼人都已出局，村庄阵营获胜。");
      return;
    }
    if (this.wolvesHaveParity()) {
      this.endGame(this.factionMembers(["wolf"]), "狼人已经控制剩余局面，狼人阵营获胜。");
      return;
    }
    if (this.day >= this.maxDays) {
      this.endGame(this.factionMembers(["wolf"]), "村庄未能在期限内找出狼人，狼人阵营获胜。");
      return;
    }
    this.day += 1;
    this.suspicion.decay(0.75);
    this.phase = "day-discussion";
    this.discussion = this.createDiscussion();
    this.emitUpdate();
  }

  private endGame(winners: string[], outcome: string): void {
    this.winners = winners;
    this.outcome = outcome;
    this.addLog(outcome, this.day);
    for (const id of this.profiles.keys()) {
      const won = winners.includes(id);
      this.pushEvent(id, {
        type: won ? "win" : "lose",
        targetId: id,
        detail: won ? `Game over: your faction won — ${outcome}` : `Game over: your faction lost — ${outcome}`
      });
    }
    this.finish();
  }

  private createDiscussion(): DiscussionDirector {
    const aliveIds = [...this.alive];
    return new DiscussionDirector({
      actorIds: aliveIds,
      displayName: (id) => this.profiles.get(id)?.displayName ?? id,
      talkativeness: (id) => this.profiles.get(id)?.temperament?.extraversion ?? 0.5,
      dominance: (id) => {
        const t = this.profiles.get(id)?.temperament;
        return t ? 0.5 + (t.extraversion - 0.5) * 0.6 + (t.conscientiousness - 0.5) * 0.3 : 0.5;
      },
      sensitivity: (id) => this.profiles.get(id)?.temperament?.neuroticism ?? 0.5
    });
  }

  private isVillageFaction(role: Role | undefined): boolean {
    return role === "seer" || role === "villager";
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
  if (phase === "day-vote") return `Discussion is closed. Every living participant is choosing one binding vote. ${wolvesAlive} wolves remain, known only to the pack.`;
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

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}
