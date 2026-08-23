import { randomInt, randomUUID } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  Commitment,
  PlayerActionSpec,
  ScenarioSummary,
  SocialChannel,
  SocialMessage,
  SocietyAgentContext,
  WorldActionCommit,
  WorldActivation,
  WorldSnapshot
} from "../contracts";
import { scopedContext, SocialWorldBase } from "../world";
import { conversationSignalsFromSocialActs, DiscussionDirector } from "../conversation";
import { SuspicionClimate } from "../suspicion";
import { boundedRounds, discussionPersonality, emitAction } from "./helpers";
import { createStrategyActionShape, socialReferenceContext } from "../social/strategy-input";
import type { SocialActDeclaration } from "../social/contracts";

type Role = "merlin" | "percival" | "servant" | "morgana" | "assassin" | "mordred" | "oberon" | "minion";

function isEvilRole(role: Role | undefined): boolean {
  return role === "morgana" || role === "assassin" || role === "mordred" || role === "oberon" || role === "minion";
}

function isLoyalRole(role: Role | undefined): boolean {
  return role === "merlin" || role === "percival" || role === "servant";
}

/**
 * Agents of evil who know each other at setup (official rule): Morgana, the
 * Assassin, Mordred and minions see one another. Oberon is excluded — his
 * loyalty is invisible to the other agents of evil, and theirs to him.
 */
function knowsEvilAllies(role: Role | undefined): boolean {
  return role === "morgana" || role === "assassin" || role === "mordred" || role === "minion";
}

/** Roles Merlin sees as evil at setup: every agent of evil except Mordred and Oberon. */
function merlinSees(role: Role | undefined): boolean {
  return role === "morgana" || role === "assassin" || role === "minion";
}

/**
 * Lady of the Lake verdict: the Lady reads loyalty, not exact identity.
 * Oberon is evil at the table yet unknown even to his allies, so the Lady
 * reads him as good (official rule).
 */
export function ladyVerdictFor(role: Role | undefined): "loyal" | "evil" {
  if (role === undefined) return "loyal";
  return role === "oberon" ? "loyal" : isEvilRole(role) ? "evil" : "loyal";
}

/**
 * Official quest team sizes by player count (The Resistance: Avalon
 * rulebook): the 5th entry is used for any quest beyond the table.
 */
export const QUEST_TEAM_SIZES: Record<number, number[]> = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5]
};

/**
 * Official good/evil split decks with the special-character setups (Merlin
 * and the Assassin are always present; Percival + Morgana from 5-6, Oberon
 * at 7, Mordred at 8-9, the full house at 10 — the published recommended
 * role sets for each count).
 */
export function deckForPlayerCount(count: number): Role[] {
  const decks: Record<number, Role[]> = {
    5: ["merlin", "percival", "servant", "morgana", "assassin"],
    6: ["merlin", "percival", "servant", "servant", "morgana", "assassin"],
    7: ["merlin", "percival", "servant", "servant", "morgana", "assassin", "oberon"],
    8: ["merlin", "percival", "servant", "servant", "servant", "morgana", "assassin", "mordred"],
    9: ["merlin", "percival", "servant", "servant", "servant", "servant", "morgana", "assassin", "mordred"],
    10: ["merlin", "percival", "servant", "servant", "servant", "servant", "morgana", "assassin", "mordred", "oberon"]
  };
  const deck = decks[count];
  if (!deck) throw new Error(`PLAYER_COUNT_INVALID: Avalon supports 5-10 seats, got ${count}.`);
  return deck;
}

/** Official rule: the fourth quest needs two fail cards at 7+ players. */
export function questFailsNeeded(playerCount: number, quest: number): number {
  return quest === 4 && playerCount >= 7 ? 2 : 1;
}
type Phase = "discussion" | "proposal" | "vote" | "quest" | "lady" | "assassination";

interface QuestRecord {
  quest: number;
  leaderId: string;
  team: string[];
  teamVotes: Record<string, boolean>;
  outcome: "success" | "fail";
  failCount: number;
  text: string;
}

interface LadyReveal {
  targetId: string;
  quest: number;
  verdict: "loyal" | "evil";
}

const MAX_REJECTIONS = 5; // five consecutive rejections hand evil the win
const AVALON_PROPOSAL_OUTCOME_KEYS = ["team-approved"] as const;
const AVALON_TEAM_VOTE_OUTCOME_KEYS = ["team-approved", "vote-matched-majority"] as const;
const AVALON_QUEST_OUTCOME_KEYS = ["quest-succeeds", "quest-fails", "quest-has-fail-card"] as const;
const AVALON_LADY_OUTCOME_KEYS = ["investigation-completed", "target-verdict-evil"] as const;
const AVALON_ASSASSINATION_OUTCOME_KEYS = ["target-is-merlin", "evil-wins"] as const;

/**
 * Avalon (The Resistance), official 5-10 player tables: the good/evil split
 * and quest team sizes follow the rulebook (5P: 3v2, 6P: 4v2, 7P: 4v3,
 * 8P: 5v3, 9P: 6v3, 10P: 6v4). Merlin always sees the evil team except
 * Mordred; the Assassin is always present. The fourth quest needs two fail
 * cards at 7+ players, and five consecutive rejected teams hand evil the
 * win. Leaders propose teams, the table votes publicly, then team members
 * secretly choose success or failure. Three successes trigger the final
 * assassination: one shot at Merlin's identity.
 */
export class AvalonWorld extends SocialWorldBase {
  private readonly totalQuests: number;
  private readonly teamSizes: number[];
  private readonly roles = new Map<string, Role>();
  private readonly questHistory: QuestRecord[] = [];
  private readonly commitments: Commitment[] = [];
  private readonly teamVotes = new Map<string, boolean>();
  private readonly teamVoteCommandIds = new Map<string, string>();
  private readonly questVotes = new Map<string, "succeed" | "fail">();
  private readonly questVoteCommandIds = new Map<string, string>();
  private readonly approvedTeamVotes = new Map<string, boolean>();
  private readonly lastExperiences = new Map<string, string>();
  private phase: Phase = "discussion";
  private discussion: DiscussionDirector | null = null;
  private readonly suspicion = new SuspicionClimate();
  private quest = 1;
  private leaderId: string;
  private proposedTeam: string[] = [];
  private rejections = 0;
  private successes = 0;
  private failures = 0;
  private winners: string[] = [];
  private outcome = "";
  private assassinated = false;
  private assassinationTargetId?: string;
  private assassinationCommandId?: string;
  private proposalCommandId?: string;
  /** Lady of the Lake (§7.5): the token holder privately inspects allegiance;
   *  the token then passes to the inspected player. */
  private ladyHolderId: string;
  private ladyInspectId?: string;
  private ladyInspectCommandId?: string;
  private readonly ladyReveals = new Map<string, LadyReveal[]>();
  private readonly ladyHolderHistory = new Set<string>();

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    this.totalQuests = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    this.teamSizes = QUEST_TEAM_SIZES[profiles.length] ?? QUEST_TEAM_SIZES[5] ?? [2, 3, 2, 3, 3];
    const ids = shuffle(profiles.map((profile) => profile.id));
    const deck = deckForPlayerCount(profiles.length);
    ids.forEach((id, index) => this.roles.set(id, deck[index]));
    this.registerFactionKnowledge();
    this.leaderId = profiles[0].id;
    // Official setup: the Lady starts with the player to the right of the
    // first leader (the previous seat in our rotation order).
    this.ladyHolderId = profiles.at(-1)?.id ?? profiles[0].id;
    this.ladyHolderHistory.add(this.ladyHolderId);
    this.discussion = this.createDiscussion();
    this.addLog("圆桌就座。忠臣要完成任务，内奸要暗中破坏；梅林看得见内奸，却看不见莫德雷德与奥伯伦，派西维尔眼中梅林与莫甘娜真假难辨。湖中仙女令牌从首位队长的右手边开始流转。", 1);
  }

  protected exportWorldState(): unknown {
    return {
      schemaVersion: 3,
      quest: this.quest,
      phase: this.phase,
      leaderId: this.leaderId,
      proposedTeam: [...this.proposedTeam],
      rejections: this.rejections,
      successes: this.successes,
      failures: this.failures,
      winners: [...this.winners],
      outcome: this.outcome,
      assassinated: this.assassinated,
      assassinationTargetId: this.assassinationTargetId ?? null,
      assassinationCommandId: this.assassinationCommandId ?? null,
      ladyHolderId: this.ladyHolderId,
      ladyInspectId: this.ladyInspectId ?? null,
      ladyInspectCommandId: this.ladyInspectCommandId ?? null,
      ladyHolderHistory: [...this.ladyHolderHistory],
      ladyReveals: [...this.ladyReveals.entries()].map(([observerId, reveals]) => [observerId, structuredClone(reveals)] as [string, LadyReveal[]]),
      roles: this.mapEntries(this.roles),
      questHistory: structuredClone(this.questHistory),
      commitments: structuredClone(this.commitments),
      teamVotes: this.mapEntries(this.teamVotes),
      teamVoteCommandIds: this.mapEntries(this.teamVoteCommandIds),
      questVotes: this.mapEntries(this.questVotes),
      questVoteCommandIds: this.mapEntries(this.questVoteCommandIds),
      approvedTeamVotes: this.mapEntries(this.approvedTeamVotes),
      proposalCommandId: this.proposalCommandId ?? null,
      lastExperiences: this.mapEntries(this.lastExperiences),
      discussion: this.discussion ? this.discussion.exportState() : null,
      suspicion: this.suspicion.exportState()
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      schemaVersion: number;
      quest: number; phase: string; leaderId: string; proposedTeam: string[]; rejections: number;
      successes: number; failures: number; winners: string[]; outcome: string; assassinated: boolean;
      assassinationTargetId: string | null; assassinationCommandId: string | null;
      ladyHolderId: string; ladyInspectId: string | null; ladyInspectCommandId: string | null;
      ladyHolderHistory: string[];
      ladyReveals: Array<[string, LadyReveal[]]>;
      roles: Array<[string, Role]>; questHistory: QuestRecord[]; commitments: Commitment[];
      teamVotes: Array<[string, boolean]>;
      teamVoteCommandIds: Array<[string, string]>; questVotes: Array<[string, "succeed" | "fail"]>;
      questVoteCommandIds: Array<[string, string]>; approvedTeamVotes: Array<[string, boolean]>;
      proposalCommandId: string | null; lastExperiences: Array<[string, string]>;
      discussion: unknown; suspicion: unknown;
    }> | undefined;
    if (!s) return;
    if (s.schemaVersion !== undefined && s.schemaVersion !== 2 && s.schemaVersion !== 3) {
      throw new Error(`AVALON_STATE_SCHEMA_UNSUPPORTED: ${s.schemaVersion}`);
    }
    this.quest = Number(s.quest ?? 1);
    this.phase = (s.phase ?? "discussion") as Phase;
    this.leaderId = String(s.leaderId ?? this.profiles.keys().next().value ?? "");
    this.proposedTeam = [...(s.proposedTeam ?? [])];
    this.rejections = Number(s.rejections ?? 0);
    this.successes = Number(s.successes ?? 0);
    this.failures = Number(s.failures ?? 0);
    this.winners = [...(s.winners ?? [])];
    this.outcome = String(s.outcome ?? "");
    this.assassinated = Boolean(s.assassinated);
    this.assassinationTargetId = s.assassinationTargetId ?? undefined;
    this.assassinationCommandId = s.assassinationCommandId ?? undefined;
    this.ladyHolderId = String(s.ladyHolderId ?? this.profiles.keys().next().value ?? "");
    this.ladyInspectId = s.ladyInspectId ?? undefined;
    this.ladyInspectCommandId = s.ladyInspectCommandId ?? undefined;
    this.ladyReveals.clear();
    this.ladyHolderHistory.clear();
    // Legacy checkpoints did not store the observer and cannot be safely
    // attributed. Do not guess: only schema v2 entries are restored.
    if (s.schemaVersion === 2 || s.schemaVersion === 3) {
      for (const [observerId, reveals] of s.ladyReveals ?? []) {
        if (!this.profiles.has(observerId) || !Array.isArray(reveals)) continue;
        const safe = reveals.filter((entry) =>
          entry && this.profiles.has(entry.targetId) && (entry.verdict === "loyal" || entry.verdict === "evil")
        ).map((entry) => ({ targetId: entry.targetId, quest: Number(entry.quest), verdict: entry.verdict }));
        if (safe.length) this.ladyReveals.set(observerId, safe);
      }
    }
    for (const holderId of s.ladyHolderHistory ?? []) {
      if (this.profiles.has(holderId)) this.ladyHolderHistory.add(holderId);
    }
    this.ladyHolderHistory.add(this.ladyHolderId);
    for (const [observerId, reveals] of this.ladyReveals) {
      this.ladyHolderHistory.add(observerId);
      for (const reveal of reveals) this.ladyHolderHistory.add(reveal.targetId);
    }
    this.fillMap(this.roles, s.roles);
    this.registerFactionKnowledge();
    this.questHistory.length = 0;
    this.questHistory.push(...structuredClone(s.questHistory ?? []));
    this.commitments.length = 0;
    this.commitments.push(...structuredClone((s.commitments ?? []).map(normalizeCommitment)));
    this.fillMap(this.teamVotes, s.teamVotes);
    this.fillMap(this.teamVoteCommandIds, s.teamVoteCommandIds);
    this.fillMap(this.questVotes, s.questVotes);
    this.fillMap(this.questVoteCommandIds, s.questVoteCommandIds);
    this.fillMap(this.approvedTeamVotes, s.approvedTeamVotes);
    this.proposalCommandId = s.proposalCommandId ?? undefined;
    this.fillMap(this.lastExperiences, s.lastExperiences);
    if (s.discussion) {
      this.discussion = this.createDiscussion();
      this.discussion.restoreState(s.discussion);
    } else {
      // Mirror the live lifecycle: the director is nulled when the waves run
      // out (activation()) and recreated at the next quest's discussion.
      this.discussion = null;
    }
    this.suspicion.restoreState(s.suspicion);
  }

  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.quest,
      totalTurns: this.totalQuests,
      phase: phaseLabel(this.phase),
      summary: this.summary(),
      details: {
        roles: Object.fromEntries(this.roles),
        leaderId: this.leaderId,
        proposedTeam: this.proposedTeam,
        pendingTeamVotes: Object.fromEntries(this.teamVotes),
        pendingQuestVotes: Object.fromEntries(this.questVotes),
        ladyHolderId: this.ladyHolderId,
        ladyInspectId: this.ladyInspectId ?? null,
        rejections: this.rejections,
        successes: this.successes,
        failures: this.failures,
        history: this.questHistory,
        commitments: this.commitments,
        winners: this.winners,
        outcome: this.outcome,
        ...(this.discussion ? { discussion: this.discussion.state() } : {}),
        suspicion: this.suspicion.snapshot()
      }
    });
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const role = this.roles.get(actorId)!;
    const evilAllies = knowsEvilAllies(role)
      ? [...this.roles].filter(([id, candidate]) => id !== actorId && knowsEvilAllies(candidate)).map(([id]) => id)
      : [];
    const knownEvil = role === "merlin"
      ? [...this.roles].filter(([, candidate]) => merlinSees(candidate)).map(([id]) => id)
      : evilAllies;
    const merlinSeat = [...this.roles].find(([, candidate]) => candidate === "merlin")?.[0];
    const morganaSeat = [...this.roles].find(([, candidate]) => candidate === "morgana")?.[0];
    const percivalSights = role === "percival" ? [merlinSeat, morganaSeat].filter((id): id is string => Boolean(id)) : [];
    const causality = this.socialCausalityFor(actorId);
    const openCommitments = this.openCommitmentsThisQuest(actorId);
    const privateLadyReveals = this.ladyReveals.get(actorId) ?? [];
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.quest,
      phase: this.phase,
      situation: `${situationFor(this.phase, this.quest, this.totalQuests, this.successes, this.failures)}\nPublic suspicion climate: ${this.suspicion.climateText((id) => this.profiles.get(id)?.displayName ?? id)}`,
      privateContext: [
        `你的隐藏身份：${roleLabel(role)}（${role}）。`,
        `你的目标：${roleObjective(role)}。`,
        knownEvil.length ? `你已知的内奸：${knownEvil.map((id) => this.profiles.get(id)?.displayName ?? id).join("、")}。` : "",
        role === "merlin" ? "莫德雷德与奥伯伦连你也看不见。" : "",
        role === "mordred" ? "梅林看不见你——保持隐身。" : "",
        role === "oberon" ? "其他内奸不认识你，你也不认识他们。" : "",
        role === "percival" && percivalSights.length === 2
          ? `你看见两个人自称梅林：${percivalSights.map((id) => this.profiles.get(id)?.displayName ?? id).join(" 与 ")}。一个是梅林，一个是莫甘娜——你分不清谁是谁。`
          : role === "percival" && percivalSights.length === 1
            ? `你知道梅林：${this.profiles.get(percivalSights[0])?.displayName ?? percivalSights[0]}。`
            : "",
        this.ladyHolderId === actorId ? "你持有湖中仙女令牌：每次任务后可以查验一名玩家的阵营。" : `湖中仙女令牌在 ${this.profiles.get(this.ladyHolderId)?.displayName ?? this.ladyHolderId} 手中。`,
        privateLadyReveals.length
          ? `你的湖中仙女查验记录：${privateLadyReveals.map((reveal) => `${this.profiles.get(reveal.targetId)?.displayName ?? reveal.targetId} 是${reveal.verdict === "loyal" ? "忠诚" : "邪恶"}阵营（第 ${reveal.quest} 次任务后）`).join("；")}。`
          : "",
        this.phase === "proposal" ? `当前队长：${this.profiles.get(this.leaderId)?.displayName ?? this.leaderId}。候选队伍：${this.proposedTeam.length ? this.proposedTeam.map((id) => this.profiles.get(id)?.displayName ?? id).join("、") : "尚未提名"}。` : "",
        `你的队伍表决：${this.teamVotes.has(actorId) ? String(this.teamVotes.get(actorId)) : "未投"}。`,
        `你的任务表决：${this.questVotes.get(actorId) ?? "未投"}。`,
        `任务历史：${this.questHistory.map((record) => `第 ${record.quest} 次任务 队伍=[${record.team.join(",")}] ${record.outcome === "success" ? "成功" : "失败"}（黑票 ${record.failCount}）`).join("；") || "暂无"}。`,
        openCommitments.length
          ? `未结算承诺：\n${openCommitments.map((commitment) => `- [${commitment.commitmentId}] ${commitment.proposition} (${commitment.state})`).join("\n")}`
          : "未结算承诺：无。",
        `已结算承诺：${this.settledCommitmentsFor(actorId).map((commitment) => `[${commitment.commitmentId}] ${commitment.proposition} (${commitment.state})`).join("; ") || "无"}。`,
        ...socialReferenceContext(causality)
      ].filter(Boolean).join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: true, role },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: true,
        status: this.statuses.get(profile.id) ?? "idle"
      })),
      recentMessages: this.visibleMessages(actorId).slice(-40),
      availableActions: this.availableActions(actorId, role)
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    const tools: Tool<SocietyAgentContext>[] = [];
    const makeCommitment = tool({
      name: "make_commitment",
      description: "Propose a public typed promise: approve/reject the current quest's team vote, or succeed/fail your own quest vote. It is recorded, but settles as kept or broken only if another participant explicitly accepts it. Loyal participants cannot promise to fail a quest.",
      parameters: z.object({
        commitmentType: z.enum(["team-vote", "quest-outcome"]),
        choice: z.enum(["approve", "reject", "succeed", "fail"]),
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
      description: "Explicitly accept one proposed commitment addressed to you. Acceptance makes it eligible for deterministic settlement against the sealed vote.",
      parameters: z.object({ commitmentId: z.string().min(1).max(200) }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "accept_commitment", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    tools.push(acceptCommitment as Tool<SocietyAgentContext>);
    const propose = tool({
      name: "propose_team",
      description: `Compare bounded team intents, predict whether the table will approve them, then nominate exactly ${this.teamSize(this.quest)} members including yourself. The team is announced publicly before the vote.`,
      parameters: z.object({
        memberIds: z.array(z.string().min(1)).min(2).max(6),
        reason: z.string().min(1).max(2_000),
        ...createStrategyActionShape({ memberIds: z.array(z.string().min(1)).min(2).max(6) }, AVALON_PROPOSAL_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || !sameMembers(selected.memberIds, input.memberIds)) {
          throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: The selected team must equal the binding proposal.");
        }
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "propose_team", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({
            ...candidate,
            action: "propose_team",
            payloadSummary: `memberIds=${candidate.memberIds.join(",")}`
          }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    tools.push(propose as Tool<SocietyAgentContext>);
    const vote = tool({
      name: "cast_team_vote",
      description: "Compare bounded vote intents, predict the public team result, then approve or reject. Votes stay hidden until every participant commits and are revealed together. Cite only authorized social references.",
      parameters: z.object({
        accept: z.boolean(),
        reason: z.string().min(1).max(2_000),
        ...createStrategyActionShape({ accept: z.boolean() }, AVALON_TEAM_VOTE_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || selected.accept !== input.accept) {
          throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: The selected team vote must equal the binding vote.");
        }
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "cast_team_vote", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({
            ...candidate,
            action: "cast_team_vote",
            payloadSummary: `accept=${candidate.accept}`
          }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    tools.push(vote as Tool<SocietyAgentContext>);
    const questChoice = tool({
      name: "cast_quest_vote",
      description: "As a quest member, compare bounded intents, predict only public quest outcomes, then secretly choose succeed or fail. Loyal participants can only succeed. Cite only authorized social references.",
      parameters: z.object({
        choice: z.enum(["succeed", "fail"]),
        reason: z.string().min(1).max(2_000),
        ...createStrategyActionShape({ choice: z.enum(["succeed", "fail"]) }, AVALON_QUEST_OUTCOME_KEYS)
      }).strict(),
      execute: async (input, runContext) => {
        const selected = input.candidateIntents[input.selectedIntentIndex];
        if (!selected || selected.choice !== input.choice) {
          throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: The selected quest choice must equal the binding choice.");
        }
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "cast_quest_vote", {
          ...input,
          candidateIntents: input.candidateIntents.map((candidate) => ({
            ...candidate,
            action: "cast_quest_vote",
            payloadSummary: `choice=${candidate.choice}`
          }))
        });
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    tools.push(questChoice as Tool<SocietyAgentContext>);
    if (this.ladyHolderId === actorId) {
      const inspect = tool({
        name: "inspect_with_lady",
        description: "Compare bounded inspection intents, then privately inspect one eligible player who has never held the Lady token. The token passes to the inspected player. You may decline; silence is a legitimate choice.",
        parameters: z.object({
          targetId: z.string().min(1),
          reason: z.string().min(1).max(2_000),
          ...createStrategyActionShape({ targetId: z.string().min(1).max(160) }, AVALON_LADY_OUTCOME_KEYS)
        }).strict(),
        execute: async (input, runContext) => {
          const selected = input.candidateIntents[input.selectedIntentIndex];
          if (!selected || selected.targetId !== input.targetId) {
            throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: The selected inspection target must equal the binding target.");
          }
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "inspect_with_lady", {
            ...input,
            candidateIntents: input.candidateIntents.map((candidate) => ({
              ...candidate,
              action: "inspect_with_lady",
              payloadSummary: `targetId=${candidate.targetId}`
            }))
          });
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(inspect as Tool<SocietyAgentContext>);
    }
    if (role === "assassin") {
      const assassinate = tool({
        name: "assassinate_merlin",
        description: "Compare bounded final targets and their risks, then name the player you believe is Merlin. A correct kill wins the game for evil; a miss hands victory to the loyal side.",
        parameters: z.object({
          targetId: z.string().min(1),
          reason: z.string().min(1).max(2_000),
          ...createStrategyActionShape({ targetId: z.string().min(1).max(160) }, AVALON_ASSASSINATION_OUTCOME_KEYS)
        }).strict(),
        execute: async (input, runContext) => {
          const selected = input.candidateIntents[input.selectedIntentIndex];
          if (!selected || selected.targetId !== input.targetId) {
            throw new Error("STRATEGY_SELECTION_ACTION_MISMATCH: The selected assassination target must equal the binding target.");
          }
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "assassinate_merlin", {
            ...input,
            candidateIntents: input.candidateIntents.map((candidate) => ({
              ...candidate,
              action: "assassinate_merlin",
              payloadSummary: `targetId=${candidate.targetId}`
            }))
          });
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(assassinate as Tool<SocietyAgentContext>);
    }
    return tools;
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    if (this.phase === "proposal" && this.leaderId === actorId && !this.proposedTeam.length) {
      return [{
        name: "propose_team",
        label: "提出队伍",
        description: `选择 ${this.teamSize(this.quest)} 名成员（必须包含自己）。`,
        kind: "team",
        field: "memberIds",
        min: this.teamSize(this.quest),
        max: this.teamSize(this.quest)
      }];
    }
    if (this.phase === "vote" && !this.teamVotes.has(actorId)) {
      return [{
        name: "cast_team_vote",
        label: "表决队伍",
        description: "表决结果在所有人提交后统一公开。",
        kind: "choice",
        field: "accept",
        options: [
          { value: "true", label: "赞成" },
          { value: "false", label: "反对" }
        ]
      }];
    }
    if (this.phase === "quest" && this.proposedTeam.includes(actorId) && !this.questVotes.has(actorId)) {
      const options = isLoyalRole(role)
        ? [{ value: "succeed", label: "任务成功" }]
        : [{ value: "succeed", label: "任务成功" }, { value: "fail", label: "任务失败" }];
      return [{
        name: "cast_quest_vote",
        label: "决定任务",
        description: "任务选择完全保密。",
        kind: "choice",
        field: "choice",
        options
      }];
    }
    if (this.phase === "lady" && this.ladyHolderId === actorId) {
      return [
        {
          name: "inspect_with_lady",
          label: "湖中仙女查验",
          description: "私下查验一名其他参与者的忠诚阵营；令牌会交给被查验者。",
          kind: "target",
          field: "targetId",
          targetFilter: "any-living"
        },
        {
          name: "decline_lady",
          label: "不使用湖中仙女",
          description: "这一轮选择不使用湖中仙女。",
          kind: "choice",
          field: "confirm",
          options: [{ value: "true", label: "确认不使用" }]
        }
      ];
    }
    if (this.phase === "assassination" && role === "assassin") {
      return [{
        name: "assassinate_merlin",
        label: "刺杀梅林",
        description: "指出你认为的梅林。",
        kind: "target",
        field: "targetId",
        targetFilter: "any-living"
      }];
    }
    return [];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    const value = recordPayload(payload);
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";

    if (action === "make_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_NOT_OPEN: Commitments are proposed during the round-table discussion.");
      const commitmentType = value.commitmentType;
      if (commitmentType !== "team-vote" && commitmentType !== "quest-outcome") {
        throw new Error("COMMITMENT_TYPE_INVALID: Promise a team-vote or quest-outcome.");
      }
      const choice = value.choice;
      const legal = commitmentType === "team-vote"
        ? (choice === "approve" || choice === "reject")
        : (choice === "succeed" || choice === "fail");
      if (!legal) throw new Error("COMMITMENT_CHOICE_INVALID: The choice does not match the commitment type.");
      if (commitmentType === "quest-outcome" && choice === "fail" && isLoyalRole(role)) {
        throw new Error("LOYAL_CANNOT_PROMISE_FAIL: Loyal participants can only succeed a quest.");
      }
      const proposition = typeof value.proposition === "string" ? value.proposition.trim() : "";
      if (!proposition) throw new Error("COMMITMENT_PROPOSITION_REQUIRED: State the promise explicitly.");
      const ownCount = this.commitments.filter((entry) => entry.quest === this.quest && entry.promisorActorId === actorId).length;
      if (ownCount >= 2) throw new Error("COMMITMENT_LIMIT_EXCEEDED: At most two proposals per participant per quest.");
      const commandId = `cmd-${randomUUID()}`;
      const commitment: Commitment = {
        commitmentId: `commit:av:${this.quest}:${actorId}:${ownCount + 1}`,
        round: this.quest,
        quest: this.quest,
        promisorActorId: actorId,
        promisorCharacterId: this.requireProfile(actorId).characterId,
        audienceActorIds: [...this.profiles.keys()].filter((id) => id !== actorId),
        proposition,
        promisedAction: commitmentType === "team-vote"
          ? { actionType: "team-vote", choice: choice as "approve" | "reject", ...(typeof value.condition === "string" && value.condition.trim() ? { condition: value.condition.trim() } : {}) }
          : { actionType: "quest-outcome", choice: choice as "succeed" | "fail", ...(typeof value.condition === "string" && value.condition.trim() ? { condition: value.condition.trim() } : {}) },
        state: "proposed",
        acceptedByActorIds: [],
        acceptedByCommandIds: [],
        createdByCommandId: commandId,
        createdAtTurn: this.quest,
        schemaVersion: 1
      };
      this.commitments.push(commitment);
      this.recordSocialCommitment(commitment);
      for (const id of this.profiles.keys()) {
        this.pushEvent(id, {
          type: "commitment-proposed",
          actorId,
          targetId: id,
          facts: { commitmentId: commitment.commitmentId, commitmentType, choice },
          detail: `${actorId === id ? "你" : this.profiles.get(actorId)?.displayName ?? actorId} 提议承诺：${proposition}。`
        });
      }
      this.emitUpdate();
      return { action, commandId, detail: proposition, result: { accepted: true, commitmentId: commitment.commitmentId } };
    }
    if (action === "accept_commitment") {
      if (this.phase !== "discussion") throw new Error("COMMITMENT_ACCEPTANCE_NOT_OPEN: Accept commitments during the round-table discussion.");
      const commitmentId = typeof value.commitmentId === "string" ? value.commitmentId : "";
      const commitment = this.commitments.find((entry) => entry.commitmentId === commitmentId && entry.quest === this.quest);
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
      commitment.acceptedAtTurn = this.quest;
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
    if (action === "propose_team") {
      if (this.phase !== "proposal") throw new Error("PROPOSAL_NOT_OPEN: Wait for the proposal phase.");
      if (this.leaderId !== actorId) throw new Error("NOT_THE_LEADER: Only the current leader can propose a team.");
      if (this.proposedTeam.length) throw new Error("TEAM_ALREADY_PROPOSED: The current proposal is fixed.");
      const memberIds = Array.isArray(value.memberIds) ? [...new Set(value.memberIds.filter((entry): entry is string => typeof entry === "string"))] : [];
      const size = this.teamSize(this.quest);
      if (memberIds.length !== size) throw new Error(`TEAM_SIZE_INVALID: This quest requires exactly ${size} members.`);
      if (!memberIds.includes(actorId)) throw new Error("TEAM_MUST_INCLUDE_LEADER: Include yourself in the proposed team.");
      for (const id of memberIds) if (!this.profiles.has(id)) throw new Error(`TEAM_MEMBER_NOT_FOUND: '${id}' is not a participant.`);
      this.proposedTeam = [...memberIds];
      const commandId = `cmd-${randomUUID()}`;
      this.proposalCommandId = commandId;
      const leaderName = this.profiles.get(actorId)?.displayName ?? actorId;
      for (const id of this.profiles.keys()) {
        if (memberIds.includes(id)) {
          this.pushEvent(id, {
            type: "included",
            actorId,
            targetId: id,
            detail: `任务 ${this.quest}：${leaderName} 将你选入任务队伍。`
          });
        } else {
          this.pushEvent(id, {
            type: "excluded",
            actorId,
            targetId: id,
            detail: `任务 ${this.quest}：${leaderName} 没有将你选入任务队伍。`
          });
        }
      }
      this.phase = "vote";
      this.emitUpdate();
      return {
        action,
        commandId,
        detail: reason ? `${memberIds.join(", ")}; ${reason}` : memberIds.join(", "),
        result: { accepted: true, team: this.proposedTeam }
      };
    }

    if (action === "cast_team_vote") {
      if (this.phase !== "vote") throw new Error("VOTE_NOT_OPEN: Team voting is not open.");
      if (this.teamVotes.has(actorId)) throw new Error("VOTE_ALREADY_CAST: Your vote is fixed.");
      const accept = value.accept === true;
      const commandId = `cmd-${randomUUID()}`;
      this.teamVotes.set(actorId, accept);
      this.teamVoteCommandIds.set(actorId, commandId);
      this.emitUpdate();
      return { action, commandId, detail: reason ? `${accept}; ${reason}` : String(accept), result: { accepted: true, accept } };
    }

    if (action === "cast_quest_vote") {
      if (this.phase !== "quest") throw new Error("QUEST_NOT_OPEN: Quest voting is not open.");
      if (!this.proposedTeam.includes(actorId)) throw new Error("NOT_ON_THE_QUEST: Only approved team members decide the quest.");
      if (this.questVotes.has(actorId)) throw new Error("QUEST_VOTE_ALREADY_CAST: Your quest choice is fixed.");
      const choice = value.choice;
      if (choice !== "succeed" && choice !== "fail") throw new Error("QUEST_CHOICE_INVALID: Choose succeed or fail.");
      if (choice === "fail" && isLoyalRole(role)) throw new Error("LOYAL_MUST_SUCCEED: Loyal participants cannot fail a quest.");
      const commandId = `cmd-${randomUUID()}`;
      this.questVotes.set(actorId, choice);
      this.questVoteCommandIds.set(actorId, commandId);
      this.emitUpdate();
      return { action, commandId, detail: reason ? `${choice}; ${reason}` : choice, result: { accepted: true, choice } };
    }

    if (action === "inspect_with_lady") {
      if (this.phase !== "lady") throw new Error("LADY_NOT_ACTIVE: The Lady of the Lake acts only between quests.");
      if (this.ladyHolderId !== actorId) throw new Error("NOT_THE_HOLDER: You do not hold the Lady of the Lake token.");
      const targetId = typeof value.targetId === "string" ? value.targetId : "";
      if (!this.profiles.has(targetId)) throw new Error(`TARGET_NOT_FOUND: '${targetId}' is not a participant.`);
      if (targetId === actorId) throw new Error("TARGET_INVALID: The Lady cannot inspect herself.");
      if (this.ladyHolderHistory.has(targetId)) {
        throw new Error("LADY_TARGET_INELIGIBLE: The Lady cannot inspect a current or previous token holder.");
      }
      const commandId = `cmd-${randomUUID()}`;
      this.ladyInspectId = targetId;
      this.ladyInspectCommandId = commandId;
      return { action, commandId, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, pending: true } };
    }
    if (action === "decline_lady") {
      if (this.phase !== "lady") throw new Error("LADY_NOT_ACTIVE: The Lady of the Lake acts only between quests.");
      if (this.ladyHolderId !== actorId) throw new Error("NOT_THE_HOLDER: You do not hold the Lady of the Lake token.");
      const commandId = `cmd-${randomUUID()}`;
      this.ladyInspectId = undefined;
      this.ladyInspectCommandId = commandId;
      return { action, commandId, detail: "不使用湖中仙女", result: { accepted: true, declined: true } };
    }
    if (action === "assassinate_merlin") {
      if (this.assassinated) throw new Error("ASSASSINATION_ALREADY_USED: The final shot has been taken.");
      if (this.phase !== "assassination") throw new Error("ASSASSINATION_NOT_OPEN: The assassination happens only after three successful quests.");
      if (role !== "assassin") throw new Error("ASSASSIN_ONLY: Only the assassin chooses the target.");
      if (typeof value.targetId !== "string" || !value.targetId) throw new Error("TARGET_REQUIRED: Name a loyal participant.");
      const targetId = value.targetId;
      if (!this.profiles.has(targetId)) throw new Error(`TARGET_NOT_FOUND: '${targetId}' is not a participant.`);
      const targetRole = this.roles.get(targetId)!;
      if (isEvilRole(targetRole)) throw new Error("TARGET_MUST_BE_LOYAL: The assassin must target a loyal participant.");
      const commandId = `cmd-${randomUUID()}`;
      this.assassinated = true;
      this.assassinationTargetId = targetId;
      this.assassinationCommandId = commandId;
      this.emitUpdate();
      return { action, commandId, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, pending: true, targetId } };
    }

    throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    const ids = [...this.profiles.keys()];
    if (this.phase === "discussion") {
      if (!this.discussion) this.discussion = this.createDiscussion();
      const actors = this.discussion.nextWave();
      if (actors.length === 0) {
        this.discussion = null;
        this.phase = "proposal";
        this.emitUpdate();
        return this.proposalActivation();
      }
      const wave = this.discussion.waveNumber;
      return {
        id: `av:${this.quest}:discussion:${wave}`,
        label: wave === 1 ? `第 ${this.quest} 次任务讨论` : `第 ${this.quest} 次任务讨论 · 回应第 ${wave - 1} 轮`,
        actorIds: actors,
        mode: "sequential",
        instructionFor: (_actorId) => wave === 1
          ? "Opening round at the round table. State your read of loyalties, ask sharp questions, or stay reserved — but do not propose a team or vote yet."
          : "The table is live and people have reacted. Answer questions directed at you, defend yourself if accused, test anyone dodging specifics, or stay silent if you have nothing new. Do not propose a team or vote yet."
      };
    }
    if (this.phase === "proposal") return this.proposalActivation();
    if (this.phase === "vote") {
      return {
        id: `av:${this.quest}:vote`,
        label: `第 ${this.quest} 次任务表决`,
        actorIds: ids,
        mode: "parallel",
        instructionFor: () => `The proposed team is [${this.proposedTeam.join(", ")}]. Call cast_team_vote exactly once: approve or reject. Rejecting too often hands evil a free quest failure.`
      };
    }
    if (this.phase === "quest") {
      return {
        id: `av:${this.quest}:quest`,
        label: `第 ${this.quest} 次任务执行`,
        actorIds: this.proposedTeam,
        mode: "parallel",
        instructionFor: () => "You are on the approved quest. Call cast_quest_vote exactly once. Loyal members must succeed; minions may fail the quest secretly."
      };
    }
    if (this.phase === "lady") {
      return {
        id: `av:${this.quest}:lady`,
        label: "湖中仙女",
        actorIds: [this.ladyHolderId],
        mode: "sequential",
        instructionFor: () => `You hold the Lady of the Lake. You may call inspect_with_lady once against a player who has never held the token. Ineligible holder history: [${[...this.ladyHolderHistory].join(", ")}]. The loyalty verdict is revealed only to you, and the token passes to the inspected player. Declining is legitimate: simply do not call the tool.`
      };
    }
    const assassin = [...this.roles].find(([, candidate]) => candidate === "assassin")?.[0];
    return {
      id: `av:${this.quest}:assassination`,
      label: "最终刺杀",
      actorIds: assassin ? [assassin] : [],
      mode: "sequential",
      instructionFor: () => "Three quests succeeded. As the Assassin, weigh every word spoken this game and call assassinate_merlin exactly once against the loyal player you believe is Merlin."
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion")) {
      this.discussion?.endWave();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":proposal")) {
      if (this.proposedTeam.length) {
        this.phase = "vote";
        this.emitUpdate();
        return { completed: true, missingActorIds: [] };
      }
      return {
        completed: false,
        missingActorIds: [this.leaderId],
        retryInstruction: `The team has not been proposed. Call propose_team with exactly ${this.teamSize(this.quest)} members including yourself.`
      };
    }
    if (activation.id.endsWith(":vote")) {
      const missingActorIds = activation.actorIds.filter((id) => !this.teamVotes.has(id));
      if (missingActorIds.length) {
        return {
          completed: false,
          missingActorIds,
          retryInstruction: "Your team vote is missing. Call cast_team_vote now: approve or reject the proposed team."
        };
      }
      this.resolveTeamVote();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":quest")) {
      const missingActorIds = activation.actorIds.filter((id) => !this.questVotes.has(id));
      if (missingActorIds.length) {
        return {
          completed: false,
          missingActorIds,
          retryInstruction: "Your quest choice is missing. Call cast_quest_vote now: succeed or fail the quest."
        };
      }
      this.resolveQuest();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":lady")) {
      this.resolveLadyPhase();
      return { completed: true, missingActorIds: [] };
    }
    if (this.assassinated) {
      if (this.assassinationTargetId && this.assassinationCommandId && this.status === "running") {
        this.resolveAssassination();
      }
      return { completed: true, missingActorIds: [] };
    }
    if (this.phase !== "assassination") {
      return { completed: true, missingActorIds: [] };
    }
    return {
      completed: false,
      missingActorIds: activation.actorIds,
      retryInstruction: "The assassination is required. Call assassinate_merlin exactly once against a loyal participant."
    };
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
    if (input.channel === "team" && (!input.recipientIds || input.recipientIds.length === 0)) {
      input = {
        ...input,
        recipientIds: [...this.roles].filter(([id, role]) => id !== input.senderId && knowsEvilAllies(role)).map(([id]) => id)
      };
    }
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
    if (message.channel === "public" && this.phase === "discussion" && this.discussion) {
      this.detectSocialActs(message, input.socialActs ?? []);
    }
    return message;
  }

  private detectSocialActs(message: SocialMessage, declarations: SocialActDeclaration[]): void {
    for (const declaration of declarations) {
      if (
        declaration.kind !== "accusation"
        && declaration.kind !== "defense"
        && declaration.kind !== "endorsement"
        && declaration.kind !== "alliance-proposal"
      ) continue;
      for (const id of [...new Set(declaration.targetActorIds ?? [])]) {
        if (id === message.senderId || !this.profiles.has(id)) continue;
        if (declaration.kind === "accusation") {
          this.suspicion.noteAccusation(this.quest, message.senderId, id);
          this.discussion?.raiseSignal({
            kind: "accusation",
            sourceActorId: message.senderId,
            targetActorIds: [id],
            sourceMessageId: message.id
          });
        }
      }
    }
  }

  private proposalActivation(): WorldActivation {
    return {
      id: `av:${this.quest}:proposal`,
      label: `第 ${this.quest} 次任务组队`,
      actorIds: [this.leaderId],
      mode: "sequential",
      instructionFor: () => `You are the leader. Call propose_team with exactly ${this.teamSize(this.quest)} members including yourself. Consider every player's incentive to fail the quest and the suspicion climate: ${this.suspicion.climateText((id) => this.profiles.get(id)?.displayName ?? id)}.`
    };
  }

  protected currentTurn(): number {
    return this.quest;
  }

  protected currentPhase(): string {
    return this.phase;
  }

  protected isAlive(_actorId: string): boolean {
    return true;
  }

  protected observerRole(actorId: string): string | undefined {
    return roleLabel(this.roles.get(actorId));
  }

  protected roleVisibleTo(viewerId: string | undefined, subjectId: string, _alive: boolean): boolean {
    if (viewerId === subjectId) return true;
    if (this.status === "finished") return true;
    return false;
  }

  protected messageChannelsFor(actorId: string): SocialChannel[] {
    return knowsEvilAllies(this.roles.get(actorId)) ? ["public", "private", "team"] : ["public", "private"];
  }

  protected redactDetails(details: Record<string, unknown>, actorId?: string): Record<string, unknown> {
    const next = super.redactDetails(details, actorId);
    const visibleRoles: Record<string, Role> = {};
    for (const [id, role] of this.roles) {
      if (this.roleVisibleTo(actorId, id, true)) visibleRoles[id] = role;
    }
    if (Object.keys(visibleRoles).length) next.roles = visibleRoles;
    return next;
  }

  protected validateMessage(senderId: string, channel: "public" | "private" | "team", recipientIds: string[]): void {
    if (channel === "private") {
      if (recipientIds.length === 0) throw new Error("RECIPIENT_REQUIRED: Private messages require recipientIds.");
      for (const id of recipientIds) this.requireProfile(id);
      return;
    }
    if (channel === "team") {
      const senderRole = this.roles.get(senderId);
      if (!senderRole || !knowsEvilAllies(senderRole)) throw new Error("TEAM_CHANNEL_FORBIDDEN: Only agents of evil who know each other may use the team channel.");
      if (recipientIds.some((id) => !knowsEvilAllies(this.roles.get(id)))) {
        throw new Error("TEAM_RECIPIENT_INVALID: Team messages may only target fellow agents of evil who know each other.");
      }
    }
  }

  private openCommitmentsThisQuest(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      (entry.quest ?? entry.round) === this.quest &&
      (entry.state === "proposed" || entry.state === "accepted") &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
  }

  private settledCommitmentsFor(actorId: string): Commitment[] {
    return this.commitments.filter((entry) =>
      (entry.quest ?? entry.round) < this.quest &&
      entry.state !== "proposed" && entry.state !== "accepted" &&
      (entry.promisorActorId === actorId || entry.audienceActorIds.includes(actorId))
    );
  }

  /** Settle this quest's accepted commitments of one action type against actual behavior. */
  private settleAvalonCommitments(
    actionType: "team-vote" | "quest-outcome",
    actualByActor: Map<string, string>,
    sourceEventId: string,
    beatFallback: "agreement-reached" | "cooperative-outcome" | "unilateral-defection" | undefined
  ): { beat: "promise-kept" | "promise-broken" | "agreement-reached" | "cooperative-outcome" | "unilateral-defection" | undefined } {
    const accepted = this.commitments.filter((entry) => (entry.quest ?? entry.round) === this.quest && entry.state === "accepted" && entry.promisedAction.actionType === actionType);
    let anyViolated = false;
    const allFulfilled = accepted.length > 0;
    for (const commitment of accepted) {
      const actual = actualByActor.get(commitment.promisorActorId);
      if (actual === undefined) {
        // The actor never had the chance to act (e.g. not on the quest team):
        // the promise is voided, not violated — no opportunity, no verdict.
        commitment.state = "void";
        commitment.settledAtTurn = this.quest;
        this.settleSocialCommitment(commitment);
        continue;
      }
      const promisedChoice = (commitment.promisedAction as { choice?: string }).choice;
      if (promisedChoice === undefined) continue;
      const fulfilled = actual === promisedChoice;
      commitment.state = fulfilled ? "fulfilled" : "violated";
      commitment.settledAtTurn = this.quest;
      commitment.settledByCommandId = this.teamVoteCommandIds.get(commitment.promisorActorId) ?? this.questVoteCommandIds.get(commitment.promisorActorId);
      this.settleSocialCommitment(commitment);
      if (!fulfilled) anyViolated = true;
      for (const id of this.profiles.keys()) {
        this.pushEvent(id, {
          type: fulfilled ? "commitment-fulfilled" : "commitment-violated",
          actorId: commitment.promisorActorId,
          targetId: id,
          facts: { commitmentId: commitment.commitmentId, promisedChoice, actualChoice: actual },
          detail: fulfilled
            ? `承诺兑现：${this.profiles.get(commitment.promisorActorId)?.displayName ?? commitment.promisorActorId} 承诺${promisedChoice}，实际也${actual}。`
            : `承诺违约：${this.profiles.get(commitment.promisorActorId)?.displayName ?? commitment.promisorActorId} 承诺${promisedChoice}，实际${actual}。`
        });
      }
    }
    for (const commitment of this.commitments.filter((entry) => (entry.quest ?? entry.round) === this.quest && entry.state === "proposed" && entry.promisedAction.actionType === actionType)) {
      commitment.state = "void";
      commitment.settledAtTurn = this.quest;
      this.settleSocialCommitment(commitment);
    }
    return anyViolated ? { beat: "promise-broken" } : allFulfilled && accepted.length > 0 ? { beat: "promise-kept" } : { beat: beatFallback as "agreement-reached" | "cooperative-outcome" | "unilateral-defection" | undefined };
  }

  private availableActions(actorId: string, role: Role): string[] {
    if (this.phase === "discussion") return ["communicate", "recall_memory", "reflect_on_social_situation", "read_the_room", "log_deception_plan", "update_inner_state"];
    if (this.phase === "proposal") return this.leaderId === actorId ? ["propose_team", "communicate"] : [];
    if (this.phase === "vote") return this.teamVotes.has(actorId) ? [] : ["cast_team_vote"];
    if (this.phase === "quest") return this.proposedTeam.includes(actorId) && !this.questVotes.has(actorId) ? ["cast_quest_vote"] : [];
    if (this.phase === "lady") return this.ladyHolderId === actorId ? ["inspect_with_lady"] : [];
    if (this.phase === "assassination") return role === "assassin" ? ["assassinate_merlin"] : [];
    return [];
  }

  private registerFactionKnowledge(): void {
    for (const [actorId, role] of this.roles) this.recordIdentityAssignment(actorId, role, [actorId]);
    for (const [subjectId, subjectRole] of this.roles) {
      const observers = new Set<string>([subjectId]);
      if (knowsEvilAllies(subjectRole)) {
        for (const [observerId, observerRole] of this.roles) {
          if (knowsEvilAllies(observerRole)) observers.add(observerId);
        }
      }
      if (merlinSees(subjectRole)) {
        const merlinId = [...this.roles].find(([, role]) => role === "merlin")?.[0];
        if (merlinId) observers.add(merlinId);
      }
      this.recordFactionAssignment(subjectId, isEvilRole(subjectRole) ? "evil" : "loyal", [...observers]);
    }
    const percivalId = [...this.roles].find(([, role]) => role === "percival")?.[0];
    if (!percivalId) return;
    for (const [subjectId, role] of this.roles) {
      if (role !== "merlin" && role !== "morgana") continue;
      this.recordPrivateObservation({
        observerActorId: percivalId,
        subjectActorId: subjectId,
        eventType: "avalon.percival-sight",
        predicate: "is-merlin-or-morgana-candidate",
        object: true,
        payload: { subjectActorId: subjectId },
        kind: "identity"
      });
    }
  }

  private resolveTeamVote(): void {
    const resolvedVotes = new Map(this.teamVotes);
    const approveCount = [...this.teamVotes.values()].filter(Boolean).length;
    const team = [...this.proposedTeam];
    const approved = approveCount > this.profiles.size / 2;
    const publicResult = this.recordPublicWorldFact({
      factKey: `avalon-team-vote:${this.quest}:${this.rejections}:${team.join(",")}`,
      eventType: "avalon.team-vote-resolved",
      predicate: "proposed-team-approved",
      object: approved,
      payload: { quest: this.quest, team, approveCount, totalVotes: resolvedVotes.size, approved }
    });
    if (this.proposalCommandId) {
      const commandId = this.proposalCommandId;
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `Proposed quest ${this.quest} team [${team.join(", ")}]; the table ${approved ? "approved" : "rejected"} it ${approveCount}-${resolvedVotes.size - approveCount}.`,
          metrics: {
            quest: this.quest,
            teamSize: team.length,
            approveCount,
            totalVotes: resolvedVotes.size,
            approved
          }
        },
        actualFacts: { "team-approved": approved },
        resultingEventIds: [publicResult.eventId],
      });
      this.proposalCommandId = undefined;
    }
    for (const [voterId, accept] of resolvedVotes) {
      const commandId = this.teamVoteCommandIds.get(voterId);
      if (!commandId) continue;
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `The quest ${this.quest} team was ${approved ? "approved" : "rejected"} by ${approveCount}/${resolvedVotes.size} approvals.`,
          metrics: { quest: this.quest, approved, approveCount, totalVotes: resolvedVotes.size, ownVote: accept }
        },
        actualFacts: {
          "team-approved": approved,
          "vote-matched-majority": accept === approved
        },
        resultingEventIds: [publicResult.eventId],
      });
    }
    const text = approved
      ? `第 ${this.quest} 次任务：圆桌以 ${approveCount} 票通过了队伍 [${team.map((member) => this.profiles.get(member)?.displayName ?? member).join("、")}]。`
      : `第 ${this.quest} 次任务：圆桌以 ${approveCount} 票赞成否决了队伍 [${team.map((member) => this.profiles.get(member)?.displayName ?? member).join("、")}]。`;
    const commitmentBeat = this.settleAvalonCommitments(
      "team-vote",
      new Map([...resolvedVotes].map(([actorId, accept]) => [actorId, accept ? "approve" : "reject"])),
      publicResult.eventId,
      approved ? "agreement-reached" : undefined
    );
    this.addLog(text, this.quest, commitmentBeat.beat ?? (approved ? "agreement-reached" : undefined));
    if (approved) {
      this.approvedTeamVotes.clear();
      for (const [actorId, vote] of resolvedVotes) this.approvedTeamVotes.set(actorId, vote);
      this.rejections = 0;
      this.teamVotes.clear();
      this.teamVoteCommandIds.clear();
      this.phase = "quest";
      this.emitUpdate();
      return;
    }
    this.rejections += 1;
    this.teamVotes.clear();
    this.teamVoteCommandIds.clear();
    if (this.rejections >= MAX_REJECTIONS) {
      this.winners = this.factionMembers(["morgana", "assassin", "mordred", "oberon", "minion"]);
      this.outcome = "连续五次组队被否决——圆桌无法达成任何共识，内奸阵营获胜。";
      this.addLog(this.outcome, this.quest, "win");
      this.endGame();
      return;
    }
    this.proposedTeam = [];
    this.rotateLeader();
    this.phase = "proposal";
    this.emitUpdate();
  }

  private resolveQuest(): void {
    const team = [...this.proposedTeam];
    const resolvedQuestVotes = new Map(this.questVotes);
    const failCount = [...resolvedQuestVotes.values()].filter((choice) => choice === "fail").length;
    const teamVotes = Object.fromEntries(this.approvedTeamVotes);
    this.questVotes.clear();
    this.approvedTeamVotes.clear();
    this.proposedTeam = [];
    this.teamVotes.clear();
    this.proposalCommandId = undefined;
    this.recordQuestFailure(team, teamVotes, false, failCount, resolvedQuestVotes);
    this.questVoteCommandIds.clear();
  }

  /** The official team size for a quest at this table's player count. */
  private teamSize(quest: number): number {
    const sizes = this.teamSizes;
    return sizes[Math.min(quest, sizes.length) - 1];
  }

  /** Fails needed to sink a quest: the 4th quest needs two at 7+ players. */
  private failsNeededForQuest(): number {
    return questFailsNeeded(this.profiles.size, this.quest);
  }

  private recordQuestFailure(
    team: string[],
    teamVotes: Record<string, boolean>,
    rejected = false,
    failCount = 0,
    resolvedQuestVotes = new Map<string, "succeed" | "fail">()
  ): void {
    const failsNeeded = this.failsNeededForQuest();
    const outcome = rejected || failCount >= failsNeeded ? "fail" : "success";
    const text = rejected
      ? `第 ${this.quest} 次任务：连续提案被否决，任务因僵局失败。`
      : outcome === "fail"
        ? `第 ${this.quest} 次任务失败：出现 ${failCount} 张黑票（需要 ${failsNeeded} 张）。`
        : `第 ${this.quest} 次任务成功。`;
    const record: QuestRecord = {
      quest: this.quest,
      leaderId: this.leaderId,
      team,
      teamVotes,
      outcome,
      failCount,
      text
    };
    this.questHistory.push(record);
    if (outcome === "fail") this.failures += 1;
    else this.successes += 1;
    const publicResult = this.recordPublicWorldFact({
      factKey: `avalon-quest-result:${this.quest}`,
      eventType: "avalon.quest-resolved",
      predicate: "quest-result",
      object: { outcome, failCount },
      payload: { quest: this.quest, team, outcome, failCount, failsNeeded }
    });
    for (const [actorId, choice] of resolvedQuestVotes) {
      const commandId = this.questVoteCommandIds.get(actorId);
      if (!commandId) continue;
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `Quest ${this.quest} ${outcome === "success" ? "succeeded" : "failed"} with ${failCount} fail card(s).`,
          metrics: { quest: this.quest, outcome, failCount, failsNeeded, ownChoice: choice }
        },
        actualFacts: {
          "quest-succeeds": outcome === "success",
          "quest-fails": outcome === "fail",
          "quest-has-fail-card": failCount > 0
        },
        resultingEventIds: [publicResult.eventId],
      });
    }
    for (const id of this.profiles.keys()) {
      this.lastExperiences.set(id, `${text} 第 ${this.quest} 次任务队伍：${team.join(", ")}。`);
      const onTeam = team.includes(id);
      if (outcome === "fail") {
        if (onTeam) {
          this.suspicion.noteOutcome(this.quest, "quest", id);
          this.pushEvent(id, {
            type: "quest-failed",
            targetId: id,
            facts: { onTeam: true, failCount },
            detail: `第 ${this.quest} 次任务失败，出现 ${failCount} 张黑票——而你就在队伍里。`
          });
        } else {
          this.pushEvent(id, {
            type: "quest-failed",
            targetId: id,
            facts: { onTeam: false, failCount },
            detail: `第 ${this.quest} 次任务失败，出现 ${failCount} 张黑票。破坏者就在：${team.map((member) => this.profiles.get(member)?.displayName ?? member).join("、")}。`
          });
        }
      } else {
        if (onTeam) this.suspicion.noteResolved(this.quest, id);
        this.pushEvent(id, {
          type: "quest-passed",
          targetId: id,
          facts: { onTeam },
          detail: onTeam
            ? `第 ${this.quest} 次任务成功——你就在胜利的队伍里。`
            : `第 ${this.quest} 次任务成功。圆桌的信任暂时站住了。`
        });
      }
    }
    // P0-09: a fail vote is a unilateral defection inside the quest, not a
    // broken promise; a pass is a cooperative outcome. Accepted quest-outcome
    // promises settle here: a minion who promised to fail and did is a kept
    // promise; one who promised loyalty-cover and failed is exposed.
    const questCommitmentBeat = this.settleAvalonCommitments(
      "quest-outcome",
      new Map(resolvedQuestVotes),
      publicResult.eventId,
      outcome === "fail" ? "unilateral-defection" : "cooperative-outcome"
    );
    this.addLog(text, this.quest, questCommitmentBeat.beat ?? (outcome === "fail" ? "unilateral-defection" : "cooperative-outcome"));
    if (this.failures >= 3) {
      this.winners = this.factionMembers(["morgana", "assassin", "mordred", "oberon", "minion"]);
      this.outcome = "三次任务失败，内奸得逞，圆桌陷落。";
      this.endGame();
      return;
    }
    if (this.successes >= 3) {
      this.phase = "assassination";
      this.addLog("三次任务全部成功。刺客将进行最后一刺。", this.quest);
      this.emitUpdate();
      return;
    }
    if (this.quest >= this.totalQuests) {
      this.phase = "assassination";
      this.addLog(`全部 ${this.totalQuests} 次任务结束，进入最终刺杀。`, this.quest);
      this.emitUpdate();
      return;
    }
    // The official Lady timing is after quests 2, 3 and 4 only.
    if (this.quest >= 2 && this.quest < this.totalQuests) {
      this.phase = "lady";
      this.ladyInspectId = undefined;
      this.emitUpdate();
      return;
    }
    this.advanceToNextQuest();
  }

  /** Resolve the Lady phase: inspect (verdict stays private) or decline, then advance. */
  private resolveLadyPhase(): void {
    const observerId = this.ladyHolderId;
    const holderName = this.profiles.get(observerId)?.displayName ?? observerId;
    const commandId = this.ladyInspectCommandId;
    if (!this.ladyInspectId) {
      const publicResult = this.recordPublicWorldFact({
        factKey: `avalon-lady:${this.quest}:${observerId}:declined`,
        eventType: "avalon.lady-resolved",
        subjectActorId: observerId,
        predicate: "lady-inspection-used",
        object: false,
        payload: { quest: this.quest, holderActorId: observerId, used: false }
      });
      this.addLog(`第 ${this.quest} 次任务后，${holderName} 没有使用湖中仙女。`, this.quest);
      if (commandId) {
        this.reconcileSocialOutcome({
          actionReceiptId: commandId,
          actualOutcome: {
            summary: `Declined to use the Lady of the Lake after quest ${this.quest}.`,
            metrics: { quest: this.quest, investigationCompleted: false }
          },
          actualFacts: { "investigation-completed": false },
          resultingEventIds: [publicResult.eventId]
        });
      }
    } else {
      const targetId = this.ladyInspectId;
      const targetName = this.profiles.get(targetId)?.displayName ?? targetId;
      const verdict = ladyVerdictFor(this.roles.get(targetId));
      const prior = this.ladyReveals.get(observerId) ?? [];
      prior.push({ targetId, quest: this.quest, verdict });
      this.ladyReveals.set(observerId, prior);
      const privateResult = this.recordPrivateObservation({
        observerActorId: observerId,
        subjectActorId: targetId,
        eventType: "avalon.lady-verdict",
        predicate: "lady-loyalty-verdict",
        object: verdict,
        ...(this.ladyInspectCommandId ? { sourceCommandId: this.ladyInspectCommandId } : {}),
        payload: { quest: this.quest, targetActorId: targetId }
      });
      const publicResult = this.recordPublicWorldFact({
        factKey: `avalon-lady:${this.quest}:${observerId}:${targetId}`,
        eventType: "avalon.lady-resolved",
        subjectActorId: observerId,
        predicate: "lady-inspection-used",
        object: true,
        payload: { quest: this.quest, holderActorId: observerId, targetActorId: targetId, used: true }
      });
      // The inspection is public knowledge; the verdict stays with the holder.
      this.addLog(`湖中仙女查验了 ${targetName}。令牌已交给 ${targetName}。`, this.quest);
      this.pushEvent(observerId, {
        type: "investigation",
        actorId: observerId,
        targetId,
        facts: { role: verdict === "evil" ? "内奸" : "好人" },
        detail: `湖中仙女告诉你：${targetName} 的阵营是${verdict === "evil" ? "邪恶" : "忠诚"}。`
      });
      if (commandId) {
        this.reconcileSocialOutcome({
          actionReceiptId: commandId,
          actualOutcome: {
            summary: `Inspected ${targetId} with the Lady of the Lake; the private verdict was ${verdict}.`,
            metrics: { quest: this.quest, targetId, verdict, investigationCompleted: true }
          },
          actualFacts: {
            "investigation-completed": true,
            "target-verdict-evil": verdict === "evil"
          },
          resultingEventIds: [publicResult.eventId, privateResult.sourceEventId ?? privateResult.evidenceId],
        });
      }
      this.ladyHolderId = targetId;
      this.ladyHolderHistory.add(targetId);
    }
    this.ladyInspectId = undefined;
    this.ladyInspectCommandId = undefined;
    this.advanceToNextQuest();
  }

  private advanceToNextQuest(): void {
    this.quest += 1;
    this.suspicion.decay(0.8);
    this.rotateLeader();
    this.phase = "discussion";
    this.discussion = this.createDiscussion();
    this.emitUpdate();
  }

  private rotateLeader(): void {
    const ids = [...this.profiles.keys()];
    const index = ids.indexOf(this.leaderId);
    this.leaderId = ids[(index + 1) % ids.length];
  }

  private resolveAssassination(): void {
    const targetId = this.assassinationTargetId;
    const commandId = this.assassinationCommandId;
    const assassinId = [...this.roles].find(([, role]) => role === "assassin")?.[0];
    if (!targetId || !commandId || !assassinId) {
      throw new Error("ASSASSINATION_STATE_INCOMPLETE: The final target or command receipt is missing.");
    }
    const targetRole = this.roles.get(targetId);
    if (!targetRole) throw new Error(`TARGET_NOT_FOUND: '${targetId}' is not a participant.`);
    const correct = targetRole === "merlin";
    this.winners = correct
      ? this.factionMembers(["morgana", "assassin", "mordred", "oberon", "minion"])
      : this.factionMembers(["merlin", "percival", "servant"]);
    this.outcome = correct
      ? `${this.profiles.get(assassinId)?.displayName} 指认 ${this.profiles.get(targetId)?.displayName} 为梅林。忠臣的事业崩塌，内奸阵营获胜。`
      : `${this.profiles.get(assassinId)?.displayName} 失手了——${this.profiles.get(targetId)?.displayName} 并不是梅林。忠臣阵营获胜。`;
    const publicResult = this.recordPublicWorldFact({
      factKey: `avalon-assassination:${this.quest}`,
      eventType: "avalon.assassination-resolved",
      subjectActorId: targetId,
      predicate: "assassination-target-role",
      object: targetRole,
      payload: {
        quest: this.quest,
        assassinActorId: assassinId,
        targetActorId: targetId,
        targetRole,
        correct,
        winningFaction: correct ? "evil" : "loyal"
      },
      kind: "identity"
    });
    this.pushEvent(targetId, {
      type: "assassinated",
      actorId: assassinId,
      targetId,
      facts: { correct, assassinId, resultEventId: publicResult.eventId },
      detail: correct
        ? "刺客找到了你。你作为梅林的身份就是你的死因——忠臣的事业与你一同倒下了。"
        : `刺客指向了你，却失手了。你的身份（${roleLabel(targetRole)}）已经公开。`
    });
    this.reconcileSocialOutcome({
      actionReceiptId: commandId,
      actualOutcome: {
        summary: correct
          ? `Targeted ${targetId}; they were Merlin, so evil won.`
          : `Targeted ${targetId}; they were ${targetRole}, so the loyal faction won.`,
        metrics: { quest: this.quest, targetId, targetRole, correct, evilWon: correct }
      },
      actualFacts: {
        "target-is-merlin": correct,
        "evil-wins": correct
      },
      resultingEventIds: [publicResult.eventId],
    });
    for (const id of this.profiles.keys()) {
      this.lastExperiences.set(id, `${this.outcome} 最终身份：${[...this.roles].map(([memberId, memberRole]) => `${memberId}=${memberRole}`).join(", ")}。`);
    }
    this.endGame();
  }

  private endGame(): void {
    this.addLog(this.outcome, this.quest);
    // §28: identity reveals carry the faction so extracted camp claims
    // (忠诚/内奸) can be reconciled — a minion who claimed loyalty is
    // exposed by the very reveal that ends the game.
    for (const [actorId, role] of this.roles) this.revealIdentity(actorId, role, isEvilRole(role) ? "evil" : "loyal");
    for (const id of this.profiles.keys()) {
      const won = this.winners.includes(id);
      this.pushEvent(id, {
        type: won ? "win" : "lose",
        targetId: id,
        detail: won ? `Game over: your faction won — ${this.outcome}` : `Game over: your faction lost — ${this.outcome}`
      });
    }
    this.finish();
  }

  protected messageWave(): number | undefined {
    return this.discussion?.waveNumber;
  }

  private createDiscussion(): DiscussionDirector {
    return new DiscussionDirector({
      actorIds: [...this.profiles.keys()],
      displayName: (id) => this.profiles.get(id)?.displayName ?? id,
      ...discussionPersonality(this.profiles)
    });
  }

  private factionMembers(roles: Role[]): string[] {
    return [...this.roles].filter(([, role]) => roles.includes(role)).map(([id]) => id);
  }

  private summary(): string {
    if (this.status === "finished") return this.outcome;
    return `任务 ${this.quest} / ${this.totalQuests} · 成功 ${this.successes} · 失败 ${this.failures} · ${phaseLabel(this.phase)}`;
  }
}

function roleObjective(role: Role): string {
  if (role === "merlin") return "帮助三次任务成功，同时隐藏身份：任务全胜后刺客有一次机会指认你。你看得见内奸，但看不见莫德雷德与奥伯伦。";
  if (role === "percival") return "帮助三次任务成功。你知道梅林是谁——但莫甘娜在局时你也会看见她，无法分辨真假。保护好真正的梅林，别公开点破。";
  if (role === "servant") return "帮助三次任务成功。开局你什么都不知道——信任只能从行为里一点点建立。";
  if (role === "assassin") return "让三次任务失败。若忠臣先完成三次任务，就用你唯一的一次猜测刺杀梅林。";
  if (role === "morgana") return "让三次任务失败。派西维尔会把你当作第二个梅林——冒充他来迷惑忠臣。";
  if (role === "mordred") return "让三次任务失败。梅林看不见你——利用这份隐身。";
  if (role === "oberon") return "独自推动三次任务失败：其他内奸不认识你，你也不认识他们。";
  return "让三次任务失败。你认识其他内奸，可以做一个高调的或安静的破坏者。";
}

function situationFor(phase: Phase, quest: number, totalQuests: number, successes: number, failures: number): string {
  if (phase === "discussion") return `第 ${quest}/${totalQuests} 次任务正在组队。成功 ${successes} 次，失败 ${failures} 次。隐藏的忠诚是这里唯一的货币。`;
  if (phase === "proposal") return `队长正在为第 ${quest} 次任务组队。每一次提名都是公开信号。`;
  if (phase === "vote") return `第 ${quest} 次任务的队伍正在表决。所有人的票会一起揭晓。`;
  if (phase === "quest") return `第 ${quest} 次任务执行中。只有入选队员行动，他们的选择保密。`;
  if (phase === "lady") return `第 ${quest} 次任务已经结算。湖中仙女持有者可以私下查验一人的阵营，查验对象本身不会得知结果。`;
  return "三次任务全胜。刺客即将对梅林发起最后一剑。";
}

function roleLabel(role: Role | undefined): string {
  if (role === "merlin") return "梅林";
  if (role === "percival") return "派西维尔";
  if (role === "servant") return "忠臣";
  if (role === "morgana") return "莫甘娜";
  if (role === "assassin") return "刺客";
  if (role === "mordred") return "莫德雷德";
  if (role === "oberon") return "奥伯伦";
  if (role === "minion") return "爪牙";
  return "未知";
}

function phaseLabel(phase: Phase): string {
  if (phase === "discussion") return "圆桌讨论";
  if (phase === "proposal") return "队长组队";
  if (phase === "vote") return "全体表决";
  if (phase === "quest") return "任务执行";
  if (phase === "lady") return "湖中仙女";
  return "最终刺杀";
}

function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function sameMembers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  return leftSet.size === right.length && right.every((value) => leftSet.has(value));
}

function normalizeCommitment(value: Commitment): Commitment {
  return {
    ...value,
    acceptedByActorIds: [...(value.acceptedByActorIds ?? [])],
    acceptedByCommandIds: [...(value.acceptedByCommandIds ?? [])]
  };
}

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}
