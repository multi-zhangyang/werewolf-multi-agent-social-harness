import { randomInt, randomUUID } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type {
  ActivationCompletion,
  AgentObservation,
  AgentProfile,
  PlayerActionSpec,
  ScenarioSummary,
  SocialChannel,
  SocialMessage,
  SocietyAgentContext,
  WorldActionCommit,
  WorldActivation,
  WorldQualityMetrics,
  WorldSnapshot
} from "../../contracts";
import { scopedContext, SocialWorldBase } from "../../world";
import { conversationSignalsFromSocialActs, DiscussionDirector, type ConversationSignal } from "../../conversation";
import { SuspicionClimate } from "../../suspicion";
import { boundedRounds, discussionPersonality, emitAction } from "../helpers";
import { roleHypothesisTool } from "../../cognition";
import { socialReferenceContext, toolArgumentFeedback } from "../../social/context-refs";
import type { SocialActDeclaration } from "../../social/contracts";
import {
  WEREWOLF_ROLES,
  deckForPlayerCount,
  isVillageRole,
  isWolfRole,
  roleLabel,
  type WerewolfRoleId
} from "./roles";

type Phase =
  | "sheriff-run"
  | "sheriff-campaign"
  | "sheriff-withdraw"
  | "sheriff-vote"
  | "sheriff-pk"
  | "day-discussion"
  | "day-knight"
  | "day-vote"
  | "day-pk"
  | "night";

/**
 * SDK `tool()` with Society validation feedback: when the model's arguments
 * fail schema parsing, the retry hint names the failing fields and their legal
 * values instead of the SDK's bare "invalid input", so the model can repair
 * its own call on the next attempt.
 */
const societyTool = ((options: Record<string, unknown>) =>
  tool({
    ...options,
    // Society tools standardize on field-level validation feedback.
    errorFunction: toolArgumentFeedback(typeof options.name === "string" ? options.name : "tool")
  } as Parameters<typeof tool>[0])) as unknown as typeof tool;

interface DayRecord {
  day: number;
  votes: Record<string, string>;
  eliminatedId?: string;
  eliminatedRole?: WerewolfRoleId;
  /** The idiot was voted out, flipped their card, survived and lost the vote. */
  idiotSurvived?: boolean;
  nightKillId?: string;
  nightKillRole?: WerewolfRoleId;
  poisonId?: string;
  shotId?: string;
  shotRole?: WerewolfRoleId;
  /** Players the white wolf king's explosion took with them. */
  boomVictims?: string[];
  /** The wolf beauty's charmed companion, if she was voted out. */
  charmVictim?: string;
  /** Day-1 sheriff election: who won the badge. */
  sheriffElectedId?: string;
}

/** A pending death skill: hunter or wolf-king must decide a target (or hold). */
interface PendingShot {
  shooterId: string;
  kind: "hunter" | "wolf-king";
  cause: string;
}

export class WerewolfWorld extends SocialWorldBase {
  /**
   * Sidecar extraction hints: teach the extractor the camp vocabulary so
   * identity claims ("我是村民" / "X 是狼人") become `identity/has-team`
   * propositions that reveal reconciliation can falsify.
   */
  extractionHints?(): string {
    return [
      "本局是狼人杀。身份主张判定：",
      '- 当说话者断言某人属于哪个阵营时，输出 claims 条目：aboutSelf（说自己为 true）、targetName（说别人时报名字）、assertedTeam（"wolf"=属于狼人阵营，"good"=属于好人阵营）、confidence。',
      '- 例：「我是村民」→ {aboutSelf:true, assertedTeam:"good"}；「我不是狼人」→ {aboutSelf:true, assertedTeam:"good"}；「X 是狼」→ {aboutSelf:false, targetName:"X", assertedTeam:"wolf"}；「我相信你」→ 不算主张。',
      '- 疑问、反问、要求他人表态、转述他人观点都不算主张。'
    ].join("\n");
  }

  private readonly maxDays: number;
  private readonly deckName: string;
  private readonly roles = new Map<string, WerewolfRoleId>();
  private readonly alive = new Set<string>();
  private readonly votes = new Map<string, string>();
  private readonly voteCommandIds = new Map<string, string>();
  private readonly wolfTargets = new Map<string, string>();
  private readonly wolfTargetCommandIds = new Map<string, string>();
  private readonly seerKnowledge = new Map<string, Map<string, WerewolfRoleId>>();
  private readonly seerTargets = new Map<string, string>();
  private readonly seerTargetCommandIds = new Map<string, string>();
  private readonly history: DayRecord[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private discussion: DiscussionDirector | null = null;
  private readonly suspicion = new SuspicionClimate();
  private winners: string[] = [];
  private outcome = "";
  /** Day 1 opens with the sheriff election before any discussion. */
  private phase: Phase = "sheriff-run";
  private day = 1;
  /** Sheriff election (day 1 only): everyone decided whether to run. */
  private readonly sheriffRunDecided = new Set<string>();
  /** Everyone who ever stood for sheriff — candidates and ex-candidates. */
  private readonly sheriffCandidates = new Set<string>();
  /** Candidates who decided the withdraw round. */
  private readonly sheriffWithdrawDecided = new Set<string>();
  private readonly sheriffWithdrawn = new Set<string>();
  /** Electors' sealed ballots: only those who never ran may vote. */
  private readonly sheriffVotes = new Map<string, string>();
  private readonly sheriffVoteCommandIds = new Map<string, string>();
  private sheriffPkCandidates: string[] = [];
  private sheriffPkHeld = false;
  /** The sitting sheriff; their day vote counts 1.5. */
  private sheriffId?: string;
  /** Dead sheriffs still owed a badge decision (hand over or tear). */
  private readonly pendingBadgePass: string[] = [];
  /** Witch potions: one antidote, one poison, once each for the whole game. */
  private antidoteAvailable = true;
  private poisonAvailable = true;
  /** This night's witch decision (set through the tool, cleared at dawn). */
  private witchSaveId?: string;
  private witchPoisonId?: string;
  private witchCommandId?: string;
  /** Whether the witch has decided tonight — a pass still counts as acting. */
  private witchActed = false;
  /** This night's guard decision. */
  private guardTargetId?: string;
  private guardCommandId?: string;
  private lastGuardTargetId?: string;
  /** Death skills waiting for their owner's decision (hunter / wolf-king). */
  private readonly pendingShots: PendingShot[] = [];
  /** Day-vote-eliminated players still owed one public last statement (遗言). */
  private readonly pendingLastWords: string[] = [];
  /** Tied-vote PK: the two accused still owe their defense speech. */
  private pkCandidates: string[] = [];
  /** PK happened today — a second tie eliminates nobody instead of looping. */
  private pkHeld = false;
  private jesterWon = false;
  /** Idiots who flipped their card: alive, but without a vote. */
  private readonly idiotRevealed = new Set<string>();
  /** The knight's one daytime duel: once per game, before the vote. */
  private knightUsed = false;
  private knightCommandId?: string;
  private knightTargetId?: string;
  private knightTargetWasWolf?: boolean;
  /** Nightmare's curse: the cursed player cannot vote the next day. */
  private nightmareCurse: string | null | undefined;
  private nightmareCurseCommandId?: string;
  /** Wolf beauty's charm: if she is voted out, her charmed target dies with her. */
  private charmTarget: string | null | undefined;
  private charmCommandId?: string;
  /** Spirit seer's knowledge: dead players' true roles, per spirit seer. */
  private readonly spiritKnowledge = new Map<string, Map<string, WerewolfRoleId>>();
  private readonly spiritTargets = new Map<string, string>();
  private readonly spiritTargetCommandIds = new Map<string, string>();
  private readonly shotCommandIds = new Map<string, string>();
  private readonly shotTargetIds = new Map<string, string | null>();
  private readonly shotKinds = new Map<string, "hunter" | "wolf-king">();

  constructor(roomId: string, scenario: ScenarioSummary, profiles: AgentProfile[], rounds?: number) {
    super(roomId, scenario, profiles);
    this.maxDays = boundedRounds(rounds, scenario.defaultRounds, scenario.maxRounds, scenario.minRounds);
    const deck = deckForPlayerCount(profiles.length);
    this.deckName = deck.name;
    const shuffledIds = shuffle(profiles.map((profile) => profile.id));
    shuffledIds.forEach((id, index) => {
      const role = deck.roles[index];
      this.roles.set(id, role);
      this.alive.add(id);
      if (role === "seer") this.seerKnowledge.set(id, new Map());
      if (role === "spirit-seer") this.spiritKnowledge.set(id, new Map());
    });
    this.registerIdentityAssignments();
    this.discussion = this.createDiscussion();
    this.addLog(`身份已经分配（${deck.name}）。公开讨论开始，所有承诺都可能是策略。`, 1);
  }



  snapshot(): WorldSnapshot {
    return this.worldSnapshot({
      title: this.scenario.name,
      turn: this.day,
      totalTurns: this.maxDays,
      phase: phaseLabel(this.phase),
      summary: this.summary(),
      details: {
        deckName: this.deckName,
        roles: Object.fromEntries(this.roles),
        aliveIds: [...this.alive],
        // The badge is worn in the open: the sitting sheriff is public to every
        // viewer (agent, human seat, spectator), not only via the day log.
        ...(this.sheriffId ? { sheriffId: this.sheriffId } : {}),
        pendingVotes: Object.fromEntries(this.votes),
        pendingNightTargets: Object.fromEntries(this.wolfTargets),
        history: this.history,
        winners: this.winners,
        outcome: this.outcome,
        ...(this.jesterWon ? { jesterWon: true } : {}),
        ...(this.discussion ? { discussion: this.discussion.state() } : {}),
        suspicion: this.suspicion.snapshot()
      }
    });
  }

  /**
   * Hidden-choice phases seal the public token stream: a wolf's night
   * deliberation or a voter's reasoning would reveal the unresolved choice to
   * spectators. Only the open day discussion streams publicly.
   */
  publicStreamingAllowed(): boolean {
    return this.phase === "day-discussion";
  }

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const role = this.roles.get(actorId)!;
    const teammates = isWolfRole(role)
      ? [...this.roles].filter(([id, candidateRole]) => id !== actorId && isWolfRole(candidateRole)).map(([id]) => id)
      : [];
    const knowledge = role === "seer" ? Object.fromEntries(this.seerKnowledge.get(actorId) ?? []) : {};
    const spiritKnowledge = role === "spirit-seer" ? Object.fromEntries(this.spiritKnowledge.get(actorId) ?? []) : {};
    const wolfTarget = this.currentWolfTarget();
    const causality = this.socialCausalityFor(actorId);
    const privateContext: string[] = [
      `Your hidden role: ${roleLabel(role)}.`,
      `Your objective: ${this.rolesObjective(role)}`,
      ...(teammates.length ? [`Wolf teammates (you know each other): ${teammates.join(", ")}.`] : []),
      ...(role === "seer" ? [`Private investigations: ${Object.entries(knowledge).map(([id, knownRole]) => `${id}=${knownRole}`).join(", ") || "none"}.`] : []),
      ...(role === "spirit-seer" ? [
        `Private communions: ${Object.entries(spiritKnowledge).map(([id, knownRole]) => `${id}=${knownRole}`).join(", ") || "none"}.`,
        "Rules: 每晚查验一名已死亡玩家的真实身份；死者身份不会变化。"
      ] : []),
      ...(role === "nightmare" ? [
        `Tonight's curse: ${this.nightmareCurse === undefined ? "not decided" : this.nightmareCurse === null ? "skipped" : this.nightmareCurse}.`,
        "Rules: 被诅咒的玩家明天白天不能投票。"
      ] : []),
      ...(role === "wolf-beauty" ? [
        `Tonight's charm: ${this.charmTarget === undefined ? "not decided" : this.charmTarget === null ? "skipped" : this.charmTarget}.`,
        "Rules: 你被投票放逐时，被魅惑的玩家陪你一起出局；被夜杀或毒杀不触发。"
      ] : []),
      ...(role === "witch" ? [
        `Potions: 解药 ${this.antidoteAvailable ? "可用" : "已用"} · 毒药 ${this.poisonAvailable ? "可用" : "已用"}.`,
        ...(this.phase === "night" && wolfTarget ? [`Tonight the wolves are attacking: ${wolfTarget}.`] : []),
        "Rules: 解药不能救自己；解药与毒药不能在同一晚使用；被你毒杀的玩家死亡时不能发动技能。"
      ] : []),
      ...(role === "guard" ? [
        `Guard duty: 今晚你 ${this.guardTargetId ? `已守护 ${this.guardTargetId}` : "尚未守护"}.`,
        ...(this.lastGuardTargetId ? [`上一晚你守护了 ${this.lastGuardTargetId}，今晚不能连续守护同一人。`] : []),
        "Rules: 你的守护只挡狼人的夜袭，挡不住女巫的毒药；若与女巫解药同守同救同一目标，该目标仍会死亡。"
      ] : []),
      ...(role === "hunter" ? ["Rules: 你被投票放逐或被狼人夜袭时可以开枪带走一名玩家；被女巫毒杀不能开枪。"] : []),
      ...(role === "wolf-king" ? ["Rules: 你被投票放逐或被猎人击杀时可以开枪带走一名玩家；被女巫毒杀不能开枪。"] : []),
      ...(role === "jester" ? ["Rules: 只有被白天投票出局你才获胜；被毒杀、被夜袭或被开枪带走都不算。"] : []),
      "For an explicit identity claim in communicate.socialActs, use kind=assertion (or denial when claiming you are NOT something), proposition.kind=identity, predicate=has-role, subjectId=the claimed actor id, object=the role id. Link deceptionId only when executing your own recorded deception plan.",
      ...socialReferenceContext(causality),
      ...(this.sheriffId
        ? [`Sheriff: ${this.displayName(this.sheriffId)} — the sheriff's daytime elimination vote counts 1.5.`]
        : ["Sheriff: none this game."]),
      `Your vote: ${this.votes.get(actorId) ?? "not cast"}.`,
      `You are ${this.alive.has(actorId) ? "alive" : "eliminated"}.`
    ];
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.day,
      phase: this.phase,
      situation: `${situationFor(this.phase, role, this.alive.size, this.wolvesAlive().length)}${
        this.phase.startsWith("sheriff-") && this.sheriffCandidates.size
          ? `\nSheriff candidates: ${this.currentSheriffCandidates().map((id) => this.displayName(id)).join("、") || "（其余已退选）"}。`
          : ""
      }\nPublic suspicion climate: ${this.suspicion.climateText((id) => this.profiles.get(id)?.displayName ?? id)}`,
      privateContext: privateContext.filter(Boolean).join("\n"),
      self: { id: self.id, displayName: self.displayName, alive: this.alive.has(actorId), role },
      others: this.otherProfiles(actorId).map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        alive: this.alive.has(profile.id),
        status: this.statuses.get(profile.id) ?? "idle",
        ...(!this.alive.has(profile.id) ? { visibleRole: roleLabel(this.roles.get(profile.id)) } : {})
      })),
      recentMessages: this.visibleMessages(actorId).slice(-42),
      availableActions: this.availableActions(actorId, role)
    };
  }

  toolsFor(actorId: string): Tool<SocietyAgentContext>[] {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    // Targets must name a real participant. The enum surfaces the legal IDs in
    // the tool schema itself, so display names, hallucinated ids and stringified
    // "null" sentinels are rejected at parse time as retryable validation
    // feedback instead of wedging the turn inside the equality guard.
    const targetRef = z.enum([...this.roles.keys()] as [string, ...string[]]);
    const tools: Tool<SocietyAgentContext>[] = [];

    const vote = societyTool({
      name: "cast_day_vote",
      description: "Cast a sealed binding vote against one living participant. The vote is revealed only after everyone has voted.",
      parameters: z.object({
        targetId: targetRef,
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, "cast_day_vote", input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    });
    tools.push(vote as Tool<SocietyAgentContext>);

    // Sheriff election (day 1). All four tools are registered unconditionally:
    // the room snapshots a seat's toolset once at construction (before the
    // election even opens), so a phase-gated tool would be missing from the
    // agent exactly when its phase arrives — the engine guards phases in
    // performDomainAction instead.
    {
      const runTool = societyTool({
        name: "run_for_sheriff",
        description: "Day 1, sheriff election run phase (上警) only: decide whether to stand. Sealed until everyone has decided. Candidates campaign and cannot vote in the election; the elected sheriff's day vote counts 1.5x.",
        parameters: z.object({
          run: z.boolean(),
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "run_for_sheriff", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(runTool as Tool<SocietyAgentContext>);
    }
    {
      const withdrawTool = societyTool({
        name: "withdraw_sheriff_run",
        description: "Day 1, sheriff election withdraw phase only: withdraw from (or stay in) the race after the campaign speeches. The last remaining candidate cannot withdraw; withdrawn candidates still cannot vote.",
        parameters: z.object({
          withdraw: z.boolean(),
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "withdraw_sheriff_run", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(withdrawTool as Tool<SocietyAgentContext>);
    }
    {
      const sheriffVote = societyTool({
        name: "cast_sheriff_vote",
        description: "Day 1, sheriff election vote phase only: cast a sealed ballot for one of the sheriff candidates. Only players who never ran may vote. Revealed after everyone has voted.",
        parameters: z.object({
          targetId: targetRef,
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "cast_sheriff_vote", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(sheriffVote as Tool<SocietyAgentContext>);
    }
    {
      const passBadge = societyTool({
        name: "pass_badge",
        description: "Dying sheriff only: hand the badge to one living participant (targetId) or tear it (tear=true — no sheriff for the rest of the game).",
        parameters: z.object({
          targetId: targetRef.optional(),
          tear: z.boolean().optional(),
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "pass_badge", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(passBadge as Tool<SocietyAgentContext>);
    }

    if (isWolfRole(role)) {
      const chooseNightTarget = societyTool({
        name: "choose_night_target",
        description: "Nominate one living non-wolf as the pack's night attack target. Each wolf submits independently and the pack majority decides.",
        parameters: z.object({
          targetId: targetRef,
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "choose_night_target", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(chooseNightTarget as Tool<SocietyAgentContext>);
    }
    if (role === "seer") {
      const investigate = societyTool({
        name: "investigate_identity",
        description: "Privately inspect one other living participant. The result is private evidence and must not be treated as public knowledge.",
        parameters: z.object({
          targetId: targetRef,
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "investigate_identity", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(investigate as Tool<SocietyAgentContext>);
    }
    if (role === "spirit-seer") {
      const investigateDead = societyTool({
        name: "investigate_dead_identity",
        description: "Inspect one dead participant's true role. The result remains private unless you later choose to disclose it.",
        parameters: z.object({
          targetId: targetRef,
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "investigate_dead_identity", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(investigateDead as Tool<SocietyAgentContext>);
    }
    if (role === "nightmare") {
      const curse = societyTool({
        name: "dream_curse",
        description: "Curse one living non-wolf so they cannot vote tomorrow, or pass with targetId=null.",
        parameters: z.object({
          targetId: targetRef.nullable().default(null),
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "dream_curse", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(curse as Tool<SocietyAgentContext>);
    }
    if (role === "wolf-beauty") {
      const charm = societyTool({
        name: "charm_target",
        description: "Charm one living non-wolf who will die with you if you are voted out tomorrow, or pass with targetId=null.",
        parameters: z.object({
          targetId: targetRef.nullable().default(null),
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "charm_target", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(charm as Tool<SocietyAgentContext>);
    }
    if (role === "witch") {
      const witchChoice = societyTool({
        name: "witch_night_choice",
        description: "Use one potion tonight: save the wolf victim with the antidote (not yourself), poison one living player, or pass with targetId=null. The two potions can never be used in the same night.",
        parameters: z.object({
          action: z.enum(["save", "poison", "pass"]),
          targetId: targetRef.nullable(),
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          // The flat action field is the single source of truth: the domain
          // payload derives saveTargetId/poisonTargetId from it, so a model can
          // never submit save and poison at once (the world still backstops).
          const saveTargetId = input.action === "save" ? input.targetId : null;
          const poisonTargetId = input.action === "poison" ? input.targetId : null;
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "witch_night_choice", {
            action: input.action,
            targetId: input.targetId,
            saveTargetId,
            poisonTargetId,
            reason: input.reason
          });
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(witchChoice as Tool<SocietyAgentContext>);
    }
    if (role === "guard") {
      const guard = societyTool({
        name: "guard_tonight",
        description: "Guard one living participant or pass with targetId=null. You may guard yourself, cannot repeat last night's target, and protection does not stop poison.",
        parameters: z.object({
          targetId: targetRef.nullable().default(null),
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "guard_tonight", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(guard as Tool<SocietyAgentContext>);
    }
    if (role === "hunter") {
      tools.push(this.deathShotTool(actorId, "hunter_shoot", "You are dying. Shoot one living participant or hold. A hunter who is poisoned cannot shoot."));
    }
    if (role === "wolf-king") {
      tools.push(this.deathShotTool(actorId, "wolf_king_shoot", "You are dying. Take one living participant with you or hold."));
    }
    // Hidden-identity worlds get the role-probability ledger: suspicion stays
    // a distribution, not a free-text hunch.
    if (role === "knight" && !this.knightUsed) {
      const duel = societyTool({
        name: "knight_challenge",
        description: "Use the knight's one challenge or pass with targetId=null. A wolf target dies; a non-wolf target causes your own death.",
        parameters: z.object({
          targetId: targetRef.nullable().default(null),
          reason: z.string().min(1).max(2_000)
        }).strict(),
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, "knight_challenge", input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      });
      tools.push(duel as Tool<SocietyAgentContext>);
    }
    tools.push(roleHypothesisTool(actorId));
    return tools;
  }

  private deathShotTool(
    actorId: string,
    action: "hunter_shoot" | "wolf_king_shoot",
    description: string
  ): Tool<SocietyAgentContext> {
    return societyTool({
      name: action,
      description,
      parameters: z.object({
        targetId: z.enum([...this.roles.keys()] as [string, ...string[]]).nullable().default(null),
        reason: z.string().min(1).max(2_000)
      }).strict(),
      execute: async (input, runContext) => {
        const context = scopedContext(runContext, actorId);
        const commit = await this.performAction(actorId, action, input);
        emitAction(context, commit.action, commit.detail);
        return commit.result;
      }
    }) as Tool<SocietyAgentContext>;
  }

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    // The dying sheriff owes the badge a decision even though they are no
    // longer alive — without this spec the human seat would have no action.
    if (this.pendingBadgePass[0] === actorId) {
      return [{
        name: "pass_badge",
        label: "移交警徽",
        description: "把警徽移交给一名存活玩家（targetId），或撕掉警徽（tear: true，本局不再有警长）。",
        kind: "target",
        field: "targetId",
        targetFilter: "any-living"
      }];
    }
    if (!this.alive.has(actorId)) return [];
    if (this.phase === "sheriff-run" && !this.sheriffRunDecided.has(actorId)) {
      return [{
        name: "run_for_sheriff",
        label: "上警决定",
        description: "决定是否竞选警长：警长的白天投票计 1.5 票；竞选者发言但不投票。",
        kind: "choice",
        field: "run"
      }];
    }
    if (this.phase === "sheriff-withdraw" && this.sheriffCandidates.has(actorId) && !this.sheriffWithdrawn.has(actorId)) {
      return [{
        name: "withdraw_sheriff_run",
        label: "退选决定",
        description: "竞选演讲结束：退选或留任。最后一名竞选者不能退选。",
        kind: "choice",
        field: "withdraw"
      }];
    }
    if (this.phase === "sheriff-vote" && !this.sheriffCandidates.has(actorId) && !this.sheriffVotes.has(actorId)) {
      return [{
        name: "cast_sheriff_vote",
        label: "警长投票",
        description: "为一名竞选人投票；所有人提交后统一公开。",
        kind: "target",
        field: "targetId",
        targetFilter: "any-living"
      }];
    }
    if (this.phase === "day-knight" && role === "knight" && !this.knightUsed) {
      return [{
        name: "knight_challenge",
        label: "发起决斗",
        description: "选择一名玩家决斗：是狼人则对方被淘汰，否则你自己死亡；也可以跳过。",
        kind: "target",
        field: "targetId",
        targetFilter: "any-living"
      }];
    }
    if (this.phase === "day-vote" && !this.votes.has(actorId)) {
      return [{
        name: "cast_day_vote",
        label: "提交投票",
        description: "投票在所有存活玩家提交后统一公开。",
        kind: "target",
        field: "targetId",
        targetFilter: "any-living"
      }];
    }
    if (this.phase === "night") {
      if (isWolfRole(role) && !this.wolfTargets.has(actorId)) {
        return [{
          name: "choose_night_target",
          label: "选择夜袭目标",
          description: "提名一名存活的非狼人玩家。",
          kind: "target",
          field: "targetId",
          targetFilter: "non-wolf"
        }];
      }
      if (role === "seer" && !this.seerTargets.has(actorId)) {
        return [{
          name: "investigate_identity",
          label: "查验身份",
          description: "查验另一名存活玩家；结果仅你可见。",
          kind: "target",
          field: "targetId",
          targetFilter: "other-living"
        }];
      }
      if (role === "witch" && !this.witchChoiceMade() && (this.antidoteAvailable || this.poisonAvailable)) {
        return [{
          name: "witch_night_choice",
          label: "使用药水",
          description: "选择救人、毒人或跳过。",
          kind: "choice",
          field: "saveTargetId"
        }];
      }
      if (role === "guard" && !this.guardTargetId) {
        return [{
          name: "guard_tonight",
          label: "守护目标",
          description: "选择今晚守护的对象，或跳过。",
          kind: "target",
          field: "targetId",
          targetFilter: "any-living"
        }];
      }
      if (role === "nightmare" && this.nightmareCurse === undefined) {
        return [{
          name: "dream_curse",
          label: "诅咒目标",
          description: "诅咒一名存活玩家，次日白天 TA 不能投票；也可以跳过。",
          kind: "target",
          field: "targetId",
          targetFilter: "any-living"
        }];
      }
      if (role === "wolf-beauty" && this.charmTarget === undefined) {
        return [{
          name: "charm_target",
          label: "魅惑目标",
          description: "魅惑一名存活玩家；若你被放逐，TA 会陪你出局；也可以跳过或改换目标。",
          kind: "target",
          field: "targetId",
          targetFilter: "any-living"
        }];
      }
      if (role === "spirit-seer" && !this.spiritTargets.has(actorId)) {
        return [{
          name: "investigate_dead_identity",
          label: "通灵查验",
          description: "查验一名已死亡玩家的真实身份；结果仅你可见。",
          kind: "target",
          field: "targetId",
          targetFilter: "any-dead"
        }];
      }
    }
    return [];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    const value = recordPayload(payload);
    const targetId = typeof value.targetId === "string" && value.targetId ? value.targetId : undefined;
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    // Death shots and the badge pass belong to a dying actor: they are legal
    // even though the actor just left the alive set.
    if (action !== "hunter_shoot" && action !== "wolf_king_shoot" && action !== "pass_badge") this.assertActiveActor(actorId);

    if (action === "knight_challenge") {
      if (this.phase !== "day-knight" || role !== "knight" || this.knightUsed) throw new Error("KNIGHT_NOT_READY: The daytime duel is not available now.");
      const duelTarget = recordPayload(payload)?.targetId as string | undefined;
      const commandId = `cmd-${randomUUID()}`;
      this.knightCommandId = commandId;
      if (!duelTarget) {
        // The knight gives up the chance; the vote opens.
        this.knightUsed = true;
        this.knightTargetId = undefined;
        this.knightTargetWasWolf = undefined;
        this.addLog(`${this.profiles.get(actorId)?.displayName} 放弃了骑士决斗机会。`, this.day);
        this.phase = "day-vote";
        this.emitUpdate();
        return { action, commandId, detail: `${actorId}; passed`, result: { accepted: true, passed: true } };
      }
      this.assertLivingTarget(duelTarget);
      if (duelTarget === actorId) throw new Error("INVALID_KNIGHT_TARGET: You may not challenge yourself.");
      this.knightUsed = true;
      const targetRole = this.roles.get(duelTarget);
      const targetIsWolf = isWolfRole(targetRole);
      this.knightTargetId = duelTarget;
      this.knightTargetWasWolf = targetIsWolf;
      const victimId = targetIsWolf ? duelTarget : actorId;
      const knightName = this.profiles.get(actorId)?.displayName ?? actorId;
      const targetName = this.profiles.get(duelTarget)?.displayName ?? duelTarget;
      this.alive.delete(victimId);
      this.pushEliminationEvents(victimId, "knight", this.roles.get(victimId));
      const text = targetIsWolf
        ? `${knightName} 发起决斗：${targetName} 是狼人，被当场淘汰！`
        : `${knightName} 发起决斗：${targetName} 并不是狼人——${knightName} 力战身亡。`;
      this.addLog(text, this.day, targetIsWolf ? "hidden-role-revealed" : "adverse-outcome");
      this.suspicion.noteResolved(this.day, victimId);
      if (this.wolvesAlive().length === 0) {
        this.endGame(this.factionMembers(["seer", "witch", "hunter", "knight", "guard", "idiot", "villager"]), "所有狼人都已出局，村庄阵营获胜。");
        return { action, commandId, detail: `${actorId}; ${duelTarget}`, result: { accepted: true, targetId: duelTarget, targetIsWolf } };
      }
      if (this.wolvesHaveParity()) {
        this.endGame(this.factionMembers(["wolf", "wolf-king", "hidden-wolf", "white-wolf-king", "wolf-beauty", "nightmare"]), "狼人已经控制投票数量，狼人阵营获胜。");
        return { action, commandId, detail: `${actorId}; ${duelTarget}`, result: { accepted: true, targetId: duelTarget, targetIsWolf } };
      }
      this.phase = "day-vote";
      this.emitUpdate();
      return { action, commandId, detail: `${actorId}; ${duelTarget}`, result: { accepted: true, targetId: duelTarget, targetIsWolf } };
    }
    if (action === "cast_day_vote") {
      if (this.idiotRevealed.has(actorId)) throw new Error("IDIOT_CANNOT_VOTE: 白痴翻牌后失去投票权，只能发言。");
      if (this.nightmareCurse === actorId) throw new Error("NIGHTMARE_CURSED: 梦魇的诅咒让你今天无法投票。");
      if (!targetId) throw new Error("TARGET_REQUIRED: Select a participant.");
      this.assertLivingTarget(targetId);
      if (this.phase !== "day-vote") throw new Error("VOTE_NOT_OPEN: Daytime voting is not open.");
      if (this.votes.has(actorId)) throw new Error("VOTE_ALREADY_CAST: Your vote is fixed.");
      const commandId = `cmd-${randomUUID()}`;
      this.votes.set(actorId, targetId);
      this.voteCommandIds.set(actorId, commandId);
      this.emitUpdate();
      return { action, commandId, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, targetId } };
    }
    if (action === "run_for_sheriff") {
      if (this.phase !== "sheriff-run") throw new Error("SHERIFF_ELECTION_NOT_OPEN: 上警阶段已结束。");
      if (this.sheriffRunDecided.has(actorId)) throw new Error("SHERIFF_RUN_LOCKED: 你的上警决定已锁定。");
      const run = value.run === true;
      const commandId = `cmd-${randomUUID()}`;
      this.sheriffRunDecided.add(actorId);
      if (run) this.sheriffCandidates.add(actorId);
      this.emitUpdate();
      return { action, commandId, detail: run ? "run" : "skip", result: { accepted: true, run } };
    }
    if (action === "withdraw_sheriff_run") {
      if (this.phase !== "sheriff-withdraw") throw new Error("SHERIFF_WITHDRAW_NOT_OPEN: 退选阶段未开放。");
      if (!this.sheriffCandidates.has(actorId) || this.sheriffWithdrawn.has(actorId)) throw new Error("SHERIFF_WITHDRAW_FORBIDDEN: 只有当前候选人可以退选。");
      if (this.sheriffWithdrawDecided.has(actorId)) throw new Error("SHERIFF_WITHDRAW_LOCKED: 你的退选决定已锁定。");
      const withdraw = value.withdraw === true;
      const remaining = this.currentSheriffCandidates();
      if (withdraw && remaining.length === 1 && remaining[0] === actorId) {
        throw new Error("LAST_CANDIDATE_CANNOT_WITHDRAW: 你是最后一名竞选者，必须留任并直接当选警长。");
      }
      const commandId = `cmd-${randomUUID()}`;
      this.sheriffWithdrawDecided.add(actorId);
      if (withdraw) this.sheriffWithdrawn.add(actorId);
      this.emitUpdate();
      return { action, commandId, detail: withdraw ? "withdraw" : "stay", result: { accepted: true, withdraw } };
    }
    if (action === "cast_sheriff_vote") {
      if (this.phase !== "sheriff-vote") throw new Error("SHERIFF_VOTE_NOT_OPEN: 警长竞选投票未开放。");
      if (this.sheriffCandidates.has(actorId)) throw new Error("SHERIFF_CANDIDATE_CANNOT_VOTE: 竞选者（含已退选者）不能参与警长投票。");
      if (!targetId) throw new Error("TARGET_REQUIRED: Select a candidate.");
      if (!this.sheriffCandidates.has(targetId) || this.sheriffWithdrawn.has(targetId)) throw new Error("INVALID_SHERIFF_VOTE_TARGET: 只能投给当前候选人。");
      if (this.sheriffVotes.has(actorId)) throw new Error("SHERIFF_VOTE_ALREADY_CAST: 你的警长票已锁定。");
      const commandId = `cmd-${randomUUID()}`;
      this.sheriffVotes.set(actorId, targetId);
      this.sheriffVoteCommandIds.set(actorId, commandId);
      this.emitUpdate();
      return { action, commandId, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, targetId } };
    }
    if (action === "pass_badge") {
      if (this.pendingBadgePass[0] !== actorId) throw new Error("BADGE_PASS_FORBIDDEN: 只有正在离场的警长可以处置警徽。");
      const tear = value.tear === true;
      if (!tear && !targetId) throw new Error("BADGE_DECISION_REQUIRED: 提供 targetId 移交警徽，或 tear=true 撕掉警徽。");
      if (tear && targetId) throw new Error("BADGE_DECISION_CONFLICT: 撕警徽时不能同时指定移交目标。");
      if (!tear) {
        this.assertLivingTarget(targetId!);
        if (targetId === actorId) throw new Error("INVALID_BADGE_TARGET: 不能把警徽移交给自己。");
      }
      this.pendingBadgePass.shift();
      const sheriffName = this.displayName(actorId);
      if (tear) {
        this.addLog(`${sheriffName} 撕掉了警徽——本局从此没有警长。`, this.day);
        this.setLastExperiences(`${sheriffName} 撕掉了警徽，本局从此没有警长。`);
      } else {
        this.sheriffId = targetId;
        const newSheriffName = this.displayName(targetId!);
        this.addLog(`${sheriffName} 在离场前把警徽移交给了 ${newSheriffName}——TA 的白天投票计 1.5 票。`, this.day);
        this.setLastExperiences(`${sheriffName} 把警徽移交给了 ${newSheriffName}：TA 的白天投票计 1.5 票。`);
        this.pushEvent(targetId!, {
          type: "endorsed",
          targetId,
          facts: { sheriff: true },
          detail: `前任警长在弥留之际把警徽交给了你——你的白天投票计 1.5 票，出局时需移交警徽或撕掉。`
        });
      }
      this.emitUpdate();
      return { action, commandId: `cmd-${randomUUID()}`, detail: tear ? "tear" : `${targetId}`, result: { accepted: true, ...(tear ? { tear: true } : { targetId }) } };
    }
    if (action === "choose_night_target") {
      if (!targetId) throw new Error("TARGET_REQUIRED: Select a participant.");
      this.assertLivingTarget(targetId);
      if (this.phase !== "night" || !isWolfRole(role)) throw new Error("NIGHT_ACTION_FORBIDDEN: Only a living wolf can choose this target at night.");
      if (targetId === actorId) throw new Error("INVALID_WOLF_TARGET: You may not nominate yourself.");
      if (isWolfRole(this.roles.get(targetId))) throw new Error("INVALID_WOLF_TARGET: Choose a living non-wolf participant.");
      if (this.wolfTargets.has(actorId)) throw new Error("NIGHT_TARGET_ALREADY_CHOSEN: Your nomination is fixed.");
      const commandId = `cmd-${randomUUID()}`;
      this.wolfTargets.set(actorId, targetId);
      this.wolfTargetCommandIds.set(actorId, commandId);
      this.emitUpdate();
      return { action, commandId, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, targetId } };
    }
    if (action === "investigate_identity") {
      if (!targetId) throw new Error("TARGET_REQUIRED: Select a participant.");
      this.assertLivingTarget(targetId);
      if (this.phase !== "night" || role !== "seer") throw new Error("INVESTIGATION_FORBIDDEN: Only a living seer can investigate at night.");
      if (targetId === actorId) throw new Error("INVALID_INVESTIGATION_TARGET: Choose another living participant.");
      if (this.seerTargets.has(actorId)) throw new Error("INVESTIGATION_ALREADY_USED: Your investigation is fixed for tonight.");
      const targetRole = this.roles.get(targetId)!;
      // The hidden wolf reads as a villager through the seer's eyes.
      const perceivedRole = targetRole === "hidden-wolf" ? "villager" : targetRole;
      const commandId = `cmd-${randomUUID()}`;
      this.seerTargets.set(actorId, targetId);
      this.seerTargetCommandIds.set(actorId, commandId);
      this.seerKnowledge.get(actorId)?.set(targetId, perceivedRole);
      this.recordIdentityObservation(actorId, targetId, perceivedRole, commandId);
      this.emitUpdate();
      return { action, commandId, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, targetId, role: perceivedRole } };
    }
    if (action === "investigate_dead_identity") {
      if (this.phase !== "night" || role !== "spirit-seer") throw new Error("SPIRIT_INVESTIGATION_FORBIDDEN: Only a living spirit seer can commune with the dead at night.");
      if (this.spiritTargets.has(actorId)) throw new Error("SPIRIT_INVESTIGATION_ALREADY_USED: Your communion for tonight is fixed.");
      if (!targetId) throw new Error("TARGET_REQUIRED: Select a participant.");
      if (!this.profiles.has(targetId)) throw new Error("TARGET_NOT_FOUND: Unknown participant.");
      if (this.alive.has(targetId)) throw new Error("INVALID_SPIRIT_TARGET: The spirit seer reads the dead, not the living.");
      if (targetId === actorId) throw new Error("INVALID_SPIRIT_TARGET: You cannot commune with yourself.");
      const targetRole = this.roles.get(targetId)!;
      const commandId = `cmd-${randomUUID()}`;
      this.spiritTargets.set(actorId, targetId);
      this.spiritTargetCommandIds.set(actorId, commandId);
      this.spiritKnowledge.get(actorId)?.set(targetId, targetRole);
      this.recordIdentityObservation(actorId, targetId, targetRole, commandId);
      this.emitUpdate();
      return { action, commandId, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, targetId, role: targetRole } };
    }
    if (action === "dream_curse") {
      if (this.phase !== "night" || role !== "nightmare") throw new Error("NIGHTMARE_FORBIDDEN: Only the living nightmare may curse at night.");
      if (this.nightmareCurse !== undefined) throw new Error("NIGHTMARE_CURSE_LOCKED: Your curse for tonight is fixed.");
      const commandId = `cmd-${randomUUID()}`;
      if (targetId) {
        this.assertLivingTarget(targetId);
        if (targetId === actorId) throw new Error("INVALID_CURSE_TARGET: You may not curse yourself.");
        if (isWolfRole(this.roles.get(targetId))) throw new Error("INVALID_CURSE_TARGET: Curse a non-wolf.");
        this.nightmareCurse = targetId;
      } else {
        this.nightmareCurse = null;
      }
      this.nightmareCurseCommandId = commandId;
      this.emitUpdate();
      return { action, commandId, detail: targetId ?? "skip", result: { accepted: true, targetId } };
    }
    if (action === "charm_target") {
      if (this.phase !== "night" || role !== "wolf-beauty") throw new Error("CHARM_FORBIDDEN: Only the living wolf beauty may charm at night.");
      if (this.charmTarget !== undefined) throw new Error("CHARM_LOCKED: Your charm for tonight is fixed.");
      const commandId = `cmd-${randomUUID()}`;
      if (targetId) {
        this.assertLivingTarget(targetId);
        if (targetId === actorId) throw new Error("INVALID_CHARM_TARGET: You may not charm yourself.");
        if (isWolfRole(this.roles.get(targetId))) throw new Error("INVALID_CHARM_TARGET: Charm a non-wolf.");
        this.charmTarget = targetId;
      } else {
        this.charmTarget = null;
      }
      this.charmCommandId = commandId;
      this.emitUpdate();
      return { action, commandId, detail: targetId ?? "skip", result: { accepted: true, targetId } };
    }
    if (action === "witch_night_choice") {
      if (this.phase !== "night" || role !== "witch") throw new Error("WITCH_ACTION_FORBIDDEN: Only the living witch may use potions at night.");
      if (this.witchChoiceMade()) throw new Error("WITCH_CHOICE_LOCKED: Your decision for tonight is fixed.");
      const saveTargetId = typeof value.saveTargetId === "string" && value.saveTargetId ? value.saveTargetId : undefined;
      const poisonTargetId = typeof value.poisonTargetId === "string" && value.poisonTargetId ? value.poisonTargetId : undefined;
      const commandId = `cmd-${randomUUID()}`;
      if (saveTargetId && poisonTargetId) throw new Error("WITCH_BOTH_POTIONS_FORBIDDEN: 解药与毒药不能在同一晚使用。");
      if (saveTargetId && !this.antidoteAvailable) throw new Error("ANTIDOTE_USED: 解药已经用过了。");
      if (poisonTargetId && !this.poisonAvailable) throw new Error("POISON_USED: 毒药已经用过了。");
      if (saveTargetId === actorId) throw new Error("WITCH_NO_SELF_SAVE: 解药不能救自己。");
      if (saveTargetId) {
        this.assertLivingTarget(saveTargetId);
        this.witchSaveId = saveTargetId;
        this.antidoteAvailable = false;
      }
      if (poisonTargetId) {
        this.assertLivingTarget(poisonTargetId);
        this.witchPoisonId = poisonTargetId;
        this.poisonAvailable = false;
      }
      this.witchActed = true;
      this.witchCommandId = commandId;
      this.emitUpdate();
      return {
        action,
        commandId,
        detail: saveTargetId ? `解药 → ${saveTargetId}` : poisonTargetId ? `毒药 → ${poisonTargetId}` : "pass",
        result: { accepted: true, saveTargetId, poisonTargetId }
      };
    }
    if (action === "guard_tonight") {
      if (this.phase !== "night" || role !== "guard") throw new Error("GUARD_ACTION_FORBIDDEN: Only the living guard may protect at night.");
      if (this.guardTargetId) throw new Error("GUARD_ALREADY_CHOSEN: Your guard choice for tonight is fixed.");
      const commandId = `cmd-${randomUUID()}`;
      if (targetId) {
        this.assertLivingTarget(targetId);
        if (targetId === this.lastGuardTargetId) throw new Error("GUARD_REPEAT_FORBIDDEN: 不能连续两晚守护同一名玩家。");
        this.guardTargetId = targetId;
      } else {
        this.guardTargetId = "__none__";
      }
      this.guardCommandId = commandId;
      this.emitUpdate();
      return { action, commandId, detail: targetId ?? "skip", result: { accepted: true, targetId } };
    }
    if (action === "hunter_shoot" || action === "wolf_king_shoot") {
      const pending = this.pendingShots.find((entry) => entry.shooterId === actorId);
      if (!pending) throw new Error("SHOT_NOT_PENDING: You are not currently resolving a death shot.");
      if (action === "hunter_shoot" && pending.kind !== "hunter") throw new Error("SHOT_ROLE_MISMATCH: Your pending shot is not a hunter shot.");
      if (action === "wolf_king_shoot" && pending.kind !== "wolf-king") throw new Error("SHOT_ROLE_MISMATCH: Your pending shot is not a wolf-king shot.");
      const commandId = `cmd-${randomUUID()}`;
      this.shotCommandIds.set(actorId, commandId);
      this.shotTargetIds.set(actorId, targetId ?? null);
      this.shotKinds.set(actorId, pending.kind);
      this.resolveShot(actorId, targetId);
      return { action, commandId, detail: targetId ?? "压枪（不开枪）", result: { accepted: true, targetId } };
    }
    throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
    // A dead sheriff owes the badge decision before anything else moves: the
    // hand-over (or the tearing) is the table's next public fact.
    const badgeSheriff = this.pendingBadgePass[0];
    if (badgeSheriff) {
      return {
        id: `ww:${this.day}:badge:${badgeSheriff}`,
        label: `${this.profiles.get(badgeSheriff)?.displayName ?? badgeSheriff} 移交警徽`,
        actorIds: [badgeSheriff],
        mode: "sequential",
        instructionFor: () =>
          "You are the dying sheriff. Decide the badge's fate: call pass_badge with targetId to hand it to one living participant, or with tear=true to destroy it — a torn badge means no sheriff for the rest of the game."
      };
    }
    // Last words first: a voted-out player states their final public case
    // before any death skill fires or the day moves on.
    const lastWordsSpeaker = this.pendingLastWords[0];
    if (lastWordsSpeaker) {
      return {
        id: `ww:${this.day}:lastwords:${lastWordsSpeaker}`,
        label: `${this.profiles.get(lastWordsSpeaker)?.displayName ?? lastWordsSpeaker} 的遗言`,
        actorIds: [lastWordsSpeaker],
        mode: "sequential",
        instructionFor: () =>
          "You have been voted out. You have ONE final public statement (遗言): a role claim, an accusation, a hint for your side — or a dignified silence. Call communicate once on the public channel; nothing else is possible now."
      };
    }
    // Death skills resolve before anything else — the room must not advance the
    // phase while a hunter or wolf-king still has a pending shot.
    const pendingShot = this.pendingShots[0];
    if (pendingShot) {
      const shooter = this.roles.get(pendingShot.shooterId);
      const isHunter = shooter === "hunter";
      return {
        id: `ww:${this.day}:shot:${pendingShot.shooterId}`,
        label: `${this.profiles.get(pendingShot.shooterId)?.displayName ?? pendingShot.shooterId} 临死抉择`,
        actorIds: [pendingShot.shooterId],
        mode: "sequential",
        instructionFor: () => isHunter
          ? "You are dying as the hunter. Call hunter_shoot once: choose one living participant to take with you, or omit targetId to hold the shot. You were not poisoned, so the shot is yours to decide."
          : "You are dying as the wolf king. Call wolf_king_shoot once: choose one living participant to take with you, or omit targetId to hold the shot. You were not poisoned, so the shot is yours to decide."
      };
    }
    const aliveIds = [...this.alive];
    if (this.phase === "sheriff-run") {
      return {
        id: "ww:1:sheriff-run",
        label: "警长竞选 · 上警",
        actorIds: aliveIds,
        mode: "parallel",
        instructionFor: () =>
          "The sheriff election (警长竞选) opens. Decide whether to run: call run_for_sheriff with run=true to stand, or run=false to abstain. The elected sheriff's daytime elimination vote counts 1.5x and decides the badge's fate when dying; candidates give campaign speeches and do not vote in the election."
      };
    }
    if (this.phase === "sheriff-campaign") {
      return {
        id: "ww:1:sheriff-campaign",
        label: "警长竞选 · 竞选发言",
        actorIds: this.currentSheriffCandidates(),
        mode: "sequential",
        instructionFor: () =>
          "You are running for sheriff. Give your campaign speech (竞选演讲): why should the village trust you with the badge and the 1.5x vote? Claim experience, read the table, or make your case. Call communicate once on the public channel."
      };
    }
    if (this.phase === "sheriff-withdraw") {
      return {
        id: "ww:1:sheriff-withdraw",
        label: "警长竞选 · 退选",
        actorIds: this.currentSheriffCandidates(),
        mode: "parallel",
        instructionFor: () =>
          "The campaign speeches are done. You may withdraw from the election (call withdraw_sheriff_run with withdraw=true) or stay on the ballot (withdraw=false). The last remaining candidate cannot withdraw — they become sheriff directly. Withdrawn candidates still cannot vote in the election."
      };
    }
    if (this.phase === "sheriff-vote") {
      const reVote = this.sheriffPkCandidates.length > 0;
      return {
        id: "ww:1:sheriff-vote",
        label: reVote ? "警长竞选 · 重新投票" : "警长竞选 · 投票",
        actorIds: this.sheriffElectorate(),
        mode: "parallel",
        instructionFor: () => reVote
          ? "The tied candidates have made their PK speeches. Call cast_sheriff_vote exactly once for one of the candidates. A second tie leaves the village without a sheriff."
          : "Elect the sheriff: call cast_sheriff_vote exactly once for one of the candidates on the ballot. Candidates do not vote; the elected sheriff's daytime elimination vote counts 1.5x."
      };
    }
    if (this.phase === "sheriff-pk") {
      return {
        id: "ww:1:sheriff-pk",
        label: "警长竞选 · 平票 PK",
        actorIds: [...this.sheriffPkCandidates],
        mode: "sequential",
        instructionFor: () =>
          "The sheriff election tied and you are one of the tied candidates. Give your PK speech (平票陈词): your final case for the badge. The electors re-vote right after both speeches. Call communicate once on the public channel."
      };
    }
    if (this.phase === "day-discussion") {
      if (!this.discussion) this.discussion = this.createDiscussion();
      const actors = this.discussion.nextWave();
      if (actors.length === 0) {
        this.discussion = null;
        if (this.knightReady()) {
          this.phase = "day-knight";
          this.emitUpdate();
          return this.knightActivation();
        }
        this.phase = "day-vote";
        this.emitUpdate();
        return this.voteActivation();
      }
      const wave = this.discussion.waveNumber;
      return {
        id: `ww:${this.day}:discussion:${wave}`,
        label: wave === 1 ? `第 ${this.day} 天讨论` : `第 ${this.day} 天讨论 · 回应第 ${wave - 1} 轮`,
        actorIds: actors,
        mode: "sequential",
        instructionFor: (_actorId) => wave === 1
          ? "Opening round of the day. Share your read of the situation: what you observed, who you trust or suspect, what you want to know. Ask questions, test others, or stay reserved — but do not cast a vote yet."
          : "The discussion is live and people have reacted. Respond to what was actually said: answer questions directed at you, defend yourself if accused, challenge weak claims, support allies, or expose contradictions. You may also stay silent if you have nothing new to add. Do not cast a vote yet."
      };
    }
    if (this.phase === "day-knight") return this.knightActivation();
    if (this.phase === "day-pk") {
      return {
        id: `ww:${this.day}:pk`,
        label: `第 ${this.day} 天平票 PK`,
        actorIds: [...this.pkCandidates],
        mode: "sequential",
        instructionFor: (_actorId) =>
          "The vote tied and you are one of the two accused. This is your PK speech (平票陈词): state your final case to the village — defend yourself, present your evidence, counter the other candidate. The table re-votes right after both speeches; you will not vote. Call communicate once on the public channel."
      };
    }
    if (this.phase === "day-vote") return this.voteActivation();
    return this.nightActivation(aliveIds);
  }

  private knightReady(): boolean {
    if (this.knightUsed) return false;
    return [...this.roles].some(([id, role]) => role === "knight" && this.alive.has(id));
  }

  private knightActivation(): WorldActivation {
    const knightEntry = [...this.roles].find(([id, role]) => role === "knight" && this.alive.has(id));
    const knightId = knightEntry?.[0] ?? "";
    return {
      id: `ww:${this.day}:knight`,
      label: `第 ${this.day} 天骑士决斗`,
      actorIds: [knightId],
      mode: "sequential",
      instructionFor: () => "讨论结束，投票开始前是你唯一的决斗时刻。可以挑战一名最可疑的存活玩家：若对方是狼人，TA 当场出局；若不是，你会倒下。也可以省略 targetId 放弃这次机会。"
    };
  }

  private voteActivation(): WorldActivation {
    const reVote = this.pkCandidates.length > 0;
    return {
      id: `ww:${this.day}:vote`,
      label: reVote ? `第 ${this.day} 天重新投票（PK 后）` : `第 ${this.day} 天投票`,
      actorIds: [...this.alive].filter((id) => !this.idiotRevealed.has(id) && id !== this.nightmareCurse && !this.pkCandidates.includes(id)),
      mode: "parallel",
      instructionFor: () => reVote
        ? "The tied candidates have made their PK speeches. You must call cast_day_vote exactly once against a living participant — the two candidates do not vote. A second tie eliminates nobody."
        : "The discussion is closed. You must call cast_day_vote exactly once against a living participant. Consider not only hidden roles but how every faction benefits from being suspected or eliminated."
    };
  }

  /** Night order: wolves → guard → seer → witch (published board order). */
  private nightActivation(aliveIds: string[]): WorldActivation {
    const ordered: string[] = [];
    for (const id of aliveIds) if (isWolfRole(this.roles.get(id)) && !this.nightActionCommitted(id)) ordered.push(id);
    for (const id of aliveIds) if (this.roles.get(id) === "guard" && !this.guardTargetId) ordered.push(id);
    for (const id of aliveIds) if (this.roles.get(id) === "seer" && !this.seerTargets.has(id)) ordered.push(id);
    for (const id of aliveIds) if (this.roles.get(id) === "spirit-seer" && !this.spiritTargets.has(id)) ordered.push(id);
    for (const id of aliveIds) {
      if (this.roles.get(id) === "witch" && !this.witchChoiceMade() && (this.antidoteAvailable || this.poisonAvailable)) ordered.push(id);
    }
    return {
      id: `ww:${this.day}:night`,
      label: `第 ${this.day} 夜`,
      actorIds: ordered,
      mode: "sequential",
      instructionFor: (actorId) => {
        const role = this.roles.get(actorId);
        if (role === "nightmare") return "Complete both night duties in this turn: call choose_night_target exactly once, then call dream_curse exactly once against a living non-wolf or pass with targetId=null.";
        if (role === "wolf-beauty") return "Complete both night duties in this turn: call choose_night_target exactly once, then call charm_target exactly once against a living non-wolf or pass with targetId=null.";
        if (isWolfRole(role)) return "Use the private team channel if coordination is useful, then call choose_night_target exactly once against a living non-wolf.";
        if (role === "guard") return "Call guard_tonight once: protect a player from the wolf kill, or omit targetId to skip. Remember you cannot guard the same target two nights in a row.";
        if (role === "seer") return "Call investigate_identity exactly once on another living participant. Keep the result private unless revealing it later serves your strategy.";
        if (role === "spirit-seer") return "Call investigate_dead_identity exactly once on a dead participant to read their true role. Keep it private unless revealing it serves your strategy.";
        return "Call witch_night_choice exactly once: save the wolf victim with the antidote (not yourself), poison one living player, or pass. You cannot use both potions in the same night.";
      }
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion")) {
      this.discussion?.endWave();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.includes(":badge:")) {
      const sheriffId = activation.actorIds[0];
      if (this.pendingBadgePass[0] === sheriffId) {
        return {
          completed: false,
          missingActorIds: [sheriffId],
          retryInstruction: "Your badge decision is still pending. Call pass_badge now (targetId to hand it over, or tear=true to destroy it)."
        };
      }
      this.resolveBadgePassCascade();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":sheriff-run")) {
      const missingActorIds = activation.actorIds.filter((id) => !this.sheriffRunDecided.has(id));
      if (missingActorIds.length) {
        return { completed: false, missingActorIds, retryInstruction: "Your sheriff-run decision is missing. Call run_for_sheriff now with run=true (stand) or run=false (abstain)." };
      }
      this.resolveSheriffRun();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":sheriff-campaign")) {
      // Candidates spoke (or stayed silent); the withdraw round opens.
      this.phase = "sheriff-withdraw";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":sheriff-withdraw")) {
      const missingActorIds = activation.actorIds.filter((id) => !this.sheriffWithdrawDecided.has(id));
      if (missingActorIds.length) {
        return { completed: false, missingActorIds, retryInstruction: "Your withdraw decision is missing. Call withdraw_sheriff_run now with withdraw=true (quit) or withdraw=false (stay)." };
      }
      this.resolveSheriffWithdraw();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":sheriff-vote")) {
      const missingActorIds = activation.actorIds.filter((id) => !this.sheriffVotes.has(id));
      if (missingActorIds.length) {
        return { completed: false, missingActorIds, retryInstruction: "Your sheriff vote is missing. Call cast_sheriff_vote now for one candidate." };
      }
      this.resolveSheriffVote();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":sheriff-pk")) {
      // The tied candidates made their cases; the electors re-vote.
      this.phase = "sheriff-vote";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.includes(":lastwords:")) {
      const speakerId = activation.actorIds[0];
      if (this.pendingLastWords[0] === speakerId) this.pendingLastWords.shift();
      // Silence is a legitimate last word; either way the day continues.
      this.afterEliminationChecks();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":pk")) {
      // Both candidates spoke (or stayed silent): the re-vote opens without them.
      this.phase = "day-vote";
      this.emitUpdate();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.includes(":shot:")) {
      const shooterId = activation.actorIds[0];
      if (this.pendingShots.some((entry) => entry.shooterId === shooterId)) {
        return {
          completed: false,
          missingActorIds: [shooterId],
          retryInstruction: "Your death shot is still pending. Call your shot tool once (choose a target or hold the shot)."
        };
      }
      this.reconcileShotAction(shooterId);
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":knight")) {
      // A knight who never called the tool has given the chance up.
      if (!this.knightUsed) {
        this.knightUsed = true;
        this.phase = "day-vote";
        this.emitUpdate();
      }
      if (this.knightCommandId) this.reconcileKnightAction();
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":vote")) {
      const missingActorIds = activation.actorIds.filter((id) => !this.votes.has(id));
      if (missingActorIds.length) {
        return { completed: false, missingActorIds, retryInstruction: "Your vote is missing. Call cast_day_vote now against one living participant." };
      }
      this.resolveVote();
      return { completed: true, missingActorIds: [] };
    }
    const missingActorIds = activation.actorIds.filter((id) => !this.nightActionCommitted(id));
    if (missingActorIds.length) {
      return {
        completed: false,
        missingActorIds,
        retryInstruction: "Your required night action is missing. Call your role tool exactly once now: wolves choose_night_target, guard guard_tonight, seer investigate_identity, witch witch_night_choice."
      };
    }
    this.resolveNight();
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
    if (input.channel === "team" && (!input.recipientIds || input.recipientIds.length === 0)) {
      input = {
        ...input,
        recipientIds: [...this.alive].filter((id) => id !== input.senderId && isWolfRole(this.roles.get(id)))
      };
    }
    const message = await super.sendMessage(input);
    if (this.phase === "day-discussion" && this.discussion) {
      this.discussion.onMessage({
        messageId: message.id,
        senderId: message.senderId,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.channel === "public" ? {} : { targetActorIds: message.recipientIds ?? [] })
      }, conversationSignalsFromSocialActs(message.senderId, message.id, input.socialActs ?? []));
    }
    if (message.channel === "public" && this.phase === "day-discussion" && this.discussion) {
      this.detectSocialActs(message, input.socialActs ?? []);
    }
    return message;
  }

  /**
   * Apply accusation declarations to the scenario's suspicion climate. The
   * shared world already handles each recipient's emotional reaction, and the
   * discussion signals arrive through conversationSignalsFromSocialActs — both
   * for declared acts (sendMessage) and extracted ones (the base feeds them
   * through handleExtractedConversationSignals), so no signal is raised here.
   */
  private detectSocialActs(message: SocialMessage, declarations: SocialActDeclaration[]): void {
    for (const declaration of declarations) {
      if (declaration.kind !== "accusation" && declaration.kind !== "defense" && declaration.kind !== "endorsement") continue;
      for (const id of [...new Set(declaration.targetActorIds ?? [])]) {
        if (id === message.senderId || !this.alive.has(id)) continue;
        if (declaration.kind === "accusation") {
          this.suspicion.noteAccusation(this.day, message.senderId, id);
        }
      }
    }
  }

  /** Extracted acts count in the suspicion climate exactly like declared ones. */
  protected override onExtractedSocialActs(message: SocialMessage, declarations: SocialActDeclaration[]): void {
    if (message.channel === "public" && this.phase === "day-discussion") {
      this.detectSocialActs(message, declarations);
    }
  }

  /**
   * Base quality signals plus vote accuracy: a day vote "hits" when its
   * target is a true wolf. Ground truth from the internal role table — this
   * is why the metrics surface is owner/operator only.
   */
  override qualityMetrics(): WorldQualityMetrics {
    const voteAccuracy = new Map<string, { votesCast: number; hits: number }>();
    for (const record of this.history) {
      for (const [voterId, targetId] of Object.entries(record.votes ?? {})) {
        const entry = voteAccuracy.get(voterId) ?? { votesCast: 0, hits: 0 };
        entry.votesCast += 1;
        if (isWolfRole(this.roles.get(targetId))) entry.hits += 1;
        voteAccuracy.set(voterId, entry);
      }
    }
    return {
      ...super.qualityMetrics(),
      voteAccuracy: [...voteAccuracy.entries()].map(([actorId, entry]) => ({ actorId, ...entry }))
    };
  }

  /** Late (extracted) signals still reach the live discussion director. */
  protected override handleExtractedConversationSignals(signals: ConversationSignal[]): void {
    for (const signal of signals) this.discussion?.raiseSignal(signal);
  }

  protected currentTurn(): number {
    return this.day;
  }

  protected currentPhase(): string {
    return this.phase;
  }

  protected isAlive(actorId: string): boolean {
    return this.alive.has(actorId);
  }

  protected observerRole(actorId: string): string | undefined {
    return roleLabel(this.roles.get(actorId));
  }

  protected roleVisibleTo(viewerId: string | undefined, subjectId: string, alive: boolean): boolean {
    if (this.status === "finished") return true;
    if (!alive || viewerId === subjectId) return true;
    return Boolean(viewerId && isWolfRole(this.roles.get(viewerId)) && isWolfRole(this.roles.get(subjectId)));
  }

  protected messageChannelsFor(actorId: string): SocialChannel[] {
    return isWolfRole(this.roles.get(actorId)) ? ["public", "private", "team"] : ["public", "private"];
  }

  protected redactDetails(details: Record<string, unknown>, actorId?: string): Record<string, unknown> {
    const next = super.redactDetails(details, actorId);
    const visibleRoles: Record<string, string> = {};
    for (const [id, role] of this.roles) {
      if (this.roleVisibleTo(actorId, id, this.alive.has(id))) visibleRoles[id] = roleLabel(role);
    }
    if (Object.keys(visibleRoles).length) next.roles = visibleRoles;
    if (actorId && this.roles.get(actorId) === "seer") {
      next.investigations = Object.fromEntries(this.seerKnowledge.get(actorId) ?? []);
    }
    if (actorId && this.roles.get(actorId) === "witch") {
      next.witchState = { antidote: this.antidoteAvailable, poison: this.poisonAvailable };
    }
    return next;
  }

  protected validateMessage(senderId: string, channel: "public" | "private" | "team", recipientIds: string[]): void {
    // 遗言: the eliminated player speaks once, publicly, before leaving.
    const inLastWords = this.pendingLastWords[0] === senderId;
    if (inLastWords && channel !== "public") {
      throw new Error("LAST_WORDS_PUBLIC_ONLY: 遗言只能公开陈述。");
    }
    if (!this.alive.has(senderId) && !inLastWords) throw new Error("ACTOR_ELIMINATED: Eliminated participants cannot communicate.");
    if (this.phase === "sheriff-campaign" && !this.currentSheriffCandidates().includes(senderId) && this.alive.has(senderId)) {
      throw new Error("SHERIFF_CAMPAIGN_SPEAKERS_ONLY: 竞选发言阶段只有候选人可以发言，其余人保持安静。");
    }
    if (this.phase === "sheriff-pk" && !this.sheriffPkCandidates.includes(senderId) && this.alive.has(senderId)) {
      throw new Error("SHERIFF_PK_SPEAKERS_ONLY: 警长竞选平票陈词阶段只有被平票的候选人可以发言，其余人保持安静。");
    }
    if (this.phase === "day-pk" && !this.pkCandidates.includes(senderId) && this.alive.has(senderId)) {
      throw new Error("PK_SPEAKERS_ONLY: 平票陈词阶段只有被平票的玩家可以发言，其余人保持安静。");
    }
    if (channel === "private") {
      if (recipientIds.length === 0) throw new Error("RECIPIENT_REQUIRED: Private messages require recipientIds.");
      for (const id of recipientIds) this.assertLivingTarget(id);
      return;
    }
    if (channel === "team") {
      if (!isWolfRole(this.roles.get(senderId))) throw new Error("TEAM_CHANNEL_FORBIDDEN: Only wolves have access to this team channel.");
      if (recipientIds.some((id) => !isWolfRole(this.roles.get(id)) || !this.alive.has(id))) {
        throw new Error("TEAM_RECIPIENT_INVALID: Team messages may only target living wolf teammates.");
      }
    }
  }

  private availableActions(actorId: string, role: WerewolfRoleId): string[] {
    if (this.pendingBadgePass[0] === actorId) return ["pass_badge"];
    if (this.pendingLastWords[0] === actorId) return ["communicate", "recall_memory"];
    if (!this.alive.has(actorId)) return [];
    if (this.phase === "sheriff-run") return ["run_for_sheriff"];
    if (this.phase === "sheriff-campaign") return this.currentSheriffCandidates().includes(actorId) ? ["communicate", "recall_memory"] : [];
    if (this.phase === "sheriff-withdraw") return this.currentSheriffCandidates().includes(actorId) ? ["withdraw_sheriff_run"] : [];
    if (this.phase === "sheriff-vote") return this.sheriffElectorate().includes(actorId) ? ["cast_sheriff_vote"] : [];
    if (this.phase === "sheriff-pk") return this.sheriffPkCandidates.includes(actorId) ? ["communicate", "recall_memory"] : [];
    if (this.phase === "day-discussion") return ["communicate", "recall_memory", "reflect_on_social_situation", "read_the_room", "log_deception_plan", "update_inner_state"];
    if (this.phase === "day-knight") return role === "knight" && !this.knightUsed ? ["knight_challenge"] : [];
    if (this.phase === "day-pk") return this.pkCandidates.includes(actorId) ? ["communicate", "recall_memory"] : [];
    if (this.phase === "day-vote") return this.idiotRevealed.has(actorId) ? [] : ["cast_day_vote"];
    if (role === "nightmare") return ["communicate:team", "choose_night_target", "dream_curse"];
    if (role === "wolf-beauty") return ["communicate:team", "choose_night_target", "charm_target"];
    if (isWolfRole(role)) return ["communicate:team", "choose_night_target"];
    if (role === "seer") return ["investigate_identity"];
    if (role === "spirit-seer") return ["investigate_dead_identity"];
    if (role === "witch") return ["witch_night_choice"];
    if (role === "guard") return ["guard_tonight"];
    return [];
  }

  private rolesObjective(role: WerewolfRoleId): string {
    return `${WEREWOLF_ROLES[role].objective}`;
  }

  private registerIdentityAssignments(): void {
    const wolfIds = [...this.roles].filter(([, role]) => isWolfRole(role)).map(([id]) => id);
    for (const [id, role] of this.roles) {
      this.recordIdentityAssignment(id, role, isWolfRole(role) ? wolfIds : [id]);
    }
  }

  private nightActionCommitted(actorId: string): boolean {
    const role = this.roles.get(actorId);
    if (role === "nightmare") return this.wolfTargets.has(actorId) && this.nightmareCurse !== undefined;
    if (role === "wolf-beauty") return this.wolfTargets.has(actorId) && this.charmTarget !== undefined;
    if (isWolfRole(role)) return this.wolfTargets.has(actorId);
    if (role === "guard") return Boolean(this.guardTargetId);
    if (role === "seer") return this.seerTargets.has(actorId);
    if (role === "spirit-seer") return this.spiritTargets.has(actorId);
    if (role === "witch") return this.witchChoiceMade() || (!this.antidoteAvailable && !this.poisonAvailable);
    return true;
  }

  private witchChoiceMade(): boolean {
    return this.witchActed;
  }

  /** The pack's plurality target right now (witch reads it while awake). */
  private currentWolfTarget(): string | undefined {
    const target = pluralityTarget(this.wolfTargets);
    return target;
  }

  private resolveVote(): void {
    // The sitting sheriff's ballot counts 1.5 (警长票): half-votes break ties
    // instead of creating them.
    const tally = new Map<string, number>();
    for (const [voterId, targetId] of this.votes) {
      const weight = voterId === this.sheriffId ? 1.5 : 1;
      tally.set(targetId, (tally.get(targetId) ?? 0) + weight);
    }
    const ranked = [...tally].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const hasTie = ranked.length > 1 && ranked[0][1] === ranked[1][1];
    const eliminatedId = hasTie ? undefined : ranked[0]?.[0];
    const eliminatedRole = eliminatedId ? this.roles.get(eliminatedId) : undefined;
    // The idiot's flip: voted out once, they reveal, survive and lose the
    // vote (official rule). A second vote-out eliminates them normally.
    const idiotSurvives = eliminatedId !== undefined && eliminatedRole === "idiot" && !this.idiotRevealed.has(eliminatedId);
    if (idiotSurvives) this.idiotRevealed.add(eliminatedId);
    else if (eliminatedId) this.alive.delete(eliminatedId);
    // The eliminated player is owed one public last statement — unless the
    // revealed idiot survives, or the solo-winning jester leaves the stage.
    if (eliminatedId && !idiotSurvives && eliminatedRole !== "jester") this.pendingLastWords.push(eliminatedId);
    // White wolf king explosion: everyone who voted for it dies with it
    // (its own death is the vote-out itself; the boom takes the voters).
    const whiteWolfBoom = eliminatedId !== undefined && eliminatedRole === "white-wolf-king" && !idiotSurvives;
    const boomVictims = whiteWolfBoom
      ? [...this.votes].filter(([voterId, targetId]) => targetId === eliminatedId && voterId !== eliminatedId && this.alive.has(voterId)).map(([voterId]) => voterId)
      : [];
    for (const victimId of boomVictims) this.alive.delete(victimId);
    // Wolf beauty's charm: the charmed player dies with her on a vote-out.
    const charmVictim = eliminatedRole === "wolf-beauty" && !idiotSurvives && this.charmTarget
      ? (this.alive.has(this.charmTarget) ? this.charmTarget : undefined)
      : undefined;
    if (charmVictim) this.alive.delete(charmVictim);
    // One record per day: a PK re-vote updates today's record instead of
    // duplicating it, so the calendar and the director see a single day.
    let record = this.history.at(-1);
    if (!record || record.day !== this.day) {
      record = { day: this.day, votes: {} };
      this.history.push(record);
    }
    record.votes = Object.fromEntries(this.votes);
    if (eliminatedId) {
      record.eliminatedId = eliminatedId;
      record.eliminatedRole = eliminatedRole;
    }
    if (idiotSurvives) record.idiotSurvived = true;
    if (boomVictims.length) record.boomVictims = boomVictims;
    if (charmVictim) record.charmVictim = charmVictim;
    const voteText = idiotSurvives
      ? `${this.profiles.get(eliminatedId!)?.displayName} 被投票放逐，亮明白痴身份——免于一死，但从此失去投票权。`
      : eliminatedId
        ? boomVictims.length
          ? `${this.profiles.get(eliminatedId)?.displayName} 被投票放逐，身份揭晓：${roleLabel(eliminatedRole)}。白狼王自爆——投票给 TA 的 ${boomVictims.map((id) => this.profiles.get(id)?.displayName ?? id).join("、")} 一同出局。`
          : charmVictim
            ? `${this.profiles.get(eliminatedId)?.displayName} 被投票放逐，身份揭晓：${roleLabel(eliminatedRole)}。狼美人的魅惑——${this.profiles.get(charmVictim)?.displayName} 陪葬。`
            : `${this.profiles.get(eliminatedId)?.displayName} 被投票放逐，身份揭晓：${roleLabel(eliminatedRole)}。`
        : "本轮平票，无人被放逐。";
    for (const id of this.profiles.keys()) this.lastExperiences.set(id, `第 ${this.day} 天投票：${voteText} 投票：${[...this.votes].map(([voter, target]) => `${voter}->${target}`).join(", ")}。`);
    // Eliminating a wolf reveals a hidden role, it does not prove a
    // specific lie was caught; eliminating an innocent is an adverse outcome.
    const voteBeat = idiotSurvives
      ? undefined
      : eliminatedId
        ? eliminatedRole === "wolf" || eliminatedRole === "wolf-king"
          ? "hidden-role-revealed" as const
          : eliminatedRole === "jester"
            ? "win" as const
            : "adverse-outcome" as const
        : undefined;
    this.addLog(voteText, this.day, voteBeat);
    const publicVoteResult = this.recordPublicWorldFact({
      factKey: `werewolf-day-vote:${this.day}`,
      eventType: "werewolf.day-vote-resolved",
      predicate: "werewolf-day-vote-result",
      object: {
        votes: Object.fromEntries(this.votes),
        eliminatedId: eliminatedId ?? null,
        revealedRole: eliminatedRole ?? null,
        idiotSurvived: idiotSurvives,
        boomVictims,
        charmVictim: charmVictim ?? null
      },
      payload: {
        day: this.day,
        votes: Object.fromEntries(this.votes),
        eliminatedId: eliminatedId ?? null,
        revealedRole: eliminatedRole ?? null,
        idiotSurvived: idiotSurvives,
        boomVictims,
        charmVictim: charmVictim ?? null
      },
      kind: "past-action"
    });

    for (const [voterId, targetId] of this.votes) {
      const voterName = this.profiles.get(voterId)?.displayName ?? voterId;
      const targetName = this.profiles.get(targetId)?.displayName ?? targetId;
      this.pushEvent(voterId, {
        type: "vote-cast",
        actorId: voterId,
        targetId,
        facts: { resultEventId: publicVoteResult.eventId },
        detail: `Day ${this.day}: you voted to eliminate ${targetName}.`
      });
      this.pushEvent(targetId, {
        type: "vote-against",
        actorId: voterId,
        targetId,
        facts: { resultEventId: publicVoteResult.eventId },
        detail: `Day ${this.day} vote: ${voterName} voted against you.`
      });
      for (const [otherVoter, otherTarget] of this.votes) {
        if (otherVoter !== voterId && otherTarget === targetId) {
          const allyName = this.profiles.get(otherVoter)?.displayName ?? otherVoter;
          this.pushEvent(voterId, {
            type: "voted-with",
            actorId: otherVoter,
            targetId,
            detail: `Day ${this.day} vote: ${allyName} voted for the same target as you.`
          });
        }
      }
    }
    if (idiotSurvives && eliminatedId) {
      const detectedDeceptions = this.revealIdentity(eliminatedId, "idiot", "good");
      if (detectedDeceptions.length) {
        this.addLog(`身份揭晓证伪了 ${detectedDeceptions.length} 条带计划、带消息引用的身份欺骗。`, this.day, "deception-exposed");
      }
      for (const id of this.profiles.keys()) {
        if (id === eliminatedId) {
          this.pushEvent(id, {
            type: "revealed",
            targetId: eliminatedId,
            facts: { role: "idiot", survived: true },
            detail: "你被投票放逐，亮明白痴身份，免于一死，但从此失去投票权。"
          });
        } else {
          this.pushEvent(id, {
            type: "revealed",
            targetId: eliminatedId,
            facts: { role: "idiot", survived: true },
            detail: `${this.profiles.get(eliminatedId)?.displayName} 亮出了白痴身份——免死，但失去投票权。`
          });
        }
      }
    } else if (eliminatedId) {
      this.pushEliminationEvents(eliminatedId, "vote", eliminatedRole);
      for (const victimId of boomVictims) this.pushEliminationEvents(victimId, "boom", this.roles.get(victimId));
      if (charmVictim) this.pushEliminationEvents(charmVictim, "charm", this.roles.get(charmVictim));
    }
    for (const [voterId, targetId] of this.votes) this.suspicion.noteVote(this.day, voterId, targetId);
    if (eliminatedId) this.suspicion.noteResolved(this.day, eliminatedId);
    const topVoteCount = ranked[0]?.[1] ?? 0;
    for (const [voterId, targetId] of this.votes) {
      const commandId = this.voteCommandIds.get(voterId);
      if (!commandId) continue;
      const targetWasRevealed = eliminatedId === targetId && eliminatedRole !== undefined;
      const actualFacts: Record<string, boolean> = {
        "target-eliminated": eliminatedId === targetId && !idiotSurvives,
        "vote-matched-plurality": (tally.get(targetId) ?? 0) === topVoteCount,
        "actor-survives-day": this.alive.has(voterId),
        ...(targetWasRevealed ? { "target-revealed-wolf": isWolfRole(eliminatedRole) } : {})
      };
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: eliminatedId
            ? `Voted for ${targetId}; the table eliminated ${eliminatedId}${idiotSurvives ? " but the revealed idiot survived" : ""}.`
            : `Voted for ${targetId}; the table tied and eliminated nobody.`,
          metrics: {
            day: this.day,
            targetId,
            targetEliminated: eliminatedId === targetId && !idiotSurvives,
            voteMatchedPlurality: (tally.get(targetId) ?? 0) === topVoteCount,
            actorSurvived: this.alive.has(voterId),
            ...(targetWasRevealed ? { revealedRole: eliminatedRole } : {})
          }
        },
        actualFacts,
        resultingEventIds: [publicVoteResult.eventId]
      });
    }
    this.votes.clear();
    this.voteCommandIds.clear();
    // The nightmare's curse expires once the day's vote is settled.
    this.nightmareCurse = undefined;
    // The wolf beauty chooses a fresh companion each night; the previous bond
    // has either fired during this vote or expired with the vote result.
    this.charmTarget = undefined;

    // A tied vote opens the PK cycle: the two accused state their case, then
    // the table re-votes without them. A second tie eliminates nobody —
    // pkHeld keeps the loop closed.
    if (hasTie && !this.pkHeld) {
      this.pkHeld = true;
      this.pkCandidates = ranked
        .filter(([, count]) => count === ranked[0][1])
        .map(([id]) => id)
        .slice(0, 2);
      this.addLog(
        `第 ${this.day} 天投票平票：${this.pkCandidates.map((id) => this.profiles.get(id)?.displayName ?? id).join("、")} 进入 PK 陈词，发言后重新投票（平票者本轮不投票）。`,
        this.day
      );
      this.phase = "day-pk";
      this.emitUpdate();
      return;
    }
    this.pkCandidates = [];

    if (eliminatedRole === "jester") {
      // The jester wins alone and leaves; the main game continues.
      this.jesterWon = true;
      this.addLog("小丑被投票出局，单独获胜并离场；对局继续。", this.day, "win");
      this.pushEvent(eliminatedId!, { type: "win", targetId: eliminatedId, detail: "你被投票出局——小丑的胜利条件达成，你赢了。" });
      if (this.alive.size === 0) {
        this.endGame([eliminatedId!], "小丑被投票出局并单独获胜；场上已无其他存活者。");
        return;
      }
      if (this.wolvesAlive().length === 0) {
        this.endGame(this.factionMembers(["seer", "witch", "hunter", "knight", "guard", "idiot", "villager"]), "所有狼人都已出局，村庄阵营获胜（小丑单独获胜后离场）。");
        return;
      }
      this.phase = "night";
      this.emitUpdate();
      return;
    }
    this.afterEliminationChecks();
  }

  // --- Sheriff election & badge flow (警长竞选 / 警徽流) ---

  /** Candidates still on the ballot: ran, not withdrawn, still alive. */
  private currentSheriffCandidates(): string[] {
    return [...this.profiles.keys()].filter((id) =>
      this.sheriffCandidates.has(id) && !this.sheriffWithdrawn.has(id) && this.alive.has(id)
    );
  }

  /** The election's electors: living players who never ran for sheriff. */
  private sheriffElectorate(): string[] {
    return [...this.alive].filter((id) => !this.sheriffCandidates.has(id));
  }

  private resolveSheriffRun(): void {
    const candidates = this.currentSheriffCandidates();
    if (candidates.length === 0) {
      this.addLog("警长竞选：无人上警，本局没有警长。", this.day);
      this.setLastExperiences("无人上警，本局没有警长。");
      this.phase = "day-discussion";
      this.emitUpdate();
      return;
    }
    if (candidates.length === 1) {
      this.electSheriff(candidates[0], "唯一上警者直接当选警长。");
      return;
    }
    this.addLog(`警长竞选：${candidates.map((id) => this.displayName(id)).join("、")} 上警，依次发表竞选演讲。`, this.day);
    this.setLastExperiences(`警长竞选开始，上警者：${candidates.map((id) => this.displayName(id)).join("、")}。`);
    this.phase = "sheriff-campaign";
    this.emitUpdate();
  }

  private resolveSheriffWithdraw(): void {
    const remaining = this.currentSheriffCandidates();
    if (remaining.length === 1) {
      this.electSheriff(remaining[0], "其余竞选者全部退选，唯一留任者当选警长。");
      return;
    }
    // 全员上警: nobody kept the right to vote, so the election cannot resolve.
    if (this.sheriffElectorate().length === 0) {
      this.addLog("警长竞选：全员上警，无人拥有警长投票权，本局没有警长。", this.day);
      this.setLastExperiences("全员上警，无人有警长投票权，本局没有警长。");
      this.phase = "day-discussion";
      this.emitUpdate();
      return;
    }
    const withdrawn = [...this.sheriffWithdrawn].map((id) => this.displayName(id));
    this.addLog(
      `警长竞选：${withdrawn.length ? `${withdrawn.join("、")} 退选，` : ""}最终候选人为 ${remaining.map((id) => this.displayName(id)).join("、")}，未上警的玩家开始投票。`,
      this.day
    );
    this.setLastExperiences(`警长竞选进入投票，候选人：${remaining.map((id) => this.displayName(id)).join("、")}。`);
    this.phase = "sheriff-vote";
    this.emitUpdate();
  }

  private resolveSheriffVote(): void {
    const tally = tallyTargets(this.sheriffVotes);
    const ranked = [...tally].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const hasTie = ranked.length > 1 && ranked[0][1] === ranked[1][1];
    const sheriffElectedId = hasTie ? undefined : ranked[0]?.[0];
    this.sheriffVotes.clear();
    this.sheriffVoteCommandIds.clear();
    if (hasTie && !this.sheriffPkHeld) {
      this.sheriffPkHeld = true;
      this.sheriffPkCandidates = ranked
        .filter(([, count]) => count === ranked[0][1])
        .map(([id]) => id)
        .slice(0, 2);
      this.addLog(
        `警长竞选投票平票：${this.sheriffPkCandidates.map((id) => this.displayName(id)).join("、")} 进入 PK 陈词，发言后重新投票（竞选者不投票）。`,
        this.day
      );
      this.setLastExperiences("警长竞选投票平票，进入 PK 陈词。");
      this.phase = "sheriff-pk";
      this.emitUpdate();
      return;
    }
    if (hasTie) {
      // A second tie ends the election: the village plays without a sheriff.
      this.addLog("警长竞选两次平票，本局没有警长。", this.day);
      this.setLastExperiences("警长竞选两次平票，本局没有警长。");
      this.phase = "day-discussion";
      this.emitUpdate();
      return;
    }
    if (sheriffElectedId) this.electSheriff(sheriffElectedId, "赢得警长竞选投票。");
  }

  private electSheriff(sheriffId: string, note: string): void {
    this.sheriffId = sheriffId;
    this.sheriffPkCandidates = [];
    let record = this.history.at(-1);
    if (!record || record.day !== this.day) {
      record = { day: this.day, votes: {} };
      this.history.push(record);
    }
    record.sheriffElectedId = sheriffId;
    const name = this.displayName(sheriffId);
    this.addLog(`${name} ${note}警长的白天投票计 1.5 票，出局时需移交警徽或撕掉。`, this.day);
    this.setLastExperiences(`${name} 当选警长：TA 的白天投票计 1.5 票。`);
    this.pushEvent(sheriffId, {
      type: "endorsed",
      targetId: sheriffId,
      facts: { sheriff: true },
      detail: `你当选警长——白天的放逐投票计 1.5 票；你出局时需要移交警徽或撕掉。`
    });
    this.recordPublicWorldFact({
      factKey: `werewolf-sheriff:${this.day}`,
      eventType: "werewolf.sheriff-elected",
      predicate: "werewolf-sheriff-result",
      object: { sheriffId },
      payload: { day: this.day, sheriffId },
      kind: "past-action"
    });
    this.phase = "day-discussion";
    this.emitUpdate();
  }

  /** After a badge decision settles, carry the day on like any other queue item. */
  private resolveBadgePassCascade(): void {
    if (this.phase === "night") {
      this.afterNightChecks();
      return;
    }
    this.afterEliminationChecks();
  }

  private displayName(actorId: string): string {
    return this.profiles.get(actorId)?.displayName ?? actorId;
  }

  private setLastExperiences(text: string): void {
    for (const id of this.profiles.keys()) this.lastExperiences.set(id, `${text}`);
  }

  private resolveNight(): void {
    const wolfTargetId = this.currentWolfTarget();
    const guardId = this.guardTargetId === "__none__" ? undefined : this.guardTargetId;
    const saveId = this.witchSaveId;
    const poisonId = this.witchPoisonId;

    // 同守同救: guard + antidote on the same victim still lets the victim die.
    const bothOnWolfTarget = Boolean(wolfTargetId && guardId === wolfTargetId && saveId === wolfTargetId);
    const wolfKillId = wolfTargetId && !bothOnWolfTarget && guardId !== wolfTargetId && saveId !== wolfTargetId
      ? wolfTargetId
      : undefined;
    const savedId = wolfTargetId && !bothOnWolfTarget && (guardId === wolfTargetId || saveId === wolfTargetId)
      ? wolfTargetId
      : undefined;

    const record = this.history.at(-1);
    const parts: string[] = [];
    if (wolfKillId) {
      this.alive.delete(wolfKillId);
      if (record && record.day === this.day) {
        record.nightKillId = wolfKillId;
        record.nightKillRole = this.roles.get(wolfKillId);
      }
      parts.push(`${this.profiles.get(wolfKillId)?.displayName} 夜里被狼人杀害，身份揭晓：${roleLabel(this.roles.get(wolfKillId))}。`);
    } else if (savedId) {
      const byGuard = guardId === savedId;
      const byWitch = saveId === savedId;
      parts.push(
        `夜里狼人袭击了 ${this.profiles.get(savedId)?.displayName}，但 ${
          byGuard && byWitch ? "守卫与女巫同时出手" : byGuard ? "守卫挡住了这一刀" : "女巫用解药救回了"
        } TA。`
      );
    } else if (wolfTargetId && bothOnWolfTarget) {
      parts.push(`${this.profiles.get(wolfTargetId)?.displayName} 夜里被狼人杀害，身份揭晓：${roleLabel(this.roles.get(wolfTargetId))}。守卫与女巫同守同救——奶穿。`);
      this.alive.delete(wolfTargetId);
      if (record && record.day === this.day) {
        record.nightKillId = wolfTargetId;
        record.nightKillRole = this.roles.get(wolfTargetId);
      }
    } else if (!wolfTargetId) {
      parts.push("今夜没有发生狼人袭击。");
    }
    if (poisonId) {
      this.alive.delete(poisonId);
      if (record && record.day === this.day) {
        record.poisonId = poisonId;
      }
      parts.push(`${this.profiles.get(poisonId)?.displayName} 被女巫毒杀，身份揭晓：${roleLabel(this.roles.get(poisonId))}。`);
    }
    const nightText = parts.join(" ");
    for (const id of this.profiles.keys()) {
      const privateResult = this.roles.get(id) === "seer" && this.seerTargets.has(id)
        ? ` 你的查验结果：${this.seerTargets.get(id)} 是${roleLabel(this.seerKnowledge.get(id)?.get(this.seerTargets.get(id)!) ?? this.roles.get(this.seerTargets.get(id)!))}。`
        : "";
      const witchResult = this.roles.get(id) === "witch" && wolfTargetId
        ? ` 今晚狼人袭击了 ${wolfTargetId}。`
        : "";
      this.lastExperiences.set(id, `第 ${this.day} 天夜晚：${nightText}${privateResult}${witchResult}`);
    }
    this.addLog(nightText, this.day, wolfKillId || (wolfTargetId && bothOnWolfTarget) ? "adverse-outcome" : undefined);

    // Appraisal + death-skill scheduling. Poisoned deaths cannot shoot.
    const deadByWolf = wolfKillId ?? (wolfTargetId && bothOnWolfTarget ? wolfTargetId : undefined);
    const publicNightResult = this.recordPublicWorldFact({
      factKey: `werewolf-night:${this.day}`,
      eventType: "werewolf.night-resolved",
      predicate: "werewolf-night-result",
      object: {
        killedByWolves: deadByWolf ?? null,
        poisoned: poisonId ?? null,
        revealedRoles: Object.fromEntries(
          [deadByWolf, poisonId]
            .filter((id): id is string => Boolean(id))
            .map((id) => [id, this.roles.get(id) ?? null])
        )
      },
      payload: {
        day: this.day,
        killedByWolves: deadByWolf ?? null,
        poisoned: poisonId ?? null
      },
      kind: "past-action"
    });
    this.reconcileNightActions({
      resultEventId: publicNightResult.eventId,
      wolfTargetId,
      deadByWolf,
      savedId,
      guardId,
      poisonId
    });
    if (deadByWolf) this.pushEliminationEvents(deadByWolf, "night", this.roles.get(deadByWolf));
    if (poisonId) this.pushEliminationEvents(poisonId, "poison", this.roles.get(poisonId));
    for (const [seerId, target] of this.seerTargets) {
      this.pushEvent(seerId, {
        type: "investigation",
        actorId: seerId,
        targetId: target,
        facts: { role: roleLabel(this.seerKnowledge.get(seerId)?.get(target) ?? this.roles.get(target)) },
        detail: `第 ${this.day} 天夜晚：你的查验显示 ${this.profiles.get(target)?.displayName ?? target} 是${roleLabel(this.seerKnowledge.get(seerId)?.get(target) ?? this.roles.get(target))}。`
      });
    }

    this.wolfTargets.clear();
    this.wolfTargetCommandIds.clear();
    this.seerTargets.clear();
    this.seerTargetCommandIds.clear();
    this.spiritTargets.clear();
    this.spiritTargetCommandIds.clear();
    this.witchSaveId = undefined;
    this.witchPoisonId = undefined;
    this.witchActed = false;
    this.witchCommandId = undefined;
    this.lastGuardTargetId = guardId;
    this.guardTargetId = undefined;
    this.guardCommandId = undefined;
    this.nightmareCurseCommandId = undefined;
    this.charmCommandId = undefined;

    if (this.pendingShots.length || this.pendingBadgePass.length) return; // shots and badge decisions resolve before the phase transition
    this.afterNightChecks();
  }

  private reconcileNightActions(input: {
    resultEventId: string;
    wolfTargetId?: string;
    deadByWolf?: string;
    savedId?: string;
    guardId?: string;
    poisonId?: string;
  }): void {
    for (const [actorId, targetId] of this.wolfTargets) {
      const commandId = this.wolfTargetCommandIds.get(actorId);
      if (!commandId) continue;
      const selectedByPack = input.wolfTargetId === targetId;
      const targetKilled = input.deadByWolf === targetId;
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `Nominated ${targetId}; the pack selected ${input.wolfTargetId ?? "nobody"}; ${input.deadByWolf ? `${input.deadByWolf} died` : "the attack killed nobody"}.`,
          metrics: {
            day: this.day,
            nominatedTarget: targetId,
            packTarget: input.wolfTargetId ?? null,
            selectedByPack,
            targetKilled
          }
        },
        actualFacts: {
          "pack-selected-target": selectedByPack,
          "target-killed-by-wolves": targetKilled,
          "actor-survives-night": this.alive.has(actorId)
        },
        resultingEventIds: [input.resultEventId],
      });
    }

    for (const [actorId, targetId] of this.seerTargets) {
      const commandId = this.seerTargetCommandIds.get(actorId);
      if (!commandId) continue;
      const perceivedRole = this.seerKnowledge.get(actorId)?.get(targetId) ?? this.roles.get(targetId) ?? "unknown";
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `Investigated ${targetId}; the private result was ${perceivedRole}.`,
          metrics: { day: this.day, targetId, perceivedRole }
        },
        actualFacts: {
          "investigation-completed": true,
          "target-appeared-wolf": isWolfRole(perceivedRole as WerewolfRoleId)
        },
        resultingEventIds: [input.resultEventId],
      });
    }

    for (const [actorId, targetId] of this.spiritTargets) {
      const commandId = this.spiritTargetCommandIds.get(actorId);
      if (!commandId) continue;
      const observedRole = this.spiritKnowledge.get(actorId)?.get(targetId) ?? this.roles.get(targetId) ?? "unknown";
      this.reconcileSocialOutcome({
        actionReceiptId: commandId,
        actualOutcome: {
          summary: `Communed with ${targetId}; the private result was ${observedRole}.`,
          metrics: { day: this.day, targetId, observedRole }
        },
        actualFacts: {
          "investigation-completed": true,
          "target-was-wolf": isWolfRole(observedRole as WerewolfRoleId)
        },
        resultingEventIds: [input.resultEventId],
      });
    }

    const nightmareId = [...this.roles].find(([, role]) => role === "nightmare")?.[0];
    if (nightmareId && this.nightmareCurseCommandId) {
      const targetId = this.nightmareCurse ?? undefined;
      this.reconcileSocialOutcome({
        actionReceiptId: this.nightmareCurseCommandId,
        actualOutcome: {
          summary: targetId ? `Cursed ${targetId}; the curse will block their next vote.` : "Skipped the night curse.",
          metrics: { day: this.day, targetId: targetId ?? null, curseApplied: Boolean(targetId) }
        },
        actualFacts: { "curse-applied": Boolean(targetId) },
        resultingEventIds: [input.resultEventId],
      });
    }

    const wolfBeautyId = [...this.roles].find(([, role]) => role === "wolf-beauty")?.[0];
    if (wolfBeautyId && this.charmCommandId) {
      const targetId = this.charmTarget ?? undefined;
      this.reconcileSocialOutcome({
        actionReceiptId: this.charmCommandId,
        actualOutcome: {
          summary: targetId ? `Charmed ${targetId}; the bond remains active.` : "Skipped creating a charm bond.",
          metrics: { day: this.day, targetId: targetId ?? null, charmActive: Boolean(targetId) }
        },
        actualFacts: { "charm-active": Boolean(targetId) },
        resultingEventIds: [input.resultEventId],
      });
    }

    const witchId = [...this.roles].find(([, role]) => role === "witch")?.[0];
    if (witchId && this.witchCommandId) {
      const attemptedSave = this.witchSaveId;
      const attemptedPoison = this.witchPoisonId;
      this.reconcileSocialOutcome({
        actionReceiptId: this.witchCommandId,
        actualOutcome: {
          summary: attemptedSave
            ? `Used the antidote on ${attemptedSave}; ${input.savedId === attemptedSave ? "the target survived the wolf attack" : "the save did not prevent a death"}.`
            : attemptedPoison
              ? `Poisoned ${attemptedPoison}; ${input.poisonId === attemptedPoison ? "the target died" : "the target survived"}.`
              : "Used no potion.",
          metrics: {
            day: this.day,
            saveTargetId: attemptedSave ?? null,
            poisonTargetId: attemptedPoison ?? null,
            saveEffective: Boolean(attemptedSave && input.savedId === attemptedSave),
            poisonEffective: Boolean(attemptedPoison && input.poisonId === attemptedPoison)
          }
        },
        actualFacts: {
          "save-prevented-wolf-kill": Boolean(attemptedSave && input.savedId === attemptedSave),
          "poison-eliminated-target": Boolean(attemptedPoison && input.poisonId === attemptedPoison)
        },
        resultingEventIds: [input.resultEventId],
      });
    }

    const guardActorId = [...this.roles].find(([, role]) => role === "guard")?.[0];
    if (guardActorId && this.guardCommandId) {
      const targetId = input.guardId;
      const targetSurvived = Boolean(targetId && this.alive.has(targetId));
      this.reconcileSocialOutcome({
        actionReceiptId: this.guardCommandId,
        actualOutcome: {
          summary: targetId
            ? `Guarded ${targetId}; the public dawn result showed that target ${targetSurvived ? "alive" : "dead"}.`
            : "Skipped guarding a target.",
          metrics: { day: this.day, targetId: targetId ?? null, targetSurvived }
        },
        actualFacts: { "guarded-target-survived": targetSurvived },
        resultingEventIds: [input.resultEventId],
      });
    }
  }

  private reconcileKnightAction(): void {
    const commandId = this.knightCommandId;
    const knightId = [...this.roles].find(([, role]) => role === "knight")?.[0];
    if (!commandId || !knightId) return;
    const targetId = this.knightTargetId;
    const targetRole = targetId ? this.roles.get(targetId) : undefined;
    const targetWasWolf = this.knightTargetWasWolf === true;
    const knightSurvived = this.alive.has(knightId);
    const targetEliminated = Boolean(targetId && !this.alive.has(targetId));
    const publicResult = this.recordPublicWorldFact({
      factKey: `werewolf-knight:${this.day}:${knightId}`,
      eventType: "werewolf.knight-resolved",
      subjectActorId: knightId,
      predicate: "knight-challenge-result",
      object: {
        targetActorId: targetId ?? null,
        targetRole: targetRole ?? null,
        targetWasWolf,
        knightSurvived,
        targetEliminated
      },
      payload: {
        day: this.day,
        knightActorId: knightId,
        targetActorId: targetId ?? null,
        targetRole: targetRole ?? null,
        passed: !targetId,
        targetWasWolf,
        knightSurvived,
        targetEliminated
      },
      kind: "past-action"
    });
    this.reconcileSocialOutcome({
      actionReceiptId: commandId,
      actualOutcome: {
        summary: targetId
          ? targetWasWolf
            ? `Challenged ${targetId}; they were a wolf and were eliminated.`
            : `Challenged ${targetId}; they were ${targetRole ?? "not a wolf"}, so the knight died.`
          : "Passed the one-time knight challenge.",
        metrics: {
          day: this.day,
          targetId: targetId ?? null,
          targetRole: targetRole ?? null,
          targetWasWolf,
          knightSurvived,
          targetEliminated
        }
      },
      actualFacts: {
        "challenge-used": Boolean(targetId),
        "target-was-wolf": targetWasWolf,
        "knight-survived": knightSurvived,
        "target-eliminated": targetEliminated
      },
      resultingEventIds: [publicResult.eventId],
    });
    this.knightCommandId = undefined;
    this.knightTargetId = undefined;
    this.knightTargetWasWolf = undefined;
  }

  private reconcileShotAction(shooterId: string): void {
    const commandId = this.shotCommandIds.get(shooterId);
    if (!commandId || !this.shotTargetIds.has(shooterId)) return;
    const targetId = this.shotTargetIds.get(shooterId) ?? undefined;
    const kind = this.shotKinds.get(shooterId) ?? "hunter";
    const targetRole = targetId ? this.roles.get(targetId) : undefined;
    const targetEliminated = Boolean(targetId && !this.alive.has(targetId));
    const targetWasWolf = Boolean(targetRole && isWolfRole(targetRole));
    const publicResult = this.recordPublicWorldFact({
      factKey: `werewolf-death-shot:${this.day}:${shooterId}`,
      eventType: "werewolf.death-shot-resolved",
      subjectActorId: shooterId,
      predicate: "death-shot-result",
      object: {
        kind,
        targetActorId: targetId ?? null,
        targetRole: targetRole ?? null,
        targetEliminated
      },
      payload: {
        day: this.day,
        shooterActorId: shooterId,
        kind,
        targetActorId: targetId ?? null,
        targetRole: targetRole ?? null,
        held: !targetId,
        targetEliminated
      },
      kind: "past-action"
    });
    this.reconcileSocialOutcome({
      actionReceiptId: commandId,
      actualOutcome: {
        summary: targetId
          ? `Used the ${kind} death shot on ${targetId}; they were ${targetRole ?? "unknown"} and were eliminated.`
          : `Held the ${kind} death shot and eliminated nobody.`,
        metrics: {
          day: this.day,
          kind,
          targetId: targetId ?? null,
          targetRole: targetRole ?? null,
          shotFired: Boolean(targetId),
          targetEliminated,
          targetWasWolf
        }
      },
      actualFacts: {
        "shot-fired": Boolean(targetId),
        "target-eliminated": targetEliminated,
        "target-was-wolf": targetWasWolf
      },
      resultingEventIds: [publicResult.eventId],
    });
    this.shotCommandIds.delete(shooterId);
    this.shotTargetIds.delete(shooterId);
    this.shotKinds.delete(shooterId);
  }

  /** Schedule death skills and run the shared win checks after any death. */
  private pushEliminationEvents(targetId: string, by: "vote" | "night" | "poison" | "shot" | "knight" | "boom" | "charm", role: WerewolfRoleId | undefined): void {
    const targetName = this.profiles.get(targetId)?.displayName ?? targetId;
    const detectedDeceptions = role ? this.revealIdentity(targetId, role, isWolfRole(role) ? "wolf" : "good") : [];
    if (detectedDeceptions.length) {
      this.addLog(`身份揭晓证伪了 ${detectedDeceptions.length} 条带计划、带消息引用的身份欺骗。`, this.day, "deception-exposed");
    }
    // A dying sheriff owes the badge a decision — hand it over or tear it.
    // The badge leaves with them right here, so no half-dead state lingers.
    if (targetId === this.sheriffId) {
      this.sheriffId = undefined;
      this.pendingBadgePass.push(targetId);
    }
    this.pushEvent(targetId, {
      type: "eliminated",
      targetId,
      facts: { by, role: roleLabel(role) },
      detail: by === "vote"
        ? `第 ${this.day} 天：你被村庄投票放逐，身份揭晓：${roleLabel(role)}。`
        : by === "poison"
          ? `第 ${this.day} 天夜晚：女巫的毒药带走了你，身份揭晓：${roleLabel(role)}。你无法使用死亡技能。`
          : by === "boom"
            ? `第 ${this.day} 天：白狼王被放逐时自爆，带走了你，身份揭晓：${roleLabel(role)}。你无法使用死亡技能。`
            : by === "charm"
              ? `第 ${this.day} 天：你被狼美人魅惑，随她一同出局，身份揭晓：${roleLabel(role)}。你无法使用死亡技能。`
              : `你被淘汰了（${by}），身份揭晓：${roleLabel(role)}。`
    });
    for (const id of this.profiles.keys()) {
      if (id === targetId) continue;
      this.pushEvent(id, {
        type: "eliminated-other",
        targetId,
        facts: {
          role: roleLabel(role),
          iVoted: by === "vote" && this.votes.get(id) === targetId,
          ally: isVillageRole(this.roles.get(id)) && isVillageRole(role)
        },
        detail: `${targetName} 被淘汰（${by}），身份揭晓：${roleLabel(role)}${by === "vote" && this.votes.get(id) === targetId ? " —— 你投了 TA。" : ""}`
      });
    }
    // Hunter / wolf-king death shots. Poisoned or exploded victims cannot shoot.
    if (by === "poison" || by === "boom" || by === "charm") return;
    if (role === "hunter") this.pendingShots.push({ shooterId: targetId, kind: "hunter", cause: by });
    if (role === "wolf-king" && (by === "vote" || by === "shot")) this.pendingShots.push({ shooterId: targetId, kind: "wolf-king", cause: by });
  }

  /** Resolve one death shot (or a held shot), then cascade. */
  private resolveShot(shooterId: string, targetId: string | undefined): void {
    const index = this.pendingShots.findIndex((entry) => entry.shooterId === shooterId);
    if (index === -1) return;
    this.pendingShots.splice(index, 1);
    const shooterName = this.profiles.get(shooterId)?.displayName ?? shooterId;
    if (!targetId) {
      // Holding a death shot is a legal choice, not a mistake — no label.
      this.addLog(`${shooterName} 选择了压枪，没有带走任何人。`, this.day);
      for (const id of this.profiles.keys()) {
        this.lastExperiences.set(id, `${shooterName} held their death shot.`);
      }
      // A held shot must still cascade like a fired one: without this the
      // phase stays where the death left it (e.g. day-vote after a vote-out),
      // and the room opens a phantom second day vote on the same day.
      if (this.pendingShots.length) {
        this.emitUpdate();
        return;
      }
      if (this.phase === "night") {
        this.afterNightChecks();
        return;
      }
      this.afterEliminationChecks();
      return;
    }
    this.assertLivingTarget(targetId);
    const targetRole = this.roles.get(targetId);
    this.alive.delete(targetId);
    this.addLog(`${shooterName} 临死开枪，带走了 ${this.profiles.get(targetId)?.displayName ?? targetId}（${roleLabel(targetRole)}）。`, this.day, "comeback");
    const record = this.history.at(-1);
    if (record && record.day === this.day) {
      record.shotId = targetId;
      record.shotRole = targetRole;
    }
    for (const id of this.profiles.keys()) {
      this.lastExperiences.set(id, `${shooterName}'s death shot eliminated ${this.profiles.get(targetId)?.displayName ?? targetId} (${roleLabel(targetRole)}).`);
    }
    this.pushEliminationEvents(targetId, "shot", targetRole);
    // Cascade: more shots resolve first; otherwise run the win checks and
    // advance the phase the way the originating elimination would have.
    if (this.pendingShots.length) {
      this.emitUpdate();
      return;
    }
    if (this.phase === "night") {
      this.afterNightChecks();
      return;
    }
    this.afterEliminationChecks();
  }

  private afterEliminationChecks(): void {
    if (this.pendingBadgePass.length || this.pendingLastWords.length || this.pendingShots.length) {
      // Stay in the current phase: the badge / last word / shot activation runs first.
      return;
    }
    if (this.wolvesAlive().length === 0) {
      this.endGame(this.factionMembers(["seer", "witch", "hunter", "knight", "guard", "idiot", "villager"]), this.jesterWon ? "所有狼人都已出局，村庄阵营获胜（小丑已单独获胜离场）。" : "所有狼人都已出局，村庄阵营获胜。");
      return;
    }
    if (this.wolvesHaveParity()) {
      this.endGame(this.factionMembers(["wolf", "wolf-king", "hidden-wolf", "white-wolf-king", "wolf-beauty", "nightmare"]), this.jesterWon ? "狼人已经控制投票数量，狼人阵营获胜（小丑已单独获胜离场）。" : "狼人已经控制投票数量，狼人阵营获胜。");
      return;
    }
    this.phase = "night";
    this.emitUpdate();
  }

  private afterNightChecks(): void {
    if (this.pendingBadgePass.length || this.pendingLastWords.length || this.pendingShots.length) return;
    if (this.wolvesAlive().length === 0) {
      this.endGame(this.factionMembers(["seer", "witch", "hunter", "knight", "guard", "idiot", "villager"]), this.jesterWon ? "所有狼人都已出局，村庄阵营获胜（小丑已单独获胜离场）。" : "所有狼人都已出局，村庄阵营获胜。");
      return;
    }
    if (this.wolvesHaveParity()) {
      this.endGame(this.factionMembers(["wolf", "wolf-king", "hidden-wolf", "white-wolf-king", "wolf-beauty", "nightmare"]), this.jesterWon ? "狼人已经控制剩余局面，狼人阵营获胜（小丑已单独获胜离场）。" : "狼人已经控制剩余局面，狼人阵营获胜。");
      return;
    }
    if (this.day >= this.maxDays) {
      this.endGame(this.factionMembers(["wolf", "wolf-king", "hidden-wolf", "white-wolf-king", "wolf-beauty", "nightmare"]), "村庄未能在期限内找出狼人，狼人阵营获胜。");
      return;
    }
    this.day += 1;
    this.suspicion.decay(0.75);
    // A new day resets the PK cycle: one PK per day, candidates cleared.
    this.pkHeld = false;
    this.pkCandidates = [];
    this.phase = "day-discussion";
    this.discussion = this.createDiscussion();
    this.emitUpdate();
  }

  private endGame(winners: string[], outcome: string): void {
    this.winners = winners;
    this.outcome = outcome;
    this.addLog(outcome, this.day, "win");
    for (const [actorId, role] of this.roles) this.revealIdentity(actorId, role, isWolfRole(role) ? "wolf" : "good");
    for (const id of this.profiles.keys()) {
      const won = winners.includes(id);
      this.pushEvent(id, {
        type: won ? "win" : "lose",
        targetId: id,
        detail: won ? `Game over: your faction won — ${outcome}` : `Game over: your faction lost — ${outcome}`
      });
    }
    this.finish();
  }

  protected messageWave(): number | undefined {
    return this.discussion?.waveNumber;
  }

  private createDiscussion(): DiscussionDirector {
    const aliveIds = [...this.alive];
    return new DiscussionDirector({
      actorIds: aliveIds,
      displayName: (id) => this.profiles.get(id)?.displayName ?? id,
      ...discussionPersonality(this.profiles, (id) => this.moodSignalFor(id))
    });
  }

  private wolvesAlive(): string[] {
    return [...this.alive].filter((id) => isWolfRole(this.roles.get(id)));
  }

  private wolvesHaveParity(): boolean {
    const wolves = this.wolvesAlive().length;
    return wolves > 0 && wolves >= this.alive.size - wolves;
  }

  private factionMembers(roles: WerewolfRoleId[]): string[] {
    return [...this.roles].filter(([, role]) => roles.includes(role)).map(([id]) => id);
  }

  private assertActiveActor(actorId: string): void {
    if (!this.alive.has(actorId)) throw new Error("ACTOR_ELIMINATED: You cannot act after elimination.");
  }

  private assertLivingTarget(targetId: string): void {
    if (!this.profiles.has(targetId)) throw new Error(`TARGET_NOT_FOUND: '${targetId}' is not a participant.`);
    if (!this.alive.has(targetId)) throw new Error(`TARGET_INACTIVE: '${targetId}' is already eliminated.`);
  }

  private summary(): string {
    if (this.status === "finished") return this.outcome;
    return `第 ${this.day} / ${this.maxDays} 天 · ${this.alive.size} 人存活 · ${phaseLabel(this.phase)}`;
  }
}

function situationFor(phase: Phase, role: WerewolfRoleId, aliveCount: number, wolvesAlive: number): string {
  if (phase === "sheriff-run") return "The sheriff election opens: every living participant decides whether to run (上警). The elected sheriff's day vote counts 1.5x; candidates campaign but cannot vote in the election.";
  if (phase === "sheriff-campaign") return "Sheriff campaign: the candidates give one speech each, in seat order — everyone else listens.";
  if (phase === "sheriff-withdraw") return "The speeches are done. Candidates may withdraw (退选); the last one standing cannot. Withdrawn candidates still cannot vote.";
  if (phase === "sheriff-vote") return "Sheriff election vote: everyone who never ran casts one sealed ballot for a candidate. The badge carries a 1.5x day vote.";
  if (phase === "sheriff-pk") return "The sheriff election tied: the tied candidates give their PK speeches, then the electors re-vote. A second tie leaves the village without a sheriff.";
  if (phase === "day-discussion") return `${aliveCount} participants remain. Hidden objectives conflict, and public behavior may not reveal private strategy. Your role is ${roleLabel(role)}.`;
  if (phase === "day-knight") return `The knight's daytime duel is open: one challenge, before the vote. ${wolvesAlive} wolves remain, known only to the pack.`;
  if (phase === "day-pk") return `The vote tied: the two accused are giving their PK speeches, then the table re-votes without them. ${wolvesAlive} wolves remain, known only to the pack.`;
  if (phase === "day-vote") return `Discussion is closed. Every living participant is choosing one binding vote. ${wolvesAlive} wolves remain, known only to the pack.`;
  return isWolfRole(role)
    ? "Night phase: coordinate privately with the pack and choose a non-wolf target."
    : role === "guard"
      ? "Night phase: choose a player to protect from the wolf kill (or skip)."
      : role === "seer"
        ? "Night phase: privately investigate one living participant."
        : role === "witch"
          ? "Night phase: decide your potions — save the wolf victim (not yourself), poison one player, or pass."
          : "Night phase: you have no domain action and will not be activated.";
}

function phaseLabel(phase: Phase): string {
  if (phase === "sheriff-run") return "警长竞选 · 上警";
  if (phase === "sheriff-campaign") return "警长竞选 · 发言";
  if (phase === "sheriff-withdraw") return "警长竞选 · 退选";
  if (phase === "sheriff-vote") return "警长竞选 · 投票";
  if (phase === "sheriff-pk") return "警长竞选 · 平票 PK";
  if (phase === "day-discussion") return "白天讨论";
  if (phase === "day-knight") return "骑士决斗";
  if (phase === "day-vote") return "白天投票";
  if (phase === "day-pk") return "平票 PK";
  return "夜晚行动";
}

function tallyTargets(votes: Map<string, string>): Map<string, number> {
  const tally = new Map<string, number>();
  for (const target of votes.values()) tally.set(target, (tally.get(target) ?? 0) + 1);
  return tally;
}

function pluralityTarget(votes: Map<string, string>): string | undefined {
  return [...tallyTargets(votes)].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function recordPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ACTION_PAYLOAD_INVALID: Provide an object payload.");
  }
  return payload as Record<string, unknown>;
}
