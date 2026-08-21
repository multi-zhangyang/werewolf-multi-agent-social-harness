import { randomUUID } from "node:crypto";
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
import { scopedContext, SocialWorldBase } from "../world";
import { conversationSignalsFromSocialActs, DiscussionDirector } from "../conversation";
import { boundedRounds, discussionPersonality, emitAction } from "./helpers";
import { createStrategyActionShape, socialReferenceContext } from "../social/strategy-input";
import type { SocialActDeclaration } from "../social/contracts";

type Choice = "swerve" | "straight";
type Phase = "discussion" | "choice";

interface RoundResult {
  round: number;
  choices: Record<string, Choice>;
  payoffs: Record<string, number>;
  text: string;
}

const CHICKEN_STATE_SCHEMA_VERSION = 3;
const CHICKEN_OUTCOME_KEYS = ["mutual-crash", "opponent-swerves", "actor-outscores-opponent", "actor-payoff-at-least-two"] as const;

/**
 * Chicken (hawk-dove) game. Both drivers choose simultaneously: swerving is
 * safe but loses face; driving straight wins big if the other blinks and
 * crashes the game if nobody does. Negotiation is pure bluff theater.
 */
export class ChickenGameWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly scores = new Map<string, number>();
  private readonly choices = new Map<string, Choice>();
  private readonly choiceCommandIds = new Map<string, string>();
  private readonly history: RoundResult[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private discussion: DiscussionDirector;
  private phase: Phase = "discussion";
  private round = 1;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    this.discussion = this.createDiscussion();
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.addLog("两辆车在一条直线上加速。每一轮都从谈判开始，然后同时打方向盘。", 1);
  }

  protected exportWorldState(): unknown {
    return {
      schemaVersion: CHICKEN_STATE_SCHEMA_VERSION,
      round: this.round,
      phase: this.phase,
      scores: this.mapEntries(this.scores),
      choices: this.mapEntries(this.choices),
      choiceCommandIds: this.mapEntries(this.choiceCommandIds),
      discussion: this.discussion.exportState(),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences)
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      schemaVersion: number;
      round: number; phase: string; scores: Array<[string, number]>; choices: Array<[string, Choice]>;
      choiceCommandIds: Array<[string, string]>;
      discussion: ReturnType<DiscussionDirector["exportState"]>;
      history: RoundResult[]; lastExperiences: Array<[string, string]>;
    }> | undefined;
    if (!s) return;
    if (s.schemaVersion !== undefined && s.schemaVersion !== 1 && s.schemaVersion !== 2 && s.schemaVersion !== CHICKEN_STATE_SCHEMA_VERSION) {
      throw new Error(`SCENARIO_STATE_SCHEMA_UNSUPPORTED: chicken-game ${s.schemaVersion}`);
    }
    this.round = Number(s.round ?? 1);
    this.phase = (s.phase ?? "discussion") as Phase;
    this.fillMap(this.scores, s.scores);
    this.fillMap(this.choices, s.choices);
    this.fillMap(this.choiceCommandIds, s.choiceCommandIds);
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
      phase: this.phase === "discussion" ? "对峙谈判" : "同时抉择",
      summary: this.summary(),
      details: {
        scores: Object.fromEntries(this.scores),
        pendingChoices: [...this.profiles.keys()].filter((id) => !this.choices.has(id)),
        history: this.history
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const own = this.choices.get(actorId);
    const causality = this.socialCausalityFor(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase === "discussion" ? "negotiation" : "simultaneous choice",
      situation: this.phase === "discussion"
        ? "Both drivers can talk before the simultaneous commitment. Threats of driving straight are cheap until the choice tool is used."
        : "Choices stay hidden until both drivers commit. The round resolves the moment the second commitment lands.",
      privateContext: [
        `Your score: ${this.scores.get(actorId) ?? 0}.`,
        `Your current choice: ${own ?? "not committed"}.`,
        ...socialReferenceContext(causality),
        `Past rounds: ${this.history.map((result) => `R${result.round} ${result.choices[actorId]} / ${result.payoffs[actorId]} points`).join("; ") || "none"}.`
      ].join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, score: this.scores.get(actorId) ?? 0 },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-20),
      availableActions: this.phase === "discussion" ? ["communicate", "recall_memory", "reflect_on_social_situation"] : ["chicken_choice", "communicate"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const choose = tool({
      name: "chicken_choice",
      description: "Compare bounded confrontation intents and predict the public result, then commit privately to swerve or straight. Binding for this round.",
      parameters: z.object({
        choice: z.enum(["swerve", "straight"]),
        reason: z.string().min(1).max(2_000),
        ...createStrategyActionShape({ choice: z.enum(["swerve", "straight"]) }, CHICKEN_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || selected.choice !== input.choice) throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: Selected chicken choice must equal the binding choice.");
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "chicken_choice", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({ ...candidate, action: "chicken_choice", payloadSummary: `choice=${candidate.choice}` }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    return [choose] as Tool<SocietyAgentContext>[];
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    this.requireProfile(actorId);
    if (this.phase !== "choice" || this.choices.has(actorId)) return [];
    return [{
      name: "chicken_choice",
      label: "提交选择",
      description: "选择会保持隐藏，直到双方都提交。",
      kind: "choice",
      field: "choice",
      options: [
        { value: "swerve", label: "闪避" },
        { value: "straight", label: "硬冲" }
      ]
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    if (action !== "chicken_choice") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.phase !== "choice") throw new Error("CHOICE_NOT_OPEN: Finish the negotiation phase before choosing.");
    if (this.choices.has(actorId)) throw new Error("CHOICE_ALREADY_COMMITTED: Your choice for this round is fixed.");
    const value = recordPayload(payload);
    const choice = value.choice;
    if (choice !== "swerve" && choice !== "straight") throw new Error("CHOICE_INVALID: Choose swerve or straight.");
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    const commandId = `cmd-${randomUUID()}`;
    this.choices.set(actorId, choice);
    this.choiceCommandIds.set(actorId, commandId);
    this.emitUpdate();
    return {
      action,
      commandId,
      detail: reason ? `${choice}; ${reason}` : choice,
      result: { accepted: true, choice, waitingFor: [...this.profiles.keys()].filter((id) => !this.choices.has(id)) }
    };
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    if (this.round > this.totalRounds) return null;
    if (this.phase === "discussion") {
      const actors = this.discussion.nextWave();
      if (actors.length) {
        const wave = this.discussion.waveNumber;
        return {
          id: `ch:${this.round}:discussion:${wave}`,
          label: wave === 1 ? `第 ${this.round} 轮对峙` : `第 ${this.round} 轮对峙 · 回应 ${wave - 1}`,
          actorIds: actors,
          mode: "sequential",
          instructionFor: () => wave === 1
            ? "Posture, threaten, seek a compromise, or stay quiet. Do not use chicken_choice yet."
            : "Respond to the actual threat, challenge, offer or private message directed at you. Do not repeat your opening statement."
        };
      }
      this.phase = "choice";
      this.emitUpdate();
    }
    return {
      id: `ch:${this.round}:choice`,
      label: `第 ${this.round} 轮抉择`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => "Review authorized threats, beliefs and actor models. Call chicken_choice exactly once with bounded candidates and public-result predictions; text cannot substitute for the tool call."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion:")) {
      this.discussion.endWave();
      return { completed: true, missingActorIds: [] };
    }
    const missingActorIds = activation.actorIds.filter((id) => !this.choices.has(id));
    if (missingActorIds.length) {
      return {
        completed: false,
        missingActorIds,
        retryInstruction: "Your private commitment is still missing. Call chicken_choice now; do not send another message first."
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

  private resolveRound(): void {
    const ids = [...this.profiles.keys()];
    const left = this.choices.get(ids[0])!;
    const right = this.choices.get(ids[1])!;
    const payoffs = payoff(left, right);
    this.scores.set(ids[0], (this.scores.get(ids[0]) ?? 0) + payoffs[0]);
    this.scores.set(ids[1], (this.scores.get(ids[1]) ?? 0) + payoffs[1]);
    const choiceLabel = (choice: Choice): string => (choice === "swerve" ? "闪避" : "硬冲");
    const text = payoffs[0] === 0 && payoffs[1] === 0
      ? `${this.profiles.get(ids[0])?.displayName}与${this.profiles.get(ids[1])?.displayName}都选择硬冲，正面相撞：0 / 0。`
      : `${this.profiles.get(ids[0])?.displayName}选择${choiceLabel(left)}；${this.profiles.get(ids[1])?.displayName}选择${choiceLabel(right)}。得分：${payoffs[0]} / ${payoffs[1]}。`;
    const result: RoundResult = { round: this.round, choices: { [ids[0]]: left, [ids[1]]: right }, payoffs: { [ids[0]]: payoffs[0], [ids[1]]: payoffs[1] }, text };
    this.history.push(result);
    const publicResult = this.recordPublicWorldFact({
      factKey: `chicken-round:${this.round}`,
      eventType: "chicken.round-resolved",
      predicate: "chicken-round-result",
      object: { choices: result.choices, payoffs: result.payoffs },
      payload: { round: this.round, choices: result.choices, payoffs: result.payoffs }
    });
    for (const id of ids) this.lastExperiences.set(id, `${text} 你本轮选择了${choiceLabel(result.choices[id])}。你的累计得分：${this.scores.get(id)}。`);
    const beat = payoffs[0] === 0 && payoffs[1] === 0 ? "adverse-outcome" as const : payoffs[0] === 4 || payoffs[1] === 4 ? "win" as const : undefined;
    this.addLog(text, this.round, beat);
    for (const id of ids) {
      const commandId = this.choiceCommandIds.get(id);
      if (!commandId) continue;
      const opponentId = ids.find((actorId) => actorId !== id)!;
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `Chose ${result.choices[id]}; opponent chose ${result.choices[opponentId]}; payoff ${result.payoffs[id]}.`,
          metrics: { round: this.round, ownChoice: result.choices[id], opponentChoice: result.choices[opponentId], ownPayoff: result.payoffs[id], opponentPayoff: result.payoffs[opponentId] }
        },
        actualFacts: {
          "mutual-crash": result.choices[id] === "straight" && result.choices[opponentId] === "straight",
          "opponent-swerves": result.choices[opponentId] === "swerve",
          "actor-outscores-opponent": result.payoffs[id] > result.payoffs[opponentId],
          "actor-payoff-at-least-two": result.payoffs[id] >= 2
        },
        resultingEventIds: [publicResult.eventId],
        memoryWriteSuggestions: [{
          summary: `In chicken round ${this.round}, I chose ${result.choices[id]}, ${opponentId} chose ${result.choices[opponentId]}, and I scored ${result.payoffs[id]}.`,
          importance: result.payoffs[id] === 0 || result.payoffs[id] === 4 ? 0.8 : 0.64,
          sourceIds: [commandId, publicResult.eventId]
        }]
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
    this.discussion = this.createDiscussion();
    this.emitUpdate();
  }

  private createDiscussion(): DiscussionDirector {
    return new DiscussionDirector({
      actorIds: [...this.profiles.keys()],
      displayName: (id) => this.profiles.get(id)?.displayName ?? id,
      ...discussionPersonality(this.profiles)
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

function payoff(left: Choice, right: Choice): [number, number] {
  if (left === "swerve" && right === "swerve") return [2, 2];
  if (left === "straight" && right === "straight") return [0, 0];
  return left === "straight" ? [4, 1] : [1, 4];
}
