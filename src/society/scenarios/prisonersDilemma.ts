import { randomUUID } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  ScenarioSummary,
  SocietyAgentContext,
  WorldActivation,
  WorldSnapshot
} from "../contracts";
import { contextFromRunContext, SocialWorldBase } from "../world";
import { emitAction, boundedRounds } from "./helpers";

type Move = "cooperate" | "defect";
type Phase = "discussion" | "choice";

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
  private readonly history: RoundResult[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private round = 1;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.addStory("第一轮谈判开始", "双方可以先说服对方，也可以保留真实意图。", "neutral", 1);
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
        history: this.history
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const ownMove = this.choices.get(actorId);
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.round,
      phase: this.phase === "discussion" ? "negotiation" : "simultaneous choice",
      situation: this.phase === "discussion"
        ? "You have time to negotiate before both participants commit privately. Public promises are cheap talk until the choice tool is used."
        : "Both choices are hidden until both participants commit. The round resolves immediately after the second commitment.",
      privateContext: [
        `Your score: ${this.scores.get(actorId) ?? 0}.`,
        `Your current choice: ${ownMove ?? "not committed"}.`,
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
      availableActions: this.phase === "discussion" ? ["communicate", "remember_experience", "recall_memory", "reflect_on_social_situation"] : ["choose_move", "communicate"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const choose = tool({
      name: "choose_move",
      description: "Commit privately to cooperate or defect for the current Prisoner's Dilemma round. This is the real domain action and cannot be changed after commitment. Use only after negotiation.",
      parameters: z.object({
        move: z.enum(["cooperate", "defect"]),
        reason: z.string().min(1).max(500)
      }).strict(),
      execute: async ({ move, reason }, runContext) => {
        const context = contextFromRunContext(runContext);
        if (this.phase !== "choice") throw new Error("CHOICE_NOT_OPEN: Finish the negotiation phase before calling choose_move.");
        if (this.choices.has(actorId)) throw new Error("CHOICE_ALREADY_COMMITTED: Your move for this round is fixed.");
        this.choices.set(actorId, move);
        emitAction(context, "choose_move", `${move}; ${reason}`);
        this.emitUpdate();
        return { accepted: true, move, waitingFor: [...this.profiles.keys()].filter((id) => !this.choices.has(id)) };
      }
    });
    return [choose] as Tool<SocietyAgentContext>[];
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    if (this.round > this.totalRounds) return null;
    if (this.phase === "discussion") {
      return {
        id: `pd:${this.round}:discussion`,
        label: `第 ${this.round} 轮谈判`,
        actorIds: [...this.profiles.keys()],
        mode: "sequential",
        instructionFor: () => "Speak once if you want to negotiate, test a promise, or conceal your intended move. Do not use choose_move until the next phase."
      };
    }
    return {
      id: `pd:${this.round}:choice`,
      label: `第 ${this.round} 轮选择`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => "Review the current incentives and every promise you heard. Now you must call choose_move exactly once; your text cannot substitute for the tool call."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.endsWith(":discussion")) {
      this.phase = "choice";
      this.emitUpdate();
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
    const text = `${this.profiles.get(ids[0])?.displayName} chose ${left}; ${this.profiles.get(ids[1])?.displayName} chose ${right}. Points: ${payoffs[0]} / ${payoffs[1]}.`;
    const result: RoundResult = { round: this.round, moves: { [ids[0]]: left, [ids[1]]: right }, payoffs: { [ids[0]]: payoffs[0], [ids[1]]: payoffs[1] }, text };
    this.history.push(result);
    for (const id of ids) this.lastExperiences.set(id, `${text} Your move was ${result.moves[id]}. Your score is now ${this.scores.get(id)}.`);
    this.addStory(`第 ${this.round} 轮结算`, text, left === "defect" || right === "defect" ? "warning" : "positive", this.round);
    this.choices.clear();
    if (this.round >= this.totalRounds) {
      this.round = this.totalRounds + 1;
      this.finish();
      return;
    }
    this.round += 1;
    this.phase = "discussion";
    this.emitUpdate();
  }

  private summary(): string {
    const scores = [...this.scores].map(([id, score]) => `${this.profiles.get(id)?.displayName}: ${score}`).join(" · ");
    return `${this.round > this.totalRounds ? "已结束" : `第 ${this.round} / ${this.totalRounds} 轮`} · ${scores}`;
  }
}

function payoff(left: Move, right: Move): [number, number] {
  if (left === "cooperate" && right === "cooperate") return [3, 3];
  if (left === "defect" && right === "defect") return [1, 1];
  return left === "defect" ? [5, 0] : [0, 5];
}
