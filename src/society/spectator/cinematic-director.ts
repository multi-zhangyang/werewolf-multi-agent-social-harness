/**
 * CinematicDirector — the automatic spectator director (AGENTS.md §8.6).
 *
 * It derives tension and camera cues from REAL events only: world beats,
 * eliminations, vote swings, role actions, emotional spikes and speaking
 * transitions. It is presentation-only infrastructure:
 *
 *   - it never advises or instructs any agent;
 *   - it never modifies world state or agent minds;
 *   - it never reads private agent context into its output (cues carry only
 *     public knowledge: names, revealed roles, focus ids);
 *   - when a signal is unobservable, it simply does not fire.
 *
 * Cues are re-derivable from the event log and are not part of world truth.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentRuntimeEvent,
  CameraMode,
  CinematicCue,
  CoreEmotions,
  TensionReason,
  WorldLogEntry,
  WorldSnapshot
} from "../contracts";
import { levelLabel, reasonBoost, reasonLabel, TensionEngine, type TensionImpact } from "./tension-engine";

export interface DirectorOptions {
  roomId: string;
  /** Emit a presentational event onto the room stream (never world state). */
  emit(event: AgentRuntimeEvent): void;
  /** Seconds between tension decay ticks (default 10). */
  tickSeconds?: number;
}

interface AgentEmotion {
  total: number;
  lastSeenAt: number;
}

export class CinematicDirector {
  private readonly engine: TensionEngine;
  private readonly emotions = new Map<string, AgentEmotion>();
  private lastAlive = new Set<string>();
  private lastVoteTally = new Map<string, number>();
  private lastLogCount = 0;
  /** Suspicion ledger watermark for direct-accusation cues (public facts only). */
  private lastSuspicionCount = 0;
  private lastHighImpactAt = 0;
  private lastCueAt = 0;
  private tickTimer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private lastTurn = 0;

  constructor(private readonly options: DirectorOptions) {
    this.engine = new TensionEngine({ tickSeconds: options.tickSeconds ?? 10 });
    this.tickTimer = setInterval(() => this.onTick(), (options.tickSeconds ?? 10) * 1_000);
    this.tickTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  /** Feed one room event (public stream) plus the internal world snapshot. */
  ingest(event: AgentRuntimeEvent, world: WorldSnapshot): void {
    if (this.disposed) return;
    switch (event.type) {
      case "world.updated":
        this.ingestWorld(world, "at" in event && typeof event.at === "string" ? event.at : new Date().toISOString());
        break;
      case "agent.status":
        if (event.status === "speaking") {
          this.cue({
            camera: "speaker",
            focusAgentIds: [event.actorId],
            priority: 3,
            title: "正在发言",
            minimumDurationMs: 2_400,
            maximumDurationMs: 9_000,
            skippable: true
          }, [event]);
        }
        break;
      case "agent.updated":
        this.ingestEmotion(event.actorId, event.mind.mood.emotions, event.at);
        break;
      case "world.action":
        if (isRoleAction(event.action)) {
          this.impact({ reason: "role-action", boost: 0.16, agentIds: [event.actorId] }, [event]);
          this.cue({
            camera: "tool-action",
            focusAgentIds: [event.actorId],
            priority: 4,
            title: roleActionLabel(event.action),
            subtitle: event.detail.slice(0, 140),
            minimumDurationMs: 2_600,
            maximumDurationMs: 9_000,
            skippable: true
          }, [event]);
        }
        break;
      default:
        break;
    }
  }

  private ingestWorld(world: WorldSnapshot, at: string): void {
    // New world-log beats (betrayal, deception-exposed, promise-broken, win…).
    const log = world.log;
    const freshLog = log.slice(this.lastLogCount);
    this.lastLogCount = log.length;
    for (const entry of freshLog) this.ingestLogBeat(entry, at);

    // Eliminations: someone left the alive set.
    const alive = new Set(world.agents.filter((agent) => agent.alive).map((agent) => agent.id));
    if (this.lastAlive.size > 0) {
      const eliminated = [...this.lastAlive].filter((id) => !alive.has(id));
      if (eliminated.length) {
        const names = eliminated.map((id) => world.agents.find((agent) => agent.id === id)?.displayName ?? id);
        const roles = eliminated.map((id) => (world.agents.find((agent) => agent.id === id) as { observerRole?: string } | undefined)?.observerRole).filter(Boolean);
        this.impact({ reason: "elimination", agentIds: eliminated }, []);
        this.cue({
          camera: roles.length ? "role-reveal" : "elimination" as CameraMode,
          focusAgentIds: eliminated,
          priority: 9,
          title: `淘汰：${names.join("、")}`,
          ...(roles.length ? { subtitle: `身份揭晓：${roles.join("、")}` } : {}),
          effect: "reveal",
          minimumDurationMs: 4_000,
          maximumDurationMs: 12_000,
          skippable: true
        }, []);
      }
    }
    this.lastAlive = alive;

    // Vote swings: compare the latest tally with the previous one.
    const tally = tallyFromWorld(world);
    if (tally.size && this.lastVoteTally.size && !sameTally(this.lastVoteTally, tally)) {
      this.impact({ reason: "vote-swing", agentIds: [...tally.keys()] }, []);
      this.cue({
        camera: "vote-board",
        focusAgentIds: [...tally.keys()].slice(0, 4),
        priority: 5,
        title: "票型变化",
        minimumDurationMs: 2_400,
        maximumDurationMs: 8_000,
        skippable: true
      }, []);
    }
    if (tally.size) this.lastVoteTally = tally;

    // Win condition approaching (public signal only: the round counter). Hidden
    // identity counts are never read by the director — §2.6.
    // Direct accusations: hidden-identity worlds publish a public suspicion
    // ledger (speech/vote/outcome entries — all heard by the table, §2.6).
    // New speech entries become duel cues between accuser and target.
    const suspicion = (world.details as { suspicion?: { entries?: Array<{ kind?: string; accuser: string; target: string }> } } | undefined)?.suspicion;
    if (suspicion && Array.isArray(suspicion.entries)) {
      const entries = suspicion.entries;
      const fresh = this.lastSuspicionCount <= entries.length ? entries.slice(this.lastSuspicionCount) : [];
      this.lastSuspicionCount = entries.length;
      if (fresh.length) {
        const names = new Map(world.agents.map((agent) => [agent.id, agent.displayName]));
        for (const entry of fresh) {
          if (entry.kind !== "speech" || entry.accuser === "world" || !entry.target) continue;
          this.impact({ reason: "direct-accusation", agentIds: [entry.accuser, entry.target] }, []);
          this.cue({
            camera: "duel",
            focusAgentIds: [entry.accuser, entry.target],
            priority: 6,
            title: "公开指控",
            subtitle: `${names.get(entry.accuser) ?? entry.accuser} → ${names.get(entry.target) ?? entry.target}`,
            minimumDurationMs: 3_000,
            maximumDurationMs: 10_000,
            skippable: true
          }, []);
        }
      }
    }

    const nearEnd = world.totalTurns - world.turn <= 1 && world.status === "running";
    if (nearEnd && world.turn !== this.lastTurn) {
      this.lastTurn = world.turn;
      this.impact({ reason: "win-condition-near", agentIds: [] }, []);
      this.cue({
        camera: "wide-table",
        focusAgentIds: [],
        priority: 7,
        title: "胜负一线",
        subtitle: "终局临近",
        minimumDurationMs: 3_000,
        maximumDurationMs: 9_000,
        skippable: true
      }, []);
    }
  }

  private ingestLogBeat(entry: WorldLogEntry, _at: string): void {
    if (!entry.beat) return;
    const mapping: Partial<Record<NonNullable<WorldLogEntry["beat"]>, { reason: TensionReason; camera: CameraMode; title: string; priority: number }>> = {
      betrayal: { reason: "betrayal", camera: "duel", title: "背叛", priority: 10 },
      "deception-exposed": { reason: "deception-exposed", camera: "role-reveal", title: "谎言揭穿", priority: 10 },
      "promise-broken": { reason: "alliance-break", camera: "duel", title: "承诺破裂", priority: 9 },
      "promise-kept": { reason: "save", camera: "relationship", title: "承诺兑现", priority: 6 },
      alliance: { reason: "save", camera: "relationship", title: "公开结盟", priority: 6 },
      comeback: { reason: "save", camera: "wide-table", title: "逆转", priority: 8 },
      misplay: { reason: "contradiction", camera: "agent-mind", title: "失手", priority: 5 },
      win: { reason: "win-condition-near", camera: "endgame", title: "终局", priority: 11 },
      // P0-09 neutral beats keep light, low-weight presentation (role-action
      // 0.16 instead of the betrayal/deception weights). Reveal and return
      // beats stay unmapped: ingestWorld already covers eliminations and
      // role flips with their own cameras.
      "cooperative-outcome": { reason: "role-action", camera: "relationship", title: "合作达成", priority: 3 },
      "high-return": { reason: "role-action", camera: "relationship", title: "回报丰厚", priority: 3 },
      "unilateral-defection": { reason: "role-action", camera: "duel", title: "单方退出", priority: 4 },
      "free-riding": { reason: "role-action", camera: "wide-table", title: "搭便车", priority: 3 },
      "adverse-outcome": { reason: "role-action", camera: "wide-table", title: "不利结果", priority: 3 },
      "agreement-reached": { reason: "role-action", camera: "relationship", title: "达成一致", priority: 3 },
      "negotiation-failed": { reason: "role-action", camera: "duel", title: "谈判破裂", priority: 4 }
    };
    const mapped = mapping[entry.beat];
    if (!mapped) return;
    this.impact({ reason: mapped.reason, agentIds: [] }, []);
    this.cue({
      camera: mapped.camera,
      focusAgentIds: [],
      priority: mapped.priority,
      title: mapped.title,
      subtitle: entry.text.slice(0, 160),
      minimumDurationMs: 3_200,
      maximumDurationMs: 12_000,
      skippable: true
    }, []);
  }

  private ingestEmotion(actorId: string, emotions: CoreEmotions, at: string): void {
    const total = Object.values(emotions).reduce((sum, value) => sum + value, 0);
    const previous = this.emotions.get(actorId);
    const previousAt = previous?.lastSeenAt ?? 0;
    this.emotions.set(actorId, { total, lastSeenAt: Date.parse(at) || Date.now() });
    if (!previous) return;
    const delta = Math.abs(total - previous.total);
    if (delta >= 0.35 && Date.now() - previousAt > 3_000) {
      this.impact({ reason: "emotional-spike", agentIds: [actorId] }, []);
      this.cue({
        camera: "agent-mind",
        focusAgentIds: [actorId],
        priority: 4,
        title: "情绪波动",
        minimumDurationMs: 2_400,
        maximumDurationMs: 7_000,
        skippable: true
      }, []);
    }
  }

  private impact(reason: TensionImpact, sourceEvents: AgentRuntimeEvent[]): void {
    const now = Date.now();
    if (now - this.lastHighImpactAt < 1_200 && reasonBoost(reason.reason) >= 0.3) return;
    this.lastHighImpactAt = now;
    const result = this.engine.impact(reason, sourceEvents[0] && "id" in sourceEvents[0] ? String((sourceEvents[0] as { id?: string }).id ?? "") : "", now);
    if (result) {
      this.options.emit({
        type: "tension.changed",
        roomId: this.options.roomId,
        score: result.state.score,
        level: result.state.level,
        reasons: result.state.reasons,
        primaryAgentIds: result.state.primaryAgentIds,
        at: new Date().toISOString()
      });
    }
  }

  private cue(input: {
    camera: CameraMode;
    focusAgentIds: string[];
    priority: number;
    title: string;
    subtitle?: string;
    effect?: string;
    minimumDurationMs: number;
    maximumDurationMs: number;
    skippable: boolean;
  }, sourceEvents: AgentRuntimeEvent[]): void {
    const now = Date.now();
    if (now - this.lastCueAt < 900) return;
    this.lastCueAt = now;
    const cue: CinematicCue = {
      id: randomUUID(),
      roomId: this.options.roomId,
      sourceEventIds: sourceEvents
        .map((event) => (event as { id?: string }).id)
        .filter((id): id is string => Boolean(id)),
      camera: input.camera,
      focusAgentIds: input.focusAgentIds,
      priority: input.priority,
      minimumDurationMs: input.minimumDurationMs,
      maximumDurationMs: input.maximumDurationMs,
      title: input.title,
      ...(input.subtitle ? { subtitle: input.subtitle } : {}),
      ...(input.effect ? { effect: input.effect } : {}),
      skippable: input.skippable,
      createdAt: new Date().toISOString()
    };
    this.options.emit({
      type: "cinematic.cue",
      roomId: this.options.roomId,
      cue,
      at: cue.createdAt
    });
  }

  private onTick(): void {
    if (this.disposed) return;
    if (this.engine.tick(Date.now())) {
      const state = this.engine.snapshot();
      this.options.emit({
        type: "tension.changed",
        roomId: this.options.roomId,
        score: state.score,
        level: state.level,
        reasons: state.reasons,
        primaryAgentIds: state.primaryAgentIds,
        at: new Date().toISOString()
      });
    }
  }
}

/** Binding role actions worth a camera move (world tool names). */
function isRoleAction(action: string): boolean {
  return /vote|kill|target|investigate|guard|shoot|bid|demand|quest|assassin|choice|contribute|hunt|chicken|take|split|transfer|call|number|liar/i.test(action);
}

function roleActionLabel(action: string): string {
  if (/vote/i.test(action)) return "投票";
  if (/kill|target|shoot/i.test(action)) return "夜间行动";
  if (/investigate/i.test(action)) return "查验";
  if (/bid|auction/i.test(action)) return "出价";
  if (/demand|split|offer|ultimatum/i.test(action)) return "谈判报价";
  if (/quest|team/i.test(action)) return "组队";
  if (/contribute/i.test(action)) return "公共投入";
  if (/choice|move|defect|cooperate/i.test(action)) return "博弈选择";
  return "行动";
}

function tallyFromWorld(world: WorldSnapshot): Map<string, number> {
  const tally = new Map<string, number>();
  const history = world.details.history as Array<{ votes?: Record<string, string> }> | undefined;
  const last = history?.at(-1)?.votes;
  if (!last) return tally;
  for (const target of Object.values(last)) {
    tally.set(target, (tally.get(target) ?? 0) + 1);
  }
  return tally;
}

function sameTally(left: Map<string, number>, right: Map<string, number>): boolean {
  if (left.size !== right.size) return false;
  for (const [id, count] of left) if (right.get(id) !== count) return false;
  return true;
}

/** Labels exposed for the UI (reason chips). */
export const directorLabels = { levelLabel, reasonLabel };