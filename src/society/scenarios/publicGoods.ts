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

type Phase = "discussion" | "contribution";

interface PublicGoodsRound {
  round: number;
  contributions: Record<string, number>;
  returns: Record<string, number>;
  pool: number;
  share: number;
}

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
   * Sidecar extraction hints: contribution statements ("我会投 5 点")
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
    const counterpart = this.strategicCounterpartFor(actorId);
    const latestRound = this.history.at(-1);
    const latestDirectedMessage = this.latestDirectedMessageFor(actorId);
    const ownMarginalReturn = this.multiplier / this.profiles.size;
    const marginalIncentive = `Immediate round score = ${this.endowment} - your contribution + (${this.multiplier} * total pool / ${this.profiles.size}). The pool share alone is not your round score. Each extra point you contribute changes your own immediate score by ${formatNumber(ownMarginalReturn - 1)} and the group's combined immediate score by +${formatNumber(this.multiplier - 1)}. Social consequences, commitments, reputation, and future rounds may still change your strategic choice.`;
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase,
      situation: this.phase === "discussion"
        ? `Each participant has ${this.endowment} points. Contributions are multiplied by ${this.multiplier} and split equally. Only typed promises that another participant explicitly accepts are settlement-eligible. ${marginalIncentive}`
        : `All contributions are private until everyone commits. You keep what you do not contribute and receive an equal share of the multiplied pool. ${marginalIncentive}`,
      privateContext: [
        `Your cumulative score: ${formatNumber(this.scores.get(actorId) ?? 0)}.`,
        `Your committed contribution: ${ownContribution ?? "not committed"}.`,
        counterpart
          ? `Current strategic counterpart: ${counterpart.displayName} (${counterpart.id}). Direct a concrete request, offer, test, challenge, or reply at this person instead of addressing a faceless group.`
          : "Current strategic counterpart: none.",
        latestDirectedMessage
          ? `Latest message requiring your attention: [${latestDirectedMessage.id}] from ${latestDirectedMessage.senderName}: ${latestDirectedMessage.text}`
          : "Latest message requiring your attention: none.",
        latestRound
          ? `Last public outcome: ${Object.entries(latestRound.contributions).map(([id, amount]) => `${this.profiles.get(id)?.displayName ?? id}=${amount}`).join(", ")}. Use this evidence when judging reliability.`
          : "Last public outcome: none yet. Use this round to test one participant's reliability.",
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
        ? ["final_response", "prepare_message", "calculate_public_goods_outcome", "make_commitment", "accept_commitment", "recall_memory", "reflect_on_social_situation", "read_the_room", "update_inner_state"]
        : ["contribute_to_pool"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const calculateOutcome = tool({
      name: "calculate_public_goods_outcome",
      description: [
        "Calculate the authoritative pool, equal pool share, and final round score for every participant under one proposed contribution profile. This tool is read-only and has no social or binding effect.",
        `Before you state any numerical pool, share, payoff, or payoff difference during discussion, call this tool with exactly one entry for every actor: ${[...this.profiles.keys()].join(", ")}. Copy its results instead of doing arithmetic in prose.`,
        `Final round score is ${this.endowment} - own contribution + pool share; pool share alone is not final score.`
      ].join("\n"),
      parameters: z.object({
        contributions: z.array(z.object({
          actorId: z.string().min(1).max(200),
          amount: z.number().int().min(0).max(this.endowment)
        }).strict()).length(this.profiles.size)
      }).strict(),
      execute: async ({ contributions }) => {
        const amounts = new Map<string, number>();
        for (const entry of contributions) {
          if (!this.profiles.has(entry.actorId)) {
            throw new Error(`CALCULATION_ACTOR_INVALID: '${entry.actorId}' is not a participant.`);
          }
          if (amounts.has(entry.actorId)) {
            throw new Error(`CALCULATION_ACTOR_DUPLICATED: '${entry.actorId}' appears more than once.`);
          }
          amounts.set(entry.actorId, entry.amount);
        }
        const missing = [...this.profiles.keys()].filter((id) => !amounts.has(id));
        if (missing.length) throw new Error(`CALCULATION_ACTOR_MISSING: ${missing.join(", ")}.`);
        const pool = [...amounts.values()].reduce((sum, amount) => sum + amount, 0);
        const multipliedPool = pool * this.multiplier;
        const share = multipliedPool / this.profiles.size;
        return {
          pool,
          multipliedPool: roundNumber(multipliedPool),
          equalPoolShare: roundNumber(share),
          finalRoundScores: Object.fromEntries([...this.profiles.values()].map((profile) => [
            profile.id,
            {
              displayName: profile.displayName,
              contribution: amounts.get(profile.id) ?? 0,
              finalRoundScore: roundNumber(this.endowment - (amounts.get(profile.id) ?? 0) + share)
            }
          ]))
        };
      }
    });
    const makeCommitment = tool({
      name: "make_commitment",
      description: [
        `Create a public, binding-capable promise to contribute at least an integer from 0 to ${this.endowment} this round and return its commitmentId.`,
        "Use only during discussion and only when you genuinely want other participants to rely on the promise. It becomes settlement-eligible after another participant calls accept_commitment.",
        "This call does not send speech: prepare delivery metadata with prepare_message, then put the proposal in your final response and cite the amount. At most two proposals are allowed per round; do not retry after a successful result because a retry creates another promise."
      ].join("\n"),
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
      description: [
        "Accept one visible public contribution promise by commitmentId, making the promisor's promised minimum eligible for deterministic settlement.",
        "Use only during discussion. You cannot accept your own promise or accept the same promise twice. On success, do not retry. Communicate why you accept or what reciprocity you expect if that matters strategically."
      ].join("\n"),
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
      description: [
        `Complete your required binding action by sealing one integer contribution from 0 to ${this.endowment}.`,
        "Use exactly once during the contribution phase. The amount is private until every participant commits and cannot be changed after success; do not retry a successful call.",
        "referencedCommitmentIds may contain only visible current-round commitment IDs that actually informed the decision. Speech, reasoning, or cognition tools do not complete this action."
      ].join("\n"),
      parameters: z.object({
        amount: z.number().int().min(0).max(this.endowment),
        reason: z.string().min(1).max(2_000),
        referencedCommitmentIds: z.array(z.string().min(1).max(200)).max(8).default([])
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "contribute_to_pool", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [calculateOutcome, makeCommitment, acceptCommitment, contribute] as Tool<SocietyAgentContext>[];
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
      if (this.acceptedCommitmentChainIsClosed()) {
        this.phase = "contribution";
        this.emitUpdate();
      }
    }
    if (this.phase === "discussion") {
      const actors = this.discussion.nextWave();
      if (actors.length) {
        const wave = this.discussion.waveNumber;
        return {
          id: `pg:${this.round}:discussion:${wave}`,
          label: wave === 1 ? `第 ${this.round} 轮协商` : `第 ${this.round} 轮协商 · 回应 ${wave - 1}`,
          actorIds: actors,
          // Opening positions do not depend on one another and can run
          // concurrently; later waves retain turn-taking so replies can cite
          // messages and commitments created earlier in that wave.
          mode: wave === 1 ? "parallel" : "sequential",
          instructionFor: (actorId) => this.discussionInstructionFor(actorId, wave)
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
      instructionFor: (actorId) => this.contributionInstructionFor(actorId)
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
        retryInstruction: `Required action still missing. Do not prepare a message or call cognition tools. Call contribute_to_pool now exactly once with amount as an integer from 0 to ${this.endowment}, a short reason, and only visible current-round IDs in referencedCommitmentIds (or []). Finish silently after the tool succeeds.`
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
      this.scores.set(id, roundNumber((this.scores.get(id) ?? 0) + payoff));
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
    // 主张对账: reconcile extracted contribution claims against the
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
      // The social ledger no longer records per-receipt decision records, so
      // the actor's cited commitments are no longer tracked at settlement
      // time; the citation fact stays unasserted in the reconciliation input.
      const citedCommitments: Commitment[] = [];
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
    // Zero contribution is free-riding, not betrayal; even high
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
      ...discussionPersonality(this.profiles, (id) => this.moodSignalFor(id)),
      maxWaves: 3,
      waveSizeCap: Math.min(4, this.profiles.size)
    });
  }

  private discussionInstructionFor(actorId: string, wave: number): string {
    if (this.acceptedCommitmentChainIsClosed()) {
      return "Every participant already has an accepted typed contribution promise for this round. The negotiation has reached a structured outcome. Do not call prepare_message or any other tool; end this turn silently so the sealed contribution phase can begin.";
    }
    const counterpart = this.strategicCounterpartFor(actorId);
    const directed = this.latestDirectedMessageFor(actorId);
    const target = counterpart
      ? `${counterpart.displayName} (actor ID ${counterpart.id})`
      : "one concrete participant";
    const response = directed
      ? `Reply directly to ${directed.senderName}'s visible message [${directed.id}] by passing replyTo: "${directed.id}" to prepare_message, then make the final response your actual reply. Take a position on what they actually said.`
      : `Direct this move at ${target}; address them by name and include their actor ID in socialActs.targetActorIds.`;
    const historyEvidence = this.history.length
      ? "Use the last revealed contribution as evidence: reward reliability, pressure a low contributor, or explain why the evidence does not persuade you."
      : "There is no contribution history yet, so use a concrete amount or reciprocal condition to test this counterpart's reliability.";
    const opening = wave === 1
      ? "Make one concise strategic move: a request, offer, question, challenge, acceptance, or deliberate refusal. Do not deliver a generic speech to everyone."
      : "Advance or change the negotiation. Do not repeat your opening, merely summarize the room, or answer a different participant.";
    return [
      opening,
      response,
      historyEvidence,
      `Before stating any numerical pool, share, final score, or payoff difference, call calculate_public_goods_outcome with one contribution for each of the ${this.profiles.size} actors and quote its result. Do not calculate payoffs in prose.`,
      "If you promise an amount, call make_commitment, then call prepare_message and state it in the final response. If you rely on another participant's visible promise, call accept_commitment with its exact ID. A spoken promise alone is non-binding.",
      "For any utterance, call prepare_message first and encode its real social act, then make the final response the exact speech. Strategic silence means skipping prepare_message."
    ].join("\n");
  }

  private contributionInstructionFor(actorId: string): string {
    const accepted = this.openCommitmentsFor(actorId).filter((entry) => entry.state === "accepted");
    const acceptedIds = accepted.map((entry) => entry.commitmentId);
    const ownAccepted = accepted.filter((entry) => entry.promisorActorId === actorId);
    return [
      "Now make the private, binding decision. Weigh the public negotiation, last-round behavior, your private beliefs, relationships, goals, and incentives.",
      ownAccepted.length
        ? `You made accepted promise(s): ${ownAccepted.map((entry) => `[${entry.commitmentId}] at least ${entry.promisedAction.actionType === "contribute-at-least" ? entry.promisedAction.amount : "the recorded amount"}`).join(", ")}. You may honor or violate them, but the world will settle the result publicly.`
        : "You have no accepted promise of your own this round.",
      `Visible accepted commitment IDs: ${acceptedIds.length ? acceptedIds.join(", ") : "none"}. Cite only IDs that actually influenced the decision; otherwise pass [].`,
      `Call contribute_to_pool exactly once with an integer from 0 to ${this.endowment}. Do not call prepare_message or cognition tools first. Finish silently after the tool succeeds.`
    ].join("\n");
  }

  private acceptedCommitmentChainIsClosed(): boolean {
    return [...this.profiles.keys()].every((actorId) => this.commitments.some((entry) =>
      entry.round === this.round
      && entry.promisorActorId === actorId
      && entry.state === "accepted"
      && entry.promisedAction.actionType === "contribute-at-least"
    ));
  }

  private strategicCounterpartFor(actorId: string): AgentProfile | undefined {
    const others = [...this.profiles.values()].filter((profile) => profile.id !== actorId);
    const latestRound = this.history.at(-1);
    if (latestRound) {
      return others.sort((left, right) =>
        (latestRound.contributions[left.id] ?? 0) - (latestRound.contributions[right.id] ?? 0)
        || left.id.localeCompare(right.id)
      )[0];
    }
    const actorIds = [...this.profiles.keys()];
    const ownIndex = actorIds.indexOf(actorId);
    const counterpartId = actorIds[(ownIndex + 1) % actorIds.length];
    return counterpartId && counterpartId !== actorId ? this.profiles.get(counterpartId) : others[0];
  }

  private latestDirectedMessageFor(actorId: string): SocialMessage | undefined {
    const self = this.requireProfile(actorId);
    const messages = this.visibleMessages(actorId).filter((message) =>
      message.turn === this.round && message.senderId !== actorId
    );
    const ownMessageIds = new Set(this.visibleMessages(actorId)
      .filter((message) => message.senderId === actorId)
      .map((message) => message.id));
    return messages.findLast((message) =>
      (message.recipientIds?.includes(actorId) ?? false)
      || (message.replyTo ? ownMessageIds.has(message.replyTo) : false)
      || message.text.includes(self.displayName)
    );
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
