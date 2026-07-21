import { ROLE_DEFINITIONS } from "./roles";
import { getPendingActions } from "./engine";
import type { DeathRecord, GameEvent, GameState, PendingAction, PlayerView, PublicGameState, PublicPlayer } from "./types";

export function toPublicPlayers(state: GameState): PublicPlayer[] {
  return [...state.players]
    .sort((a, b) => a.seat - b.seat)
    .map((player) => ({
      id: player.id,
      seat: player.seat,
      name: player.name,
      alive: player.alive,
      isSheriff: player.isSheriff,
      revealedRole: state.config.revealOnDeath && !player.alive ? player.role : undefined,
      eliminatedAt: player.eliminatedAt
    }));
}

export function createPlayerView(state: GameState, playerId: string, pendingAction: PendingAction): PlayerView {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error(`Unknown player ${playerId}.`);
  const werewolfAllies =
    player.role === "werewolf"
      ? state.players.filter((candidate) => candidate.role === "werewolf").map((candidate) => candidate.id)
      : undefined;
  const lastInspection =
    player.role === "seer" && state.night.seerInspection?.actorId === player.id ? state.night.seerInspection : undefined;

  return {
    phase: state.phase,
    day: state.day,
    you: {
      id: player.id,
      seat: player.seat,
      name: player.name,
      role: player.role,
      team: player.team,
      alive: player.alive,
      ability: player.ability
    },
    publicPlayers: toPublicPlayers(state),
    privateInfo: {
      werewolfAllies,
      lastInspection,
      witchNightVictimId: player.role === "witch" ? pendingAction.kind === "witch" ? pendingAction.nightVictimId : undefined : undefined
    },
    speeches: state.speeches,
    votes: state.votes,
    deaths: publicDeathsForState(state.deaths),
    recentEvents: visibleEventsForPlayer(state.events, player.id),
    pendingAction
  };
}

export function serializePublicState(state: GameState): PublicGameState {
  const publicEvents = publicEventsForState(state.events);
  return {
    config: state.config,
    phase: state.phase,
    day: state.day,
    players: toPublicPlayers(state),
    speeches: cloneJson(state.speeches),
    votes: cloneJson(state.votes),
    deaths: publicDeathsForState(state.deaths),
    events: publicEvents,
    currentSpeakerSeat: state.currentSpeakerSeat,
    winner: state.winner,
    endReason: state.endReason,
    pendingActionCount: getPendingActions(state).length,
    publicEventCount: publicEvents.length
  };
}

export function roleText(role: keyof typeof ROLE_DEFINITIONS): string {
  return ROLE_DEFINITIONS[role].displayName;
}

function visibleEventsForPlayer(events: GameEvent[], playerId: string): GameEvent[] {
  return events
    .filter((event) => event.visibility === "public" || (event.visibility === "private" && event.actorId === playerId))
    .map((event) => (event.visibility === "public" ? sanitizePublicEvent(event) : cloneJson(event)))
    .slice(-40);
}

function publicEventsForState(events: GameEvent[]): GameEvent[] {
  return events.filter((event) => event.visibility === "public").map(sanitizePublicEvent);
}

function sanitizePublicEvent(event: GameEvent): GameEvent {
  if (event.type === "night.resolved" && isRecord(event.payload)) {
    return {
      ...event,
      actorId: "system",
      payload: {
        ...event.payload,
        deaths: Array.isArray(event.payload.deaths)
          ? event.payload.deaths.map((death) => (isRecord(death) ? omitKeys(death, ["sourceId"]) : death))
          : event.payload.deaths
      }
    };
  }
  if (event.type === "player.died" && isRecord(event.payload)) {
    return {
      ...event,
      actorId: "system",
      payload: omitKeys(event.payload, ["sourceId"])
    };
  }
  return cloneJson(event);
}

function publicDeathsForState(deaths: DeathRecord[]): Array<Omit<DeathRecord, "sourceId">> {
  return deaths.map((death) => ({
    day: death.day,
    playerId: death.playerId,
    reason: death.reason
  }));
}

function omitKeys<T extends Record<string, unknown>>(input: T, keys: string[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!keys.includes(key)) output[key] = cloneJson(value);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
