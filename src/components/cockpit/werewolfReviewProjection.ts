import type { Role } from "../../core/types";
import type { PostgameMatchProjectionDto } from "../../server/artifactProjection";

const ROLES: readonly Role[] = ["villager", "werewolf", "seer", "witch", "hunter"];

export type WerewolfReviewVisibility = "postgame-review" | "truth-redacted";

export interface WerewolfReviewSeat {
  id: string;
  seat: number;
  name: string;
  alive: boolean;
  isSheriff: boolean;
  eliminatedAt?: {
    day: number;
    phase: string;
    reason: string;
  };
  /** Present only in the explicit local postgame review projection. */
  postgameRole?: Role;
}

export interface WerewolfReviewSpeech {
  day: number;
  playerId: string;
  text: string;
  kind: "day" | "last_words";
  claimedRole?: Role;
  pressureTargetId?: string;
  strategyTags: string[];
}

export interface WerewolfReviewVote {
  day: number;
  voterId: string;
  targetId?: string;
  abstain: boolean;
  weight: number;
  kind: "exile" | "sheriff";
}

export interface WerewolfReviewDeath {
  day: number;
  playerId: string;
  reason: string;
}

export interface WerewolfReviewPublicEvent {
  id: string;
  seq: number;
  day: number;
  phase: string;
  type: string;
  createdAt: string;
}

/**
 * This is intentionally a narrow view model, not a cast of GameState. The
 * truth-redacted DTO is structurally narrower than its historical TypeScript
 * declaration, so the selector treats every raw state field as unknown and
 * copies only safe public/postgame-review values into the render contract.
 */
export interface WerewolfReviewModel {
  visibility: WerewolfReviewVisibility;
  phase: string | null;
  day: number | null;
  currentSpeakerSeat?: number;
  pendingActionCount?: number;
  seats: WerewolfReviewSeat[];
  speeches: WerewolfReviewSpeech[];
  votes: WerewolfReviewVote[];
  deaths: WerewolfReviewDeath[];
  publicEvents: WerewolfReviewPublicEvent[];
}

export function buildWerewolfReviewModel(artifact: PostgameMatchProjectionDto | null): WerewolfReviewModel | null {
  if (!artifact || !isRecord(artifact.projection)) return null;
  const truthRedacted =
    artifact.projection.view === "truth-redacted" || artifact.projection.postgameTruthRedacted === true;
  const visibility: WerewolfReviewVisibility = truthRedacted ? "truth-redacted" : "postgame-review";
  const state = isRecord(artifact.finalState) ? artifact.finalState : null;
  if (!state) return null;

  const seats = readArray(state.players)
    .map((player) => reviewSeat(player, visibility))
    .filter((seat): seat is WerewolfReviewSeat => seat !== null)
    .sort((left, right) => left.seat - right.seat || left.id.localeCompare(right.id));

  return {
    visibility,
    phase: readString(state.phase) ?? null,
    day: readFiniteNumber(state.day) ?? null,
    currentSpeakerSeat: readFiniteNumber(state.currentSpeakerSeat),
    pendingActionCount: readFiniteNumber(state.pendingActionCount),
    seats,
    speeches: readArray(state.speeches)
      .map(reviewSpeech)
      .filter((speech): speech is WerewolfReviewSpeech => speech !== null),
    votes: readArray(state.votes)
      .map(reviewVote)
      .filter((vote): vote is WerewolfReviewVote => vote !== null),
    deaths: readArray(state.deaths)
      .map(reviewDeath)
      .filter((death): death is WerewolfReviewDeath => death !== null),
    publicEvents: readArray(state.events)
      .map(reviewPublicEvent)
      .filter((event): event is WerewolfReviewPublicEvent => event !== null)
      .sort((left, right) => left.seq - right.seq)
  };
}

function reviewSeat(value: unknown, visibility: WerewolfReviewVisibility): WerewolfReviewSeat | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const seat = readFiniteNumber(value.seat);
  if (!id || seat === undefined) return null;
  const eliminatedAt = isRecord(value.eliminatedAt)
    ? compactElimination(value.eliminatedAt)
    : undefined;
  const postgameRole = visibility === "postgame-review" ? readRole(value.role ?? value.revealedRole) : undefined;
  return {
    id,
    seat,
    name: readString(value.name) ?? id,
    alive: value.alive === true,
    isSheriff: value.isSheriff === true,
    eliminatedAt,
    ...(postgameRole ? { postgameRole } : {})
  };
}

function reviewSpeech(value: unknown): WerewolfReviewSpeech | null {
  if (!isRecord(value)) return null;
  const day = readFiniteNumber(value.day);
  const playerId = readString(value.playerId);
  const text = readString(value.text);
  if (day === undefined || !playerId || text === undefined) return null;
  return {
    day,
    playerId,
    text,
    kind: value.kind === "last_words" ? "last_words" : "day",
    ...(readRole(value.claimedRole) ? { claimedRole: readRole(value.claimedRole) } : {}),
    ...(readString(value.pressureTargetId) ? { pressureTargetId: readString(value.pressureTargetId) } : {}),
    strategyTags: readArray(value.strategyTags).flatMap((tag) => (typeof tag === "string" ? [tag] : []))
  };
}

function reviewVote(value: unknown): WerewolfReviewVote | null {
  if (!isRecord(value)) return null;
  const day = readFiniteNumber(value.day);
  const voterId = readString(value.voterId);
  if (day === undefined || !voterId) return null;
  const targetId = readString(value.targetId);
  const weight = readFiniteNumber(value.weight);
  return {
    day,
    voterId,
    ...(targetId ? { targetId } : {}),
    abstain: value.abstain === true,
    weight: weight ?? 1,
    kind: value.kind === "sheriff" ? "sheriff" : "exile"
  };
}

function reviewDeath(value: unknown): WerewolfReviewDeath | null {
  if (!isRecord(value)) return null;
  const day = readFiniteNumber(value.day);
  const playerId = readString(value.playerId);
  const reason = readString(value.reason);
  if (day === undefined || !playerId || !reason) return null;
  return { day, playerId, reason };
}

function reviewPublicEvent(value: unknown): WerewolfReviewPublicEvent | null {
  if (!isRecord(value) || value.visibility !== "public") return null;
  const id = readString(value.id);
  const seq = readFiniteNumber(value.seq);
  const day = readFiniteNumber(value.day);
  const phase = readString(value.phase);
  const type = readString(value.type);
  const createdAt = readString(value.createdAt);
  if (!id || seq === undefined || day === undefined || !phase || !type || !createdAt) return null;
  return { id, seq, day, phase, type, createdAt };
}

function compactElimination(value: Record<string, unknown>): WerewolfReviewSeat["eliminatedAt"] {
  const day = readFiniteNumber(value.day);
  const phase = readString(value.phase);
  const reason = readString(value.reason);
  if (day === undefined || !phase || !reason) return undefined;
  return { day, phase, reason };
}

function readRole(value: unknown): Role | undefined {
  return typeof value === "string" && ROLES.includes(value as Role) ? (value as Role) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
