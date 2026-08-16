import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  PlayerActionSpec,
  ScenarioSummary,
  SocialMessage,
  SocietyAgentContext,
  WorldActionCommit,
  WorldActivation,
  WorldSnapshot
} from "../contracts";
import { contextFromRunContext, scopedContext, SocialWorldBase } from "../world";
import { DiscussionDirector } from "../conversation";
import { boundedRounds, emitAction } from "./helpers";

type Phase = "discussion" | "propose" | "respond";

interface UltimatumRound {
  round: number;
  proposerId: string;
  responderId: string;
  offer: number;
  accepted: boolean;
  payoffs: Record<string, number>;
}

export class UltimatumWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly pot = 10;
  private readonly scores = new Map<string, number>();
  private readonly history: UltimatumRound[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private discussion: DiscussionDirector | null = null;
  private round = 1;
  private offer?: number;
  private response?: boolean;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    if (profiles.length !== 2) throw new Error("PLAYER_COUNT_INVALID: Ultimatum Game requires two participants.");
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.addLog("第一轮开始：提议者提出 10 点资源的分配方案，回应者可以接受，也可以用拒绝惩罚不公平。", 1);
  }

  snapshot(): WorldSnapshot {
    const [proposerId, responderId] = this.rolesForRound();
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.round,
      totalTurns: this.totalRounds,
      phase: phaseLabel(this.phase),
      summary: this.summary(),
      details: {
        pot: this.pot,
        proposerId,
        responderId,
        offer: this.offer,
        response: this.response,
        scores: Object.fromEntries(this.scores),
        history: this.history
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const [proposerId, responderId] = this.rolesForRound();
    const role = actorId === proposerId ? "proposer" : "responder";
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase,
      situation: situationFor(this.phase, role, this.offer, this.pot),
      privateContext: [
        `Your role this round: ${role}.`,
        `Your cumulative score: ${this.scores.get(actorId) ?? 0}.`,
        `Current offer: ${this.offer ?? "not proposed"}. Your response: ${this.response ?? "not decided"}.`,
        `Round history: ${this.history.map((entry) => `R${entry.round} ${entry.proposerId === actorId ? "proposed" : "responded"} ${entry.offer}/${this.pot}, payoff ${entry.payoffs[actorId]}`).join("; ") || "none"}.`
      ].join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, role, score: this.scores.get(actorId) ?? 0 },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle",
        visibleRole: profile.id === proposerId ? "proposer" : "responder"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-24),
      availableActions: this.availableActions(actorId, proposerId, responderId)
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const propose = tool({
      name: "propose_split",
      description: `As the current proposer, offer the responder an integer share from 0 to ${this.pot} of the ${this.pot}-point pot. You keep the rest, but an angry rejection gives both zero.`,
      parameters: z.object({ offer: z.number().int().min(0).max(this.pot), reason: z.string().min(1).max(2_000) }).strict(),
      execute: async ({ offer, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "propose_split", { offer, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const respond = tool({
      name: "respond_to_offer",
      description: "As the current responder, accept or reject the proposer's split. Accepting locks in both payoffs; rejecting gives both zero for this round.",
      parameters: z.object({ accept: z.boolean(), reason: z.string().min(1).max(2_000) }).strict(),
      execute: async ({ accept, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "respond_to_offer", { accept, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [propose, respond];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    const [proposerId, responderId] = this.rolesForRound();
    const actions: PlayerActionSpec[] = [];
    if (this.phase === "propose" && actorId === proposerId) {
      actions.push({
        name: "propose_split",
        label: "提出分配",
        description: `从 ${this.pot} 点资源中给回应者一个整数份额，剩余归自己。`,
        kind: "number",
        min: 0,
        max: this.pot,
        step: 1
      });
    }
    if (this.phase === "respond" && actorId === responderId) {
      actions.push({
        name: "respond_to_offer",
        label: "接受或拒绝",
        description: "接受则按方案结算，拒绝则双方本轮都得 0 分。",
        kind: "choice",
        field: "accept",
        options: [
          { value: "true", label: "接受" },
          { value: "false", label: "拒绝" }
        ]
      });
    }
    return actions;
  }

  performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    const [proposerId, responderId] = this.rolesForRound();
    if (action === "propose_split") {
      const { offer } = parseProposePayload(payload);
      if (this.phase !== "propose" || actorId !== proposerId) {
        throw new Error("ACTION_NOT_AVAILABLE: Only the current proposer may propose during the propose phase.");
      }
      if (offer < 0 || offer > this.pot) {
        throw new Error(`OFFER_OUT_OF_RANGE: offer must be an integer from 0 to ${this.pot}.`);
      }
      this.offer = offer;
      return Promise.resolve({ action, detail: `提出分配：自己 ${this.pot - offer}，对方 ${offer}`, result: { offer } });
    }
    if (action === "respond_to_offer") {
      const { accept } = parseRespondPayload(payload);
      if (this.phase !== "respond" || actorId !== responderId) {
        throw new Error("ACTION_NOT_AVAILABLE: Only the current responder may respond during the respond phase.");
      }
      if (this.offer === undefined) throw new Error("OFFER_MISSING: No offer has been proposed this round.");
      this.response = accept;
      return Promise.resolve({ action, detail: accept ? "接受分配方案" : "拒绝分配方案", result: { accept } });
    }
    throw new Error(`ACTION_NOT_FOUND: '${action}' is not a domain action in this scenario.`);
  }

  activation(): WorldActivation | null {
    if (this.round > this.totalRounds) return null;
    const [proposerId, responderId] = this.rolesForRound();
    if (this.phase === "discussion") {
      if (!this.discussion) this.discussion = this.createDiscussion();
      const actors = this.discussion.nextWave();
      if (actors.length === 0) {
        this.discussion = null;
        this.phase = "propose";
        this.emitUpdate();
      } else {
        const wave = this.discussion.waveNumber;
        return {
          id: `round:${this.round}:discussion:${wave}`,
          label: wave === 1 ? `第 ${this.round} 轮谈判` : `第 ${this.round} 轮谈判 · 回应 ${wave - 1}`,
          actorIds: actors,
          mode: "sequential",
          instructionFor: () => wave === 1
            ? "Negotiate openly. Promises are not binding. The proposer decides the split next; the responder can punish unfairness by rejecting."
            : "The negotiation is live. React to what was actually said: answer questions, test promises, or hold your ground. You may stay silent."
        };
      }
    }
    if (this.phase === "propose") {
      const proposerName = this.profiles.get(proposerId)?.displayName ?? proposerId;
      return {
        id: `round:${this.round}:propose`,
        label: `${proposerName} 提出分配`,
        actorIds: [proposerId],
        mode: "sequential",
        instructionFor: () => `Call propose_split now with an integer offer from 0 to ${this.pot}.`
      };
    }
    if (this.phase === "respond") {
      const responderName = this.profiles.get(responderId)?.displayName ?? responderId;
      return {
        id: `round:${this.round}:respond`,
        label: `${responderName} 回应`,
        actorIds: [responderId],
        mode: "sequential",
        instructionFor: () => "Call respond_to_offer now, accepting or rejecting the proposed split."
      };
    }
    return null;
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion")) {
      this.discussion?.endWave();
      return { completed: true, missingActorIds: [] };
    }
    if (this.phase === "propose") {
      if (this.offer === undefined) {
        return { completed: false, missingActorIds: activation.actorIds, retryInstruction: `Call propose_split now with an integer from 0 to ${this.pot}.` };
      }
      this.phase = "respond";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    if (this.phase === "respond") {
      if (this.response === undefined) {
        return { completed: false, missingActorIds: activation.actorIds, retryInstruction: "Call respond_to_offer now with accept true or false." };
      }
      this.resolveRound();
      return { completed: true, missingActorIds: [] };
    }
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
    const message = await super.sendMessage(input);
    if (message.channel === "public" && this.phase === "discussion" && this.discussion) {
      this.discussion.onMessage({ senderId: message.senderId, text: message.text, ...(message.replyTo ? { replyTo: message.replyTo } : {}) });
    }
    return message;
  }

  private createDiscussion(): DiscussionDirector {
    return new DiscussionDirector({
      actorIds: this.rolesForRound(),
      displayName: (id) => this.profiles.get(id)?.displayName ?? id,
      talkativeness: (id) => this.profiles.get(id)?.temperament?.extraversion ?? 0.5,
      dominance: (id) => {
        const t = this.profiles.get(id)?.temperament;
        return t ? 0.5 + (t.extraversion - 0.5) * 0.6 + (t.conscientiousness - 0.5) * 0.3 : 0.5;
      },
      sensitivity: (id) => this.profiles.get(id)?.temperament?.neuroticism ?? 0.5
    });
  }

  protected currentTurn(): number {
    return this.round;
  }

  protected currentPhase(): string {
    return this.phase;
  }

  protected isAlive(_actorId: string): boolean {
    return true;
  }

  protected score(actorId: string): number | undefined {
    return this.scores.get(actorId);
  }

  protected observerRole(actorId: string): string | undefined {
    const [proposerId] = this.rolesForRound();
    return actorId === proposerId ? "提议者" : "回应者";
  }

  protected roleVisibleTo(_viewerId: string | undefined, _subjectId: string, _alive: boolean): boolean {
    return true;
  }

  protected redactDetails(details: Record<string, unknown>, actorId?: string): Record<string, unknown> {
    const next = super.redactDetails(details, actorId);
    const [proposerId, responderId] = this.rolesForRound();
    if (this.phase === "propose" && actorId !== proposerId) delete next.offer;
    if (this.phase === "respond") {
      if (actorId !== proposerId && actorId !== responderId) delete next.offer;
      delete next.response;
    }
    if (this.status !== "finished" && this.phase !== "discussion" && this.phase !== "respond") delete next.offer;
    return next;
  }

  private availableActions(actorId: string, proposerId: string, responderId: string): string[] {
    if (this.phase === "propose" && actorId === proposerId) return ["propose_split", "remember_experience"];
    if (this.phase === "respond" && actorId === responderId) return ["respond_to_offer", "remember_experience"];
    return ["communicate", "reflect_on_social_situation", "read_the_room", "update_inner_state"];
  }

  private rolesForRound(): [string, string] {
    const ids = [...this.profiles.keys()];
    return this.round % 2 === 1 ? [ids[0], ids[1]] : [ids[1], ids[0]];
  }

  private resolveRound(): void {
    const [proposerId, responderId] = this.rolesForRound();
    const offer = this.offer ?? 0;
    const accepted = this.response ?? false;
    const proposerPayoff = accepted ? this.pot - offer : 0;
    const responderPayoff = accepted ? offer : 0;
    this.scores.set(proposerId, (this.scores.get(proposerId) ?? 0) + proposerPayoff);
    this.scores.set(responderId, (this.scores.get(responderId) ?? 0) + responderPayoff);
    const payoffs = { [proposerId]: proposerPayoff, [responderId]: responderPayoff };
    this.history.push({ round: this.round, proposerId, responderId, offer, accepted, payoffs });
    for (const id of this.profiles.keys()) {
      this.lastExperiences.set(
        id,
        `Round ${this.round}: ${this.profiles.get(proposerId)?.displayName} offered ${offer} of ${this.pot}; ${this.profiles.get(responderId)?.displayName} ${accepted ? "accepted" : "rejected"}. Your payoff was ${payoffs[id]}. Roles reverse on the next round.`
      );
    }
    this.addLog(`第 ${this.round} 轮结算：提议 ${offer}/${this.pot}，回应者${accepted ? "接受" : "拒绝"}。`, this.round);
    this.offer = undefined;
    this.response = undefined;
    if (this.round >= this.totalRounds) {
      this.round = this.totalRounds + 1;
      this.finish();
      return;
    }
    this.round += 1;
    this.phase = "discussion";
    this.discussion = null;
    this.emitUpdate();
  }

  private summary(): string {
    const scores = [...this.scores].map(([id, value]) => `${this.profiles.get(id)?.displayName} ${value}`).join(" · ");
    return `${this.round > this.totalRounds ? "已结束" : `第 ${this.round} / ${this.totalRounds} 轮`} · ${scores}`;
  }
}

function parseProposePayload(payload: unknown): { offer: number } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.offer !== "number" || !Number.isInteger(value.offer)) {
    throw new Error("OFFER_INVALID: offer must be an integer.");
  }
  return { offer: value.offer };
}

function parseRespondPayload(payload: unknown): { accept: boolean } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.accept !== "boolean") {
    throw new Error("RESPONSE_INVALID: accept must be a boolean.");
  }
  return { accept: value.accept };
}

function phaseLabel(phase: Phase): string {
  if (phase === "discussion") return "谈判";
  if (phase === "propose") return "提出分配";
  return "回应";
}

function situationFor(phase: Phase, role: "proposer" | "responder", offer: number | undefined, pot: number): string {
  if (phase === "discussion") return `You are the ${role} this round. Promises are not binding, and roles reverse next round.`;
  if (phase === "propose") return role === "proposer" ? "Choose how to split the pot. Too greedy a split may be rejected." : "The proposer is deciding the split.";
  return role === "responder" ? `The proposer offered you ${offer ?? 0} of ${pot}. Rejection punishes unfairness but costs you both.` : "The responder is deciding whether to accept your split.";
}
