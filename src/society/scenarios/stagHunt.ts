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
import { scopedContext, SocialWorldBase } from "../world";
import { boundedRounds, emitAction } from "./helpers";

type Choice = "stag" | "rabbit";
type Phase = "discussion" | "choice";

interface RoundResult {
  round: number;
  choices: Record<string, Choice>;
  payoffs: Record<string, number>;
  text: string;
}

/**
 * Stag hunt. The shared hunt pays the most but fails completely unless both
 * hunters commit; hunting rabbits alone is always safe. Cooperation is
 * profitable only when both sides genuinely trust each other.
 */
export class StagHuntWorld extends SocialWorldBase {
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
    this.addLog(`鹿在林中。${profiles.length} 名猎人同时决定结伴猎鹿，还是各猎各的兔子。`, 1);
  }

  protected exportWorldState(): unknown {
    return {
      round: this.round,
      phase: this.phase,
      scores: this.mapEntries(this.scores),
      choices: this.mapEntries(this.choices),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences)
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      round: number; phase: string; scores: Array<[string, number]>; choices: Array<[string, Choice]>;
      history: RoundResult[]; lastExperiences: Array<[string, string]>;
    }> | undefined;
    if (!s) return;
    this.round = Number(s.round ?? 1);
    this.phase = (s.phase ?? "discussion") as Phase;
    this.fillMap(this.scores, s.scores);
    this.fillMap(this.choices, s.choices);
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
      availableActions: this.phase === "discussion" ? ["communicate", "remember_experience", "recall_memory", "reflect_on_social_situation"] : ["hunt_choice", "communicate"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const choose = tool({
      name: "hunt_choice",
      description: "Commit privately to hunt the stag (4 points each only if every hunter commits; 0 for stag hunters otherwise) or hunt rabbits (3 points, always safe). Binding for this round.",
      parameters: z.object({
        choice: z.enum(["stag", "rabbit"]),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async ({ choice, reason }, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "hunt_choice", { choice, reason });
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
        id: `sh:${this.round}:discussion`,
        label: `第 ${this.round} 轮结伴谈判`,
        actorIds: [...this.profiles.keys()],
        mode: "sequential",
        instructionFor: () => "Speak once if you want to commit to the shared hunt, probe the other hunter's reliability, or hedge toward rabbits. Do not use hunt_choice until the choice phase."
      };
    }
    return {
      id: `sh:${this.round}:choice`,
      label: `第 ${this.round} 轮出发`,
      actorIds: [...this.profiles.keys()],
      mode: "parallel",
      instructionFor: () => "Review every promise you heard. Call hunt_choice exactly once; your text cannot substitute for the tool call."
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
        retryInstruction: "Your private commitment is still missing. Call hunt_choice now; do not send another message first."
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
    for (const id of ids) this.lastExperiences.set(id, `${text} 你的选择是 ${choices[id] === "stag" ? "猎鹿" : "猎兔"}。你当前得分 ${this.scores.get(id)}。`);
    const beat = allStag
      ? "promise-kept" as const
      : stagHunters.length > 0 && stagHunters.length < ids.length
        ? "betrayal" as const
        : undefined;
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

