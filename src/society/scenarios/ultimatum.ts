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
  private readonly commitments: Commitment[] = [];
  private readonly history: UltimatumRound[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private discussion: DiscussionDirector | null = null;
  private round = 1;
  private offer?: number;
  private response?: boolean;
  private offerCommandId?: string;
  private responseCommandId?: string;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    if (profiles.length !== 2) throw new Error("PLAYER_COUNT_INVALID: Ultimatum Game requires two participants.");
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.addLog("第一轮开始：提议者提出 10 点资源的分配方案，回应者可以接受，也可以用拒绝惩罚不公平。", 1);
  }

  /**
   * Sidecar extraction hints: split statements ("我会给你 4")
   * become `claimed-action` propositions reconciled against the sealed
   * offer at settlement.
   */
  extractionHints?(): string {
    return [
      "本局是最后通牒博弈。行动主张判定：",
      '- 当说话者（提议者）断言自己将提出的份额时输出 claims 条目：aboutSelf=true、assertedAction（格式 "offer-数字"，如 "offer-4"）、confidence。',
      '- 例：「我会给你 4」→{aboutSelf:true, assertedAction:"offer-4"}；「我一分都不会让」→{aboutSelf:true, assertedAction:"offer-0"}；「你应该多要一点」→ 不算主张。',
      '- 疑问、劝告、回应者的意图表态都不算主张。'
    ].join("\n");
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
        commitments: this.commitments,
        history: this.history,
        ...(this.discussion ? { discussion: this.discussion.state() } : {})
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const [proposerId, responderId] = this.rolesForRound();
    const role = actorId === proposerId ? "proposer" : "responder";
    const causality = this.socialCausalityFor(actorId);
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
        ...socialReferenceContext(causality),
        `Round history: ${this.history.map((entry) => `R${entry.round} ${entry.proposerId === actorId ? "proposed" : "responded"} ${entry.offer}/${this.pot}, payoff ${entry.payoffs[actorId]}`).join("; ") || "none"}.`,
        `Settled commitments: ${this.settledCommitmentsFor(actorId).map((commitment) => `[${commitment.commitmentId}] ${commitment.proposition} (${commitment.state})`).join("; ") || "none"}.`
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
      description: `Offer the responder an integer share from 0 to ${this.pot}. This typed offer is binding for the response phase.`,
      parameters: z.object({
        offer: z.number().int().min(0).max(this.pot),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "propose_split", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const respond = tool({
      name: "respond_to_offer",
      description: "Accept or reject the typed split. Accepting locks in both payoffs; rejecting gives both zero.",
      parameters: z.object({
        accept: z.boolean(),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "respond_to_offer", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const makeCommitment = tool({
      name: "make_commitment",
      description: `Propose a typed promise: as the proposer, offer at least N to the responder; as the responder, accept any offer at least N. It settles as kept or broken only if the other participant explicitly accepts it.`,
      parameters: z.object({
        commitmentType: z.enum(["offer-at-least", "accept-at-least"]),
        amount: z.number().int().min(0).max(this.pot),
        proposition: z.string().min(1).max(400),
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
      description: "Explicitly accept one proposed commitment addressed to you. Acceptance makes it eligible for deterministic settlement against the sealed offer and response.",
      parameters: z.object({ commitmentId: z.string().min(1).max(200) }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "accept_commitment", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [propose, respond, makeCommitment, acceptCommitment];
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
    if (action === "make_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_NOT_OPEN: Commitments are proposed during the negotiation.");
      const type = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).commitmentType : undefined;
      if (type !== "offer-at-least" && type !== "accept-at-least") {
        throw new Error("COMMITMENT_TYPE_INVALID: Promise offer-at-least or accept-at-least.");
      }
      const amount = Number((payload as Record<string, unknown>).amount);
      if (!Number.isInteger(amount) || amount < 0 || amount > this.pot) {
        throw new Error(`COMMITMENT_AMOUNT_INVALID: Promise an integer from 0 to ${this.pot}.`);
      }
      const proposition = typeof (payload as Record<string, unknown>).proposition === "string"
        ? ((payload as Record<string, unknown>).proposition as string).trim() : "";
      if (!proposition) throw new Error("COMMITMENT_PROPOSITION_REQUIRED: State the promise explicitly.");
      if (type === "offer-at-least" && actorId !== proposerId) {
        throw new Error("ROLE_MISMATCH: Only this round's proposer can promise an offer.");
      }
      if (type === "accept-at-least" && actorId !== responderId) {
        throw new Error("ROLE_MISMATCH: Only this round's responder can promise acceptance.");
      }
      const ownCount = this.commitments.filter((entry) => entry.round === this.round && entry.promisorActorId === actorId).length;
      if (ownCount >= 2) throw new Error("COMMITMENT_LIMIT_EXCEEDED: At most two proposals per participant per round.");
      const commandId = `cmd-${randomUUID()}`;
      const condition = typeof (payload as Record<string, unknown>).condition === "string"
        && ((payload as Record<string, unknown>).condition as string).trim()
        ? ((payload as Record<string, unknown>).condition as string).trim() : undefined;
      const commitment: Commitment = {
        commitmentId: `commit:ug:${this.round}:${actorId}:${ownCount + 1}`,
        round: this.round,
        promisorActorId: actorId,
        promisorCharacterId: this.requireProfile(actorId).characterId,
        audienceActorIds: [actorId === proposerId ? responderId : proposerId],
        proposition,
        promisedAction: type === "offer-at-least"
          ? { actionType: "offer-at-least", amount, ...(condition ? { condition } : {}) }
          : { actionType: "accept-at-least", amount, ...(condition ? { condition } : {}) },
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
          facts: { commitmentId: commitment.commitmentId, commitmentType: type, amount },
          detail: `${actorId === id ? "你" : this.profiles.get(actorId)?.displayName ?? actorId} 提议承诺：${proposition}。`
        });
      }
      this.emitUpdate();
      return Promise.resolve({ action, commandId, detail: proposition, result: { accepted: true, commitmentId: commitment.commitmentId } });
    }
    if (action === "accept_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_ACCEPTANCE_NOT_OPEN: Accept commitments during the negotiation.");
      const commitmentId = typeof (payload as Record<string, unknown>).commitmentId === "string"
        ? ((payload as Record<string, unknown>).commitmentId as string) : "";
      const commitment = this.commitments.find((entry) => entry.commitmentId === commitmentId && entry.round === this.round);
      if (!commitment) throw new Error(`COMMITMENT_NOT_FOUND: '${commitmentId}'.`);
      if (commitment.promisorActorId === actorId || !commitment.audienceActorIds.includes(actorId)) {
        throw new Error("COMMITMENT_ACCEPTOR_INVALID: Only the other participant may accept this proposal.");
      }
      if (commitment.state !== "proposed" && commitment.state !== "accepted") {
        throw new Error(`COMMITMENT_NOT_OPEN: '${commitmentId}' is already ${commitment.state}.`);
      }
      const acceptedByActorIds = commitment.acceptedByActorIds ?? (commitment.acceptedByActorIds = []);
      const acceptedByCommandIds = commitment.acceptedByCommandIds ?? (commitment.acceptedByCommandIds = []);
      if (acceptedByActorIds.includes(actorId)) throw new Error(`COMMITMENT_ALREADY_ACCEPTED: '${commitmentId}'.`);
      const commandId = `cmd-${randomUUID()}`;
      acceptedByActorIds.push(actorId);
      acceptedByCommandIds.push(commandId);
      commitment.acceptedAtTurn = this.round;
      commitment.state = "accepted";
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
      return Promise.resolve({ action, commandId, detail: commitmentId, result: { accepted: true, commitmentId, state: commitment.state } });
    }
    if (action === "propose_split") {
      const { offer } = parseProposePayload(payload);
      if (this.phase !== "propose" || actorId !== proposerId) {
        throw new Error("ACTION_NOT_AVAILABLE: Only the current proposer may propose during the propose phase.");
      }
      if (offer < 0 || offer > this.pot) {
        throw new Error(`OFFER_OUT_OF_RANGE: offer must be an integer from 0 to ${this.pot}.`);
      }
      this.offer = offer;
      const commandId = `cmd-${randomUUID()}`;
      this.offerCommandId = commandId;
      return Promise.resolve({ action, commandId, detail: `提出分配：自己 ${this.pot - offer}，对方 ${offer}`, result: { offer } });
    }
    if (action === "respond_to_offer") {
      const { accept } = parseRespondPayload(payload);
      if (this.phase !== "respond" || actorId !== responderId) {
        throw new Error("ACTION_NOT_AVAILABLE: Only the current responder may respond during the respond phase.");
      }
      if (this.offer === undefined) throw new Error("OFFER_MISSING: No offer has been proposed this round.");
      this.response = accept;
      const commandId = `cmd-${randomUUID()}`;
      this.responseCommandId = commandId;
      return Promise.resolve({ action, commandId, detail: accept ? "接受分配方案" : "拒绝分配方案", result: { accept } });
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
    if (this.phase === "propose" && actorId === proposerId) return ["propose_split"];
    if (this.phase === "respond" && actorId === responderId) return ["respond_to_offer"];
    return ["final_response", "reflect_on_social_situation", "read_the_room", "update_inner_state"];
  }

  private openCommitmentsThisRound(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      entry.round === this.round &&
      (entry.state === "proposed" || entry.state === "accepted") &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
  }

  private settledCommitmentsFor(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      entry.round < this.round &&
      entry.state !== "proposed" && entry.state !== "accepted" &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
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
    const publicResult = this.recordPublicWorldFact({
      factKey: `ultimatum-round:${this.round}`,
      eventType: "ultimatum.round-resolved",
      predicate: "ultimatum-round-result",
      object: { proposerId, responderId, offer, accepted, payoffs },
      payload: { round: this.round, proposerId, responderId, offer, accepted, payoffs }
    });
    // 主张对账: reconcile extracted offer claims ("我会给你 4")
    // against the actual sealed offer.
    for (const id of this.profiles.keys()) {
      const characterId = this.requireProfile(id).characterId;
      for (const claim of this.extractedActionClaims(characterId)) {
        this.recordClaimedActionOutcome({
          propositionId: claim.propositionId,
          actualValue: String(offer),
          matches: claim.object === `offer-${offer}`,
          sourceEventId: publicResult.eventId
        });
      }
    }
    // Settle this round's accepted commitments against the sealed offer
    // and response. An accept-at-least promise whose threshold the offer never
    // reached is voided — the condition never materialized.
    const roundCommitments = this.commitments.filter((entry) => entry.round === this.round && entry.state === "accepted");
    let anyViolated = false;
    let anyFulfilled = false;
    for (const commitment of roundCommitments) {
      if (commitment.promisedAction.actionType === "offer-at-least") {
        const fulfilled = offer >= commitment.promisedAction.amount;
        if (fulfilled) anyFulfilled = true;
        commitment.state = fulfilled ? "fulfilled" : "violated";
        if (!fulfilled) anyViolated = true;
      } else if (commitment.promisedAction.actionType === "accept-at-least") {
        if (offer < commitment.promisedAction.amount) {
          commitment.state = "void";
        } else {
          const fulfilled = accepted;
          if (fulfilled) anyFulfilled = true;
          commitment.state = fulfilled ? "fulfilled" : "violated";
          if (!fulfilled) anyViolated = true;
        }
      } else {
        continue;
      }
      commitment.settledAtTurn = this.round;
      commitment.settledByCommandId = commitment.promisedAction.actionType === "offer-at-least" ? this.offerCommandId : this.responseCommandId;
      this.settleSocialCommitment(commitment);
      if (commitment.state !== "void") {
        for (const id of this.profiles.keys()) {
          this.pushEvent(id, {
            type: commitment.state === "fulfilled" ? "commitment-fulfilled" : "commitment-violated",
            actorId: commitment.promisorActorId,
            targetId: id,
            facts: { commitmentId: commitment.commitmentId, promisedAmount: commitment.promisedAction.amount, offer },
            detail: commitment.state === "fulfilled"
              ? `承诺兑现：${this.profiles.get(commitment.promisorActorId)?.displayName ?? commitment.promisorActorId} 的「${commitment.proposition}」得到兑现。`
              : `承诺违约：${this.profiles.get(commitment.promisorActorId)?.displayName ?? commitment.promisorActorId} 的「${commitment.proposition}」被实际行为违背。`
          });
        }
      }
    }
    for (const commitment of this.commitments.filter((entry) => entry.round === this.round && entry.state === "proposed")) {
      commitment.state = "void";
      commitment.settledAtTurn = this.round;
      this.settleSocialCommitment(commitment);
    }
    for (const id of this.profiles.keys()) {
      this.lastExperiences.set(
        id,
        `Round ${this.round}: ${this.profiles.get(proposerId)?.displayName} offered ${offer} of ${this.pot}; ${this.profiles.get(responderId)?.displayName} ${accepted ? "accepted" : "rejected"}. Your payoff was ${payoffs[id]}. Roles reverse on the next round.`
      );
    }
    for (const id of this.profiles.keys()) {
      this.pushEvent(id, {
        type: accepted ? "agreement-reached" : "negotiation-failed",
        actorId: responderId,
        targetId: proposerId,
        facts: { offer, accepted, payoff: payoffs[id] },
        detail: accepted
          ? `回应者接受了 ${offer}/${this.pot} 的 typed 分配，交易按规则结算。这是一次协议，不是联盟。`
          : `回应者拒绝了 ${offer}/${this.pot} 的 typed 分配，双方本轮得分为零。拒绝不自动等于敌意或失误。`
      });
    }
    if (this.offerCommandId) {
      this.reconcileSocialOutcome({
        actionReceiptId: this.offerCommandId,
        actualOutcome: {
          summary: `Offered responder ${offer}; response=${accepted ? "accept" : "reject"}; proposer payoff ${proposerPayoff}.`,
          metrics: { round: this.round, offer, accepted, proposerPayoff, responderPayoff }
        },
        actualFacts: {
          "offer-accepted": accepted,
          "proposer-payoff-at-least-five": proposerPayoff >= 5,
          "responder-payoff-at-least-three": responderPayoff >= 3,
          "both-receive-positive": proposerPayoff > 0 && responderPayoff > 0
        },
        resultingEventIds: [publicResult.eventId],
      });
    }
    if (this.responseCommandId) {
      this.reconcileSocialOutcome({
        actionReceiptId: this.responseCommandId,
        actualOutcome: {
          summary: `${accepted ? "Accepted" : "Rejected"} offer ${offer}; responder payoff ${responderPayoff}.`,
          metrics: { round: this.round, offer, accepted, proposerPayoff, responderPayoff }
        },
        actualFacts: {
          "offer-accepted": accepted,
          "actor-payoff-positive": responderPayoff > 0,
          "proposer-payoff-positive": proposerPayoff > 0,
          "agreement-reached": accepted
        },
        resultingEventIds: [publicResult.eventId],
      });
    }
    const beat = anyViolated
      ? "promise-broken" as const
      : anyFulfilled
        ? "promise-kept" as const
        : accepted
          ? "agreement-reached" as const
          : "negotiation-failed" as const;
    this.addLog(`第 ${this.round} 轮结算：提议 ${offer}/${this.pot}，回应者${accepted ? "接受" : "拒绝"}。`, this.round, beat);
    this.offer = undefined;
    this.response = undefined;
    this.offerCommandId = undefined;
    this.responseCommandId = undefined;
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
