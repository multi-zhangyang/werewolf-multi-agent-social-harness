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
import { boundedRounds, discussionPersonality, emitAction } from "./helpers";

type Phase = "discussion" | "investment" | "return";

interface TrustRound {
  round: number;
  investorId: string;
  trusteeId: string;
  investment: number;
  multipliedAmount: number;
  returnedAmount: number;
  payoffs: Record<string, number>;
}

export class TrustGameWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly multiplier = 3;
  private readonly endowment = 10;
  private readonly scores = new Map<string, number>();
  private readonly history: TrustRound[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private discussion: DiscussionDirector | null = null;
  private round = 1;
  private investment?: number;
  private returnedAmount?: number;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    if (profiles.length !== 2) throw new Error("PLAYER_COUNT_INVALID: Trust Game requires two participants.");
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.addLog("第一轮开始：投资者先决定交出多少资源，受托者随后决定返还多少。", 1);
  }

  snapshot(): WorldSnapshot {
    const [investorId, trusteeId] = this.rolesForRound();
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.round,
      totalTurns: this.totalRounds,
      phase: phaseLabel(this.phase),
      summary: this.summary(),
      details: {
        investorId,
        trusteeId,
        multiplier: this.multiplier,
        endowment: this.endowment,
        investment: this.investment,
        multipliedAmount: this.investment === undefined ? undefined : this.investment * this.multiplier,
        returnedAmount: this.returnedAmount,
        scores: Object.fromEntries(this.scores),
        history: this.history,
        ...(this.discussion ? { discussion: this.discussion.state() } : {})
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const [investorId, trusteeId] = this.rolesForRound();
    const role = actorId === investorId ? "investor" : "trustee";
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase,
      situation: situationFor(this.phase, role, this.investment, this.multiplier),
      privateContext: [
        `Your role this round: ${role}.`,
        `Your cumulative score: ${this.scores.get(actorId) ?? 0}.`,
        `Investment: ${this.investment ?? "not committed"}. Return: ${this.returnedAmount ?? "not committed"}.`,
        `Role history: ${this.history.map((entry) => `R${entry.round} ${entry.investorId === actorId ? "investor" : "trustee"}, payoff ${entry.payoffs[actorId]}`).join("; ") || "none"}.`
      ].join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, role, score: this.scores.get(actorId) ?? 0 },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle",
        visibleRole: profile.id === investorId ? "investor" : "trustee"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-24),
      availableActions: this.availableActions(actorId, investorId, trusteeId)
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const invest = tool({
      name: "make_investment",
      description: `As the current investor, commit an integer from 0 to ${this.endowment}. The amount is multiplied by ${this.multiplier} before the trustee decides what to return.`,
      parameters: z.object({ amount: z.number().int().min(0).max(this.endowment), reason: z.string().min(1).max(2_000) }).strict(),
      execute: async ({ amount, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "make_investment", { amount, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const returnFromTrust = tool({
      name: "return_from_trust",
      description: "As the current trustee, return an integer amount to the investor from the multiplied investment. You may return none, some, or all of the available amount.",
      parameters: z.object({ amount: z.number().int().min(0), reason: z.string().min(1).max(2_000) }).strict(),
      execute: async ({ amount, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "return_from_trust", { amount, reason });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [invest, returnFromTrust] as Tool<SocietyAgentContext>[];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    const [investorId, trusteeId] = this.rolesForRound();
    if (this.phase === "investment" && actorId === investorId && this.investment === undefined) {
      return [{
        name: "make_investment",
        label: "确定投资",
        description: `投入 0 到 ${this.endowment} 点，随后放大 ${this.multiplier} 倍交给受托者。`,
        kind: "number",
        field: "amount",
        min: 0,
        max: this.endowment,
        step: 1
      }];
    }
    if (this.phase === "return" && actorId === trusteeId && this.returnedAmount === undefined) {
      const available = (this.investment ?? 0) * this.multiplier;
      return [{
        name: "return_from_trust",
        label: "确定返还",
        description: `从可支配的 ${available} 点中决定返还多少。`,
        kind: "number",
        field: "amount",
        min: 0,
        max: available,
        step: 1
      }];
    }
    return [];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    const value = recordPayload(payload);
    const amount = value.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount)) {
      throw new Error("AMOUNT_INVALID: Choose a whole-number amount.");
    }
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    const [investorId, trusteeId] = this.rolesForRound();
    if (action === "make_investment") {
      if (this.phase !== "investment") throw new Error("INVESTMENT_NOT_OPEN: Investment is not open now.");
      if (actorId !== investorId) throw new Error(`ROLE_MISMATCH: The current investor is '${investorId}'.`);
      if (this.investment !== undefined) throw new Error("INVESTMENT_ALREADY_COMMITTED: The investment cannot be changed.");
      if (amount < 0 || amount > this.endowment) throw new Error(`INVESTMENT_INVALID: Choose 0 to ${this.endowment}.`);
      this.investment = amount;
      this.emitUpdate();
      return {
        action,
        detail: reason ? `${amount}; ${reason}` : String(amount),
        result: { accepted: true, investment: amount, trusteeReceives: amount * this.multiplier }
      };
    }
    if (action === "return_from_trust") {
      if (this.phase !== "return") throw new Error("RETURN_NOT_OPEN: Return is only available after an investment.");
      if (actorId !== trusteeId) throw new Error(`ROLE_MISMATCH: The current trustee is '${trusteeId}'.`);
      if (this.returnedAmount !== undefined) throw new Error("RETURN_ALREADY_COMMITTED: The return cannot be changed.");
      const available = (this.investment ?? 0) * this.multiplier;
      if (amount < 0 || amount > available) throw new Error(`RETURN_EXCEEDS_AVAILABLE: Return 0 to ${available}.`);
      this.returnedAmount = amount;
      this.emitUpdate();
      return {
        action,
        detail: reason ? `${amount}; ${reason}` : String(amount),
        result: { accepted: true, returnedAmount: amount, retainedAmount: available - amount }
      };
    }
    throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
  }

  activation(): WorldActivation | null {
    if (this.status !== "running" || this.round > this.totalRounds) return null;
    const [investorId, trusteeId] = this.rolesForRound();
    if (this.phase === "discussion") {
      if (!this.discussion) this.discussion = this.createDiscussion();
      const actors = this.discussion.nextWave();
      if (actors.length === 0) {
        this.discussion = null;
        this.phase = "investment";
        this.emitUpdate();
      } else {
        const wave = this.discussion.waveNumber;
        return {
          id: `tg:${this.round}:discussion:${wave}`,
          label: wave === 1 ? `第 ${this.round} 轮协商` : `第 ${this.round} 轮协商 · 回应 ${wave - 1}`,
          actorIds: actors,
          mode: "sequential",
          instructionFor: (actorId) => wave === 1
            ? actorId === investorId
              ? "You are the investor. State or conceal what level of reciprocity would justify a larger investment. Speak once before acting."
              : "You are the trustee. You may make a non-binding promise, challenge the investor's assumptions, or preserve ambiguity. Speak once."
            : "The negotiation is live. React to what was actually said: answer questions, test promises, or hold your ground. You may stay silent."
        };
      }
    }
    if (this.phase === "investment") {
      return {
        id: `tg:${this.round}:investment`,
        label: `第 ${this.round} 轮投资`,
        actorIds: [investorId],
        mode: "sequential",
        instructionFor: () => "You must now call make_investment exactly once. Evaluate the trustee's promises, your relationship history, and the role reversal in future rounds."
      };
    }
    return {
      id: `tg:${this.round}:return`,
      label: `第 ${this.round} 轮返还`,
      actorIds: [trusteeId],
      mode: "sequential",
      instructionFor: () => `The investment was ${this.investment}; you control ${(this.investment ?? 0) * this.multiplier}. You must call return_from_trust exactly once.`
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion")) {
      this.discussion?.endWave();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":investment")) {
      if (this.investment === undefined) {
        return { completed: false, missingActorIds: activation.actorIds, retryInstruction: "Call make_investment now with an integer from 0 to 10." };
      }
      this.phase = "return";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    if (this.returnedAmount === undefined) {
      return { completed: false, missingActorIds: activation.actorIds, retryInstruction: `Call return_from_trust now with an integer from 0 to ${(this.investment ?? 0) * this.multiplier}.` };
    }
    this.resolveRound();
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
      ...discussionPersonality(this.profiles)
    });
  }

  protected messageWave(): number | undefined {
    return this.discussion?.waveNumber;
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
    const [investorId] = this.rolesForRound();
    return actorId === investorId ? "投资者" : "受托者";
  }

  protected roleVisibleTo(_viewerId: string | undefined, _subjectId: string, _alive: boolean): boolean {
    return true;
  }

  protected redactDetails(details: Record<string, unknown>, actorId?: string): Record<string, unknown> {
    const next = super.redactDetails(details, actorId);
    const [investorId, trusteeId] = this.rolesForRound();
    // The investor knows their own commitment. The trustee only sees it once
    // the investment phase has closed; spectators never see a pending amount.
    if (this.phase === "investment") {
      if (actorId !== investorId) delete next.investment;
      delete next.multipliedAmount;
      delete next.returnedAmount;
    }
    if (this.phase === "return") {
      if (actorId !== investorId && actorId !== trusteeId) delete next.investment;
      delete next.returnedAmount;
    }
    if (this.status !== "finished" && this.phase !== "discussion") {
      delete next.returnedAmount;
    }
    return next;
  }

  private availableActions(actorId: string, investorId: string, trusteeId: string): string[] {
    if (this.phase === "investment" && actorId === investorId) return ["make_investment", "remember_experience"];
    if (this.phase === "return" && actorId === trusteeId) return ["return_from_trust", "remember_experience"];
    return ["communicate", "reflect_on_social_situation", "update_inner_state"];
  }

  private rolesForRound(): [string, string] {
    const ids = [...this.profiles.keys()];
    return this.round % 2 === 1 ? [ids[0], ids[1]] : [ids[1], ids[0]];
  }

  private resolveRound(): void {
    const [investorId, trusteeId] = this.rolesForRound();
    const investment = this.investment ?? 0;
    const multipliedAmount = investment * this.multiplier;
    const returnedAmount = this.returnedAmount ?? 0;
    const investorPayoff = this.endowment - investment + returnedAmount;
    const trusteePayoff = multipliedAmount - returnedAmount;
    this.scores.set(investorId, (this.scores.get(investorId) ?? 0) + investorPayoff);
    this.scores.set(trusteeId, (this.scores.get(trusteeId) ?? 0) + trusteePayoff);
    const payoffs = { [investorId]: investorPayoff, [trusteeId]: trusteePayoff };
    this.history.push({ round: this.round, investorId, trusteeId, investment, multipliedAmount, returnedAmount, payoffs });
    for (const id of this.profiles.keys()) {
      this.lastExperiences.set(
        id,
        `Round ${this.round}: ${investorId} invested ${investment}, creating ${multipliedAmount}; ${trusteeId} returned ${returnedAmount}. Your payoff was ${payoffs[id]}. Roles reverse on the next round.`
      );
    }
    const reciprocal = investment > 0 && returnedAmount >= investment;
    const beat = investment === 0
      ? undefined
      : reciprocal
        ? "promise-kept" as const
        : returnedAmount === 0
          ? "betrayal" as const
          : "promise-broken" as const;
    this.addLog(`第 ${this.round} 轮结算：投入 ${investment}，增长为 ${multipliedAmount}，返还 ${returnedAmount}。`, this.round, beat);
    this.investment = undefined;
    this.returnedAmount = undefined;
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

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}

function phaseLabel(phase: Phase): string {
  if (phase === "discussion") return "协商";
  if (phase === "investment") return "投资";
  return "返还";
}

function situationFor(phase: Phase, role: "investor" | "trustee", investment: number | undefined, multiplier: number): string {
  if (phase === "discussion") return `You are the ${role}. Promises are not binding, and roles will reverse next round.`;
  if (phase === "investment") return role === "investor" ? "Choose how much control to transfer to the trustee." : "The investor is deciding how much to trust you.";
  return role === "trustee" ? `The investment was ${investment ?? 0}, giving you ${(investment ?? 0) * multiplier} to allocate.` : "The trustee is deciding how much of the multiplied investment to return.";
}
