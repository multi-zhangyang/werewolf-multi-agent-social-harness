import { randomInt } from "node:crypto";
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
  WorldSnapshot
} from "../../contracts";
import { contextFromRunContext, scopedContext, SocialWorldBase } from "../../world";
import { DiscussionDirector } from "../../conversation";
import { SuspicionClimate } from "../../suspicion";
import { boundedRounds, discussionPersonality, emitAction } from "../helpers";
import { roleHypothesisTool } from "../../cognition";
import {
  WEREWOLF_ROLES,
  deckForPlayerCount,
  isVillageRole,
  isWolfRole,
  roleLabel,
  type WerewolfRoleId
} from "./roles";

type Phase = "day-discussion" | "day-knight" | "day-vote" | "night";

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
}

/** A pending death skill: hunter or wolf-king must decide a target (or hold). */
interface PendingShot {
  shooterId: string;
  kind: "hunter" | "wolf-king";
  cause: string;
}

const ACCUSATION_LEXICON = /怀疑|是狼|狼人|铁狼|狼王|出局|投|说谎|撒谎|骗|小丑|查杀|金水|装好人|带节奏|站队|伪/;
const DEFENSE_LEXICON = /相信|支持|担保|信任|不是狼|好人|别投|我信|没问题/;

export class WerewolfWorld extends SocialWorldBase {
  private readonly maxDays: number;
  private readonly deckName: string;
  private readonly roles = new Map<string, WerewolfRoleId>();
  private readonly alive = new Set<string>();
  private readonly votes = new Map<string, string>();
  private readonly wolfTargets = new Map<string, string>();
  private readonly seerKnowledge = new Map<string, Map<string, WerewolfRoleId>>();
  private readonly seerTargets = new Map<string, string>();
  private readonly history: DayRecord[] = [];
  private readonly lastExperiences = new Map<string, string>();
  private discussion: DiscussionDirector | null = null;
  private readonly suspicion = new SuspicionClimate();
  private winners: string[] = [];
  private outcome = "";
  private phase: Phase = "day-discussion";
  private day = 1;
  /** Witch potions: one antidote, one poison, once each for the whole game. */
  private antidoteAvailable = true;
  private poisonAvailable = true;
  /** This night's witch decision (set through the tool, cleared at dawn). */
  private witchSaveId?: string;
  private witchPoisonId?: string;
  /** Whether the witch has decided tonight — a pass still counts as acting. */
  private witchActed = false;
  /** This night's guard decision. */
  private guardTargetId?: string;
  private lastGuardTargetId?: string;
  /** Death skills waiting for their owner's decision (hunter / wolf-king). */
  private readonly pendingShots: PendingShot[] = [];
  private jesterWon = false;
  /** Idiots who flipped their card: alive, but without a vote. */
  private readonly idiotRevealed = new Set<string>();
  /** The knight's one daytime duel: once per game, before the vote. */
  private knightUsed = false;

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
    });
    this.discussion = this.createDiscussion();
    this.addLog(`身份已经分配（${deck.name}）。公开讨论开始，所有承诺都可能是策略。`, 1);
  }

  protected exportWorldState(): unknown {
    return {
      day: this.day,
      phase: this.phase,
      roles: this.mapEntries(this.roles),
      alive: [...this.alive],
      votes: this.mapEntries(this.votes),
      wolfTargets: this.mapEntries(this.wolfTargets),
      seerKnowledge: [...this.seerKnowledge.entries()].map(([seerId, knowledge]) => [seerId, [...knowledge.entries()]] as [string, Array<[string, WerewolfRoleId]>]),
      seerTargets: this.mapEntries(this.seerTargets),
      history: structuredClone(this.history),
      lastExperiences: this.mapEntries(this.lastExperiences),
      discussion: this.discussion ? this.discussion.exportState() : null,
      suspicion: this.suspicion.exportState(),
      winners: [...this.winners],
      outcome: this.outcome,
      antidoteAvailable: this.antidoteAvailable,
      poisonAvailable: this.poisonAvailable,
      witchSaveId: this.witchSaveId ?? null,
      witchPoisonId: this.witchPoisonId ?? null,
      witchActed: this.witchActed,
      guardTargetId: this.guardTargetId ?? null,
      lastGuardTargetId: this.lastGuardTargetId ?? null,
      pendingShots: structuredClone(this.pendingShots),
      jesterWon: this.jesterWon,
      idiotRevealed: [...this.idiotRevealed],
      knightUsed: this.knightUsed
    };
  }

  protected restoreWorldState(state: unknown): void {
    const s = state as Partial<{
      day: number; phase: string; roles: Array<[string, WerewolfRoleId]>; alive: string[];
      votes: Array<[string, string]>; wolfTargets: Array<[string, string]>;
      seerKnowledge: Array<[string, Array<[string, WerewolfRoleId]>]>; seerTargets: Array<[string, string]>;
      history: DayRecord[]; lastExperiences: Array<[string, string]>; discussion: unknown; suspicion: unknown;
      winners: string[]; outcome: string; antidoteAvailable: boolean; poisonAvailable: boolean;
      witchSaveId: string | null; witchPoisonId: string | null; witchActed: boolean;
      guardTargetId: string | null; lastGuardTargetId: string | null; pendingShots: PendingShot[]; jesterWon: boolean; idiotRevealed: string[]; knightUsed: boolean;
    }> | undefined;
    if (!s) return;
    this.day = Number(s.day ?? 1);
    this.phase = (s.phase ?? "day-discussion") as Phase;
    this.fillMap(this.roles, s.roles);
    this.alive.clear();
    for (const id of s.alive ?? []) this.alive.add(id);
    this.fillMap(this.votes, s.votes);
    this.fillMap(this.wolfTargets, s.wolfTargets);
    this.seerKnowledge.clear();
    for (const [seerId, knowledge] of s.seerKnowledge ?? []) {
      this.seerKnowledge.set(seerId, new Map(knowledge ?? []));
    }
    this.fillMap(this.seerTargets, s.seerTargets);
    this.history.length = 0;
    this.history.push(...structuredClone(s.history ?? []));
    this.fillMap(this.lastExperiences, s.lastExperiences);
    if (s.discussion) {
      this.discussion = this.createDiscussion();
      this.discussion.restoreState(s.discussion);
    }
    this.suspicion.restoreState(s.suspicion);
    this.winners = [...(s.winners ?? [])];
    this.outcome = String(s.outcome ?? "");
    this.antidoteAvailable = Boolean(s.antidoteAvailable);
    this.poisonAvailable = Boolean(s.poisonAvailable);
    this.witchSaveId = s.witchSaveId ?? undefined;
    this.witchPoisonId = s.witchPoisonId ?? undefined;
    this.witchActed = Boolean(s.witchActed);
    this.guardTargetId = s.guardTargetId ?? undefined;
    this.lastGuardTargetId = s.lastGuardTargetId ?? undefined;
    this.pendingShots.length = 0;
    this.pendingShots.push(...structuredClone(s.pendingShots ?? []));
    this.jesterWon = Boolean(s.jesterWon);
    this.idiotRevealed.clear();
    for (const id of s.idiotRevealed ?? []) this.idiotRevealed.add(id);
    this.knightUsed = Boolean(s.knightUsed);
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

  observe(actorId: string): AgentObservation {
    const self = this.requireProfile(actorId);
    const role = this.roles.get(actorId)!;
    const teammates = isWolfRole(role)
      ? [...this.roles].filter(([id, candidateRole]) => id !== actorId && isWolfRole(candidateRole)).map(([id]) => id)
      : [];
    const knowledge = role === "seer" ? Object.fromEntries(this.seerKnowledge.get(actorId) ?? []) : {};
    const wolfTarget = this.currentWolfTarget();
    const privateContext: string[] = [
      `Your hidden role: ${roleLabel(role)}.`,
      `Your objective: ${this.rolesObjective(role)}`,
      ...(teammates.length ? [`Wolf teammates (you know each other): ${teammates.join(", ")}.`] : []),
      ...(role === "seer" ? [`Private investigations: ${Object.entries(knowledge).map(([id, knownRole]) => `${id}=${knownRole}`).join(", ") || "none"}.`] : []),
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
      `Your vote: ${this.votes.get(actorId) ?? "not cast"}.`,
      `You are ${this.alive.has(actorId) ? "alive" : "eliminated"}.`
    ];
    return {
      roomId: this.roomId,
      scenarioId: this.scenario.id,
      turn: this.day,
      phase: this.phase,
      situation: `${situationFor(this.phase, role, this.alive.size, this.wolvesAlive().length)}\nPublic suspicion climate: ${this.suspicion.climateText((id) => this.profiles.get(id)?.displayName ?? id)}`,
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
    const tools: Tool<SocietyAgentContext>[] = [];
    const bind = (name: string, description: string, schema: z.ZodType, action: string): Tool<SocietyAgentContext> =>
      tool({
        name,
        description,
        parameters: schema,
        execute: async (input, runContext) => {
          const context = scopedContext(runContext, actorId);
          const commit = await this.performAction(actorId, action, input);
          emitAction(context, commit.action, commit.detail);
          return commit.result;
        }
      }) as Tool<SocietyAgentContext>;

    tools.push(bind(
      "cast_day_vote",
      "Cast your binding daytime vote against one living participant. Votes remain hidden until every living participant commits and cannot be changed.",
      z.object({ targetId: z.string().min(1), reason: z.string().min(1).max(2_000) }).strict(),
      "cast_day_vote"
    ));

    if (isWolfRole(role)) {
      tools.push(bind(
        "choose_night_target",
        "As a living wolf at night, nominate one living non-wolf participant for elimination. Each wolf submits a target; the pack's majority decides. You may not nominate yourself.",
        z.object({ targetId: z.string().min(1), reason: z.string().min(1).max(2_000) }).strict(),
        "choose_night_target"
      ));
    }
    if (role === "seer") {
      tools.push(bind(
        "investigate_identity",
        "As the living seer at night, inspect one other living participant. The exact hidden role is returned privately and remains available in future observations.",
        z.object({ targetId: z.string().min(1), reason: z.string().min(1).max(2_000) }).strict(),
        "investigate_identity"
      ));
    }
    if (role === "witch") {
      tools.push(bind(
        "witch_night_choice",
        "As the living witch, decide tonight's potions. Use saveTargetId to save the wolf victim (not yourself; cannot be you). Use poisonTargetId to kill one living participant. You may pass (no fields), but you cannot use both potions in the same night. A saved-and-poisoned same target dies (poison wins).",
        z.object({
          saveTargetId: z.string().min(1).optional(),
          poisonTargetId: z.string().min(1).optional()
        }).strict(),
        "witch_night_choice"
      ));
    }
    if (role === "guard") {
      tools.push(bind(
        "guard_tonight",
        "As the living guard, choose one player to protect from the wolf kill tonight. You may guard yourself or skip (omit targetId). You cannot guard the same target as the previous night. Guarding does not stop poison.",
        z.object({
          targetId: z.string().min(1).optional(),
          reason: z.string().min(1).max(2_000).optional()
        }).strict(),
        "guard_tonight"
      ));
    }
    if (role === "hunter") {
      tools.push(bind(
        "hunter_shoot",
        "You are dying. Shoot one living participant, or pass (omit targetId). A hunter who is poisoned cannot shoot. A shot resolves immediately.",
        z.object({ targetId: z.string().min(1).optional(), reason: z.string().min(1).max(2_000).optional() }).strict(),
        "hunter_shoot"
      ));
    }
    if (role === "wolf-king") {
      tools.push(bind(
        "wolf_king_shoot",
        "You are dying (not by poison). Take one living participant with you, or pass (omit targetId). The shot resolves immediately.",
        z.object({ targetId: z.string().min(1).optional(), reason: z.string().min(1).max(2_000).optional() }).strict(),
        "wolf_king_shoot"
      ));
    }
    // Hidden-identity worlds get the role-probability ledger: suspicion stays
    // a distribution, not a free-text hunch.
    if (role === "knight" && !this.knightUsed) {
      const duel = tool({
        name: "knight_challenge",
        description: "Once per game, during the day before the vote, challenge one living participant to a duel. If they are a wolf, they are eliminated; if they are not a wolf, YOU die instead. Omit targetId to pass and give up the chance.",
        parameters: z.object({
          targetId: z.string().min(1).max(60).optional(),
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

  domainActionsFor(actorId: string): PlayerActionSpec[] {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    if (!this.alive.has(actorId)) return [];
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
    }
    return [];
  }

  async performDomainAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit> {
    const role = this.roles.get(actorId);
    if (!role) throw new Error(`ACTOR_NOT_FOUND: '${actorId}' is not in this room.`);
    const value = recordPayload(payload);
    const targetId = typeof value.targetId === "string" && value.targetId ? value.targetId : undefined;
    const reason = typeof value.reason === "string" ? value.reason.trim() : "";
    // Death shots belong to a dying actor: they are legal even though the
    // shooter just left the alive set.
    if (action !== "hunter_shoot" && action !== "wolf_king_shoot") this.assertActiveActor(actorId);

    if (action === "knight_challenge") {
      if (this.phase !== "day-knight" || role !== "knight" || this.knightUsed) throw new Error("KNIGHT_NOT_READY: The daytime duel is not available now.");
      const duelTarget = recordPayload(payload)?.targetId as string | undefined;
      if (!duelTarget) {
        // The knight gives up the chance; the vote opens.
        this.knightUsed = true;
        this.addLog(`${this.profiles.get(actorId)?.displayName} 放弃了骑士决斗机会。`, this.day);
        this.phase = "day-vote";
        this.emitUpdate();
        return { action, detail: `${actorId}; passed`, result: { accepted: true, passed: true } };
      }
      this.assertLivingTarget(duelTarget);
      if (duelTarget === actorId) throw new Error("INVALID_KNIGHT_TARGET: You may not challenge yourself.");
      this.knightUsed = true;
      const targetRole = this.roles.get(duelTarget);
      const targetIsWolf = isWolfRole(targetRole);
      const victimId = targetIsWolf ? duelTarget : actorId;
      const knightName = this.profiles.get(actorId)?.displayName ?? actorId;
      const targetName = this.profiles.get(duelTarget)?.displayName ?? duelTarget;
      this.alive.delete(victimId);
      this.pushEliminationEvents(victimId, "knight", this.roles.get(victimId));
      const text = targetIsWolf
        ? `${knightName} 发起决斗：${targetName} 是狼人，被当场淘汰！`
        : `${knightName} 发起决斗：${targetName} 并不是狼人——${knightName} 力战身亡。`;
      this.addLog(text, this.day, targetIsWolf ? "deception-exposed" : "misplay");
      this.suspicion.noteResolved(this.day, victimId);
      if (this.wolvesAlive().length === 0) {
        this.endGame(this.factionMembers(["seer", "witch", "hunter", "knight", "guard", "idiot", "villager"]), "所有狼人都已出局，村庄阵营获胜。");
        return { action, detail: `${actorId}; ${duelTarget}`, result: { accepted: true, targetId: duelTarget, targetIsWolf } };
      }
      if (this.wolvesHaveParity()) {
        this.endGame(this.factionMembers(["wolf", "wolf-king"]), "狼人已经控制投票数量，狼人阵营获胜。");
        return { action, detail: `${actorId}; ${duelTarget}`, result: { accepted: true, targetId: duelTarget, targetIsWolf } };
      }
      this.phase = "day-vote";
      this.emitUpdate();
      return { action, detail: `${actorId}; ${duelTarget}`, result: { accepted: true, targetId: duelTarget, targetIsWolf } };
    }
    if (action === "cast_day_vote") {
      if (this.idiotRevealed.has(actorId)) throw new Error("IDIOT_CANNOT_VOTE: 白痴翻牌后失去投票权，只能发言。");
      if (!targetId) throw new Error("TARGET_REQUIRED: Select a participant.");
      this.assertLivingTarget(targetId);
      if (this.phase !== "day-vote") throw new Error("VOTE_NOT_OPEN: Daytime voting is not open.");
      if (this.votes.has(actorId)) throw new Error("VOTE_ALREADY_CAST: Your vote is fixed.");
      this.votes.set(actorId, targetId);
      this.emitUpdate();
      return { action, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, targetId } };
    }
    if (action === "choose_night_target") {
      if (!targetId) throw new Error("TARGET_REQUIRED: Select a participant.");
      this.assertLivingTarget(targetId);
      if (this.phase !== "night" || !isWolfRole(role)) throw new Error("NIGHT_ACTION_FORBIDDEN: Only a living wolf can choose this target at night.");
      if (targetId === actorId) throw new Error("INVALID_WOLF_TARGET: You may not nominate yourself.");
      if (isWolfRole(this.roles.get(targetId))) throw new Error("INVALID_WOLF_TARGET: Choose a living non-wolf participant.");
      if (this.wolfTargets.has(actorId)) throw new Error("NIGHT_TARGET_ALREADY_CHOSEN: Your nomination is fixed.");
      this.wolfTargets.set(actorId, targetId);
      this.emitUpdate();
      return { action, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, targetId } };
    }
    if (action === "investigate_identity") {
      if (!targetId) throw new Error("TARGET_REQUIRED: Select a participant.");
      this.assertLivingTarget(targetId);
      if (this.phase !== "night" || role !== "seer") throw new Error("INVESTIGATION_FORBIDDEN: Only a living seer can investigate at night.");
      if (targetId === actorId) throw new Error("INVALID_INVESTIGATION_TARGET: Choose another living participant.");
      if (this.seerTargets.has(actorId)) throw new Error("INVESTIGATION_ALREADY_USED: Your investigation is fixed for tonight.");
      const targetRole = this.roles.get(targetId)!;
      this.seerTargets.set(actorId, targetId);
      this.seerKnowledge.get(actorId)?.set(targetId, targetRole);
      this.emitUpdate();
      return { action, detail: reason ? `${targetId}; ${reason}` : targetId, result: { accepted: true, targetId, role: targetRole } };
    }
    if (action === "witch_night_choice") {
      if (this.phase !== "night" || role !== "witch") throw new Error("WITCH_ACTION_FORBIDDEN: Only the living witch may use potions at night.");
      if (this.witchChoiceMade()) throw new Error("WITCH_CHOICE_LOCKED: Your decision for tonight is fixed.");
      const saveTargetId = typeof value.saveTargetId === "string" && value.saveTargetId ? value.saveTargetId : undefined;
      const poisonTargetId = typeof value.poisonTargetId === "string" && value.poisonTargetId ? value.poisonTargetId : undefined;
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
      this.emitUpdate();
      return {
        action,
        detail: saveTargetId ? `解药 → ${saveTargetId}` : poisonTargetId ? `毒药 → ${poisonTargetId}` : "pass",
        result: { accepted: true, saveTargetId, poisonTargetId }
      };
    }
    if (action === "guard_tonight") {
      if (this.phase !== "night" || role !== "guard") throw new Error("GUARD_ACTION_FORBIDDEN: Only the living guard may protect at night.");
      if (this.guardTargetId) throw new Error("GUARD_ALREADY_CHOSEN: Your guard choice for tonight is fixed.");
      if (targetId) {
        this.assertLivingTarget(targetId);
        if (targetId === this.lastGuardTargetId) throw new Error("GUARD_REPEAT_FORBIDDEN: 不能连续两晚守护同一名玩家。");
        this.guardTargetId = targetId;
      } else {
        this.guardTargetId = "__none__";
      }
      this.emitUpdate();
      return { action, detail: targetId ?? "skip", result: { accepted: true, targetId } };
    }
    if (action === "hunter_shoot" || action === "wolf_king_shoot") {
      const pending = this.pendingShots.find((entry) => entry.shooterId === actorId);
      if (!pending) throw new Error("SHOT_NOT_PENDING: You are not currently resolving a death shot.");
      if (action === "hunter_shoot" && pending.kind !== "hunter") throw new Error("SHOT_ROLE_MISMATCH: Your pending shot is not a hunter shot.");
      if (action === "wolf_king_shoot" && pending.kind !== "wolf-king") throw new Error("SHOT_ROLE_MISMATCH: Your pending shot is not a wolf-king shot.");
      this.resolveShot(actorId, targetId);
      return { action, detail: targetId ?? "压枪（不开枪）", result: { accepted: true, targetId } };
    }
    throw new Error(`ACTION_NOT_AVAILABLE: '${action}' is not valid in this world.`);
  }

  activation(): WorldActivation | null {
    if (this.status !== "running") return null;
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
        instructionFor: (actorId) => wave === 1
          ? "Opening round of the day. Share your read of the situation: what you observed, who you trust or suspect, what you want to know. Ask questions, test others, or stay reserved — but do not cast a vote yet."
          : "The discussion is live and people have reacted. Respond to what was actually said: answer questions directed at you, defend yourself if accused, challenge weak claims, support allies, or expose contradictions. You may also stay silent if you have nothing new to add. Do not cast a vote yet."
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
    const knightId = [...this.roles].find(([id, role]) => role === "knight" && this.alive.has(id))?.[0]!;
    return {
      id: `ww:${this.day}:knight`,
      label: `第 ${this.day} 天骑士决斗`,
      actorIds: [knightId],
      mode: "sequential",
      instructionFor: () => "讨论结束，投票开始前是你唯一的决斗时刻。可以挑战一名最可疑的存活玩家：若对方是狼人，TA 当场出局；若不是，你会倒下。也可以省略 targetId 放弃这次机会。"
    };
  }

  private voteActivation(): WorldActivation {
    return {
      id: `ww:${this.day}:vote`,
      label: `第 ${this.day} 天投票`,
      actorIds: [...this.alive].filter((id) => !this.idiotRevealed.has(id)),
      mode: "parallel",
      instructionFor: () => "The discussion is closed. You must call cast_day_vote exactly once against a living participant. Consider not only hidden roles but how every faction benefits from being suspected or eliminated."
    };
  }

  /** Night order: wolves → guard → seer → witch (published board order). */
  private nightActivation(aliveIds: string[]): WorldActivation {
    const ordered: string[] = [];
    for (const id of aliveIds) if (isWolfRole(this.roles.get(id)) && !this.wolfTargets.has(id)) ordered.push(id);
    for (const id of aliveIds) if (this.roles.get(id) === "guard" && !this.guardTargetId) ordered.push(id);
    for (const id of aliveIds) if (this.roles.get(id) === "seer" && !this.seerTargets.has(id)) ordered.push(id);
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
        if (isWolfRole(role)) return "Use the private team channel if coordination is useful, then call choose_night_target exactly once against a living non-wolf.";
        if (role === "guard") return "Call guard_tonight once: protect a player from the wolf kill, or omit targetId to skip. Remember you cannot guard the same target two nights in a row.";
        if (role === "seer") return "Call investigate_identity exactly once on another living participant. Keep the result private unless revealing it later serves your strategy.";
        return "Call witch_night_choice exactly once: save the wolf victim with the antidote (not yourself), poison one living player, or pass. You cannot use both potions in the same night.";
      }
    };
  }

  completeActivation(activation: WorldActivation): ActivationCompletion {
    if (activation.id.includes(":discussion")) {
      this.discussion?.endWave();
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
      return { completed: true, missingActorIds: [] };
    }
    if (activation.id.endsWith(":knight")) {
      // A knight who never called the tool has given the chance up.
      if (!this.knightUsed) {
        this.knightUsed = true;
        this.phase = "day-vote";
        this.emitUpdate();
      }
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
  }): Promise<SocialMessage> {
    if (input.channel === "team" && (!input.recipientIds || input.recipientIds.length === 0)) {
      input = {
        ...input,
        recipientIds: [...this.alive].filter((id) => id !== input.senderId && isWolfRole(this.roles.get(id)))
      };
    }
    const message = await super.sendMessage(input);
    if (message.channel === "public" && this.phase === "day-discussion" && this.discussion) {
      this.discussion.onMessage({
        senderId: message.senderId,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {})
      });
      this.detectSocialActs(message);
    }
    return message;
  }

  /**
   * Read public speech for its social meaning: who was accused, who was
   * defended. These become appraisal events so the target's emotions and
   * relationships react — an accusation is not just a line of text.
   */
  private detectSocialActs(message: SocialMessage): void {
    for (const id of this.alive) {
      if (id === message.senderId) continue;
      const name = this.profiles.get(id)?.displayName ?? id;
      const atName = message.text.indexOf(name);
      const atId = message.text.indexOf(id);
      if (atName === -1 && atId === -1) continue;
      const at = atName !== -1 ? atName : atId;
      const window = message.text.slice(Math.max(0, at - 16), at + 40);
      const snippet = message.text.slice(0, 120);
      if (ACCUSATION_LEXICON.test(window)) {
        this.suspicion.noteAccusation(this.day, message.senderId, id);
        this.pushEvent(id, {
          type: "accused",
          actorId: message.senderId,
          targetId: id,
          detail: `Day ${this.day} discussion: ${message.senderName} accused you in public — "${snippet}"`
        });
      } else if (DEFENSE_LEXICON.test(window)) {
        this.pushEvent(id, {
          type: "defended",
          actorId: message.senderId,
          targetId: id,
          detail: `Day ${this.day} discussion: ${message.senderName} stood up for you in public — "${snippet}"`
        });
      }
    }
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
    if (!this.alive.has(senderId)) throw new Error("ACTOR_ELIMINATED: Eliminated participants cannot communicate.");
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
    if (!this.alive.has(actorId)) return [];
    if (this.phase === "day-discussion") return ["communicate", "recall_memory", "reflect_on_social_situation", "update_inner_state"];
    if (this.phase === "day-knight") return role === "knight" && !this.knightUsed ? ["knight_challenge", "remember_experience"] : [];
    if (this.phase === "day-vote") return this.idiotRevealed.has(actorId) ? ["remember_experience"] : ["cast_day_vote", "remember_experience"];
    if (isWolfRole(role)) return ["communicate:team", "choose_night_target"];
    if (role === "seer") return ["investigate_identity", "remember_experience"];
    if (role === "witch") return ["witch_night_choice", "remember_experience"];
    if (role === "guard") return ["guard_tonight", "remember_experience"];
    return [];
  }

  private rolesObjective(role: WerewolfRoleId): string {
    return `${WEREWOLF_ROLES[role].objective}`;
  }

  private nightActionCommitted(actorId: string): boolean {
    const role = this.roles.get(actorId);
    if (isWolfRole(role)) return this.wolfTargets.has(actorId);
    if (role === "guard") return Boolean(this.guardTargetId);
    if (role === "seer") return this.seerTargets.has(actorId);
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
    const tally = tallyTargets(this.votes);
    const ranked = [...tally].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const hasTie = ranked.length > 1 && ranked[0][1] === ranked[1][1];
    const eliminatedId = hasTie ? undefined : ranked[0]?.[0];
    const eliminatedRole = eliminatedId ? this.roles.get(eliminatedId) : undefined;
    // The idiot's flip: voted out once, they reveal, survive and lose the
    // vote (official rule). A second vote-out eliminates them normally.
    const idiotSurvives = eliminatedId !== undefined && eliminatedRole === "idiot" && !this.idiotRevealed.has(eliminatedId);
    if (idiotSurvives) this.idiotRevealed.add(eliminatedId);
    else if (eliminatedId) this.alive.delete(eliminatedId);
    const record: DayRecord = {
      day: this.day,
      votes: Object.fromEntries(this.votes),
      ...(eliminatedId ? { eliminatedId, eliminatedRole } : {}),
      ...(idiotSurvives ? { idiotSurvived: true } : {})
    };
    this.history.push(record);
    const voteText = idiotSurvives
      ? `${this.profiles.get(eliminatedId!)?.displayName} 被投票放逐，亮明白痴身份——免于一死，但从此失去投票权。`
      : eliminatedId
        ? `${this.profiles.get(eliminatedId)?.displayName} 被投票放逐，身份揭晓：${roleLabel(eliminatedRole)}。`
        : "本轮平票，无人被放逐。";
    for (const id of this.profiles.keys()) this.lastExperiences.set(id, `第 ${this.day} 天投票：${voteText} 投票：${[...this.votes].map(([voter, target]) => `${voter}->${target}`).join(", ")}。`);
    const voteBeat = idiotSurvives
      ? undefined
      : eliminatedId
        ? eliminatedRole === "wolf" || eliminatedRole === "wolf-king"
          ? "deception-exposed" as const
          : eliminatedRole === "jester"
            ? "win" as const
            : "misplay" as const
        : undefined;
    this.addLog(voteText, this.day, voteBeat);

    for (const [voterId, targetId] of this.votes) {
      const voterName = this.profiles.get(voterId)?.displayName ?? voterId;
      const targetName = this.profiles.get(targetId)?.displayName ?? targetId;
      this.pushEvent(voterId, {
        type: "vote-cast",
        actorId: voterId,
        targetId,
        detail: `Day ${this.day}: you voted to eliminate ${targetName}.`
      });
      this.pushEvent(targetId, {
        type: "vote-against",
        actorId: voterId,
        targetId,
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
    }
    for (const [voterId, targetId] of this.votes) this.suspicion.noteVote(this.day, voterId, targetId);
    if (eliminatedId) this.suspicion.noteResolved(this.day, eliminatedId);
    this.votes.clear();

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
      parts.push(`夜里狼人袭击了 ${this.profiles.get(savedId)?.displayName}，但 ${guardId === savedId && saveId === savedId ? "守卫与女巫同时出手" : guardId === savedId ? "守卫挡住了这一刀" : "女巫用解药救回了"} TA。`);
    } else if (wolfTargetId && bothOnWolfTarget) {
      parts.push(`夜里狼人袭击了 ${this.profiles.get(wolfTargetId)?.displayName}，守卫与女巫同守同救——奶穿，TA 仍然倒下了。`);
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
        ? ` 你的查验结果：${this.seerTargets.get(id)} 是${roleLabel(this.roles.get(this.seerTargets.get(id)!))}。`
        : "";
      const witchResult = this.roles.get(id) === "witch" && wolfTargetId
        ? ` 今晚狼人袭击了 ${wolfTargetId}。`
        : "";
      this.lastExperiences.set(id, `第 ${this.day} 天夜晚：${nightText}${privateResult}${witchResult}`);
    }
    this.addLog(nightText, this.day, wolfKillId || (wolfTargetId && bothOnWolfTarget) ? "betrayal" : undefined);

    // Appraisal + death-skill scheduling. Poisoned deaths cannot shoot.
    const deadByWolf = wolfKillId ?? (wolfTargetId && bothOnWolfTarget ? wolfTargetId : undefined);
    if (deadByWolf) this.pushEliminationEvents(deadByWolf, "night", this.roles.get(deadByWolf));
    if (poisonId) this.pushEliminationEvents(poisonId, "poison", this.roles.get(poisonId));
    for (const [seerId, target] of this.seerTargets) {
      this.pushEvent(seerId, {
        type: "investigation",
        actorId: seerId,
        targetId: target,
        facts: { role: roleLabel(this.roles.get(target)) },
        detail: `第 ${this.day} 天夜晚：你的查验显示 ${this.profiles.get(target)?.displayName ?? target} 是${roleLabel(this.roles.get(target))}。`
      });
    }

    this.wolfTargets.clear();
    this.seerTargets.clear();
    this.witchSaveId = undefined;
    this.witchPoisonId = undefined;
    this.witchActed = false;
    this.lastGuardTargetId = guardId;
    this.guardTargetId = undefined;

    if (this.pendingShots.length) return; // shots resolve before phase transition
    this.afterNightChecks();
  }

  /** Schedule death skills and run the shared win checks after any death. */
  private pushEliminationEvents(targetId: string, by: "vote" | "night" | "poison" | "shot" | "knight", role: WerewolfRoleId | undefined): void {
    const targetName = this.profiles.get(targetId)?.displayName ?? targetId;
    this.pushEvent(targetId, {
      type: "eliminated",
      targetId,
      facts: { by, role: roleLabel(role) },
      detail: by === "vote"
        ? `第 ${this.day} 天：你被村庄投票放逐，身份揭晓：${roleLabel(role)}。`
        : by === "poison"
          ? `第 ${this.day} 天夜晚：女巫的毒药带走了你，身份揭晓：${roleLabel(role)}。你无法使用死亡技能。`
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
    // Hunter / wolf-king death shots. Poisoned victims cannot shoot.
    if (by === "poison") return;
    if (role === "hunter") this.pendingShots.push({ shooterId: targetId, kind: "hunter", cause: by });
    if (role === "wolf-king" && (by === "vote" || by === "shot")) this.pendingShots.push({ shooterId: targetId, kind: "wolf-king", cause: by });
  }

  /** Resolve one death shot (or a held shot), then cascade. */
  private resolveShot(shooterId: string, targetId: string | undefined): void {
    const index = this.pendingShots.findIndex((entry) => entry.shooterId === shooterId);
    if (index === -1) return;
    const shot = this.pendingShots[index];
    this.pendingShots.splice(index, 1);
    const shooterName = this.profiles.get(shooterId)?.displayName ?? shooterId;
    if (!targetId) {
      this.addLog(`${shooterName} 选择了压枪，没有带走任何人。`, this.day, "misplay");
      for (const id of this.profiles.keys()) {
        this.lastExperiences.set(id, `${shooterName} held their death shot.`);
      }
      this.emitUpdate();
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
    if (this.pendingShots.length) {
      // Stay in the current phase: the shot activation runs first.
      return;
    }
    if (this.wolvesAlive().length === 0) {
      this.endGame(this.factionMembers(["seer", "witch", "hunter", "knight", "guard", "idiot", "villager"]), this.jesterWon ? "所有狼人都已出局，村庄阵营获胜（小丑已单独获胜离场）。" : "所有狼人都已出局，村庄阵营获胜。");
      return;
    }
    if (this.wolvesHaveParity()) {
      this.endGame(this.factionMembers(["wolf", "wolf-king"]), this.jesterWon ? "狼人已经控制投票数量，狼人阵营获胜（小丑已单独获胜离场）。" : "狼人已经控制投票数量，狼人阵营获胜。");
      return;
    }
    this.phase = "night";
    this.emitUpdate();
  }

  private afterNightChecks(): void {
    if (this.wolvesAlive().length === 0) {
      this.endGame(this.factionMembers(["seer", "witch", "hunter", "knight", "guard", "idiot", "villager"]), this.jesterWon ? "所有狼人都已出局，村庄阵营获胜（小丑已单独获胜离场）。" : "所有狼人都已出局，村庄阵营获胜。");
      return;
    }
    if (this.wolvesHaveParity()) {
      this.endGame(this.factionMembers(["wolf", "wolf-king"]), this.jesterWon ? "狼人已经控制剩余局面，狼人阵营获胜（小丑已单独获胜离场）。" : "狼人已经控制剩余局面，狼人阵营获胜。");
      return;
    }
    if (this.day >= this.maxDays) {
      this.endGame(this.factionMembers(["wolf", "wolf-king"]), "村庄未能在期限内找出狼人，狼人阵营获胜。");
      return;
    }
    this.day += 1;
    this.suspicion.decay(0.75);
    this.phase = "day-discussion";
    this.discussion = this.createDiscussion();
    this.emitUpdate();
  }

  private endGame(winners: string[], outcome: string): void {
    this.winners = winners;
    this.outcome = outcome;
    this.addLog(outcome, this.day, "win");
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
      ...discussionPersonality(this.profiles)
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
  if (phase === "day-discussion") return `${aliveCount} participants remain. Hidden objectives conflict, and public behavior may not reveal private strategy. Your role is ${roleLabel(role)}.`;
  if (phase === "day-knight") return `The knight's daytime duel is open: one challenge, before the vote. ${wolvesAlive} wolves remain, known only to the pack.`;
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
  if (phase === "day-discussion") return "白天讨论";
  if (phase === "day-knight") return "骑士决斗";
  if (phase === "day-vote") return "白天投票";
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
