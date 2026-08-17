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
import { contextFromRunContext, scopedContext, SocialWorldBase } from "../world";
import { boundedRounds, emitAction } from "./helpers";

type Choice = "swerve" | "straight";
type Phase = "discussion" | "choice";

interface RoundResult {
  round: number;
  choices: Record<string, Choice>;
  payoffs: Record<string, number>;
  text: string;
}

/**
 * Chicken (hawk-dove) game. Both drivers choose simultaneously: swerving is
 * safe but loses face; driving straight wins big if the other blinks and
 * crashes the game if nobody does. Negotiation is pure bluff theater.
 */
export class ChickenGameWorld extends SocialWorldBase {
  private readonly totalRounds: number;
  private readonly scores = new Map<string, number>();
  private readonly choices = new Map<string, Choice>();
  private readonly history: RoundResult[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private round = 1;

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    this.totalRounds = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    for (const profile of profiles) this.scores.set(profile.id, 0);
    this.addLog("两辆车在一条直线上加速。每一轮都从谈判开始，然后同时打方向盘。", 1);
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
      availableActions: this.phase === "discussion" ? ["communicate", "remember_experience", "recall_memory", "reflect_on_social_situation"] : ["chicken_choice", "communicate"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const choose = tool({
      name: "chicken_choice",
      description: "Commit privately to swerve (safe, loses face) or drive straight (wins big if the other swerves, mutual crash if both go straight). Binding for this round.",
      parameters: z.object({
        choice: z.enum(["swerve", "straight"]),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async ({ choice, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "chicken_choice", { choice, reason });
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
    this.choices.set(actorId, choice);
    this.emitUpdate();
    return {
      action,
      detail: reason ? `${choice}; ${reason}` : choice,
      result: { accepted: true, choice, waitingFor: [...this.profiles.keys()].filter((id) => !this.choices.has(id)) }
    };
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    if (this.round > this.totalRounds) return null;
    if (this.phase === "discussion") {
      return {
        id: `ch:${this.round}:discussion`,
        label: `第 ${this.round} 轮对峙`,
        actorIds: [...this.profiles.keys()],
        mode: "sequential",
        instructionFor: () => "Speak once if you want to posture, threaten to drive straight, or signal a compromise. Do not use chicken_choice until the choice phase."
      };
    }
    return {
      id: `ch:${this.round}:choice`,
      label: `第 ${this.round} 轮抉择`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => "Review every threat and signal you heard. Call chicken_choice exactly once; your text cannot substitute for the tool call."
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
        retryInstruction: "Your private commitment is still missing. Call chicken_choice now; do not send another message first."
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
    const choiceLabel = (choice: Choice): string => (choice === "swerve" ? "闪避" : "硬冲");
    const text = payoffs[0] === 0 && payoffs[1] === 0
      ? `${this.profiles.get(ids[0])?.displayName}与${this.profiles.get(ids[1])?.displayName}都选择硬冲，正面相撞：0 / 0。`
      : `${this.profiles.get(ids[0])?.displayName}选择${choiceLabel(left)}；${this.profiles.get(ids[1])?.displayName}选择${choiceLabel(right)}。得分：${payoffs[0]} / ${payoffs[1]}。`;
    const result: RoundResult = { round: this.round, choices: { [ids[0]]: left, [ids[1]]: right }, payoffs: { [ids[0]]: payoffs[0], [ids[1]]: payoffs[1] }, text };
    this.history.push(result);
    for (const id of ids) this.lastExperiences.set(id, `${text} 你本轮选择了${choiceLabel(result.choices[id])}。你的累计得分：${this.scores.get(id)}。`);
    const beat = payoffs[0] === 0 && payoffs[1] === 0 ? "misplay" as const : payoffs[0] === 4 || payoffs[1] === 4 ? "win" as const : undefined;
    this.addLog(text, this.round, beat);
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

function payoff(left: Choice, right: Choice): [number, number] {
  if (left === "swerve" && right === "swerve") return [2, 2];
  if (left === "straight" && right === "straight") return [0, 0];
  return left === "straight" ? [4, 1] : [1, 4];
}