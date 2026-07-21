import { shuffleDeterministic } from "./random";
import { DEFAULT_CONFIG, ROLE_DEFINITIONS, teamForRole } from "./roles";
import type {
  CastSheriffVoteCommand,
  CastVoteCommand,
  DeathReason,
  GameCommand,
  GameConfig,
  GameEvent,
  GameState,
  HunterShootCommand,
  PendingAction,
  Phase,
  PlayerState,
  Role,
  SpeechRecord,
  SubmitLastWordsCommand,
  SubmitSpeechCommand,
  Team,
  VoteRecord
} from "./types";

// Event timestamps are part of GameState and therefore part of replay hashes.
// Derive them from the event sequence instead of wall-clock time so identical
// seeds and commands produce byte-identical state regardless of execution day.
const DETERMINISTIC_EVENT_EPOCH_MS = 0;
const eventTimestamp = (seq: number): string => new Date(DETERMINISTIC_EVENT_EPOCH_MS + seq * 1000).toISOString();

export function createGame(options: {
  id: string;
  seed: string;
  config?: Partial<GameConfig> & { roles?: Role[] };
  playerNames?: string[];
}): GameState {
  const config: GameConfig = {
    ...DEFAULT_CONFIG,
    ...options.config,
    timers: {
      ...DEFAULT_CONFIG.timers,
      ...options.config?.timers
    },
    roles: options.config?.roles ?? DEFAULT_CONFIG.roles
  };
  if (config.roles.length !== config.seats) {
    throw new Error(`Role count (${config.roles.length}) must equal seat count (${config.seats}).`);
  }
  assertSupportedRoleCardinality(config.roles);
  if (!Number.isFinite(config.sheriffVoteWeight) || config.sheriffVoteWeight <= 0) {
    throw new Error("sheriffVoteWeight must be a finite positive number.");
  }

  const roles = shuffleDeterministic(config.roles, `${options.seed}:roles`);
  const players: PlayerState[] = roles.map((role, index) => ({
    id: `p${index + 1}`,
    seat: index + 1,
    name: options.playerNames?.[index] ?? `Agent ${index + 1}`,
    role,
    team: teamForRole(role),
    alive: true,
    isSheriff: false,
    ability: {
      witchSaveAvailable: role === "witch",
      witchPoisonAvailable: role === "witch",
      hunterShotAvailable: role === "hunter"
    }
  }));

  const state: GameState = {
    id: options.id,
    seed: options.seed,
    config,
    phase: "role_reveal",
    day: 0,
    players,
    night: { wolfVotes: {} },
    speeches: [],
    wolfWhispers: [],
    votes: [],
    deaths: [],
    events: [],
    currentSpeakerSeat: undefined
  };

  return appendEvent(state, {
    type: "game.created",
    actorId: "system",
    visibility: "postgame",
    payload: {
      config,
      roleCounts: countRoles(players.map((player) => player.role))
    }
  });
}

export function getPendingActions(state: GameState): PendingAction[] {
  if (state.winner || state.phase === "game_over") return [];
  const alive = livingPlayers(state);

  if (state.phase === "role_reveal") {
    return [{ kind: "advance", phase: state.phase, actorId: "system" }];
  }

  if (state.phase === "night_seer") {
    const seer = alive.find((player) => player.role === "seer");
    if (!seer || state.night.seerInspection) return [{ kind: "advance", phase: state.phase, actorId: "system" }];
    return [
      {
        kind: "inspect",
        phase: "night_seer",
        actorId: seer.id,
        legalTargetIds: alive.filter((player) => player.id !== seer.id).map((player) => player.id)
      }
    ];
  }

  if (state.phase === "night_wolves") {
    const wolves = alive.filter((player) => player.role === "werewolf");
    const openWolves = wolves.filter((wolf) => !state.night.wolfVotes[wolf.id]);
    if (wolves.length === 0 || openWolves.length === 0) {
      return [{ kind: "advance", phase: state.phase, actorId: "system" }];
    }
    const legalTargetIds = alive.filter((player) => player.role !== "werewolf").map((player) => player.id);
    return openWolves.map((wolf) => ({
      kind: "kill",
      phase: "night_wolves",
      actorId: wolf.id,
      legalTargetIds,
      teamActorIds: wolves.map((player) => player.id)
    }));
  }

  if (state.phase === "night_wolf_discussion") {
    const wolves = alive.filter((player) => player.role === "werewolf");
    const alreadyWhispered = new Set(state.wolfWhispers.filter((whisper) => whisper.day === state.day).map((whisper) => whisper.playerId));
    const openWolves = wolves.filter((wolf) => !alreadyWhispered.has(wolf.id));
    if (wolves.length === 0 || openWolves.length === 0) {
      return [{ kind: "advance", phase: state.phase, actorId: "system" }];
    }
    return openWolves.map((wolf) => ({
      kind: "whisper",
      phase: "night_wolf_discussion",
      actorId: wolf.id,
      teamActorIds: wolves.map((player) => player.id)
    }));
  }

  if (state.phase === "night_witch") {
    const witch = alive.find((player) => player.role === "witch");
    if (!witch || state.night.witch) return [{ kind: "advance", phase: state.phase, actorId: "system" }];
    const nightVictimId = selectWolfTarget(state);
    return [
      {
        kind: "witch",
        phase: "night_witch",
        actorId: witch.id,
        nightVictimId,
        canSave: witch.ability.witchSaveAvailable && Boolean(nightVictimId),
        canPoison: witch.ability.witchPoisonAvailable,
        legalPoisonTargetIds: alive.filter((player) => player.id !== witch.id).map((player) => player.id)
      }
    ];
  }

  if (state.phase === "night_resolve" || state.phase === "exile_resolve") {
    return [{ kind: "advance", phase: state.phase, actorId: "system" }];
  }

  if (state.phase === "last_words") {
    const actorId = state.lastWordsQueue?.[0];
    if (!actorId) return [{ kind: "advance", phase: state.phase, actorId: "system" }];
    return [{ kind: "last_words", phase: state.phase, actorId }];
  }

  if (state.phase === "sheriff_vote") {
    const electedVotes = state.votes.filter((vote) => vote.day === state.day && vote.kind === "sheriff");
    const voted = new Set(electedVotes.map((vote) => vote.voterId));
    const open = alive.filter((player) => !voted.has(player.id));
    if (open.length === 0) return [{ kind: "advance", phase: state.phase, actorId: "system" }];
    const legalTargetIds = alive.map((player) => player.id);
    return open.map((player) => ({
      kind: "sheriff_vote",
      phase: "sheriff_vote",
      actorId: player.id,
      legalTargetIds
    }));
  }

  if (state.phase === "day_speech") {
    const current = getCurrentSpeaker(state);
    if (!current) return [{ kind: "advance", phase: state.phase, actorId: "system" }];
    return [
      {
        kind: "speech",
        phase: "day_speech",
        actorId: current.id,
        legalPressureTargetIds: alive.filter((player) => player.id !== current.id).map((player) => player.id)
      }
    ];
  }

  if (state.phase === "day_vote") {
    const voted = new Set(
      state.votes.filter((vote) => vote.day === state.day && (vote.kind ?? "exile") === "exile").map((vote) => vote.voterId)
    );
    const open = alive.filter((player) => !voted.has(player.id));
    if (open.length === 0) return [{ kind: "advance", phase: state.phase, actorId: "system" }];
    return open.map((player) => ({
      kind: "vote",
      phase: "day_vote",
      actorId: player.id,
      legalTargetIds: alive.filter((target) => target.id !== player.id).map((target) => target.id)
    }));
  }

  if (state.phase === "hunter_shot") {
    const hunter = state.pendingHunterId ? getPlayer(state, state.pendingHunterId) : undefined;
    if (!hunter || !hunter.ability.hunterShotAvailable) {
      return [{ kind: "advance", phase: state.phase, actorId: "system" }];
    }
    return [
      {
        kind: "shoot",
        phase: "hunter_shot",
        actorId: hunter.id,
        legalTargetIds: livingPlayers(state).map((player) => player.id)
      }
    ];
  }

  return [];
}

export function applyCommand(state: GameState, command: GameCommand): GameState {
  assertPhaseAllows(state, command);

  if (command.type === "system.advance") {
    return advancePhase(state);
  }
  if (command.type === "seer.inspect") {
    const actor = requireAliveRole(state, command.actorId, "seer");
    const target = requireLivingTarget(state, command.targetId);
    if (actor.id === target.id) throw new Error("Seer cannot inspect self.");
    let next = cloneState(state);
    next.night.seerInspection = {
      actorId: actor.id,
      targetId: target.id,
      resultTeam: target.team
    };
    next = appendEvent(next, {
      type: "seer.inspected",
      actorId: actor.id,
      visibility: "private",
      payload: {
        targetId: target.id,
        resultTeam: target.team
      }
    });
    return maybeAutoAdvance(next);
  }
  if (command.type === "werewolf.killVote") {
    const actor = requireAliveRole(state, command.actorId, "werewolf");
    const target = requireLivingTarget(state, command.targetId);
    if (target.role === "werewolf") throw new Error("Werewolves cannot night-kill another werewolf in this ruleset.");
    let next = cloneState(state);
    next.night.wolfVotes[actor.id] = target.id;
    next = appendEvent(next, {
      type: "werewolves.voted",
      actorId: actor.id,
      visibility: "private",
      payload: {
        targetId: target.id
      }
    });
    return maybeAutoAdvance(next);
  }
  if (command.type === "werewolf.whisper") {
    return submitWerewolfWhisper(state, command);
  }
  if (command.type === "witch.act") {
    const actor = requireAliveRole(state, command.actorId, "witch");
    if (command.saveTargetId && !actor.ability.witchSaveAvailable) throw new Error("Witch save is not available.");
    if (command.poisonTargetId && !actor.ability.witchPoisonAvailable) throw new Error("Witch poison is not available.");
    const nightVictimId = selectWolfTarget(state);
    if (command.saveTargetId && command.saveTargetId !== nightVictimId) {
      throw new Error("Witch can only save the selected wolf-night victim.");
    }
    if (command.saveTargetId) requireLivingTarget(state, command.saveTargetId);
    if (command.poisonTargetId === actor.id) throw new Error("Witch cannot poison self.");
    if (command.poisonTargetId) requireLivingTarget(state, command.poisonTargetId);
    let next = cloneState(state);
    const nextActor = getPlayer(next, actor.id);
    if (!nextActor) throw new Error("Missing witch after clone.");
    next.night.witch = {
      actorId: actor.id,
      saveTargetId: command.saveTargetId,
      poisonTargetId: command.poisonTargetId
    };
    if (command.saveTargetId) nextActor.ability.witchSaveAvailable = false;
    if (command.poisonTargetId) nextActor.ability.witchPoisonAvailable = false;
    next = appendEvent(next, {
      type: "witch.acted",
      actorId: actor.id,
      visibility: "private",
      payload: {
        saveTargetId: command.saveTargetId,
        poisonTargetId: command.poisonTargetId
      }
    });
    return maybeAutoAdvance(next);
  }
  if (command.type === "speech.submit") {
    return submitSpeech(state, command);
  }
  if (command.type === "lastWords.submit") {
    return submitLastWords(state, command);
  }
  if (command.type === "vote.cast") {
    return castVote(state, command);
  }
  if (command.type === "sheriff.vote") {
    return castSheriffVote(state, command);
  }
  if (command.type === "hunter.shoot") {
    return hunterShoot(state, command);
  }

  return state;
}

export function computeMetrics(state: GameState): {
  wolfVoteAccuracy: number;
  villageVoteAccuracy: number;
  deceptionSurvivalScore: number;
} {
  const byId = new Map(state.players.map((player) => [player.id, player]));
  const dayVotes = state.votes.filter((vote) => !vote.abstain && vote.targetId);
  const wolfVotes = dayVotes.filter((vote) => byId.get(vote.voterId)?.team === "werewolves");
  const villageVotes = dayVotes.filter((vote) => byId.get(vote.voterId)?.team === "village");
  const wolfAccuracy = ratio(
    wolfVotes.filter((vote) => byId.get(vote.targetId ?? "")?.team === "village").length,
    wolfVotes.length
  );
  const villageAccuracy = ratio(
    villageVotes.filter((vote) => byId.get(vote.targetId ?? "")?.team === "werewolves").length,
    villageVotes.length
  );
  const livingDaysByWolf = state.players
    .filter((player) => player.role === "werewolf")
    .map((player) => player.eliminatedAt?.day ?? state.day);
  return {
    wolfVoteAccuracy: wolfAccuracy,
    villageVoteAccuracy: villageAccuracy,
    deceptionSurvivalScore: livingDaysByWolf.length
      ? livingDaysByWolf.reduce((sum, day) => sum + day, 0) / livingDaysByWolf.length
      : 0
  };
}

export function livingPlayers(state: GameState): PlayerState[] {
  return state.players.filter((player) => player.alive).sort((a, b) => a.seat - b.seat);
}

export function getPlayer(state: GameState, playerId: string): PlayerState | undefined {
  return state.players.find((player) => player.id === playerId);
}

function submitSpeech(state: GameState, command: SubmitSpeechCommand): GameState {
  const actor = requireLivingTarget(state, command.actorId);
  const current = getCurrentSpeaker(state);
  if (!current || current.id !== actor.id) throw new Error("It is not this player's speech turn.");
  const trimmed = command.text.trim();
  if (!trimmed) throw new Error("Speech cannot be empty.");
  const record: SpeechRecord = {
    day: state.day,
    playerId: actor.id,
    text: trimmed.slice(0, 1200),
    kind: "day",
    claimedRole: command.claimedRole,
    pressureTargetId: command.pressureTargetId,
    strategyTags: command.strategyTags?.slice(0, 8) ?? []
  };
  let next = cloneState(state);
  next.speeches.push(record);
  next = appendEvent(next, {
    type: "speech.submitted",
    actorId: actor.id,
    visibility: "public",
    payload: record
  });
  next.currentSpeakerSeat = nextLivingSpeakerSeat(next);
  return maybeAutoAdvance(next);
}

function submitWerewolfWhisper(state: GameState, command: Extract<GameCommand, { type: "werewolf.whisper" }>): GameState {
  const actor = requireAliveRole(state, command.actorId, "werewolf");
  const alreadyWhispered = state.wolfWhispers.some((whisper) => whisper.day === state.day && whisper.playerId === actor.id);
  if (alreadyWhispered) throw new Error("Werewolf already used this night's discussion turn.");
  const trimmed = command.text.trim();
  if (!trimmed) throw new Error("Werewolf whisper cannot be empty.");
  let next = cloneState(state);
  next.wolfWhispers.push({
    day: state.day,
    playerId: actor.id,
    text: trimmed.slice(0, 1200),
    strategyTags: command.strategyTags?.slice(0, 8) ?? []
  });
  next = appendEvent(next, {
    type: "werewolves.whispered",
    actorId: actor.id,
    visibility: "private",
    payload: {
      text: trimmed.slice(0, 1200)
    }
  });
  return maybeAutoAdvance(next);
}

function submitLastWords(state: GameState, command: SubmitLastWordsCommand): GameState {
  const expectedActorId = state.lastWordsQueue?.[0];
  if (!expectedActorId || expectedActorId !== command.actorId) {
    throw new Error("No last words are pending for this player.");
  }
  const actor = getPlayer(state, command.actorId);
  if (!actor || actor.alive) throw new Error("Only an eliminated player may submit last words.");
  const trimmed = command.text.trim();
  if (!trimmed) throw new Error("Last words cannot be empty.");
  let next = cloneState(state);
  next.speeches.push({
    day: next.day,
    playerId: actor.id,
    text: trimmed.slice(0, 1200),
    kind: "last_words",
    strategyTags: command.strategyTags?.slice(0, 8) ?? []
  });
  next.lastWordsQueue = (next.lastWordsQueue ?? []).slice(1);
  next = appendEvent(next, {
    type: "last_words.submitted",
    actorId: actor.id,
    visibility: "public",
    payload: {
      playerId: actor.id,
      text: trimmed.slice(0, 1200),
      remaining: next.lastWordsQueue.length
    }
  });
  return maybeAutoAdvance(next);
}

function castVote(state: GameState, command: CastVoteCommand): GameState {
  const actor = requireLivingTarget(state, command.actorId);
  if (!command.abstain) {
    if (!command.targetId) throw new Error("Vote target is required unless abstaining.");
    const target = requireLivingTarget(state, command.targetId);
    if (target.id === actor.id) throw new Error("Player cannot vote self.");
  }
  const alreadyVoted = state.votes.some(
    (vote) => vote.day === state.day && (vote.kind ?? "exile") === "exile" && vote.voterId === actor.id
  );
  if (alreadyVoted) throw new Error("Player already voted this day.");
  const record: VoteRecord = {
    day: state.day,
    voterId: actor.id,
    targetId: command.abstain ? undefined : command.targetId,
    abstain: Boolean(command.abstain),
    weight: actor.isSheriff ? state.config.sheriffVoteWeight : 1,
    kind: "exile"
  };
  let next = cloneState(state);
  next.votes.push(record);
  next = appendEvent(next, {
    type: "vote.cast",
    actorId: actor.id,
    visibility: "public",
    payload: record
  });
  return maybeAutoAdvance(next);
}

function castSheriffVote(state: GameState, command: CastSheriffVoteCommand): GameState {
  const actor = requireLivingTarget(state, command.actorId);
  if (!command.abstain) {
    if (!command.targetId) throw new Error("Sheriff vote target is required unless abstaining.");
    requireLivingTarget(state, command.targetId);
  }
  const alreadyVoted = state.votes.some((vote) => vote.day === state.day && vote.kind === "sheriff" && vote.voterId === actor.id);
  if (alreadyVoted) throw new Error("Player already cast a sheriff vote this day.");
  const record: VoteRecord = {
    day: state.day,
    voterId: actor.id,
    targetId: command.abstain ? undefined : command.targetId,
    abstain: Boolean(command.abstain),
    weight: 1,
    kind: "sheriff"
  };
  let next = cloneState(state);
  next.votes.push(record);
  next = appendEvent(next, {
    type: "sheriff.vote_cast",
    actorId: actor.id,
    visibility: "public",
    payload: record
  });
  return maybeAutoAdvance(next);
}

function hunterShoot(state: GameState, command: HunterShootCommand): GameState {
  const actor = getPlayer(state, command.actorId);
  if (!actor || actor.role !== "hunter" || state.pendingHunterId !== actor.id) {
    throw new Error("No hunter shot is pending for this player.");
  }
  let next = cloneState(state);
  const nextHunter = getPlayer(next, actor.id);
  if (!nextHunter) throw new Error("Missing hunter after clone.");
  nextHunter.ability.hunterShotAvailable = false;
  next.pendingHunterId = undefined;
  if (command.targetId) {
    const target = requireLivingTarget(state, command.targetId);
    next = eliminatePlayer(next, target.id, "hunter_shot", actor.id);
  }
  next = appendEvent(next, {
    type: "hunter.shot",
    actorId: actor.id,
    visibility: "public",
    payload: {
      targetId: command.targetId
    }
  });
  return maybeAutoAdvance(next);
}

function advancePhase(state: GameState): GameState {
  let next = cloneState(state);

  if (next.phase === "role_reveal") {
    next.phase = firstNightPhase(next);
    next.day = 1;
    next = appendPhaseChanged(next);
    return next;
  }
  if (next.phase === "night_seer") {
    next.phase = firstWolfPhase(next);
    next = appendPhaseChanged(next);
    return next;
  }
  if (next.phase === "night_wolf_discussion") {
    next.phase = livingPlayers(next).some((player) => player.role === "werewolf") ? "night_wolves" : firstPostWolfPhase(next);
    next = appendPhaseChanged(next);
    return next;
  }
  if (next.phase === "night_wolves") {
    next.phase = "night_witch";
    next = appendPhaseChanged(next);
    return next;
  }
  if (next.phase === "night_witch") {
    next.phase = "night_resolve";
    next = appendPhaseChanged(next);
    return next;
  }
  if (next.phase === "night_resolve") {
    next = resolveNight(next);
    const winner = determineWinner(next);
    if (winner) return endGame(next, winner, "night resolution met a win condition");
    if (next.pendingHunterId) {
      next.phase = "hunter_shot";
      return appendPhaseChanged(next);
    }
    return resumeAfterDeathResolution(next, shouldHoldSheriffElection(next) ? "sheriff_vote" : "day_speech");
  }
  if (next.phase === "last_words") {
    if (next.lastWordsQueue?.length) {
      throw new Error("Cannot advance while a player still has last words pending.");
    }
    const resume = next.lastWordsResume;
    if (!resume) throw new Error("Last words phase is missing its deterministic resume target.");
    next.lastWordsResume = undefined;
    return enterResumePhase(next, resume);
  }
  if (next.phase === "sheriff_vote") {
    next = resolveSheriffElection(next);
    next.phase = "day_speech";
    next.currentSpeakerSeat = livingPlayers(next)[0]?.seat;
    next = appendPhaseChanged(next);
    return next;
  }
  if (next.phase === "day_speech") {
    next.phase = "day_vote";
    next = appendPhaseChanged(next);
    return next;
  }
  if (next.phase === "day_vote") {
    next.phase = "exile_resolve";
    next = appendPhaseChanged(next);
    return next;
  }
  if (next.phase === "exile_resolve") {
    next = resolveExile(next);
    const winner = determineWinner(next);
    if (winner) return endGame(next, winner, "day vote met a win condition");
    if (next.pendingHunterId) {
      next.phase = "hunter_shot";
      return appendPhaseChanged(next);
    }
    return resumeAfterDeathResolution(next, "next_night");
  }
  if (next.phase === "hunter_shot") {
    const winner = determineWinner(next);
    if (winner) return endGame(next, winner, "hunter shot met a win condition");
    const resume = next.hunterResume === "day_speech" ? (shouldHoldSheriffElection(next) ? "sheriff_vote" : "day_speech") : "next_night";
    next.hunterResume = undefined;
    return resumeAfterDeathResolution(next, resume);
  }

  return next;
}

function maybeAutoAdvance(state: GameState): GameState {
  let next = state;
  let guard = 0;
  while (guard < 20) {
    const pending = getPendingActions(next);
    if (pending.length !== 1 || pending[0].kind !== "advance") return next;
    next = applyCommand(next, { type: "system.advance", actorId: "system" });
    guard += 1;
  }
  throw new Error("Auto-advance guard exceeded.");
}

function resolveNight(state: GameState): GameState {
  let next = cloneState(state);
  const deaths: Array<{ playerId: string; reason: DeathReason; sourceId?: string }> = [];
  const wolfTargetId = selectWolfTarget(next);
  const saved = wolfTargetId && next.night.witch?.saveTargetId === wolfTargetId;
  if (wolfTargetId && !saved) {
    deaths.push({ playerId: wolfTargetId, reason: "night_kill", sourceId: "werewolves" });
  }
  if (next.night.witch?.poisonTargetId && !deaths.some((death) => death.playerId === next.night.witch?.poisonTargetId)) {
    deaths.push({ playerId: next.night.witch.poisonTargetId, reason: "poison", sourceId: next.night.witch.actorId });
  }
  for (const death of deaths) {
    next = eliminatePlayer(next, death.playerId, death.reason, death.sourceId);
  }
  next = appendEvent(next, {
    type: "night.resolved",
    actorId: "system",
    visibility: "public",
    payload: {
      deaths: deaths.map((death) => ({
        ...death,
        revealedRole: next.config.revealOnDeath ? getPlayer(next, death.playerId)?.role : undefined
      }))
    }
  });
  return next;
}

function resolveExile(state: GameState): GameState {
  let next = cloneState(state);
  const todaysVotes = next.votes.filter(
    (vote) => vote.day === next.day && (vote.kind ?? "exile") === "exile" && !vote.abstain && vote.targetId
  );
  const tally = new Map<string, number>();
  for (const vote of todaysVotes) {
    if (!vote.targetId) continue;
    tally.set(vote.targetId, (tally.get(vote.targetId) ?? 0) + vote.weight);
  }
  const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0 && (sorted.length === 1 || sorted[0][1] > sorted[1][1])) {
    next = eliminatePlayer(next, sorted[0][0], "exile", "village_vote");
  }
  return next;
}

/**
 * Classic-9-seat-v1 sheriff rule: after every living player casts one public
 * day-one election ballot, a unique plurality becomes sheriff. A tied or
 * fully abstained election deliberately leaves the office vacant; there is no
 * hidden tie-breaker and no synthetic winner.
 */
function resolveSheriffElection(state: GameState): GameState {
  let next = cloneState(state);
  const ballots = next.votes.filter((vote) => vote.day === next.day && vote.kind === "sheriff" && !vote.abstain && vote.targetId);
  const tally = new Map<string, number>();
  for (const ballot of ballots) {
    if (!ballot.targetId) continue;
    tally.set(ballot.targetId, (tally.get(ballot.targetId) ?? 0) + 1);
  }
  const ranking = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const winnerId = ranking.length > 0 && (ranking.length === 1 || ranking[0][1] > ranking[1][1]) ? ranking[0][0] : undefined;
  for (const player of next.players) player.isSheriff = player.id === winnerId;
  next.sheriffElectionCompleted = true;
  next = appendEvent(next, {
    type: "sheriff.elected",
    actorId: "system",
    visibility: "public",
    payload: {
      winnerId,
      status: winnerId ? "elected" : "vacant_tie_or_abstention",
      tally: Object.fromEntries(ranking)
    }
  });
  return next;
}

function shouldHoldSheriffElection(state: GameState): boolean {
  return state.config.sheriff === "day1" && state.day === 1 && !state.sheriffElectionCompleted;
}

function resumeAfterDeathResolution(
  state: GameState,
  resume: NonNullable<GameState["lastWordsResume"]>
): GameState {
  const queued = eligibleLastWords(state);
  if (queued.length > 0) {
    const next = cloneState(state);
    next.lastWordsQueue = queued;
    next.lastWordsResume = resume;
    next.currentSpeakerSeat = undefined;
    next.phase = "last_words";
    return appendPhaseChanged(next);
  }
  return enterResumePhase(state, resume);
}

function enterResumePhase(state: GameState, resume: NonNullable<GameState["lastWordsResume"]>): GameState {
  let next = cloneState(state);
  next.lastWordsQueue = undefined;
  if (resume === "sheriff_vote") {
    next.phase = "sheriff_vote";
    next.currentSpeakerSeat = undefined;
    return appendPhaseChanged(next);
  }
  if (resume === "day_speech") {
    next.phase = "day_speech";
    next.currentSpeakerSeat = livingPlayers(next)[0]?.seat;
    return appendPhaseChanged(next);
  }
  if (next.day >= next.config.maxDays) return endGame(next, "werewolves", `maxDays=${next.config.maxDays} reached`);
  next.day += 1;
  next.night = { wolfVotes: {} };
  next.currentSpeakerSeat = undefined;
  next.phase = firstNightPhase(next);
  return appendPhaseChanged(next);
}

function eligibleLastWords(state: GameState): string[] {
  if (state.config.lastWords === "none") return [];
  const alreadySpoken = new Set(state.speeches.filter((speech) => speech.kind === "last_words").map((speech) => speech.playerId));
  const alreadyQueued = new Set(state.lastWordsQueue ?? []);
  return state.deaths
    .filter((death) => {
      if (alreadySpoken.has(death.playerId) || alreadyQueued.has(death.playerId)) return false;
      if (state.config.lastWords === "all") return true;
      return death.day === 1 && (death.reason === "night_kill" || death.reason === "poison");
    })
    .map((death) => death.playerId);
}

export function selectWolfTarget(state: GameState): string | undefined {
  const entries = Object.entries(state.night.wolfVotes);
  if (entries.length === 0) return undefined;
  const tally = new Map<string, { count: number; firstIndex: number }>();
  entries.forEach(([, targetId], index) => {
    const current = tally.get(targetId);
    tally.set(targetId, {
      count: (current?.count ?? 0) + 1,
      firstIndex: current?.firstIndex ?? index
    });
  });
  return [...tally.entries()].sort((a, b) => b[1].count - a[1].count || a[1].firstIndex - b[1].firstIndex)[0]?.[0];
}

function eliminatePlayer(state: GameState, playerId: string, reason: DeathReason, sourceId?: string): GameState {
  let next = cloneState(state);
  const player = getPlayer(next, playerId);
  if (!player || !player.alive) return next;
  player.alive = false;
  player.eliminatedAt = { day: next.day, phase: next.phase, reason };
  next.deaths.push({ day: next.day, playerId, reason, sourceId });
  if (player.role === "hunter" && player.ability.hunterShotAvailable && reason !== "poison") {
    next.pendingHunterId = player.id;
    next.hunterResume = next.phase === "night_resolve" ? "day_speech" : "next_night";
  }
  next = appendEvent(next, {
    type: "player.died",
    actorId: sourceId,
    visibility: "public",
    payload: {
      playerId,
      reason,
      sourceId,
      revealedRole: next.config.revealOnDeath ? player.role : undefined
    }
  });
  if (player.isSheriff) {
    player.isSheriff = false;
    next = appendEvent(next, {
      type: "sheriff.vacated",
      actorId: "system",
      visibility: "public",
      payload: {
        playerId,
        reason,
        succession: "vacant"
      }
    });
  }
  return next;
}

function determineWinner(state: GameState): Team | undefined {
  const alive = livingPlayers(state);
  const wolves = alive.filter((player) => player.team === "werewolves").length;
  const village = alive.filter((player) => player.team === "village").length;
  if (wolves === 0) return "village";
  if (wolves >= village) return "werewolves";
  return undefined;
}

function endGame(state: GameState, winner: Team, reason: string): GameState {
  let next = cloneState(state);
  next.winner = winner;
  next.endReason = reason;
  next.phase = "game_over";
  next = appendEvent(next, {
    type: "game.ended",
    actorId: "system",
    visibility: "public",
    payload: {
      winner,
      reason
    }
  });
  return appendPhaseChanged(next);
}

function firstNightPhase(state: GameState): Phase {
  if (livingPlayers(state).some((player) => player.role === "seer")) return "night_seer";
  return firstWolfPhase(state);
}

function firstWolfPhase(state: GameState): Phase {
  if (livingPlayers(state).some((player) => player.role === "werewolf")) {
    return state.config.wolfDiscussion === "one_turn" ? "night_wolf_discussion" : "night_wolves";
  }
  return firstPostWolfPhase(state);
}

function firstPostWolfPhase(state: GameState): Phase {
  if (livingPlayers(state).some((player) => player.role === "witch")) return "night_witch";
  return "night_resolve";
}

function getCurrentSpeaker(state: GameState): PlayerState | undefined {
  if (!state.currentSpeakerSeat) return undefined;
  return livingPlayers(state).find((player) => player.seat === state.currentSpeakerSeat);
}

function nextLivingSpeakerSeat(state: GameState): number | undefined {
  const alive = livingPlayers(state);
  const spokenIds = new Set(state.speeches.filter((speech) => speech.day === state.day).map((speech) => speech.playerId));
  return alive.find((player) => !spokenIds.has(player.id))?.seat;
}

function assertPhaseAllows(state: GameState, command: GameCommand): void {
  const phaseFor: Record<GameCommand["type"], Phase[]> = {
    "system.advance": [
      "role_reveal",
      "night_seer",
      "night_wolf_discussion",
      "night_wolves",
      "night_witch",
      "night_resolve",
      "last_words",
      "sheriff_vote",
      "day_speech",
      "day_vote",
      "exile_resolve",
      "hunter_shot"
    ],
    "seer.inspect": ["night_seer"],
    "werewolf.whisper": ["night_wolf_discussion"],
    "werewolf.killVote": ["night_wolves"],
    "witch.act": ["night_witch"],
    "speech.submit": ["day_speech"],
    "lastWords.submit": ["last_words"],
    "sheriff.vote": ["sheriff_vote"],
    "vote.cast": ["day_vote"],
    "hunter.shoot": ["hunter_shot"]
  };
  if (!phaseFor[command.type].includes(state.phase)) {
    throw new Error(`Command ${command.type} is not legal during ${state.phase}.`);
  }
}

function requireAliveRole(state: GameState, playerId: string, role: Role): PlayerState {
  const player = requireLivingTarget(state, playerId);
  if (player.role !== role) throw new Error(`Player ${playerId} is not ${ROLE_DEFINITIONS[role].displayName}.`);
  return player;
}

function requireLivingTarget(state: GameState, playerId: string): PlayerState {
  const player = getPlayer(state, playerId);
  if (!player) throw new Error(`Unknown player: ${playerId}.`);
  if (!player.alive) throw new Error(`Player is not alive: ${playerId}.`);
  return player;
}

function appendPhaseChanged(state: GameState): GameState {
  return appendEvent(state, {
    type: "phase.changed",
    actorId: "system",
    visibility: "public",
    payload: {
      phase: state.phase,
      day: state.day
    }
  });
}

function appendEvent(
  state: GameState,
  event: Omit<GameEvent, "id" | "seq" | "day" | "phase" | "createdAt">
): GameState {
  const next = cloneState(state);
  const seq = next.events.length + 1;
  next.events.push({
    id: `${next.id}:e${seq}`,
    seq,
    day: next.day,
    phase: next.phase,
    createdAt: eventTimestamp(seq),
    ...event
  });
  return next;
}

function countRoles(roles: Role[]): Record<Role, number> {
  return roles.reduce(
    (acc, role) => {
      acc[role] += 1;
      return acc;
    },
    { villager: 0, werewolf: 0, seer: 0, witch: 0, hunter: 0 } satisfies Record<Role, number>
  );
}

function assertSupportedRoleCardinality(roles: Role[]): void {
  for (const role of ["seer", "witch", "hunter"] as const) {
    const count = roles.filter((candidate) => candidate === role).length;
    if (count > 1) {
      throw new Error(`Classic Werewolf ruleset supports at most one ${ROLE_DEFINITIONS[role].displayName}; received ${count}.`);
    }
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}
