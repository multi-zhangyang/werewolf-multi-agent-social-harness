import { randomUUID } from "node:crypto";
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

type Phase = "discussion" | "contribution";

interface PublicGoodsRound {
  round: number;
  contributions: Record<string, number>;
  returns: Record<string, number>;
  pool: number;
  share: number;
}

const PUBLIC_GOODS_STATE_SCHEMA_VERSION = 3;
const PUBLIC_GOODS_OUTCOME_KEYS = [
  "group-pool-at-least-half",
  "actor-contributes-at-least-group-average",
  "actor-payoff-at-least-endowment",
  "group-has-zero-contributor",
  "cited-commitments-fulfilled"
] as const;

export class PublicGoodsWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly endowment = 10;
  private readonly multiplier = 1.6;
  private readonly scores = new Map<string, number>();
  private readonly contributions = new Map<string, number>();
  private readonly contributionCommandIds = new Map<string, string>();
  private readonly commitments: Commitment[] = [];
  private readonly history: PublicGoodsRound[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private discussion: DiscussionDirector;
  private phase: Phase = "discussion";
  private round = 1;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    const range = scenario.playerRange ?? { min: scenario.players, max: scenario.players };
    if (profiles.length < range.min || profiles.length > range.max) {
      throw new Error(`PLAYER_COUNT_INVALID: ${scenario.name} supports ${range.min}-${range.max} participants.`);
    }
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    this.discussion = this.createDiscussion();
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.addLog(`${profiles.length} 名参与者每人每轮获得 ${this.endowment} 点资源，公共池按 ${this.multiplier} 倍增长后均分。`, 1);
  }

  /**
   * Sidecar extraction hints (§19): contribution statements ("我会投 5 点")
   * become `claimed-action` propositions reconciled against the actual
   * contribution at settlement.
   */
  extractionHints?(): string {
    return [
      "本局是公共品博弈。行动主张判定：",
      '- 当说话者断言自己将投入的数额时输出 claims 条目：aboutSelf=true、assertedAction（格式 "contribute-数字"，如 "contribute-5"）、confidence。',
      '- 例：「我会投 5 点」→{aboutSelf:true, assertedAction:"contribute-5"}；「我一分都不会投」→{aboutSelf:true, assertedAction:"contribute-0"}；「大家都该多投」→ 不算主张。',
      '- 疑问、呼吁、要求他人表态都不算主张。'
    ].join("\n");
  }

  protected exportWorldState(): unknown {
    return {
      schemaVersion: PUBLIC_GOODS_STATE_SCHEMA_VERSION,
      round: this.round,
      phase: this.phase,
      scores: this.mapEntries(this.scores),
      contributions: this.mapEntries(this.contributions),
      contributionCommandIds: this.mapEntries(this.contributionCommandIds),
      commitments: structuredClone(this.commitments),
      discussion: this.discussion.exportState(),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences)
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      schemaVersion: number;
      round: number; phase: string; scores: Array<[string, number]>; contributions: Array<[string, number]>;
      contributionCommandIds: Array<[string, string]>; commitments: Commitment[];
      discussion: ReturnType<DiscussionDirector["exportState"]>;
      history: PublicGoodsRound[]; lastExperiences: Array<[string, string]>;
    }> | undefined;
    if (!s) return;
    if (s.schemaVersion !== undefined && s.schemaVersion !== 1 && s.schemaVersion !== 2 && s.schemaVersion !== PUBLIC_GOODS_STATE_SCHEMA_VERSION) {
      throw new Error(`SCENARIO_STATE_SCHEMA_UNSUPPORTED: public-goods ${s.schemaVersion}`);
    }
    this.round = Number(s.round ?? 1);
    this.phase = (s.phase ?? "discussion") as Phase;
    this.fillMap(this.scores, s.scores);
    this.fillMap(this.contributions, s.contributions);
    this.fillMap(this.contributionCommandIds, s.contributionCommandIds);
    this.commitments.length = 0;
    this.commitments.push(...structuredClone((s.commitments ?? []).map(normalizeCommitment)));
    this.discussion = this.createDiscussion();
    this.discussion.restoreState(s.discussion);
    this.history.length = 0;
    this.history.push(...structuredClone(s.history ?? []));
    this.fillMap(this.lastExperiences, s.lastExperiences);
  }

  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.round,
      totalTurns: this.totalRounds,
      phase: this.phase === "discussion" ? "公开协商" : "同时投入",
      summary: this.summary(),
      details: {
        endowment: this.endowment,
        multiplier: this.multiplier,
        scores: roundedRecord(this.scores),
        pendingContributions: [...this.profiles.keys()].filter((id) => !this.contributions.has(id)),
        commitments: this.commitments,
        history: this.history
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const ownContribution = this.contributions.get(actorId);
    const openCommitments = this.openCommitmentsFor(actorId);
    const causality = this.socialCausalityFor(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase,
      situation: this.phase === "discussion"
        ? `Each participant has ${this.endowment} points. Contributions are multiplied by ${this.multiplier} and split equally. Only typed promises that another participant explicitly accepts are settlement-eligible.`
        : "All contributions are private until everyone commits. You keep what you do not contribute and receive an equal share of the multiplied pool.",
      privateContext: [
        `Your cumulative score: ${formatNumber(this.scores.get(actorId) ?? 0)}.`,
        `Your committed contribution: ${ownContribution ?? "not committed"}.`,
        openCommitments.length
          ? `Open commitments:\n${openCommitments.map((commitment) => `- [${commitment.commitmentId}] ${commitment.proposition} (${commitment.state})`).join("\n")}`
          : "Open commitments: none.",
        ...socialReferenceContext(causality),
        `Previous contributions: ${this.history.map((entry) => `R${entry.round}=${entry.contributions[actorId]}`).join(", ") || "none"}.`,
        `Settled commitments: ${this.settledCommitmentsFor(actorId).map((commitment) => `[${commitment.commitmentId}] ${commitment.proposition} (${commitment.state})`).join("; ") || "none"}.`
      ].join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, score: this.scores.get(actorId) ?? 0 },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-30),
      availableActions: this.phase === "discussion"
        ? ["communicate", "make_commitment", "accept_commitment", "recall_memory", "reflect_on_social_situation", "read_the_room", "update_inner_state"]
        : ["contribute_to_pool"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const makeCommitment = tool({
      name: "make_commitment",
      description: `Propose a public, typed promise to contribute at least an integer from 0 to ${this.endowment} this round. It is settled only if another participant explicitly accepts it.`,
      parameters: z.object({
        amount: z.number().int().min(0).max(this.endowment),
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
      description: "Explicitly accept one public contribution promise. One real acceptance makes that promisor's amount eligible for deterministic settlement.",
      parameters: z.object({ commitmentId: z.string().min(1).max(200) }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "accept_commitment", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const contribute = tool({
      name: "contribute_to_pool",
      description: `Compare bounded contribution intents, predict the public result, then commit an integer from 0 to ${this.endowment}. Contributions remain sealed until the barrier and cannot be changed.`,
      parameters: z.object({
        amount: z.number().int().min(0).max(this.endowment),
        reason: z.string().min(1).max(2_000),
        referencedCommitmentIds: z.array(z.string().min(1).max(200)).max(8).default([]),
        ...createStrategyActionShape({ amount: z.number().int().min(0).max(this.endowment) }, PUBLIC_GOODS_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || selected.amount !== input.amount) {
          throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: The selected contribution must equal the binding amount.");
        }
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "contribute_to_pool", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({
            ...candidate,
            action: "contribute_to_pool",
            payloadSummary: `amount=${candidate.amount}`
          }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [makeCommitment, acceptCommitment, contribute] as Tool<SocietyAgentContext>[];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    if (this.phase !== "contribution" || this.contributions.has(actorId)) return [];
    return [{
      name: "contribute_to_pool",
      label: "投入公共池",
      description: `提交 0 到 ${this.endowment} 点；所有人提交后才公开。`,
      kind: "number",
      field: "amount",
      min: 0,
      max: this.endowment,
      step: 1
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    const value = recordPayload(payload);
    if (action === "make_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_NOT_OPEN: Contribution promises are proposed during discussion.");
      const amount = value.amount;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > this.endowment) {
        throw new Error(`COMMITMENT_AMOUNT_INVALID: Promise an integer from 0 to ${this.endowment}.`);
      }
      const proposition = typeof value.proposition === "string" ? value.proposition.trim() : "";
      if (!proposition) throw new Error("COMMITMENT_PROPOSITION_REQUIRED: State the promise explicitly.");
      const ownCount = this.commitments.filter((entry) => entry.round === this.round && entry.promisorActorId === actorId).length;
      if (ownCount >= 2) throw new Error("COMMITMENT_LIMIT_EXCEEDED: At most two proposals per participant per round.");
      const commandId = `cmd-${randomUUID()}`;
      const commitment: Commitment = {
        commitmentId: `commit:pg:${this.round}:${actorId}:${ownCount + 1}`,
        round: this.round,
        promisorActorId: actorId,
        promisorCharacterId: this.requireProfile(actorId).characterId,
        audienceActorIds: [...this.profiles.keys()].filter((id) => id !== actorId),
        proposition,
        promisedAction: {
          actionType: "contribute-at-least",
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
      this.discussion.raiseSignal({
        kind: "promise",
        sourceActorId: actorId,
        targetActorIds: [...this.profiles.keys()].filter((id) => id !== actorId)
      });
      for (const id of this.profiles.keys()) {
        this.pushEvent(id, {
          type: "commitment-proposed",
          actorId,
          targetId: id,
          facts: { commitmentId: commitment.commitmentId, promisedAmount: amount },
          detail: `${actorId === id ? "你" : this.profiles.get(actorId)?.displayName ?? actorId} 提议承诺：${proposition}。`
        });
      }
      this.emitUpdate();
      return { action, commandId, detail: proposition, result: { accepted: true, commitmentId: commitment.commitmentId } };
    }
    if (action === "accept_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_ACCEPTANCE_NOT_OPEN: Accept contribution promises during discussion.");
      const commitmentId = typeof value.commitmentId === "string" ? value.commitmentId : "";
      const commitment = this.commitments.find((entry) => entry.commitmentId === commitmentId && entry.round === this.round);
      if (!commitment) throw new Error(`COMMITMENT_NOT_FOUND: '${commitmentId}'.`);
      if (commitment.promisorActorId === actorId || !commitment.audienceActorIds.includes(actorId)) {
        throw new Error("COMMITMENT_ACCEPTOR_INVALID: A promisor cannot accept their own promise.");
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
      return { action, commandId, detail: commitmentId, result: { accepted: true, commitmentId, state: commitment.state } };
    }
    if (action !== "contribute_to_pool") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.phase !== "contribution") throw new Error("CONTRIBUTION_NOT_OPEN: Wait until the contribution phase.");
    if (this.contributions.has(actorId)) throw new Error("CONTRIBUTION_ALREADY_COMMITTED: Your amount for this round is fixed.");
    const amount = value.amount;
    if (!Number.isInteger(amount) || typeof amount !== "number" || amount < 0 || amount > this.endowment) {
      throw new Error(`CONTRIBUTION_INVALID: Choose an integer from 0 to ${this.endowment}.`);
    }
    const referencedCommitmentIds = Array.isArray(value.referencedCommitmentIds)
      ? value.referencedCommitmentIds.filter((id): id is string => typeof id === "string").slice(0, 8)
      : [];
    this.assertCommitmentReferences(actorId, referencedCommitmentIds);
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    const commandId = `cmd-${randomUUID()}`;
    this.contributions.set(actorId, amount);
    this.contributionCommandIds.set(actorId, commandId);
    this.emitUpdate();
    return {
      action,
      commandId,
      detail: reason ? `${amount}; ${reason}` : String(amount),
      result: { accepted: true, amount, waitingFor: [...this.profiles.keys()].filter((id) => !this.contributions.has(id)) }
    };
  }

  openCommitmentsFor(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      entry.round === this.round
      && (entry.state === "proposed" || entry.state === "accepted")
      && (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
  }

  private settledCommitmentsFor(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      entry.round < this.round &&
      entry.state !== "proposed" && entry.state !== "accepted" &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
  }

  private assertCommitmentReferences(actorId: string, commitmentIds: string[]): void {
    for (const commitmentId of commitmentIds) {
      const commitment = this.commitments.find((entry) => entry.commitmentId === commitmentId);
      if (
        !commitment || commitment.round !== this.round
        || (commitment.promisorActorId !== actorId && !commitment.audienceActorIds.includes(actorId))
      ) {
        throw new Error(`COMMITMENT_REFERENCE_INVALID: '${commitmentId}' is not visible in the current round.`);
      }
    }
  }

  activation(): WorldActivation | null {
    if (this.status !== "running" || this.round > this.totalRounds) return null;
    if (this.phase === "discussion") {
      const actors = this.discussion.nextWave();
      if (actors.length) {
        const wave = this.discussion.waveNumber;
        return {
          id: `pg:${this.round}:discussion:${wave}`,
          label: wave === 1 ? `第 ${this.round} 轮协商` : `第 ${this.round} 轮协商 · 回应 ${wave - 1}`,
          actorIds: actors,
          mode: "sequential",
          instructionFor: () => wave === 1
            ? "Address the group. You may propose a contribution norm, use make_commitment for a typed promise, accept a visible promise, question prior behavior, or stay strategically vague."
            : "Respond to the actual promises, questions, objections or private messages directed at you. Do not repeat your opening statement."
        };
      }
      this.phase = "contribution";
      this.emitUpdate();
    }
    return {
      id: `pg:${this.round}:contribution`,
      label: `第 ${this.round} 轮投入`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => "Review the public norm, accepted commitments, private beliefs and actor models. Call contribute_to_pool exactly once with bounded candidates and public-result predictions. Chat cannot replace the typed action."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion:")) {
      this.discussion.endWave();
      return { completed: true, missingActorIds: [] };
    }
    const missingActorIds = activation.actorIds.filter((id) => !this.contributions.has(id));
    if (missingActorIds.length) {
      return {
        completed: false,
        missingActorIds,
        retryInstruction: "Your contribution is missing. Call contribute_to_pool now with an integer from 0 to 10."
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
    if (this.phase === "discussion") {
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

  protected messageWave(): number | undefined {
    return this.phase === "discussion" ? this.discussion.waveNumber : undefined;
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

  private resolveRound(): void {
    const pool = [...this.contributions.values()].reduce((sum, value) => sum + value, 0);
    const share = pool * this.multiplier / this.profiles.size;
    const returns: Record<string, number> = {};
    const contributions = Object.fromEntries(this.contributions);
    for (const id of this.profiles.keys()) {
      const payoff = this.endowment - (this.contributions.get(id) ?? 0) + share;
      returns[id] = roundNumber(payoff);
      this.scores.set(id, (this.scores.get(id) ?? 0) + payoff);
      this.lastExperiences.set(
        id,
        `Round ${this.round}: the group contributed ${pool}. You contributed ${this.contributions.get(id)} and received ${formatNumber(payoff)} points. Contributions by participant: ${Object.entries(contributions).map(([actorId, amount]) => `${actorId}=${amount}`).join(", ")}.`
      );
    }
    this.history.push({ round: this.round, contributions, returns, pool, share: roundNumber(share) });
    const acceptedCommitments = this.commitments.filter((entry) => entry.round === this.round && entry.state === "accepted");
    for (const commitment of acceptedCommitments) {
      if (commitment.promisedAction.actionType !== "contribute-at-least") continue;
      const actualAmount = contributions[commitment.promisorActorId] ?? 0;
      const fulfilled = actualAmount >= commitment.promisedAction.amount;
      commitment.state = fulfilled ? "fulfilled" : "violated";
      commitment.settledAtTurn = this.round;
      commitment.settledByCommandId = this.contributionCommandIds.get(commitment.promisorActorId);
      this.settleSocialCommitment(commitment);
      for (const id of this.profiles.keys()) {
        this.pushEvent(id, {
          type: fulfilled ? "commitment-fulfilled" : "commitment-violated",
          actorId: commitment.promisorActorId,
          targetId: id,
          facts: {
            commitmentId: commitment.commitmentId,
            promisedAmount: commitment.promisedAction.amount,
            actualAmount
          },
          detail: fulfilled
            ? `承诺兑现：${this.profiles.get(commitment.promisorActorId)?.displayName ?? commitment.promisorActorId} 承诺至少投入 ${commitment.promisedAction.amount}，实际投入 ${actualAmount}。`
            : `承诺违约：${this.profiles.get(commitment.promisorActorId)?.displayName ?? commitment.promisorActorId} 承诺至少投入 ${commitment.promisedAction.amount}，实际投入 ${actualAmount}。`
        });
      }
    }
    for (const commitment of this.commitments.filter((entry) => entry.round === this.round && entry.state === "proposed")) {
      commitment.state = "void";
      commitment.settledAtTurn = this.round;
      this.settleSocialCommitment(commitment);
    }
    const publicResult = this.recordPublicWorldFact({
      factKey: `public-goods-round:${this.round}`,
      eventType: "public-goods.round-resolved",
      predicate: "public-goods-round-result",
      object: { pool, share: roundNumber(share), contributions },
      payload: { round: this.round, pool, share: roundNumber(share), contributions, returns }
    });
    // §28 主张对账: reconcile extracted contribution claims against the
    // actual sealed contribution.
    for (const actorId of this.profiles.keys()) {
      const actualAmount = contributions[actorId] ?? 0;
      const characterId = this.requireProfile(actorId).characterId;
      for (const claim of this.extractedActionClaims(characterId)) {
        this.recordClaimedActionOutcome({
          propositionId: claim.propositionId,
          actualValue: String(actualAmount),
          matches: claim.object === `contribute-${actualAmount}`,
          sourceEventId: publicResult.eventId
        });
      }
    }
    const groupAverage = pool / this.profiles.size;
    const groupHasZeroContributor = Object.values(contributions).some((amount) => amount === 0);
    for (const actorId of this.profiles.keys()) {
      const commandId = this.contributionCommandIds.get(actorId);
      if (!commandId) continue;
      const decision = this.socialCausalityFor(actorId).decisions.find((entry) => entry.actionReceiptId === commandId);
      const citedCommitments = acceptedCommitments.filter((entry) => decision?.openCommitmentIds.includes(entry.commitmentId));
      const ownContribution = contributions[actorId] ?? 0;
      const ownReturn = returns[actorId] ?? 0;
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `Contributed ${ownContribution}; group pool ${pool}; payoff ${ownReturn}.`,
          metrics: {
            round: this.round,
            ownContribution,
            groupAverage: roundNumber(groupAverage),
            pool,
            share: roundNumber(share),
            ownPayoff: ownReturn
          }
        },
        actualFacts: {
          "group-pool-at-least-half": pool >= this.profiles.size * this.endowment / 2,
          "actor-contributes-at-least-group-average": ownContribution >= groupAverage,
          "actor-payoff-at-least-endowment": ownReturn >= this.endowment,
          "group-has-zero-contributor": groupHasZeroContributor,
          "cited-commitments-fulfilled": citedCommitments.length > 0 && citedCommitments.every((entry) => entry.state === "fulfilled")
        },
        resultingEventIds: [publicResult.eventId],
      });
    }
    const highest = Math.max(...this.contributions.values());
    const lowest = Math.min(...this.contributions.values());
    // P0-09: zero contribution is free-riding, not betrayal; even high
    // contributions are a cooperative outcome, not a kept promise.
    const anyViolated = acceptedCommitments.some((entry) => entry.state === "violated");
    const allFulfilled = acceptedCommitments.length > 0 && acceptedCommitments.every((entry) => entry.state === "fulfilled");
    const beat = anyViolated
      ? "promise-broken" as const
      : allFulfilled
        ? "promise-kept" as const
        : highest === 0
          ? undefined
          : lowest === 0 && highest >= 3
            ? "free-riding" as const
            : lowest > 0 && lowest >= highest * 0.75
              ? "cooperative-outcome" as const
              : undefined;
    this.addLog(`第 ${this.round} 轮结算：公共池 ${pool}，每人分得 ${formatNumber(share)}。最高投入 ${highest}，最低投入 ${lowest}。`, this.round, beat);
    this.contributions.clear();
    this.contributionCommandIds.clear();
    if (this.round >= this.totalRounds) {
      this.round = this.totalRounds + 1;
      this.finish();
      return;
    }
    this.round += 1;
    this.phase = "discussion";
    this.discussion = this.createDiscussion();
    this.emitUpdate();
  }

  private createDiscussion(): DiscussionDirector {
    return new DiscussionDirector({
      actorIds: [...this.profiles.keys()],
      displayName: (id) => this.profiles.get(id)?.displayName ?? id,
      ...discussionPersonality(this.profiles),
      maxWaves: 4,
      waveSizeCap: Math.min(4, this.profiles.size)
    });
  }

  private summary(): string {
    const ranking = [...this.scores]
      .sort((left, right) => right[1] - left[1])
      .map(([id, value]) => `${this.profiles.get(id)?.displayName} ${formatNumber(value)}`)
      .join(" · ");
    return `${this.round > this.totalRounds ? "已结束" : `第 ${this.round} / ${this.totalRounds} 轮`} · ${ranking}`;
  }
}

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}

function roundedRecord(values: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...values].map(([id, value]) => [id, roundNumber(value)]));
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatNumber(value: number): string {
  return roundNumber(value).toFixed(Number.isInteger(roundNumber(value)) ? 0 : 2);
}

function normalizeCommitment(value: Commitment): Commitment {
  return {
    ...value,
    acceptedByActorIds: [...(value.acceptedByActorIds ?? [])],
    acceptedByCommandIds: [...(value.acceptedByCommandIds ?? [])]
  };
}
