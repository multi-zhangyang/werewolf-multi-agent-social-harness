import { randomUUID } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  PlayerActionSpec,
  ScenarioSummary,
  SocietyAgentContext,
  WorldActionCommit,
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
    this.addLog("谈判开始：承诺没有约束力，行动会留下记忆。", 1);
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
        const commit = await this.performAction(actorId, "choose_move", { move, reason });
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
      name: "choose_move",
      label: "提交选择",
      description: "选择会保持隐藏，直到双方都提交。",
      kind: "choice",
      field: "move",
      options: [
        { value: "cooperate", label: "合作" },
        { value: "defect", label: "背叛" }
      ]
    }];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    this.requireProfile(actorId);
    if (action !== "choose_move") throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
    if (this.phase !== "choice") throw new Error("CHOICE_NOT_OPEN: Finish the negotiation phase before choosing.");
    if (this.choices.has(actorId)) throw new Error("CHOICE_ALREADY_COMMITTED: Your move for this round is fixed.");
    const value = recordPayload(payload);
    const move = value.move;
    if (move !== "cooperate" && move !== "defect") throw new Error("MOVE_INVALID: Choose cooperate or defect.");
    const reason = typeof value.reason === "string" ? value.reason.trim().slice(0, 500) : "";
    this.choices.set(actorId, move);
    this.emitUpdate();
    const detail = reason ? `${move}; ${reason}` : move;
    return {
      action,
      detail,
      result: { accepted: true, move, waitingFor: [...this.profiles.keys()].filter((id) => !this.choices.has(id)) }
    };
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
    this.addLog(text, this.round);
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
