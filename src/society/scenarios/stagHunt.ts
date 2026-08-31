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
  private readonly commitments: Commitment[] = [];
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

  /**
   * Sidecar extraction hints: choice statements become `claimed-action`
   * propositions reconciled against the sealed choice at settlement.
   */
  extractionHints?(): string {
    return [
      "本局是猎鹿博弈。行动主张判定：",
      '- 当说话者断言自己将选择的行动时输出 claims 条目：aboutSelf=true、assertedAction（只能是 "stag"=猎鹿 或 "rabbit"=猎兔）、confidence。例：「我肯定去猎鹿」→{aboutSelf:true, assertedAction:"stag"}',
      '- 疑问、质询、要求对方先表态都不算主张。'
    ].join("\n");
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
        commitments: this.commitments,
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
      availableActions: this.phase === "discussion" ? ["final_response", "recall_memory", "reflect_on_social_situation"] : ["hunt_choice", "final_response"]
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    this.requireProfile(actorId);
    const choose = tool({
      name: "hunt_choice",
      description: "Commit privately to stag or rabbit. The typed choice is the binding action for this round and cannot be changed.",
      parameters: z.object({
        choice: z.enum(["stag", "rabbit"]),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "hunt_choice", {
          choice: input.choice,
          reason: input.reason
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    const tools: Tool<SocietyAgentContext>[] = [choose];
    const makeCommitment = tool({
      name: "make_commitment",
      description: "Propose a public typed promise about your next choice. It is recorded, but settles as kept or broken only if another participant explicitly accepts it.",
      parameters: z.object({
        choice: z.enum(["stag", "rabbit"]),
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
    tools.push(makeCommitment as Tool<SocietyAgentContext>);
    const acceptCommitment = tool({
      name: "accept_commitment",
      description: "Explicitly accept one proposed commitment addressed to you. Acceptance makes it eligible for deterministic settlement against the sealed choice.",
      parameters: z.object({ commitmentId: z.string().min(1).max(200) }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "accept_commitment", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    tools.push(acceptCommitment as Tool<SocietyAgentContext>);
    return tools;
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
    if (action === "make_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_NOT_OPEN: Commitments are proposed during the negotiation.");
      const value = recordPayload(payload);
      const choice = value.choice;
      if (!(choice === "stag" || choice === "rabbit")) throw new Error('COMMITMENT_CHOICE_INVALID: Promise one of "stag" 或 "rabbit".');
      const proposition = typeof value.proposition === "string" ? value.proposition.trim() : "";
      if (!proposition) throw new Error("COMMITMENT_PROPOSITION_REQUIRED: State the promise explicitly.");
      const ownCount = this.commitments.filter((entry) => entry.round === this.round && entry.promisorActorId === actorId).length;
      if (ownCount >= 2) throw new Error("COMMITMENT_LIMIT_EXCEEDED: At most two proposals per participant per round.");
      const commandId = `cmd-${randomUUID()}`;
      const commitment: Commitment = {
        commitmentId: `commit:sh:${this.round}:${actorId}:${ownCount + 1}`,
        round: this.round,
        promisorActorId: actorId,
        promisorCharacterId: this.requireProfile(actorId).characterId,
        audienceActorIds: [...this.profiles.keys()].filter((id) => id !== actorId),
        proposition,
        promisedAction: {
          actionType: "hunt-choice",
          choice,
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
          facts: { commitmentId: commitment.commitmentId, promisedChoice: choice },
          detail: `${actorId === id ? "你" : this.profiles.get(actorId)?.displayName ?? actorId} 提议承诺：${proposition}。`
        });
      }
      this.emitUpdate();
      return { action, commandId, detail: proposition, result: { accepted: true, commitmentId: commitment.commitmentId } };
    }
    if (action === "accept_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_ACCEPTANCE_NOT_OPEN: Accept commitments during the negotiation.");
      const value = recordPayload(payload);
      const commitmentId = typeof value.commitmentId === "string" ? value.commitmentId : "";
      const commitment = this.commitments.find((entry) => entry.commitmentId === commitmentId && entry.round === this.round);
      if (!commitment) throw new Error(`COMMITMENT_NOT_FOUND: '${commitmentId}'.`);
      if (commitment.promisorActorId === actorId || !commitment.audienceActorIds.includes(actorId)) {
        throw new Error("COMMITMENT_ACCEPTOR_INVALID: Only another participant may accept this proposal.");
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
      instructionFor: () => "Review authorized messages, beliefs and actor models. Call hunt_choice exactly once; text cannot substitute for the tool call."
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
    // 主张对账: reconcile extracted choice claims against the
    // actual sealed choice; settle accepted choice promises.
    for (const id of ids) {
      const actualChoice = choices[id];
      const characterId = this.requireProfile(id).characterId;
      for (const claim of this.extractedActionClaims(characterId)) {
        this.recordClaimedActionOutcome({
          propositionId: claim.propositionId,
          actualValue: actualChoice,
          matches: claim.object === actualChoice,
          sourceEventId: publicResult.eventId
        });
      }
    }
    let anyViolated = false;
    let anyFulfilled = false;
    for (const commitment of this.commitments.filter((entry) => entry.round === this.round && entry.state === "accepted" && entry.promisedAction.actionType === "hunt-choice")) {
      const actualChoice = choices[commitment.promisorActorId];
      if (actualChoice === undefined) continue;
      const promised = (commitment.promisedAction as { choice?: string }).choice;
      if (promised === undefined) continue;
      const fulfilled = promised === actualChoice;
      commitment.state = fulfilled ? "fulfilled" : "violated";
      commitment.settledAtTurn = this.round;
      commitment.settledByCommandId = this.choiceCommandIds.get(commitment.promisorActorId);
      this.settleSocialCommitment(commitment);
      if (fulfilled) anyFulfilled = true; else anyViolated = true;
      for (const id of ids) {
        this.pushEvent(id, {
          type: fulfilled ? "commitment-fulfilled" : "commitment-violated",
          actorId: commitment.promisorActorId,
          targetId: id,
          facts: { commitmentId: commitment.commitmentId, promisedChoice: promised, actualChoice },
          detail: fulfilled
            ? `承诺兑现：${commitment.promisorActorId} 承诺${promised}，实际也${actualChoice}。`
            : `承诺违约：${commitment.promisorActorId} 承诺${promised}，实际${actualChoice}。`
        });
      }
    }
    for (const commitment of this.commitments.filter((entry) => entry.round === this.round && entry.state === "proposed")) {
      commitment.state = "void";
      commitment.settledAtTurn = this.round;
      this.settleSocialCommitment(commitment);
    }
    if (anyViolated) {
      this.addLog(text, this.round, "promise-broken" as const);
    } else if (anyFulfilled) {
      this.addLog(text, this.round, "promise-kept" as const);
    }
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

  private openCommitmentsThisRound(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      entry.round === this.round &&
      (entry.state === "proposed" || entry.state === "accepted") &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
  }

  private settledCommitmentsFor(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      entry.round < this.round &&
      entry.state !== "proposed" && entry.state !== "accepted" &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
  }

  private createDiscussion(): DiscussionDirector {
    return new DiscussionDirector({
      actorIds: [...this.profiles.keys()],
      displayName: (id) => this.profiles.get(id)?.displayName ?? id,
      ...discussionPersonality(this.profiles, (id) => this.moodSignalFor(id))
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
