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
import { emitAction, boundedRounds, discussionPersonality } from "./helpers";
import { createStrategyActionShape, socialReferenceContext } from "../social/strategy-input";
import type { SocialActDeclaration } from "../social/contracts";

type Move = "cooperate" | "defect";
type Phase = "discussion" | "choice";

const PRISONERS_DILEMMA_STATE_SCHEMA_VERSION = 2;
const PD_OUTCOME_KEYS = [
  "opponent-cooperates",
  "both-cooperate",
  "actor-outscores-opponent",
  "actor-payoff-at-least-three",
  "cited-commitments-fulfilled"
] as const;

interface RoundResult {
  round: number;
  moves: Record<string, Move>;
  payoffs: Record<string, number>;
  text: string;
}

export class PrisonersDilemmaWorld extends SocialWorldBase {
  readonly name = "囚徒困境";
  private readonly totalRounds: number;
  private readonly scores = new Map<string, number>();
  private readonly choices = new Map<string, Move>();
  private readonly choiceCommandIds = new Map<string, string>();
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
    this.addLog("谈判开始：语言不能替代行动；只有被明确接受的承诺才会在结算时对账。", 1);
  }

  protected exportWorldState(): unknown {
    return {
      schemaVersion: PRISONERS_DILEMMA_STATE_SCHEMA_VERSION,
      round: this.round,
      phase: this.phase,
      scores: this.mapEntries(this.scores),
      choices: this.mapEntries(this.choices),
      choiceCommandIds: this.mapEntries(this.choiceCommandIds),
      commitments: structuredClone(this.commitments),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences),
      discussion: this.discussion ? this.discussion.exportState() : null
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      schemaVersion: number;
      round: number; phase: string; scores: Array<[string, number]>; choices: Array<[string, Move]>;
      choiceCommandIds: Array<[string, string]>; commitments: Commitment[];
      history: RoundResult[]; lastExperiences: Array<[string, string]>; discussion: unknown;
    }> | undefined;
    if (!s) return;
    if (s.schemaVersion !== undefined && s.schemaVersion !== 1 && s.schemaVersion !== PRISONERS_DILEMMA_STATE_SCHEMA_VERSION) {
      throw new Error(`SCENARIO_STATE_SCHEMA_UNSUPPORTED: prisoners-dilemma ${s.schemaVersion}`);
    }
    this.round = Number(s.round ?? 1);
    this.phase = (s.phase ?? "discussion") as Phase;
    this.fillMap(this.scores, s.scores);
    this.fillMap(this.choices, s.choices);
    this.fillMap(this.choiceCommandIds, s.choiceCommandIds);
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
      phase: this.phase === "discussion" ? "谈判" : "同时选择",
      summary: this.summary(),
      details: {
        scores: Object.fromEntries(this.scores),
        pendingChoices: [...this.profiles.keys()].filter((id) => !this.choices.has(id)),
        commitments: this.commitments,
        history: this.history,
        ...(this.discussion ? { discussion: this.discussion.state() } : {})
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const ownMove = this.choices.get(actorId);
    const openCommitments = this.openCommitmentsFor(actorId);
    const causality = this.socialCausalityFor(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase === "discussion" ? "negotiation" : "simultaneous choice",
      situation: this.phase === "discussion"
        ? "You may negotiate before both participants commit privately. A proposed promise becomes settlement-eligible only after its recipient explicitly accepts it."
        : "Both choices are hidden until both participants commit. The round resolves immediately after the second commitment.",
      privateContext: [
        `Your score: ${this.scores.get(actorId) ?? 0}.`,
        `Your current choice: ${ownMove ?? "not committed"}.`,
        openCommitments.length
          ? `Open commitments:\n${openCommitments.map((commitment) => `- [${commitment.commitmentId}] ${commitment.proposition} (${commitment.state})`).join("\n")}`
          : "Open commitments: none.",
        ...socialReferenceContext(causality),
        `Past rounds: ${this.history.map((result) => `${result.round} ${result.moves[actorId]} / ${result.payoffs[actorId]} points`).join("; ") || "none"}.`
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
        ? ["communicate", "make_commitment", "accept_commitment", "recall_memory", "reflect_on_social_situation", "read_the_room"]
        : ["choose_move", "communicate"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const makeCommitment = tool({
      name: "make_commitment",
      description: "Propose a public promise to cooperate or defect this round. It is recorded, but it can only be settled as kept or broken if the other participant explicitly accepts it.",
      parameters: z.object({
        move: z.enum(["cooperate", "defect"]),
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
      description: "Explicitly accept one proposed commitment addressed to you. Acceptance makes it eligible for deterministic settlement against the sealed move.",
      parameters: z.object({ commitmentId: z.string().min(1).max(200) }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "accept_commitment", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const choose = tool({
      name: "choose_move",
      description: "Compare bounded candidate intents, select one, predict the round, then commit privately to cooperate or defect. This typed move is the binding action and cannot be changed.",
      parameters: z.object({
        move: z.enum(["cooperate", "defect"]),
        reason: z.string().min(1).max(2_000),
        referencedCommitmentIds: z.array(z.string().min(1).max(200)).max(4).default([]),
        ...createStrategyActionShape({ move: z.enum(["cooperate", "defect"]) }, PD_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || selected.move !== input.move) {
          throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: The selected intent move must equal the binding move.");
        }
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "choose_move", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({
            ...candidate,
            action: "choose_move",
            payloadSummary: `move=${candidate.move}`
          }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [makeCommitment, acceptCommitment, choose] as Tool<SocietyAgentContext>[];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    if (this.phase !== "choice" || this.choices.has(actorId)) return [];
    return [{
      name: "choose_move",
      label: "提交选择",
      description: "选择会保持隐藏，直到双方都提交。",
      kind: "choice",
      field: "move",
      options: [
        { value: "cooperate", label: "合作" },
        { value: "defect", label: "不合作" }
      ]
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    const value = recordPayload(payload);
    if (action === "make_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_NOT_OPEN: Commitments can only be proposed during negotiation.");
      const move = value.move;
      if (move !== "cooperate" && move !== "defect") throw new Error("MOVE_INVALID: Promise cooperate or defect.");
      const proposition = typeof value.proposition === "string" ? value.proposition.trim() : "";
      if (!proposition) throw new Error("COMMITMENT_PROPOSITION_REQUIRED: State the promise explicitly.");
      const ownCount = this.commitments.filter((entry) => entry.round === this.round && entry.promisorActorId === actorId).length;
      if (ownCount >= 2) throw new Error("COMMITMENT_LIMIT_EXCEEDED: At most two proposals per participant per round.");
      const commandId = `cmd-${randomUUID()}`;
      const commitment: Commitment = {
        commitmentId: `commit:pd:${this.round}:${actorId}:${ownCount + 1}`,
        round: this.round,
        promisorActorId: actorId,
        promisorCharacterId: this.requireProfile(actorId).characterId,
        audienceActorIds: [...this.profiles.keys()].filter((id) => id !== actorId),
        proposition,
        promisedAction: {
          actionType: "choose-move",
          choice: move,
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
          facts: { commitmentId: commitment.commitmentId, promisedMove: move },
          detail: `${actorId === id ? "你" : this.profiles.get(actorId)?.displayName ?? actorId} 提议承诺：${proposition}。`
        });
      }
      this.emitUpdate();
      return { action, commandId, detail: proposition, result: { accepted: true, commitmentId: commitment.commitmentId } };
    }
    if (action === "accept_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_ACCEPTANCE_NOT_OPEN: Accept during negotiation.");
      const commitmentId = typeof value.commitmentId === "string" ? value.commitmentId : "";
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
      const requiredRecipients = commitment.audienceActorIds.filter((id) => id !== commitment.promisorActorId);
      if (requiredRecipients.every((id) => acceptedByActorIds.includes(id))) commitment.state = "accepted";
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
    if (action !== "choose_move") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.phase !== "choice") throw new Error("CHOICE_NOT_OPEN: Finish the negotiation phase before choosing.");
    if (this.choices.has(actorId)) throw new Error("CHOICE_ALREADY_COMMITTED: Your move for this round is fixed.");
    const move = value.move;
    if (move !== "cooperate" && move !== "defect") throw new Error("MOVE_INVALID: Choose cooperate or defect.");
    const referencedCommitmentIds = Array.isArray(value.referencedCommitmentIds)
      ? value.referencedCommitmentIds.filter((id): id is string => typeof id === "string").slice(0, 4)
      : [];
    this.assertCommitmentReferences(actorId, referencedCommitmentIds);
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    const commandId = `cmd-${randomUUID()}`;
    this.choices.set(actorId, move);
    this.choiceCommandIds.set(actorId, commandId);
    this.emitUpdate();
    const detail = reason ? `${move}; ${reason}` : move;
    return {
      action,
      commandId,
      detail,
      result: { accepted: true, move, waitingFor: [...this.profiles.keys()].filter((id) => !this.choices.has(id)) }
    };
  }

  openCommitmentsFor(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      entry.round === this.round &&
      (entry.state === "proposed" || entry.state === "accepted") &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
  }

  private assertCommitmentReferences(actorId: string, commitmentIds: string[]): void {
    for (const commitmentId of commitmentIds) {
      const commitment = this.commitments.find((entry) => entry.commitmentId === commitmentId);
      if (
        !commitment || commitment.round !== this.round ||
        (commitment.promisorActorId !== actorId && !commitment.audienceActorIds.includes(actorId))
      ) {
        throw new Error(`COMMITMENT_REFERENCE_INVALID: '${commitmentId}' is not visible to this actor in the current round.`);
      }
    }
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    if (this.round > this.totalRounds) return null;
    if (this.phase === "discussion") {
      if (!this.discussion) this.discussion = this.createDiscussion();
      const actors = this.discussion.nextWave();
      if (actors.length === 0) {
        this.discussion = null;
        this.phase = "choice";
        this.emitUpdate();
      } else {
        const wave = this.discussion.waveNumber;
        return {
          id: `pd:${this.round}:discussion:${wave}`,
          label: wave === 1 ? `第 ${this.round} 轮谈判` : `第 ${this.round} 轮谈判 · 回应 ${wave - 1}`,
          actorIds: actors,
          mode: "sequential",
          instructionFor: () => wave === 1
            ? "Opening negotiation. Probe the other side, propose a typed commitment if warranted, or conceal your intended move. Do not use choose_move yet."
            : "React to what was actually said. You may accept a specific proposal with accept_commitment, challenge it, or stay silent. Do not use choose_move yet."
        };
      }
    }
    return {
      id: `pd:${this.round}:choice`,
      label: `第 ${this.round} 轮选择`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => "Review incentives, accepted commitments, your beliefs and actor model. Call choose_move exactly once with bounded candidates and predictions; text cannot substitute for the tool call."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion")) {
      this.discussion?.endWave();
      return { completed: true, missingActorIds: [] };
    }
    const missingActorIds = activation.actorIds.filter((id) => !this.choices.has(id));
    if (missingActorIds.length) {
      return {
        completed: false,
        missingActorIds,
        retryInstruction: "Your private commitment is still missing. Call choose_move now; do not send another message first."
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

  private createDiscussion(): DiscussionDirector {
    return new DiscussionDirector({
      actorIds: [...this.profiles.keys()],
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

  private resolveRound(): void {
    const ids = [...this.profiles.keys()];
    const left = this.choices.get(ids[0])!;
    const right = this.choices.get(ids[1])!;
    const payoffs = payoff(left, right);
    this.scores.set(ids[0], (this.scores.get(ids[0]) ?? 0) + payoffs[0]);
    this.scores.set(ids[1], (this.scores.get(ids[1]) ?? 0) + payoffs[1]);
    const moveLabel = (move: Move): string => (move === "cooperate" ? "合作" : "不合作");
    const text = `${this.profiles.get(ids[0])?.displayName}选择${moveLabel(left)}；${this.profiles.get(ids[1])?.displayName}选择${moveLabel(right)}。得分：${payoffs[0]} / ${payoffs[1]}。`;
    const result: RoundResult = { round: this.round, moves: { [ids[0]]: left, [ids[1]]: right }, payoffs: { [ids[0]]: payoffs[0], [ids[1]]: payoffs[1] }, text };
    this.history.push(result);
    for (const id of ids) this.lastExperiences.set(id, `${text} 你本轮选择了${moveLabel(result.moves[id])}。你的累计得分：${this.scores.get(id)}。`);
    const acceptedCommitments = this.commitments.filter((entry) => entry.round === this.round && entry.state === "accepted");
    for (const commitment of acceptedCommitments) {
      if (commitment.promisedAction.actionType !== "choose-move") continue;
      const actualMove = result.moves[commitment.promisorActorId];
      const fulfilled = actualMove === commitment.promisedAction.choice;
      commitment.state = fulfilled ? "fulfilled" : "violated";
      commitment.settledAtTurn = this.round;
      commitment.settledByCommandId = this.choiceCommandIds.get(commitment.promisorActorId);
      this.settleSocialCommitment(commitment);
      for (const id of ids) {
        this.pushEvent(id, {
          type: fulfilled ? "commitment-fulfilled" : "commitment-violated",
          actorId: commitment.promisorActorId,
          targetId: id,
          facts: {
            commitmentId: commitment.commitmentId,
            promisedMove: commitment.promisedAction.choice,
            actualMove
          },
          detail: fulfilled
            ? `承诺兑现：${commitment.promisorActorId} 承诺${moveLabel(commitment.promisedAction.choice)}，实际也选择了${moveLabel(actualMove)}。`
            : `承诺违约：${commitment.promisorActorId} 承诺${moveLabel(commitment.promisedAction.choice)}，实际选择了${moveLabel(actualMove)}。`
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
      factKey: `prisoners-dilemma-round:${this.round}`,
      eventType: "prisoners-dilemma.round-resolved",
      predicate: "prisoners-dilemma-round-result",
      object: { moves: result.moves, payoffs: result.payoffs },
      payload: { round: this.round, moves: result.moves, payoffs: result.payoffs },
      kind: "past-action"
    });
    for (const actorId of ids) {
      const opponentId = ids.find((id) => id !== actorId)!;
      const opponentMove = result.moves[opponentId];
      this.pushEvent(actorId, {
        type: opponentMove === "cooperate" ? "opponent-cooperated" : "opponent-defected",
        actorId: opponentId,
        targetId: actorId,
        facts: { selfMove: result.moves[actorId], opponentMove, payoff: result.payoffs[actorId], resultEventId: publicResult.eventId },
        detail: `${this.profiles.get(opponentId)?.displayName ?? opponentId} 本轮选择了${moveLabel(opponentMove)}；你选择了${moveLabel(result.moves[actorId])}。`
      });
    }
    const anyViolated = acceptedCommitments.some((entry) => entry.state === "violated");
    const allFulfilled = acceptedCommitments.length > 0 && acceptedCommitments.every((entry) => entry.state === "fulfilled");
    const beat = anyViolated
      ? "promise-broken" as const
      : allFulfilled
        ? "promise-kept" as const
        : left === right
          ? (left === "cooperate" ? "cooperative-outcome" as const : undefined)
          : "unilateral-defection" as const;
    this.addLog(text, this.round, beat);
    for (const actorId of ids) {
      const commandId = this.choiceCommandIds.get(actorId);
      if (!commandId) continue;
      const opponentId = ids.find((id) => id !== actorId)!;
      const decision = this.socialCausalityFor(actorId).decisions.find((entry) => entry.actionReceiptId === commandId);
      const citedCommitments = acceptedCommitments.filter((entry) => decision?.openCommitmentIds.includes(entry.commitmentId));
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `Chose ${result.moves[actorId]}; ${opponentId} chose ${result.moves[opponentId]}; payoff ${result.payoffs[actorId]}.`,
          metrics: {
            round: this.round,
            ownMove: result.moves[actorId],
            opponentMove: result.moves[opponentId],
            ownPayoff: result.payoffs[actorId],
            opponentPayoff: result.payoffs[opponentId]
          }
        },
        actualFacts: {
          "opponent-cooperates": result.moves[opponentId] === "cooperate",
          "both-cooperate": result.moves[actorId] === "cooperate" && result.moves[opponentId] === "cooperate",
          "actor-outscores-opponent": result.payoffs[actorId] > result.payoffs[opponentId],
          "actor-payoff-at-least-three": result.payoffs[actorId] >= 3,
          "cited-commitments-fulfilled": citedCommitments.length > 0 && citedCommitments.every((entry) => entry.state === "fulfilled")
        },
        resultingEventIds: [publicResult.eventId]
      });
    }
    this.choices.clear();
    this.choiceCommandIds.clear();
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

function payoff(left: Move, right: Move): [number, number] {
  if (left === "cooperate" && right === "cooperate") return [3, 3];
  if (left === "defect" && right === "defect") return [1, 1];
  return left === "defect" ? [5, 0] : [0, 5];
}

function normalizeCommitment(value: Commitment): Commitment {
  const legacy = value as Commitment & {
    acceptedByActorIds?: string[];
    acceptedByCommandIds?: string[];
  };
  return {
    ...value,
    acceptedByActorIds: [...(legacy.acceptedByActorIds ?? [])],
    acceptedByCommandIds: [...(legacy.acceptedByCommandIds ?? [])]
  };
}
