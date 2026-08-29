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
import { socialReferenceContext } from "../social/context-refs";
import type { SocialActDeclaration } from "../social/contracts";

type Phase = "discussion" | "choice";

interface BeautyRound {
  round: number;
  choices: Record<string, number>;
  average: number;
  target: number;
  winnerIds: string[];
  text: string;
}

/**
 * Keynesian Beauty Contest.
 *
 * Each player privately picks an integer from 0 to 100. The winner is the player
 * closest to 2/3 of the group average. It rewards higher-order reasoning: what you
 * think others think about what everyone thinks.
 */
export class BeautyContestWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly minChoice = 0;
  private readonly maxChoice = 100;
  private readonly targetRatio = 2 / 3;
  private readonly scores = new Map<string, number>();
  private readonly choices = new Map<string, number>();
  private readonly choiceCommandIds = new Map<string, string>();
  private readonly history: BeautyRound[] = [];
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
    this.addLog("选美博弈开始：每人私下选择 0–100 的整数，最接近所有人平均值 2/3 的人获胜。", 1);
  }

  /**
   * Sidecar extraction hints: number statements ("我会选 50") become
   * `claimed-action` propositions reconciled against the sealed choice.
   */
  extractionHints?(): string {
    return [
      "本局是选美博弈。行动主张判定：",
      '- 当说话者断言自己将选择的数字时输出 claims 条目：aboutSelf=true、assertedAction（格式 "number-数字"，如 "number-50"）、confidence。',
      '- 例：「我会选 50」→{aboutSelf:true, assertedAction:"number-50"}；「大家都该选 0」→ 不算主张。',
      '- 疑问、呼吁、要求他人表态都不算主张。'
    ].join("\n");
  }



  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.round,
      totalTurns: this.totalRounds,
      phase: this.phase === "discussion" ? "公开讨论" : "同时选择",
      summary: this.summary(),
      details: {
        targetRatio: this.targetRatio,
        minChoice: this.minChoice,
        maxChoice: this.maxChoice,
        scores: Object.fromEntries(this.scores),
        pendingChoices: [...this.profiles.keys()].filter((id) => !this.choices.has(id)),
        history: this.history
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const causality = this.socialCausalityFor(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase,
      situation: this.phase === "discussion"
        ? `Everyone will privately choose an integer from ${this.minChoice} to ${this.maxChoice}. The winner is closest to ${Math.round(this.targetRatio * 100)}% of the group average. Public claims are cheap talk.`
        : `Choices are hidden until everyone commits. The target is ${Math.round(this.targetRatio * 100)}% of the average of all choices.`,
      privateContext: [
        `Your cumulative score: ${this.scores.get(actorId) ?? 0}.`,
        `Your current choice: ${this.choices.get(actorId) ?? "not committed"}.`,
        ...socialReferenceContext(causality),
        `Past rounds: ${this.history.map((entry) => `R${entry.round} avg=${entry.average.toFixed(1)} target=${entry.target.toFixed(1)} winner=${entry.winnerIds.map((id) => this.profiles.get(id)?.displayName ?? id).join(",")}`).join("; ") || "none"}.`
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
        ? ["communicate", "reflect_on_social_situation", "read_the_room", "update_inner_state"]
        : ["choose_number"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const choose = tool({
      name: "choose_number",
      description: `Privately choose an integer from ${this.minChoice} to ${this.maxChoice}. The typed number is the binding action and cannot be changed.`,
      parameters: z.object({
        number: z.number().int().min(this.minChoice).max(this.maxChoice),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "choose_number", {
          number: input.number,
          reason: input.reason
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
      name: "choose_number",
      label: "提交数字",
      description: `选择 ${this.minChoice}–${this.maxChoice} 的整数；所有人提交后统一结算。`,
      kind: "number",
      field: "number",
      min: this.minChoice,
      max: this.maxChoice,
      step: 1
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    if (action !== "choose_number") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.phase !== "choice") throw new Error("CHOICE_NOT_OPEN: Finish the discussion before choosing.");
    if (this.choices.has(actorId)) throw new Error("CHOICE_ALREADY_COMMITTED: Your number for this round is fixed.");
    const value = recordPayload(payload);
    const number = value.number;
    if (typeof number !== "number" || !Number.isInteger(number) || number < this.minChoice || number > this.maxChoice) {
      throw new Error(`CHOICE_INVALID: Choose an integer from ${this.minChoice} to ${this.maxChoice}.`);
    }
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    const commandId = `cmd-${randomUUID()}`;
    this.choices.set(actorId, number);
    this.choiceCommandIds.set(actorId, commandId);
    this.emitUpdate();
    return {
      action,
      commandId,
      detail: reason ? `${number}; ${reason}` : String(number),
      result: { accepted: true, number, waitingFor: [...this.profiles.keys()].filter((id) => !this.choices.has(id)) }
    };
  }

  activation(): WorldActivation | null {
    if (this.status !== "running" || this.round > this.totalRounds) return null;
    if (this.phase === "discussion") {
      const actors = this.discussion.nextWave();
      if (actors.length) {
        const wave = this.discussion.waveNumber;
        return {
          id: `bc:${this.round}:discussion:${wave}`,
          label: wave === 1 ? `第 ${this.round} 轮讨论` : `第 ${this.round} 轮讨论 · 回应 ${wave - 1}`,
          actorIds: actors,
          mode: "sequential",
          instructionFor: () => wave === 1
            ? "Discuss the likely group reasoning, test a theory, mislead, or stay quiet. Do not commit your number yet."
            : "Respond to the concrete theory, question, challenge or private message directed at you. Avoid repeating your opening view."
        };
      }
      this.phase = "choice";
      this.emitUpdate();
    }
    return {
      id: `bc:${this.round}:choice`,
      label: `第 ${this.round} 轮选择`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => `Call choose_number exactly once. Use your authorized actor models to reason about what others believe.`
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
        retryInstruction: `Your private number is still missing. Call choose_number now with an integer from ${this.minChoice} to ${this.maxChoice}.`
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

  protected redactDetails(details: Record<string, unknown>, actorId?: string): Record<string, unknown> {
    const next = super.redactDetails(details, actorId);
    // Keep private choices hidden until the round resolves.
    if (this.status !== "finished" && this.phase === "choice") delete next.pendingChoices;
    return next;
  }

  private resolveRound(): void {
    const ids = [...this.profiles.keys()];
    const choices = Object.fromEntries(ids.map((id) => [id, this.choices.get(id) ?? 0]));
    const average = ids.reduce((sum, id) => sum + (choices[id] ?? 0), 0) / ids.length;
    const target = average * this.targetRatio;
    const bestDistance = Math.min(...ids.map((id) => Math.abs((choices[id] ?? 0) - target)));
    const winnerIds = ids.filter((id) => Math.abs((choices[id] ?? 0) - target) === bestDistance);
    for (const id of winnerIds) this.scores.set(id, (this.scores.get(id) ?? 0) + 1);
    const text = `平均 ${average.toFixed(2)}，目标 ${target.toFixed(2)}，获胜：${winnerIds.map((id) => this.profiles.get(id)?.displayName ?? id).join("、")}`;
    const entry: BeautyRound = { round: this.round, choices, average, target, winnerIds, text };
    this.history.push(entry);
    const publicResult = this.recordPublicWorldFact({
      factKey: `beauty-contest-round:${this.round}`,
      eventType: "beauty-contest.round-resolved",
      predicate: "beauty-contest-round-result",
      object: { choices, average, target, winnerIds },
      payload: { round: this.round, choices, average, target, winnerIds }
    });
    // 主张对账: reconcile extracted number claims against the
    // actual sealed choice.
    for (const id of ids) {
      const actualNumber = choices[id];
      const characterId = this.requireProfile(id).characterId;
      for (const claim of this.extractedActionClaims(characterId)) {
        this.recordClaimedActionOutcome({
          propositionId: claim.propositionId,
          actualValue: String(actualNumber),
          matches: claim.object === `number-${actualNumber}`,
          sourceEventId: publicResult.eventId
        });
      }
    }
    for (const id of ids) {
      this.lastExperiences.set(
        id,
        `${text} Your choice was ${choices[id]}. ${winnerIds.includes(id) ? "You won this round." : "You did not win this round."} Your score is now ${this.scores.get(id)}.`
      );
    }
    this.addLog(`第 ${this.round} 轮结算：${text}`, this.round);
    for (const id of ids) {
      const commandId = this.choiceCommandIds.get(id);
      if (!commandId) continue;
      const ownChoice = choices[id] ?? 0;
      const distance = Math.abs(ownChoice - target);
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `Chose ${ownChoice}; average ${average.toFixed(2)}; target ${target.toFixed(2)}; distance ${distance.toFixed(2)}; won=${winnerIds.includes(id)}.`,
          metrics: { round: this.round, ownChoice, average, target, distance, won: winnerIds.includes(id) }
        },
        actualFacts: {
          "actor-wins": winnerIds.includes(id),
          "choice-below-average": ownChoice < average,
          "choice-within-five-of-target": distance <= 5,
          "target-below-thirty": target < 30
        },
        resultingEventIds: [publicResult.eventId],
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
      ...discussionPersonality(this.profiles, (id) => this.moodSignalFor(id)),
      maxWaves: 4
    });
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
