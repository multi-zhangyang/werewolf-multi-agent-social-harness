import { randomInt, randomUUID } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
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
import { createStrategyActionShape, socialReferenceContext } from "../social/strategy-input";
import type { SocialActDeclaration } from "../social/contracts";

type Phase = "discussion" | "demand";

interface RoundResult {
  round: number;
  demands: Record<string, number>;
  outsideOptions: Record<string, number>;
  payoffs: Record<string, number>;
  agreed: boolean;
  text: string;
}

/**
 * The Nash demand game (Nash 1953): two players simultaneously claim shares of
 * a fixed prize. The prize splits only when both claims fit; otherwise each
 * player falls back on a private outside option nobody else can see.
 *
 * That private fallback is what turns bargaining into deception: talk is cheap
 * ("I'd never settle for less than 7"), but only the binding demand tool
 * settles the round. Bluffing about your outside option can scare the other
 * side into a modest claim — or collapse the deal for both of you.
 */
export class NegotiationWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly scores = new Map<string, number>();
  private readonly outsideOptions = new Map<string, number>();
  private readonly demands = new Map<string, number>();
  private readonly demandCommandIds = new Map<string, string>();
  private readonly offers: NegotiationOffer[] = [];
  private readonly commitments: Commitment[] = [];
  private readonly history: RoundResult[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private discussion: DiscussionDirector | null = null;
  private round = 1;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.dealOutsideOptions();
    this.discussion = this.createDiscussion();
    this.addLog("奖池固定为 10 点。双方各有私密保底选项：谈崩了就各自拿走自己的保底。", 1);
  }

  protected exportWorldState(): unknown {
    return {
      schemaVersion: NEGOTIATION_STATE_SCHEMA_VERSION,
      round: this.round,
      phase: this.phase,
      scores: this.mapEntries(this.scores),
      outsideOptions: this.mapEntries(this.outsideOptions),
      demands: this.mapEntries(this.demands),
      demandCommandIds: this.mapEntries(this.demandCommandIds),
      offers: structuredClone(this.offers),
      commitments: structuredClone(this.commitments),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences),
      discussion: this.discussion ? this.discussion.exportState() : null
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      schemaVersion: number;
      round: number; phase: string; scores: Array<[string, number]>; outsideOptions: Array<[string, number]>;
      demands: Array<[string, number]>; demandCommandIds: Array<[string, string]>;
      offers: NegotiationOffer[]; commitments: Commitment[];
      history: RoundResult[]; lastExperiences: Array<[string, string]>; discussion: unknown;
    }> | undefined;
    if (!s) return;
    if (s.schemaVersion !== undefined && s.schemaVersion !== 1 && s.schemaVersion !== NEGOTIATION_STATE_SCHEMA_VERSION) {
      throw new Error(`SCENARIO_STATE_SCHEMA_UNSUPPORTED: negotiation-game ${s.schemaVersion}`);
    }
    this.round = Number(s.round ?? 1);
    this.phase = (s.phase ?? "discussion") as Phase;
    this.fillMap(this.scores, s.scores);
    this.fillMap(this.outsideOptions, s.outsideOptions);
    this.fillMap(this.demands, s.demands);
    this.fillMap(this.demandCommandIds, s.demandCommandIds);
    this.offers.length = 0;
    this.offers.push(...structuredClone(s.offers ?? []));
    this.commitments.length = 0;
    this.commitments.push(...structuredClone((s.commitments ?? []).map(normalizeCommitment)));
    this.history.length = 0;
    this.history.push(...structuredClone(s.history ?? []));
    this.fillMap(this.lastExperiences, s.lastExperiences);
    if (s.discussion) {
      this.discussion = this.createDiscussion();
      this.discussion.restoreState(s.discussion);
    }
  }

  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.round,
      totalTurns: this.totalRounds,
      phase: this.phase === "discussion" ? "谈判" : "同时叫价",
      summary: this.summary(),
      details: {
        scores: Object.fromEntries(this.scores),
        pendingDemands: [...this.profiles.keys()].filter((id) => !this.demands.has(id)),
        offers: this.offers.map(({ proposedByCommandId: _proposedReceipt, respondedByCommandId: _responseReceipt, ...offer }) => offer),
        commitments: this.commitments,
        history: this.history.map(({ outsideOptions: _privateOutsideOptions, ...publicResult }) => publicResult),
        ...(this.discussion ? { discussion: this.discussion.state() } : {})
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const openCommitments = this.openCommitmentsFor(actorId);
    const causality = this.socialCausalityFor(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase === "discussion" ? "bargaining" : "simultaneous demands",
      situation: this.phase === "discussion"
        ? "The prize is 10 points. If combined claims exceed 10, the deal collapses. Plain chat is not binding; an offer creates settlement-eligible demand commitments only after the recipient accepts it through the typed response tool."
        : "Both claims are hidden until both players submit. The round settles the moment the second claim lands.",
      privateContext: [
        `Your score: ${this.scores.get(actorId) ?? 0}.`,
        `Your private outside option: ${this.outsideOptions.get(actorId)} points if the deal collapses.`,
        `Your sealed demand: ${this.demands.get(actorId) ?? "not committed"}.`,
        openCommitments.length
          ? `Open commitments:\n${openCommitments.map((commitment) => `- [${commitment.commitmentId}] ${commitment.proposition} (${commitment.state})`).join("\n")}`
          : "Open commitments: none.",
        `Current offers: ${this.offers.filter((offer) => offer.round === this.round).map((offer) => `${offer.offerId}: ${offer.proposerActorId} asks ${offer.proposerDemand}, ${offer.recipientActorId} gets ${offer.recipientDemand} (${offer.state})`).join("; ") || "none"}.`,
        ...socialReferenceContext(causality),
        `Past rounds: ${this.history.map((result) => `R${result.round} claim ${result.demands[actorId] ?? "-"} → ${result.payoffs[actorId]} points${result.agreed ? "" : " (no deal)"}`).join("; ") || "none"}.`
      ].join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, score: this.scores.get(actorId) ?? 0 },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-20),
      availableActions: this.phase === "discussion"
        ? ["communicate", "make_offer", "respond_to_offer", "recall_memory", "reflect_on_social_situation", "read_the_room", "update_inner_state"]
        : ["submit_demand"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const makeOffer = tool({
      name: "make_offer",
      description: "Compare bounded split proposals, then submit one typed offer to the other participant. The offer is not an agreement until the named recipient explicitly accepts it.",
      parameters: z.object({
        recipientId: z.string().min(1).max(160),
        proposerDemand: z.number().int().min(0).max(10),
        recipientDemand: z.number().int().min(0).max(10),
        message: z.string().min(1).max(500),
        ...createStrategyActionShape({
          recipientId: z.string().min(1).max(160),
          proposerDemand: z.number().int().min(0).max(10),
          recipientDemand: z.number().int().min(0).max(10)
        }, NEGOTIATION_OFFER_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected
          || selected.recipientId !== input.recipientId
          || selected.proposerDemand !== input.proposerDemand
          || selected.recipientDemand !== input.recipientDemand) {
          throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: The selected split must equal the binding offer.");
        }
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "make_offer", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({
            ...candidate,
            action: "make_offer",
            payloadSummary: `recipientId=${candidate.recipientId}; proposerDemand=${candidate.proposerDemand}; recipientDemand=${candidate.recipientDemand}`
          }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const respondToOffer = tool({
      name: "respond_to_offer",
      description: "Compare bounded responses, then explicitly accept or reject a typed offer addressed to you. Acceptance creates mutual demand commitments; rejection creates no alliance, promise, or transaction.",
      parameters: z.object({
        offerId: z.string().min(1).max(200),
        response: z.enum(["accept", "reject"]),
        reason: z.string().min(1).max(500),
        ...createStrategyActionShape({
          offerId: z.string().min(1).max(200),
          response: z.enum(["accept", "reject"])
        }, NEGOTIATION_OFFER_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || selected.offerId !== input.offerId || selected.response !== input.response) {
          throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: The selected response must equal the binding response.");
        }
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "respond_to_offer", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({
            ...candidate,
            action: "respond_to_offer",
            payloadSummary: `offerId=${candidate.offerId}; response=${candidate.response}`
          }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const submitDemand = tool({
      name: "submit_demand",
      description: "Compare bounded demand intents, predict the public transaction result, then submit one sealed binding claim. Accepted offers remain social commitments but do not bypass the typed demand.",
      parameters: z.object({
        demand: z.number().int().min(0).max(10),
        reason: z.string().min(1).max(2_000),
        referencedCommitmentIds: z.array(z.string().min(1).max(200)).max(4).default([]),
        ...createStrategyActionShape({ demand: z.number().int().min(0).max(10) }, NEGOTIATION_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || selected.demand !== input.demand) {
          throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: The selected demand must equal the binding demand.");
        }
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "submit_demand", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({
            ...candidate,
            action: "submit_demand",
            payloadSummary: `demand=${candidate.demand}`
          }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [makeOffer, respondToOffer, submitDemand] as Tool<SocietyAgentContext>[];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    if (this.phase !== "demand" || this.demands.has(actorId)) return [];
    return [{
      name: "submit_demand",
      label: "提交叫价",
      description: "在 0–10 之间选择你要求的份额；双方叫价之和不超过 10 才成交。",
      kind: "number",
      field: "demand",
      min: 0,
      max: 10,
      step: 1
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    const value = recordPayload(payload);
    if (action === "make_offer") {
      if (this.phase !== "discussion") throw new Error("OFFER_NOT_OPEN: Offers are proposed during bargaining.");
      const recipientId = typeof value.recipientId === "string" ? value.recipientId : "";
      if (!this.profiles.has(recipientId) || recipientId === actorId) throw new Error("OFFER_RECIPIENT_INVALID: Address the other participant.");
      const proposerDemand = Number(value.proposerDemand);
      const recipientDemand = Number(value.recipientDemand);
      if (!Number.isInteger(proposerDemand) || !Number.isInteger(recipientDemand) || proposerDemand < 0 || recipientDemand < 0 || proposerDemand + recipientDemand > 10) {
        throw new Error("OFFER_SPLIT_INVALID: Offer integer shares between 0 and 10 whose sum does not exceed 10.");
      }
      const message = typeof value.message === "string" ? value.message.trim() : "";
      if (!message) throw new Error("OFFER_MESSAGE_REQUIRED: Explain the typed split.");
      const proposedCount = this.offers.filter((offer) => offer.round === this.round && offer.proposerActorId === actorId).length;
      if (proposedCount >= 3) throw new Error("OFFER_LIMIT_EXCEEDED: At most three offers per participant per round.");
      const commandId = `cmd-${randomUUID()}`;
      const offer: NegotiationOffer = {
        offerId: `offer:ng:${this.round}:${actorId}:${proposedCount + 1}`,
        round: this.round,
        proposerActorId: actorId,
        recipientActorId: recipientId,
        proposerDemand,
        recipientDemand,
        state: "proposed",
        proposedByCommandId: commandId
      };
      this.offers.push(offer);
      this.discussion?.raiseSignal({
        kind: "offer",
        sourceActorId: actorId,
        targetActorIds: [recipientId]
      });
      this.pushEvent(recipientId, {
        type: "offer-proposed",
        actorId,
        targetId: recipientId,
        facts: { offerId: offer.offerId, proposerDemand, recipientDemand },
        detail: `${this.profiles.get(actorId)?.displayName ?? actorId} 提出交易：自己要求 ${proposerDemand}，你获得 ${recipientDemand}。这仍是待回应报价。`
      });
      this.emitUpdate();
      return { action, commandId, detail: message, result: { accepted: true, offerId: offer.offerId, state: offer.state } };
    }
    if (action === "respond_to_offer") {
      if (this.phase !== "discussion") throw new Error("OFFER_RESPONSE_NOT_OPEN: Respond during bargaining.");
      const offerId = typeof value.offerId === "string" ? value.offerId : "";
      const offer = this.offers.find((entry) => entry.offerId === offerId && entry.round === this.round);
      if (!offer) throw new Error(`OFFER_NOT_FOUND: '${offerId}'.`);
      if (offer.recipientActorId !== actorId) throw new Error("OFFER_RESPONSE_FORBIDDEN: Only the named recipient may respond.");
      if (offer.state !== "proposed") throw new Error(`OFFER_ALREADY_RESOLVED: '${offerId}' is ${offer.state}.`);
      const response = value.response;
      if (response !== "accept" && response !== "reject") throw new Error("OFFER_RESPONSE_INVALID: Choose accept or reject.");
      const commandId = `cmd-${randomUUID()}`;
      offer.respondedByCommandId = commandId;
      offer.state = response === "accept" ? "accepted" : "rejected";
      if (response === "accept") {
        const proposerCommitment = this.commitmentFromOffer({
          offer,
          promisorActorId: offer.proposerActorId,
          promiseeActorId: offer.recipientActorId,
          amount: offer.proposerDemand,
          createdByCommandId: offer.proposedByCommandId
        });
        const recipientCommitment = this.commitmentFromOffer({
          offer,
          promisorActorId: offer.recipientActorId,
          promiseeActorId: offer.proposerActorId,
          amount: offer.recipientDemand,
          createdByCommandId: commandId
        });
        this.commitments.push(proposerCommitment, recipientCommitment);
        this.recordSocialCommitment(proposerCommitment);
        this.recordSocialCommitment(recipientCommitment);
        this.acceptNegotiatedCommitment(proposerCommitment, offer.recipientActorId, commandId);
        this.acceptNegotiatedCommitment(recipientCommitment, offer.proposerActorId, offer.proposedByCommandId);
        for (const id of this.profiles.keys()) {
          this.pushEvent(id, {
            type: "agreement-reached",
            actorId,
            targetId: offer.proposerActorId,
            facts: { offerId, proposerDemand: offer.proposerDemand, recipientDemand: offer.recipientDemand },
            detail: `报价 ${offerId} 被明确接受：${offer.proposerActorId} 计划要求 ${offer.proposerDemand}，${offer.recipientActorId} 计划要求 ${offer.recipientDemand}。这是交易协议，不是联盟。`
          });
        }
      } else {
        this.pushEvent(offer.proposerActorId, {
          type: "offer-rejected",
          actorId,
          targetId: offer.proposerActorId,
          facts: { offerId },
          detail: `${this.profiles.get(actorId)?.displayName ?? actorId} 拒绝了报价 ${offerId}。拒绝本身不构成敌意或背叛。`
        });
      }
      this.emitUpdate();
      return { action, commandId, detail: `${offerId}; ${response}`, result: { accepted: true, offerId, state: offer.state } };
    }
    if (action !== "submit_demand") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.phase !== "demand") throw new Error("DEMAND_NOT_OPEN: Submit the binding demand after bargaining closes.");
    if (this.demands.has(actorId)) throw new Error("DEMAND_ALREADY_COMMITTED: Your claim for this round is fixed.");
    const demand = Number(value.demand);
    if (!Number.isInteger(demand) || demand < 0 || demand > 10) {
      throw new Error("DEMAND_INVALID: Your claim must be an integer between 0 and 10.");
    }
    const referencedCommitmentIds = Array.isArray(value.referencedCommitmentIds)
      ? value.referencedCommitmentIds.filter((id): id is string => typeof id === "string").slice(0, 4)
      : [];
    this.assertCommitmentReferences(actorId, referencedCommitmentIds);
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    const commandId = `cmd-${randomUUID()}`;
    this.demands.set(actorId, demand);
    this.demandCommandIds.set(actorId, commandId);
    this.emitUpdate();
    return {
      action,
      commandId,
      detail: `demand ${demand}${reason ? `; ${reason}` : ""}`,
      result: { accepted: true, demand, waitingFor: [...this.profiles.keys()].filter((id) => !this.demands.has(id)) }
    };
  }

  openCommitmentsFor(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      entry.round === this.round
      && (entry.state === "proposed" || entry.state === "accepted")
      && (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
  }

  private assertCommitmentReferences(actorId: string, commitmentIds: string[]): void {
    for (const commitmentId of commitmentIds) {
      const commitment = this.commitments.find((entry) => entry.commitmentId === commitmentId);
      if (!commitment || commitment.round !== this.round || (commitment.promisorActorId !== actorId && !commitment.audienceActorIds.includes(actorId))) {
        throw new Error(`COMMITMENT_REFERENCE_INVALID: '${commitmentId}' is not visible in the current round.`);
      }
    }
  }

  private commitmentFromOffer(input: {
    offer: NegotiationOffer;
    promisorActorId: string;
    promiseeActorId: string;
    amount: number;
    createdByCommandId: string;
  }): Commitment {
    return {
      commitmentId: `commit:ng:${input.offer.offerId}:${input.promisorActorId}`,
      round: this.round,
      promisorActorId: input.promisorActorId,
      promisorCharacterId: this.requireProfile(input.promisorActorId).characterId,
      audienceActorIds: [input.promiseeActorId],
      proposition: `${input.promisorActorId} will submit demand ${input.amount} for accepted offer ${input.offer.offerId}.`,
      promisedAction: { actionType: "demand-exactly", amount: input.amount, condition: `accepted offer ${input.offer.offerId}` },
      state: "proposed",
      acceptedByActorIds: [],
      acceptedByCommandIds: [],
      createdByCommandId: input.createdByCommandId,
      createdAtTurn: this.round,
      schemaVersion: 1
    };
  }

  private acceptNegotiatedCommitment(commitment: Commitment, acceptorActorId: string, commandId: string): void {
    commitment.state = "accepted";
    commitment.acceptedByActorIds = [acceptorActorId];
    commitment.acceptedByCommandIds = [commandId];
    commitment.acceptedAtTurn = this.round;
    this.acceptSocialCommitment(commitment, acceptorActorId, commandId);
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    if (this.round > this.totalRounds) return null;
    if (this.phase === "discussion") {
      if (!this.discussion) this.discussion = this.createDiscussion();
      const actors = this.discussion.nextWave();
      if (actors.length === 0) {
        for (const offer of this.offers) {
          if (offer.round === this.round && offer.state === "proposed") offer.state = "expired";
        }
        this.discussion = null;
        this.phase = "demand";
        this.emitUpdate();
      } else {
        const wave = this.discussion.waveNumber;
        return {
          id: `ng:${this.round}:discussion:${wave}`,
          label: wave === 1 ? `第 ${this.round} 轮谈判` : `第 ${this.round} 轮谈判 · 回应 ${wave - 1}`,
          actorIds: actors,
          mode: "sequential",
          instructionFor: () => wave === 1
            ? "Bargain without revealing unauthorized information. Use make_offer for a typed split; use respond_to_offer for an offer addressed to you. Plain language remains non-binding. Do not submit the sealed demand yet."
            : "Respond to actual offers, questions, and claims. Accept or reject a typed offer explicitly when warranted. Do not submit the sealed demand yet."
        };
      }
    }
    return {
      id: `ng:${this.round}:demand`,
      label: `第 ${this.round} 轮叫价`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => "Review accepted offers, beliefs, actor models, and your private outside option. Call submit_demand exactly once with bounded candidates and public-result predictions; text cannot substitute for the tool call."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion:")) {
      this.discussion?.endWave();
      return { completed: true, missingActorIds: [] };
    }
    const missingActorIds = activation.actorIds.filter((id) => !this.demands.has(id));
    if (missingActorIds.length) {
      return {
        completed: false,
        missingActorIds,
        retryInstruction: "Your binding claim is still missing. Call submit_demand now; do not send another message first."
      };
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

  protected currentTurn(): number {
    return this.round;
  }

  protected currentPhase(): string {
    return this.phase;
  }

  protected isAlive(_actorId: string): boolean {
    return true;
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

  private dealOutsideOptions(): void {
    for (const profile of this.profiles.values()) {
      this.outsideOptions.set(profile.id, randomInt(2, 6));
    }
  }

  private resolveRound(): void {
    const ids = [...this.profiles.keys()];
    const left = this.demands.get(ids[0]) ?? 0;
    const right = this.demands.get(ids[1]) ?? 0;
    const agreed = left + right <= 10;
    const payoffs: Record<string, number> = agreed
      ? { [ids[0]]: left, [ids[1]]: right }
      : { [ids[0]]: this.outsideOptions.get(ids[0]) ?? 0, [ids[1]]: this.outsideOptions.get(ids[1]) ?? 0 };
    for (const id of ids) this.scores.set(id, (this.scores.get(id) ?? 0) + payoffs[id]);
    const text = agreed
      ? `${this.profiles.get(ids[0])?.displayName} 叫价 ${left}，${this.profiles.get(ids[1])?.displayName} 叫价 ${right} —— 成交：${payoffs[ids[0]]} / ${payoffs[ids[1]]}。`
      : `${this.profiles.get(ids[0])?.displayName} 叫价 ${left}，${this.profiles.get(ids[1])?.displayName} 叫价 ${right} —— 破裂：双方各自拿走私密保底。`;
    const result: RoundResult = {
      round: this.round,
      demands: { [ids[0]]: left, [ids[1]]: right },
      outsideOptions: Object.fromEntries(this.outsideOptions),
      payoffs,
      agreed,
      text
    };
    this.history.push(result);
    const acceptedCommitments = this.commitments.filter((entry) => entry.round === this.round && entry.state === "accepted");
    for (const commitment of acceptedCommitments) {
      if (commitment.promisedAction.actionType !== "demand-exactly") continue;
      const actualDemand = result.demands[commitment.promisorActorId];
      const fulfilled = actualDemand === commitment.promisedAction.amount;
      commitment.state = fulfilled ? "fulfilled" : "violated";
      commitment.settledAtTurn = this.round;
      commitment.settledByCommandId = this.demandCommandIds.get(commitment.promisorActorId);
      this.settleSocialCommitment(commitment);
      for (const id of ids) {
        this.pushEvent(id, {
          type: fulfilled ? "commitment-fulfilled" : "commitment-violated",
          actorId: commitment.promisorActorId,
          targetId: id,
          facts: {
            commitmentId: commitment.commitmentId,
            promisedDemand: commitment.promisedAction.amount,
            actualDemand
          },
          detail: fulfilled
            ? `交易承诺兑现：${commitment.promisorActorId} 同意要求 ${commitment.promisedAction.amount}，实际也提交了 ${actualDemand}。`
            : `交易承诺违约：${commitment.promisorActorId} 同意要求 ${commitment.promisedAction.amount}，实际提交了 ${actualDemand}。`
        });
      }
    }
    const publicResult = this.recordPublicWorldFact({
      factKey: `negotiation-round:${this.round}`,
      eventType: "negotiation.round-resolved",
      predicate: "negotiation-round-result",
      object: { demands: result.demands, payoffs, agreed },
      payload: { round: this.round, demands: result.demands, payoffs, agreed }
    });
    this.reconcileOfferOutcomes(result, publicResult.eventId);
    for (const id of ids) {
      const own = payoffs[id];
      this.lastExperiences.set(
        id,
        agreed
          ? `${text} Deal reached: your claim ${result.demands[id]} was paid in full. Your score is now ${this.scores.get(id)}.`
          : `${text} No deal: you fell back on your private option of ${result.outsideOptions[id]} points. Your score is now ${this.scores.get(id)}.`
      );
      this.pushEvent(id, {
        type: agreed ? "agreement-reached" : "negotiation-failed",
        targetId: ids.find((other) => other !== id),
        facts: { own: result.demands[id], payoff: own, agreed },
        detail: agreed
          ? `Deal struck this round: your claim of ${result.demands[id]} was paid.`
          : `The deal collapsed this round; you took your fallback of ${result.outsideOptions[id]} instead.`
      });
      const commandId = this.demandCommandIds.get(id);
      if (!commandId) continue;
      const decision = this.socialCausalityFor(id).decisions.find((entry) => entry.actionReceiptId === commandId);
      const citedCommitments = acceptedCommitments.filter((entry) => decision?.openCommitmentIds.includes(entry.commitmentId));
      const outsideOption = result.outsideOptions[id];
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: agreed
            ? `Demanded ${result.demands[id]}; deal reached; payoff ${payoffs[id]}.`
            : `Demanded ${result.demands[id]}; no deal; private outside-option payoff ${payoffs[id]}.`,
          metrics: {
            round: this.round,
            ownDemand: result.demands[id],
            combinedDemand: left + right,
            agreed,
            ownPayoff: payoffs[id],
            ownOutsideOption: outsideOption
          }
        },
        actualFacts: {
          "deal-reached": agreed,
          "actor-demand-paid": agreed && payoffs[id] === result.demands[id],
          "actor-payoff-at-least-outside-option": payoffs[id] >= outsideOption,
          "combined-demand-at-most-prize": left + right <= 10,
          "cited-commitments-fulfilled": citedCommitments.length > 0 && citedCommitments.every((entry) => entry.state === "fulfilled")
        },
        resultingEventIds: [publicResult.eventId],
        memoryWriteSuggestions: [{
          summary: agreed
            ? `In negotiation round ${this.round}, I demanded ${result.demands[id]}; the other demand was ${result.demands[ids.find((other) => other !== id)!]}; the deal paid me ${payoffs[id]}.`
            : `In negotiation round ${this.round}, combined demands exceeded 10; I fell back to my private option and received ${payoffs[id]}.`,
          importance: citedCommitments.length || !agreed ? 0.84 : 0.68,
          sourceIds: [commandId, publicResult.eventId, ...citedCommitments.map((entry) => entry.commitmentId)]
        }]
      });
    }
    // P0-09: a deal is an agreement, not an alliance; a failed deal is a
    // negotiation failure, not a mistake.
    const anyViolated = acceptedCommitments.some((entry) => entry.state === "violated");
    const allFulfilled = acceptedCommitments.length > 0 && acceptedCommitments.every((entry) => entry.state === "fulfilled");
    const beat = anyViolated
      ? "promise-broken" as const
      : allFulfilled
        ? "promise-kept" as const
        : agreed
          ? "agreement-reached" as const
          : "negotiation-failed" as const;
    this.addLog(text, this.round, beat);
    this.demands.clear();
    this.demandCommandIds.clear();
    if (this.round >= this.totalRounds) {
      this.round = this.totalRounds + 1;
      this.finish();
      return;
    }
    this.round += 1;
    this.phase = "discussion";
    this.dealOutsideOptions();
    this.discussion = this.createDiscussion();
    this.emitUpdate();
  }

  private reconcileOfferOutcomes(result: RoundResult, roundResultEventId: string): void {
    for (const offer of this.offers.filter((entry) => entry.round === this.round)) {
      const offerCommitments = this.commitments.filter((commitment) =>
        commitment.commitmentId === `commit:ng:${offer.offerId}:${offer.proposerActorId}`
        || commitment.commitmentId === `commit:ng:${offer.offerId}:${offer.recipientActorId}`
      );
      const offerAccepted = offer.state === "accepted";
      const offerImplemented = offerAccepted
        && offerCommitments.length === 2
        && offerCommitments.every((commitment) => commitment.state === "fulfilled");
      const offerResult = this.recordPublicWorldFact({
        factKey: `negotiation-offer:${offer.offerId}`,
        eventType: "negotiation.offer-resolved",
        subjectActorId: offer.proposerActorId,
        predicate: "negotiation-offer-result",
        object: {
          state: offer.state,
          implemented: offerImplemented,
          dealReached: result.agreed
        },
        payload: {
          round: this.round,
          offerId: offer.offerId,
          proposerActorId: offer.proposerActorId,
          recipientActorId: offer.recipientActorId,
          proposerDemand: offer.proposerDemand,
          recipientDemand: offer.recipientDemand,
          state: offer.state,
          implemented: offerImplemented,
          dealReached: result.agreed
        }
      });
      const resultingEventIds = [offerResult.eventId, roundResultEventId];
      this.reconcileOfferDecision({
        actorId: offer.proposerActorId,
        commandId: offer.proposedByCommandId,
        offer,
        result,
        offerAccepted,
        offerImplemented,
        resultingEventIds,
        perspective: "proposer"
      });
      if (offer.respondedByCommandId) {
        this.reconcileOfferDecision({
          actorId: offer.recipientActorId,
          commandId: offer.respondedByCommandId,
          offer,
          result,
          offerAccepted,
          offerImplemented,
          resultingEventIds,
          perspective: "recipient"
        });
      }
    }
  }

  private reconcileOfferDecision(input: {
    actorId: string;
    commandId: string;
    offer: NegotiationOffer;
    result: RoundResult;
    offerAccepted: boolean;
    offerImplemented: boolean;
    resultingEventIds: string[];
    perspective: "proposer" | "recipient";
  }): void {
    const hasDecision = this.socialCausalityFor(input.actorId).decisions.some(
      (decision) => decision.actionReceiptId === input.commandId
    );
    if (!hasDecision) return;
    const actorDemand = input.result.demands[input.actorId];
    const actorPayoff = input.result.payoffs[input.actorId];
    const responseSummary = input.offer.state === "expired"
      ? "expired without a response"
      : input.offer.state === "accepted"
        ? "was accepted"
        : "was rejected";
    this.reconcileSocialOutcome({
      actionReceiptId: input.commandId,
      actualOutcome: {
        summary: input.perspective === "proposer"
          ? `Offer ${input.offer.offerId} ${responseSummary}; ${input.offerImplemented ? "both promised demands were submitted" : "the proposed split was not fully implemented"}; ${input.result.agreed ? "a deal was reached" : "the round ended without a deal"}.`
          : `${input.offer.state === "accepted" ? "Accepted" : "Rejected"} offer ${input.offer.offerId}; ${input.offerImplemented ? "both promised demands were submitted" : "the proposed split was not fully implemented"}; ${input.result.agreed ? "a deal was reached" : "the round ended without a deal"}.`,
        metrics: {
          round: this.round,
          offerId: input.offer.offerId,
          offerState: input.offer.state,
          offerAccepted: input.offerAccepted,
          offerImplemented: input.offerImplemented,
          dealReached: input.result.agreed,
          actorDemand,
          actorPayoff
        }
      },
      actualFacts: {
        "offer-accepted": input.offerAccepted,
        "offer-implemented": input.offerImplemented,
        "deal-reached": input.result.agreed
      },
      resultingEventIds: input.resultingEventIds,
      memoryWriteSuggestions: [{
        summary: input.perspective === "proposer"
          ? `In negotiation round ${this.round}, my offer ${input.offer.offerId} ${responseSummary}; it ${input.offerImplemented ? "was" : "was not"} implemented in the sealed demands.`
          : `In negotiation round ${this.round}, I ${input.offer.state === "accepted" ? "accepted" : "rejected"} offer ${input.offer.offerId}; it ${input.offerImplemented ? "was" : "was not"} implemented in the sealed demands.`,
        importance: input.offerAccepted ? (input.offerImplemented ? 0.88 : 0.92) : 0.66,
        sourceIds: [input.commandId, ...input.resultingEventIds]
      }]
    });
  }

  private summary(): string {
    const scores = [...this.scores].map(([id, score]) => `${this.profiles.get(id)?.displayName}: ${score}`).join(" · ");
    return `${this.round > this.totalRounds ? "已结束" : `第 ${this.round} / ${this.totalRounds} 轮`} · ${scores}`;
  }
}

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}

interface NegotiationOffer {
  offerId: string;
  round: number;
  proposerActorId: string;
  recipientActorId: string;
  proposerDemand: number;
  recipientDemand: number;
  state: "proposed" | "accepted" | "rejected" | "expired";
  proposedByCommandId: string;
  respondedByCommandId?: string;
}

const NEGOTIATION_STATE_SCHEMA_VERSION = 2;
const NEGOTIATION_OFFER_OUTCOME_KEYS = ["offer-accepted", "offer-implemented", "deal-reached"] as const;
const NEGOTIATION_OUTCOME_KEYS = [
  "deal-reached",
  "actor-demand-paid",
  "actor-payoff-at-least-outside-option",
  "combined-demand-at-most-prize",
  "cited-commitments-fulfilled"
] as const;

function normalizeCommitment(value: Commitment): Commitment {
  return {
    ...value,
    acceptedByActorIds: [...(value.acceptedByActorIds ?? [])],
    acceptedByCommandIds: [...(value.acceptedByCommandIds ?? [])]
  };
}
