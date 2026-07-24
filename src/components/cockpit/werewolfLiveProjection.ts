/**
 * The running-match API is intentionally separate from postgame artifact
 * projections. This module reads only its small, public table contract and
 * drops every unrecognised field before React receives it.
 */
export interface WerewolfLivePublicStateView {
  phase: "night" | "day" | "game_over";
  day: number;
  players: Array<{
    id: string;
    seat: number;
    name: string;
    alive: boolean;
    isSheriff: boolean;
    eliminatedAt?: {
      day: number;
      reason: string;
    };
  }>;
  speeches: Array<{
    day: number;
    playerId: string;
    text: string;
    kind: "day" | "last_words";
  }>;
  votes: Array<{
    day: number;
    voterId: string;
    targetId?: string;
    abstain: boolean;
  }>;
  deaths: Array<{
    day: number;
    playerId: string;
    reason: string;
  }>;
  currentSpeakerSeat?: number;
}

/**
 * The browser receives this narrow acknowledgement when it explicitly starts
 * a live spectator run. It is deliberately not a MatchRecord: operator
 * registry metadata, raw public state, profiles, model ids, progress counts,
 * checkpoints, and artifacts belong to different audiences and routes.
 */
export interface LiveMatchStart {
  artifactVersion: "server.match-live-start.v1";
  kind: "match-live-start";
  matchId: string;
  lifecycle: "running";
  artifactAvailable: false;
  projection: LivePublicProjectionPolicy;
}

export interface LivePublicProjectionPolicy {
  view: "live-public";
  privateEvidenceRedacted: true;
  postgameTruthRedacted: true;
}

export type LiveMatchProjection =
  | {
      artifactVersion: "server.match-live-projection.v1";
      kind: "match-live-projection";
      matchId: string;
      lifecycle: "running";
      artifactAvailable: false;
      /** A process-restart fallback may still be running without a frame. */
      projection?: LivePublicProjectionPolicy;
      publicState?: WerewolfLivePublicStateView;
    }
  | {
      artifactVersion: "server.match-live-projection.v1";
      kind: "match-live-projection";
      matchId: string;
      lifecycle: "completed" | "truncated" | "failed";
      artifactAvailable: boolean;
    };

/**
 * Runtime validation is also a projection boundary. In particular, this must
 * not cast a live response into a GameState or a postgame artifact: the
 * browser has no authority to reconstruct either from a running table.
 */
export function readLiveMatchProjection(value: unknown, expectedMatchId?: string): LiveMatchProjection {
  if (!isRecord(value)) throw new Error("Live match response must be an object.");
  if (value.artifactVersion !== "server.match-live-projection.v1" || value.kind !== "match-live-projection") {
    throw new Error("Live match response has an unsupported projection version.");
  }
  const matchId = readString(value.matchId);
  if (!matchId) throw new Error("Live match response is missing matchId.");
  if (expectedMatchId && matchId !== expectedMatchId) throw new Error("Live match response belongs to a different match.");

  if (value.lifecycle === "running") {
    if (value.artifactAvailable !== false) throw new Error("A running live projection cannot advertise an artifact.");
    const projection = readLiveProjectionPolicy(value.projection);
    const publicState = value.publicState === undefined ? undefined : readLivePublicState(value.publicState);
    if (publicState && !projection) throw new Error("A running live public state is missing its redaction policy.");
    return {
      artifactVersion: "server.match-live-projection.v1",
      kind: "match-live-projection",
      matchId,
      lifecycle: "running",
      artifactAvailable: false,
      ...(projection ? { projection } : {}),
      ...(publicState ? { publicState } : {})
    };
  }

  if (value.lifecycle !== "completed" && value.lifecycle !== "truncated" && value.lifecycle !== "failed") {
    throw new Error("Live match response has an unsupported lifecycle.");
  }
  if (typeof value.artifactAvailable !== "boolean") throw new Error("Terminal live response is missing artifact availability.");
  return {
    artifactVersion: "server.match-live-projection.v1",
    kind: "match-live-projection",
    matchId,
    lifecycle: value.lifecycle,
    artifactAvailable: value.artifactAvailable
  };
}

/**
 * Validate and narrow the live-start acknowledgement before it reaches React
 * state. Its purpose is only to select the subsequent `/live` projection; it
 * cannot become a substitute for an operator match record or an artifact.
 */
export function readLiveMatchStart(value: unknown): LiveMatchStart {
  if (!isRecord(value)) throw new Error("Live match start response must be an object.");
  if (value.artifactVersion !== "server.match-live-start.v1" || value.kind !== "match-live-start") {
    throw new Error("Live match start response has an unsupported version.");
  }
  const matchId = readString(value.matchId);
  if (!matchId) throw new Error("Live match start response is missing matchId.");
  if (value.lifecycle !== "running" || value.artifactAvailable !== false) {
    throw new Error("Live match start response must describe a running artifact-free match.");
  }
  const projection = readLiveProjectionPolicy(value.projection);
  if (!projection) throw new Error("Live match start response is missing its redaction policy.");
  return {
    artifactVersion: "server.match-live-start.v1",
    kind: "match-live-start",
    matchId,
    lifecycle: "running",
    artifactAvailable: false,
    projection
  };
}

function readLiveProjectionPolicy(value: unknown): LivePublicProjectionPolicy | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.view !== "live-public" ||
    value.privateEvidenceRedacted !== true ||
    value.postgameTruthRedacted !== true
  ) {
    throw new Error("Live match response has an unsafe projection policy.");
  }
  return {
    view: "live-public",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: true
  };
}

function readLivePublicState(value: unknown): WerewolfLivePublicStateView {
  if (!isRecord(value)) throw new Error("Live match response is missing publicState.");
  const phase = value.phase;
  if (phase !== "night" && phase !== "day" && phase !== "game_over") {
    throw new Error("Live match response has an unsupported public phase.");
  }
  const day = readFiniteNumber(value.day);
  if (day === undefined) throw new Error("Live match response is missing public day.");
  return {
    phase,
    day,
    players: readArray(value.players)
      .map(readPlayer)
      .filter((player): player is WerewolfLivePublicStateView["players"][number] => player !== null)
      .sort((left, right) => left.seat - right.seat || left.id.localeCompare(right.id)),
    speeches: readArray(value.speeches)
      .map(readSpeech)
      .filter((speech): speech is WerewolfLivePublicStateView["speeches"][number] => speech !== null),
    votes: readArray(value.votes)
      .map(readVote)
      .filter((vote): vote is WerewolfLivePublicStateView["votes"][number] => vote !== null),
    deaths: readArray(value.deaths)
      .map(readDeath)
      .filter((death): death is WerewolfLivePublicStateView["deaths"][number] => death !== null),
    ...(readFiniteNumber(value.currentSpeakerSeat) !== undefined
      ? { currentSpeakerSeat: readFiniteNumber(value.currentSpeakerSeat) }
      : {})
  };
}

function readPlayer(value: unknown): WerewolfLivePublicStateView["players"][number] | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const seat = readFiniteNumber(value.seat);
  if (!id || seat === undefined || typeof value.alive !== "boolean" || typeof value.isSheriff !== "boolean") return null;
  const eliminatedAt = isRecord(value.eliminatedAt) ? readElimination(value.eliminatedAt) : undefined;
  return {
    id,
    seat,
    name: readString(value.name) ?? id,
    alive: value.alive,
    isSheriff: value.isSheriff,
    ...(eliminatedAt ? { eliminatedAt } : {})
  };
}

function readElimination(value: Record<string, unknown>): { day: number; reason: string } | undefined {
  const day = readFiniteNumber(value.day);
  const reason = readString(value.reason);
  return day === undefined || !reason ? undefined : { day, reason };
}

function readSpeech(value: unknown): WerewolfLivePublicStateView["speeches"][number] | null {
  if (!isRecord(value)) return null;
  const day = readFiniteNumber(value.day);
  const playerId = readString(value.playerId);
  const text = readString(value.text);
  if (day === undefined || !playerId || text === undefined) return null;
  return { day, playerId, text, kind: value.kind === "last_words" ? "last_words" : "day" };
}

function readVote(value: unknown): WerewolfLivePublicStateView["votes"][number] | null {
  if (!isRecord(value)) return null;
  const day = readFiniteNumber(value.day);
  const voterId = readString(value.voterId);
  if (day === undefined || !voterId) return null;
  // Server live projection omits `abstain: false` (sparse encoding). Only an
  // explicit boolean true is abstention; missing/false both mean a cast vote.
  if (value.abstain !== undefined && typeof value.abstain !== "boolean") return null;
  const abstain = value.abstain === true;
  const targetId = readString(value.targetId);
  if (!abstain && !targetId) return null;
  return { day, voterId, abstain, ...(targetId ? { targetId } : {}) };
}

function readDeath(value: unknown): WerewolfLivePublicStateView["deaths"][number] | null {
  if (!isRecord(value)) return null;
  const day = readFiniteNumber(value.day);
  const playerId = readString(value.playerId);
  const reason = readString(value.reason);
  return day === undefined || !playerId || !reason ? null : { day, playerId, reason };
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
