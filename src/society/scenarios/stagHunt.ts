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

type Choice = "stag" | "rabbit";
type Phase = "discussion" | "choice";

interface RoundResult {
  round: number;
  choices: Record<string, Choice>;
  payoffs: Record<string, number>;
  text: string;
}

const STAG_HUNT_STATE_SCHEMA_VERSION = 3;
const STAG_HUNT_OUTCOME_KEYS = ["all-hunt-stag", "actor-payoff-at-least-three", "any-rabbit", "actor-chose-stag"] as const;

/**
 * Stag hunt. The shared hunt pays the most but fails completely unless both
 * hunters commit; hunting rabbits alone is always safe. Cooperation is
 * profitable only when both sides genuinely trust each other.
 */
export class StagHuntWorld extends SocialWorldBase {
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
    this.addLog(`鹿在林中。${profiles.length} 名猎人同时决定结伴猎鹿，还是各猎各的兔子。`, 1);
  }

  protected exportWorldState(): unknown {
    return {
      schemaVersion: STAG_HUNT_STATE_SCHEMA_VERSION,
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
    if (s.schemaVersion !== undefined && s.schemaVersion !== 1 && s.schemaVersion !== 2 && s.schemaVersion !== STAG_HUNT_STATE_SCHEMA_VERSION) {
      throw new Error(`SCENARIO_STATE_SCHEMA_UNSUPPORTED: stag-hunt ${s.schemaVersion}`);
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
      phase: this.phase === "discussion" ? "结伴谈判" : "同时出发",
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
        ? "All hunters can talk before committing. A promise to hunt the stag is cheap until the choice tool is used."
        : "Choices stay hidden until every hunter commits. The round resolves the moment the last commitment lands.",
      privateContext: [
        `Your score: ${this.scores.get(actorId) ?? 0}.`,
        `Your current choice: ${own ?? "not committed"}.`,
        `Payoffs: all stag = 4 each; if anyone hunts rabbits, every stag hunter gets 0 and every rabbit hunter gets 3.`,
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
      availableActions: this.phase === "discussion" ? ["communicate", "recall_memory", "reflect_on_social_situation"] : ["hunt_choice", "communicate"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const choose = tool({
      name: "hunt_choice",
      description: "Compare bounded hunt intents and predict the public result, then commit privately to stag or rabbit. Binding for this round.",
      parameters: z.object({
        choice: z.enum(["stag", "rabbit"]),
        reason: z.string().min(1).max(2_000),
        ...createStrategyActionShape({ choice: z.enum(["stag", "rabbit"]) }, STAG_HUNT_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || selected.choice !== input.choice) throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: Selected hunt choice must equal the binding choice.");
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "hunt_choice", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({ ...candidate, action: "hunt_choice", payloadSummary: `choice=${candidate.choice}` }))
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
      name: "hunt_choice",
      label: "提交选择",
      description: "选择会保持隐藏，直到所有猎人都提交。",
      kind: "choice",
      field: "choice",
      options: [
        { value: "stag", label: "猎鹿" },
        { value: "rabbit", label: "猎兔" }
      ]
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    if (action !== "hunt_choice") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.phase !== "choice") throw new Error("CHOICE_NOT_OPEN: Finish the negotiation phase before choosing.");
    if (this.choices.has(actorId)) throw new Error("CHOICE_ALREADY_COMMITTED: Your choice for this round is fixed.");
    const value = recordPayload(payload);
    const choice = value.choice;
    if (choice !== "stag" && choice !== "rabbit") throw new Error("CHOICE_INVALID: Choose stag or rabbit.");
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
          id: `sh:${this.round}:discussion:${wave}`,
          label: wave === 1 ? `第 ${this.round} 轮结伴谈判` : `第 ${this.round} 轮结伴谈判 · 回应 ${wave - 1}`,
          actorIds: actors,
          mode: "sequential",
          instructionFor: () => wave === 1
            ? "Signal whether you want the shared hunt, probe reliability, or hedge toward rabbits. Do not use hunt_choice yet."
            : "Respond to the concrete promise, question, warning or private message directed at you. Do not repeat your opening statement."
        };
      }
      this.phase = "choice";
      this.emitUpdate();
    }
    return {
      id: `sh:${this.round}:choice`,
      label: `第 ${this.round} 轮出发`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => "Review authorized messages, beliefs and actor models. Call hunt_choice exactly once with bounded candidates and public-result predictions; text cannot substitute for the tool call."
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
        retryInstruction: "Your private commitment is still missing. Call hunt_choice now; do not send another message first."
      };
    }
    this.resolveRound();
    return { completed: true, missingActorIds: [] };
  }

  experienceFor(actorId: string): string | undefined {
    return this.lastExperiences.get(actorId);
  }

  reconciliationOwnsOutcomeMemory(): boolean {
    return true;
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
    const choices: Record<string, Choice> = {};
    const payoffs: Record<string, number> = {};
    const allStag = ids.every((id) => this.choices.get(id) === "stag");
    for (const id of ids) {
      const choice = this.choices.get(id)!;
      choices[id] = choice;
      payoffs[id] = allStag ? 4 : choice === "stag" ? 0 : 3;
      this.scores.set(id, (this.scores.get(id) ?? 0) + payoffs[id]);
    }
    const stagHunters = ids.filter((id) => choices[id] === "stag");
    const names = (list: string[]) => list.map((id) => this.profiles.get(id)?.displayName ?? id).join("、");
    const text = allStag
      ? `${names(ids)} 一起猎到了鹿。每人 4 分。`
      : stagHunters.length
        ? `${names(stagHunters)} 扑向鹿群却一无所获（0 分），其余人猎兔各得 3 分。`
        : `所有人都去猎兔，各得 3 分。`;
    const result: RoundResult = { round: this.round, choices, payoffs, text };
    this.history.push(result);
    const publicResult = this.recordPublicWorldFact({
      factKey: `stag-hunt-round:${this.round}`,
      eventType: "stag-hunt.round-resolved",
      predicate: "stag-hunt-round-result",
      object: { choices, payoffs, allStag },
      payload: { round: this.round, choices, payoffs, allStag }
    });
    for (const id of ids) this.lastExperiences.set(id, `${text} 你的选择是 ${choices[id] === "stag" ? "猎鹿" : "猎兔"}。你当前得分 ${this.scores.get(id)}。`);
    const beat = allStag
      ? "cooperative-outcome" as const
      : stagHunters.length > 0 && stagHunters.length < ids.length
        ? "unilateral-defection" as const
        : undefined;
    this.addLog(text, this.round, beat);
    for (const id of ids) {
      const commandId = this.choiceCommandIds.get(id);
      if (!commandId) continue;
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `Chose ${choices[id]}; payoff ${payoffs[id]}; all-stag=${allStag}.`,
          metrics: { round: this.round, ownChoice: choices[id], ownPayoff: payoffs[id], allStag }
        },
        actualFacts: {
          "all-hunt-stag": allStag,
          "actor-payoff-at-least-three": payoffs[id] >= 3,
          "any-rabbit": ids.some((actorId) => choices[actorId] === "rabbit"),
          "actor-chose-stag": choices[id] === "stag"
        },
        resultingEventIds: [publicResult.eventId],
        memoryWriteSuggestions: [{
          summary: `In stag-hunt round ${this.round}, I chose ${choices[id]}; choices were ${Object.entries(choices).map(([actorId, choice]) => `${actorId}=${choice}`).join(", ")}; payoff ${payoffs[id]}.`,
          importance: allStag || payoffs[id] === 0 ? 0.8 : 0.64,
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

