import { randomUUID } from "node:crypto";
import type { Tool } from "@openai/agents";
import { societyTool as tool } from "../tools";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  Commitment,
  PlayerActionSpec,
  ScenarioSummary,
  SocialMessage,
  SocietyAgentContext,
  WorldActionCommit,
  WorldActivation,
  WorldSnapshot
} from "../contracts";
import { scopedContext, SocialWorldBase } from "../world";
import { conversationSignalsFromSocialActs, DiscussionDirector } from "../conversation";
import { boundedRounds, discussionPersonality, emitAction } from "./helpers";
import { socialReferenceContext } from "../social/context-refs";
import type { SocialActDeclaration } from "../social/contracts";

type Phase = "discussion" | "investment" | "return";

/** At most this many commitments per participant per round. */
const MAX_COMMITMENTS_PER_ACTOR = 3;

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
  private investmentCommandId?: string;
  private returnCommandId?: string;
  /** The commitment ledger: promises declared through make_commitment. */
  private readonly commitments: Commitment[] = [];

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    if (profiles.length !== 2) throw new Error("PLAYER_COUNT_INVALID: Trust Game requires two participants.");
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.addLog("第一轮开始：投资者先决定交出多少资源，受托者随后决定返还多少。", 1);
  }

  /**
   * Sidecar extraction hints: stake/return statements ("我会投 8" /
   * "我会返还 10") become `claimed-action` propositions reconciled
   * against the sealed amounts at settlement.
   */
  extractionHints?(): string {
    return [
      "本局是信任博弈。行动主张判定：",
      '- 当说话者断言自己将投入或返还的数额时输出 claims 条目：aboutSelf=true、assertedAction（格式 "invest-数字" 或 "return-数字"，如 "invest-8"、"return-10"）、confidence。',
      '- 例：「我会投 8」→{aboutSelf:true, assertedAction:"invest-8"}；「我至少返还 10」→{aboutSelf:true, assertedAction:"return-10"}；「你应该多投点」→ 不算主张。',
      '- 疑问、呼吁、要求他人表态都不算主张。'
    ].join("\n");
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
        commitments: this.commitments,
        ...(this.discussion ? { discussion: this.discussion.state() } : {})
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const [investorId, trusteeId] = this.rolesForRound();
    const role = actorId === investorId ? "investor" : "trustee";
    const openCommitments = this.openCommitmentsFor(actorId);
    const causality = this.socialCausalityFor(actorId);
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
        openCommitments.length
          ? `Open commitments this round:\n${openCommitments.map((commitment) => `- ${commitment.promisorActorId === actorId ? "You declared" : `${commitment.promisorActorId} declared`}: ${commitment.proposition} (${commitment.state})`).join("\n")}`
          : "Open commitments this round: none.",
        ...socialReferenceContext(causality),
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
    const commitment = tool({
      name: "make_commitment",
      description: `During negotiation, propose a public promise the world will check. Two forms: "return-at-least" fixes an absolute amount, "return-ratio" promises a percentage of whatever the investor actually transfers (e.g. amount 150 = return at least 1.5x their investment), so you can commit before knowing their stake. It becomes settlement-eligible only after the recipient explicitly accepts it; then the world checks the sealed action and records fulfillment or violation.`,
      parameters: z.object({
        proposition: z.string().min(1).max(400),
        actionType: z.enum(["return-at-least", "invest-at-least", "return-ratio"]),
        amount: z.number().int().min(0).max(this.endowment * this.multiplier),
        condition: z.string().min(1).max(400).nullable().default(null)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "make_commitment", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const acceptCommitment = tool({
      name: "accept_commitment",
      description: "Explicitly accept one open commitment addressed to you. Only accepted commitments can later be settled as fulfilled or violated.",
      parameters: z.object({
        commitmentId: z.string().min(1).max(200)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "accept_commitment", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const invest = tool({
      name: "make_investment",
      description: `As the current investor, commit an integer from 0 to ${this.endowment}. The amount is multiplied by ${this.multiplier} before the trustee decides what to return. References must be IDs present in your authorized observation.`,
      parameters: z.object({
        amount: z.number().int().min(0).max(this.endowment),
        reason: z.string().min(1).max(2_000),
        referencedCommitmentIds: z.array(z.string()).max(3).nullable().default(null),
        beliefPropositions: z.array(z.string().min(1).max(400)).max(3).nullable().default(null)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "make_investment", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const returnFromTrust = tool({
      name: "return_from_trust",
      description: "As the current trustee, return an integer amount from the multiplied investment. References must be IDs present in your authorized observation.",
      parameters: z.object({
        amount: z.number().int().min(0),
        reason: z.string().min(1).max(2_000),
        referencedCommitmentIds: z.array(z.string()).max(3).nullable().default(null),
        beliefPropositions: z.array(z.string().min(1).max(400)).max(3).nullable().default(null)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "return_from_trust", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [commitment, acceptCommitment, invest, returnFromTrust] as Tool<SocietyAgentContext>[];
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
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    const [investorId, trusteeId] = this.rolesForRound();
    if (action === "accept_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_ACCEPTANCE_NOT_OPEN: Commitments can only be accepted during negotiation.");
      const commitmentId = typeof value.commitmentId === "string" ? value.commitmentId : "";
      const commitment = this.commitments.find((entry) => entry.commitmentId === commitmentId && entry.round === this.round);
      if (!commitment) throw new Error(`COMMITMENT_NOT_FOUND: '${commitmentId}'.`);
      if (commitment.promisorActorId === actorId || !commitment.audienceActorIds.includes(actorId)) {
        throw new Error("COMMITMENT_ACCEPTOR_INVALID: Only a recipient may accept this commitment.");
      }
      if (commitment.state !== "proposed" && commitment.state !== "accepted") {
        throw new Error(`COMMITMENT_NOT_OPEN: '${commitmentId}' is already ${commitment.state}.`);
      }
      const acceptedByActorIds = commitment.acceptedByActorIds ?? (commitment.acceptedByActorIds = []);
      const acceptedByCommandIds = commitment.acceptedByCommandIds ?? (commitment.acceptedByCommandIds = []);
      if (acceptedByActorIds.includes(actorId)) {
        throw new Error(`COMMITMENT_ALREADY_ACCEPTED: '${actorId}' already accepted '${commitmentId}'.`);
      }
      const commandId = `cmd-${randomUUID()}`;
      acceptedByActorIds.push(actorId);
      acceptedByCommandIds.push(commandId);
      const requiredRecipients = commitment.audienceActorIds.filter((id) => id !== commitment.promisorActorId);
      if (requiredRecipients.every((id) => acceptedByActorIds.includes(id))) commitment.state = "accepted";
      commitment.acceptedAtTurn = this.round;
      this.acceptSocialCommitment(commitment, actorId, commandId);
      for (const id of this.profiles.keys()) {
        this.pushEvent(id, {
          type: "commitment-accepted",
          actorId,
          targetId: commitment.promisorActorId,
          facts: { commitmentId },
          detail: `${actorId === id ? "你" : this.profiles.get(actorId)?.displayName ?? actorId} 接受了承诺「${commitment.proposition}」。`
        });
      }
      this.emitUpdate();
      return { action, commandId, detail: commitmentId, result: { accepted: true, commitmentId, state: commitment.state } };
    }
    const amount = value.amount;
    if (typeof amount !== "number" || !Number.isInteger(amount)) {
      throw new Error("AMOUNT_INVALID: Choose a whole-number amount.");
    }
    if (action === "make_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_NOT_OPEN: Commitments can only be declared during the negotiation.");
      const actionType = value.actionType;
      if (actionType !== "return-at-least" && actionType !== "invest-at-least" && actionType !== "return-ratio") {
        throw new Error("COMMITMENT_ACTION_INVALID: actionType must be return-at-least, invest-at-least, or return-ratio.");
      }
      const expectedActor = actionType === "invest-at-least" ? investorId : trusteeId;
      if (actorId !== expectedActor) {
        throw new Error(`ROLE_MISMATCH: Only the ${actionType === "invest-at-least" ? "investor" : "trustee"} can promise that action.`);
      }
      if (actionType === "return-ratio" && (amount <= 0 || amount > 100 * this.multiplier)) {
        throw new Error(`COMMITMENT_RATIO_INVALID: A return-ratio promise is a percent from 1 to ${100 * this.multiplier}.`);
      }
      const cap = actionType === "return-ratio" ? 100 * this.multiplier : actionType === "return-at-least" ? this.endowment * this.multiplier : this.endowment;
      if (amount < 0 || amount > cap) throw new Error(`COMMITMENT_AMOUNT_INVALID: A ${actionType} promise must be 0 to ${cap}.`);
      const proposition = typeof value.proposition === "string" ? value.proposition.trim() : "";
      if (!proposition) throw new Error("COMMITMENT_PROPOSITION_REQUIRED: Say in words what you promise.");
      const ownCount = this.commitments.filter((entry) => entry.round === this.round && entry.promisorActorId === actorId).length;
      if (ownCount >= MAX_COMMITMENTS_PER_ACTOR) {
        throw new Error(`COMMITMENT_LIMIT_EXCEEDED: At most ${MAX_COMMITMENTS_PER_ACTOR} commitments per participant per round.`);
      }
      const commandId = `cmd-${randomUUID()}`;
      const commitment: Commitment = {
        // Deterministic id (round + promisor + ordinal): stable and citeable by
        // scripts and observers.
        commitmentId: `commit:${this.round}:${actorId}:${ownCount + 1}`,
        round: this.round,
        promisorActorId: actorId,
        promisorCharacterId: this.profiles.get(actorId)?.characterId ?? actorId,
        audienceActorIds: [...this.profiles.keys()].filter((id) => id !== actorId),
        proposition,
        promisedAction: {
          actionType,
          amount,
          ...(typeof value.condition === "string" && value.condition.trim() ? { condition: value.condition.trim() } : {})
        },
        state: "proposed",
        acceptedByActorIds: [],
        acceptedByCommandIds: [],
        createdByCommandId: commandId,
        createdAtTurn: this.round,
        schemaVersion: 1
      };
      this.commitments.push(commitment);
      this.recordSocialCommitment(commitment);
      for (const id of this.profiles.keys()) {
        this.pushEvent(id, {
          type: "commitment-proposed",
          actorId,
          targetId: id,
          facts: { commitmentId: commitment.commitmentId, promisedAction: commitment.promisedAction },
          detail: `${actorId === id ? "你" : this.profiles.get(actorId)?.displayName ?? actorId} 公开承诺：${proposition}。`
        });
      }
      this.emitUpdate();
      return {
        action,
        commandId,
        detail: `${actionType} ${amount}; ${proposition}`,
        result: { accepted: true, commitmentId: commitment.commitmentId }
      };
    }
    if (action === "make_investment") {
      if (this.phase !== "investment") throw new Error("INVESTMENT_NOT_OPEN: Investment is not open now.");
      if (actorId !== investorId) throw new Error(`ROLE_MISMATCH: The current investor is '${investorId}'.`);
      if (this.investment !== undefined) throw new Error("INVESTMENT_ALREADY_COMMITTED: The investment cannot be changed.");
      if (amount < 0 || amount > this.endowment) throw new Error(`INVESTMENT_INVALID: Choose 0 to ${this.endowment}.`);
      const references = parseReferences(value);
      this.assertCommitmentReferences(actorId, references.referencedCommitmentIds);
      this.investment = amount;
      const commandId = `cmd-${randomUUID()}`;
      this.investmentCommandId = commandId;
      this.emitUpdate();
      return {
        action,
        commandId,
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
      const references = parseReferences(value);
      this.assertCommitmentReferences(actorId, references.referencedCommitmentIds);
      this.returnedAmount = amount;
      const commandId = `cmd-${randomUUID()}`;
      this.returnCommandId = commandId;
      this.emitUpdate();
      return {
        action,
        commandId,
        detail: reason ? `${amount}; ${reason}` : String(amount),
        result: { accepted: true, returnedAmount: amount, retainedAmount: available - amount }
      };
    }
    throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
  }

  /**
   * A decision may only cite commitments the actor is party to (promisor or
   * audience) from the current round — never a foreign or stale promise.
   */
  private assertCommitmentReferences(actorId: string, referencedCommitmentIds: string[]): void {
    for (const id of referencedCommitmentIds) {
      const commitment = this.commitments.find((entry) => entry.commitmentId === id);
      if (
        !commitment ||
        commitment.round !== this.round ||
        (commitment.promisorActorId !== actorId && !commitment.audienceActorIds.includes(actorId))
      ) {
        throw new Error(`COMMITMENT_REFERENCE_INVALID: '${id}' is not an open commitment you are party to this round.`);
      }
    }
  }

  /** Open (proposed) commitments this participant made or received. */
  openCommitmentsFor(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      (entry.state === "proposed" || entry.state === "accepted") &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
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
              : "You are the trustee. You may publicly declare a binding promise with make_commitment — an absolute amount (return-at-least) or a percent of whatever the investor transfers (return-ratio, e.g. amount 150 = return 1.5x their stake) — and the world will check it against your sealed return. Challenge the investor's assumptions, or preserve ambiguity. Speak once."
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
        instructionFor: () => "You must now call make_investment exactly once. Evaluate the trustee's declared promises, your relationship history, and the role reversal in future rounds. If a declared promise shaped your decision, cite its commitmentId in referencedCommitmentIds."
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
    socialActs?: SocialActDeclaration[];
  }): Promise<SocialMessage> {
    const message = await super.sendMessage(input);
    if (this.phase === "discussion" && this.discussion) {
      this.discussion.onMessage({
        messageId: message.id,
        senderId: message.senderId,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.channel === "public" ? {} : { targetActorIds: message.recipientIds ?? [] })
      }, conversationSignalsFromSocialActs(message.senderId, message.id, input.socialActs ?? []));
    }
    return message;
  }

  private createDiscussion(): DiscussionDirector {
    return new DiscussionDirector({
      actorIds: this.rolesForRound(),
      displayName: (id) => this.profiles.get(id)?.displayName ?? id,
      ...discussionPersonality(this.profiles, (id) => this.moodSignalFor(id))
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
    if (this.phase === "investment" && actorId === investorId) return ["make_investment"];
    if (this.phase === "return" && actorId === trusteeId) return ["return_from_trust"];
    return ["final_response", "make_commitment", "accept_commitment", "reflect_on_social_situation", "update_inner_state"];
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
    // Settle this round's commitments against the sealed actions: only a
    // declared promise that the world checked may earn the strong
    // promise-kept / promise-broken labels.
    const roundCommitments = this.commitments.filter((entry) => entry.round === this.round && entry.state === "accepted");
    for (const commitment of roundCommitments) {
      const actionType = commitment.promisedAction.actionType;
      if (actionType !== "return-at-least" && actionType !== "invest-at-least" && actionType !== "return-ratio") continue;
      const promised = commitment.promisedAction.amount;
      // A ratio promise (percent of whatever was actually transferred) stays
      // checkable even when the investor's stake was unknown at proposal time.
      const actual = actionType === "return-ratio"
        ? returnedAmount
        : actionType === "return-at-least" ? returnedAmount : investment;
      const threshold = actionType === "return-ratio" ? (investment * promised) / 100 : promised;
      const fulfilled = actual >= threshold;
      commitment.state = fulfilled ? "fulfilled" : "violated";
      commitment.settledAtTurn = this.round;
      commitment.settledByCommandId = actionType === "invest-at-least" ? this.investmentCommandId : this.returnCommandId;
      this.settleSocialCommitment(commitment);
      for (const id of this.profiles.keys()) {
        this.pushEvent(id, {
          type: fulfilled ? "commitment-fulfilled" : "commitment-violated",
          actorId: commitment.promisorActorId,
          targetId: id,
          facts: { commitmentId: commitment.commitmentId, promised: threshold, actual },
          detail: fulfilled
            ? `承诺兑现：${commitment.promisorActorId} 承诺「${commitment.proposition}」，实际 ${actual}。`
            : `承诺破裂：${commitment.promisorActorId} 承诺「${commitment.proposition}」，实际只有 ${actual}（要求 ${threshold}）。`
        });
      }
    }
    const unacceptedCommitments = this.commitments.filter((entry) => entry.round === this.round && entry.state === "proposed");
    for (const commitment of unacceptedCommitments) {
      commitment.state = "void";
      commitment.settledAtTurn = this.round;
      this.settleSocialCommitment(commitment);
    }
    const publicResult = this.recordPublicWorldFact({
      factKey: `trust-game-round:${this.round}`,
      eventType: "trust-game.round-resolved",
      predicate: "trust-game-round-result",
      object: { investorId, trusteeId, investment, multipliedAmount, returnedAmount, payoffs },
      payload: { round: this.round, investorId, trusteeId, investment, multipliedAmount, returnedAmount, payoffs },
      kind: "past-action"
    });
    for (const id of this.profiles.keys()) {
      const actualAmount = id === investorId ? investment : returnedAmount;
      const characterId = this.requireProfile(id).characterId;
      for (const claim of this.extractedActionClaims(characterId)) {
        this.recordClaimedActionOutcome({
          propositionId: claim.propositionId,
          actualValue: String(actualAmount),
          matches: claim.object === `${id === investorId ? "invest" : "return"}-${actualAmount}`,
          sourceEventId: publicResult.eventId
        });
      }
    }
    for (const id of this.profiles.keys()) {
      this.pushEvent(id, { type: "investment-made", actorId: investorId, targetId: id, facts: { amount: investment, resultEventId: publicResult.eventId }, detail: `第 ${this.round} 轮投资 ${investment} 已结算。` });
      this.pushEvent(id, { type: "return-made", actorId: trusteeId, targetId: id, facts: { amount: returnedAmount, resultEventId: publicResult.eventId }, detail: `第 ${this.round} 轮返还 ${returnedAmount} 已结算。` });
    }
    const violated = roundCommitments.some((entry) => entry.state === "violated");
    const allFulfilled = roundCommitments.length > 0 && roundCommitments.every((entry) => entry.state === "fulfilled");
    const reciprocal = investment > 0 && returnedAmount >= investment;
    const beat = investment === 0
      ? undefined
      : violated
        ? "promise-broken" as const
        : allFulfilled
          ? "promise-kept" as const
          : reciprocal
            ? "high-return" as const
            : returnedAmount === 0
              ? "adverse-outcome" as const
              : "low-return" as const;
    this.addLog(`第 ${this.round} 轮结算：投入 ${investment}，增长为 ${multipliedAmount}，返还 ${returnedAmount}。`, this.round, beat);
    const reconcile = (actorId: string, commandId: string | undefined, role: "investor" | "trustee") => {
      if (!commandId) return;
      const actorPayoff = payoffs[actorId];
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: role === "investor"
            ? `Invested ${investment}; the trustee returned ${returnedAmount}; payoff ${actorPayoff}.`
            : `Received control of ${multipliedAmount}; returned ${returnedAmount}; payoff ${actorPayoff}.`,
          metrics: {
            round: this.round,
            role,
            investment,
            multipliedAmount,
            returnedAmount,
            actorPayoff
          }
        },
        actualFacts: {
          "investment-positive": investment > 0,
          "return-at-least-investment": investment > 0 && returnedAmount >= investment,
          "actor-payoff-at-least-endowment": actorPayoff >= this.endowment
        },
        resultingEventIds: [publicResult.eventId]
      });
    };
    reconcile(investorId, this.investmentCommandId, "investor");
    reconcile(trusteeId, this.returnCommandId, "trustee");
    this.investment = undefined;
    this.returnedAmount = undefined;
    this.investmentCommandId = undefined;
    this.returnCommandId = undefined;
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

function parseReferences(value: Record<string, unknown>): { referencedCommitmentIds: string[]; beliefPropositions: string[] } {
  const ids = Array.isArray(value.referencedCommitmentIds)
    ? value.referencedCommitmentIds.filter((id): id is string => typeof id === "string")
    : [];
  const beliefs = Array.isArray(value.beliefPropositions)
    ? value.beliefPropositions.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
  return { referencedCommitmentIds: ids.slice(0, 3), beliefPropositions: beliefs.slice(0, 3) };
}

function phaseLabel(phase: Phase): string {
  if (phase === "discussion") return "协商";
  if (phase === "investment") return "投资";
  return "返还";
}

function situationFor(phase: Phase, role: "investor" | "trustee", investment: number | undefined, multiplier: number): string {
  if (phase === "discussion") return `You are the ${role}. A promise declared through make_commitment is checked against the sealed action by the world — a return-ratio promise (percent of whatever is actually transferred) can be made before the stake is known; roles will reverse next round.`;
  if (phase === "investment") return role === "investor" ? "Choose how much control to transfer to the trustee." : "The investor is deciding how much to trust you.";
  return role === "trustee" ? `The investment was ${investment ?? 0}, giving you ${(investment ?? 0) * multiplier} to allocate.` : "The trustee is deciding how much of the multiplied investment to return.";
}
