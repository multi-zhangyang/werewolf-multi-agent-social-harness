export type Team = "village" | "werewolves";

export type Role = "villager" | "werewolf" | "seer" | "witch" | "hunter";

export type Phase =
  | "role_reveal"
  | "night_seer"
  | "night_wolves"
  | "night_witch"
  | "night_resolve"
  | "last_words"
  | "sheriff_vote"
  | "day_speech"
  | "day_vote"
  | "exile_resolve"
  | "hunter_shot"
  | "game_over";

export type DeathReason = "night_kill" | "poison" | "exile" | "hunter_shot";

export interface RoleDefinition {
  role: Role;
  team: Team;
  displayName: string;
  nightOrder: number | null;
  objective: string;
  abilitySummary: string;
}

export interface GameConfig {
  seats: number;
  roles: Role[];
  sheriff: "off" | "day1";
  sheriffVoteWeight: number;
  revealOnDeath: boolean;
  lastWords: "none" | "firstNightOnly" | "all";
  maxDays: number;
  timers: {
    speechSeconds: number;
    debateSeconds: number;
    voteSeconds: number;
    nightActionSeconds: number;
  };
}

export interface PlayerState {
  id: string;
  seat: number;
  name: string;
  role: Role;
  team: Team;
  alive: boolean;
  isSheriff: boolean;
  eliminatedAt?: {
    day: number;
    phase: Phase;
    reason: DeathReason;
  };
  ability: {
    witchSaveAvailable: boolean;
    witchPoisonAvailable: boolean;
    hunterShotAvailable: boolean;
  };
}

export interface PublicPlayer {
  id: string;
  seat: number;
  name: string;
  alive: boolean;
  isSheriff: boolean;
  revealedRole?: Role;
  eliminatedAt?: PlayerState["eliminatedAt"];
}

export interface NightState {
  seerInspection?: {
    actorId: string;
    targetId: string;
    resultTeam: Team;
  };
  wolfVotes: Record<string, string>;
  witch?: {
    actorId: string;
    saveTargetId?: string;
    poisonTargetId?: string;
  };
}

export interface SpeechRecord {
  day: number;
  playerId: string;
  text: string;
  /**
   * A last word is a public, terminal statement by an eliminated player. It
   * deliberately remains a speech record so projections and evaluators keep a
   * single auditable public-language ledger.
   */
  kind?: "day" | "last_words";
  claimedRole?: Role;
  pressureTargetId?: string;
  strategyTags: string[];
}

export interface VoteRecord {
  day: number;
  voterId: string;
  targetId?: string;
  abstain: boolean;
  weight: number;
  /** Day exile votes are weighted; day-one sheriff votes are always one vote. */
  kind?: "exile" | "sheriff";
}

export interface DeathRecord {
  day: number;
  playerId: string;
  reason: DeathReason;
  sourceId?: string;
}

export interface AgentBelief {
  wolfProb: number;
  roleGuess?: Role;
  rationaleTags: string[];
}

export interface HarnessTurnSnapshot {
  playerId: string;
  profileId?: string;
  model: string;
  actionKind: string;
  confidence: number;
  intent: string;
  targetId?: string;
  beliefs: Record<string, AgentBelief>;
  policyName: string;
  privateMemo: string;
  commandType: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  traceId: string;
}

export interface GameEvent {
  id: string;
  seq: number;
  day: number;
  phase: Phase;
  type:
    | "game.created"
    | "phase.changed"
    | "seer.inspected"
    | "werewolves.voted"
    | "witch.acted"
    | "night.resolved"
    | "speech.submitted"
    | "vote.cast"
    | "sheriff.vote_cast"
    | "sheriff.elected"
    | "sheriff.vacated"
    | "last_words.submitted"
    | "player.died"
    | "hunter.shot"
    | "game.ended";
  actorId?: string;
  visibility: "public" | "private" | "postgame";
  payload: unknown;
  createdAt: string;
}

export interface GameState {
  id: string;
  seed: string;
  config: GameConfig;
  phase: Phase;
  day: number;
  players: PlayerState[];
  night: NightState;
  speeches: SpeechRecord[];
  votes: VoteRecord[];
  deaths: DeathRecord[];
  events: GameEvent[];
  currentSpeakerSeat?: number;
  pendingHunterId?: string;
  hunterResume?: "day_speech" | "next_night";
  /** Ordered by deterministic death resolution; only the head may speak. */
  lastWordsQueue?: string[];
  /** Where the state machine resumes once the last queued final statement ends. */
  lastWordsResume?: "sheriff_vote" | "day_speech" | "next_night";
  sheriffElectionCompleted?: boolean;
  winner?: Team;
  endReason?: string;
}

export type PublicGameState = Omit<
  GameState,
  "id" | "seed" | "players" | "night" | "deaths" | "events" | "pendingHunterId" | "hunterResume"
  | "lastWordsQueue" | "lastWordsResume"
> & {
  players: PublicPlayer[];
  deaths: Array<Omit<DeathRecord, "sourceId">>;
  events: GameEvent[];
  pendingActionCount: number;
  publicEventCount: number;
};

export type SeerInspectCommand = {
  type: "seer.inspect";
  actorId: string;
  targetId: string;
};

export type WerewolfKillVoteCommand = {
  type: "werewolf.killVote";
  actorId: string;
  targetId: string;
};

export type WitchActCommand = {
  type: "witch.act";
  actorId: string;
  saveTargetId?: string;
  poisonTargetId?: string;
};

export type SubmitSpeechCommand = {
  type: "speech.submit";
  actorId: string;
  text: string;
  claimedRole?: Role;
  pressureTargetId?: string;
  strategyTags?: string[];
};

export type CastVoteCommand = {
  type: "vote.cast";
  actorId: string;
  targetId?: string;
  abstain?: boolean;
};

export type HunterShootCommand = {
  type: "hunter.shoot";
  actorId: string;
  targetId?: string;
};

export type CastSheriffVoteCommand = {
  type: "sheriff.vote";
  actorId: string;
  targetId?: string;
  abstain?: boolean;
};

export type SubmitLastWordsCommand = {
  type: "lastWords.submit";
  actorId: string;
  text: string;
  strategyTags?: string[];
};

export type SystemAdvanceCommand = {
  type: "system.advance";
  actorId: "system";
};

export type GameCommand =
  | SeerInspectCommand
  | WerewolfKillVoteCommand
  | WitchActCommand
  | SubmitSpeechCommand
  | CastVoteCommand
  | HunterShootCommand
  | CastSheriffVoteCommand
  | SubmitLastWordsCommand
  | SystemAdvanceCommand;

export type PendingAction =
  | {
      kind: "inspect";
      phase: "night_seer";
      actorId: string;
      legalTargetIds: string[];
    }
  | {
      kind: "kill";
      phase: "night_wolves";
      actorId: string;
      legalTargetIds: string[];
      teamActorIds: string[];
    }
  | {
      kind: "witch";
      phase: "night_witch";
      actorId: string;
      nightVictimId?: string;
      canSave: boolean;
      canPoison: boolean;
      legalPoisonTargetIds: string[];
    }
  | {
      kind: "speech";
      phase: "day_speech";
      actorId: string;
      legalPressureTargetIds: string[];
    }
  | {
      kind: "last_words";
      phase: "last_words";
      actorId: string;
    }
  | {
      kind: "sheriff_vote";
      phase: "sheriff_vote";
      actorId: string;
      legalTargetIds: string[];
    }
  | {
      kind: "vote";
      phase: "day_vote";
      actorId: string;
      legalTargetIds: string[];
    }
  | {
      kind: "shoot";
      phase: "hunter_shot";
      actorId: string;
      legalTargetIds: string[];
    }
  | {
      kind: "advance";
      phase: Phase;
      actorId: "system";
    };

export interface PlayerView {
  phase: Phase;
  day: number;
  you: {
    id: string;
    seat: number;
    name: string;
    role: Role;
    team: Team;
    alive: boolean;
    ability: PlayerState["ability"];
  };
  publicPlayers: PublicPlayer[];
  privateInfo: {
    werewolfAllies?: string[];
    lastInspection?: NightState["seerInspection"];
    witchNightVictimId?: string;
  };
  speeches: SpeechRecord[];
  votes: VoteRecord[];
  deaths: Array<Omit<DeathRecord, "sourceId">>;
  recentEvents: GameEvent[];
  pendingAction: PendingAction;
}

export interface MatchMetrics {
  winner?: Team;
  days: number;
  totalDeaths: number;
  totalSpeeches: number;
  totalVotes: number;
  harnessTurnCount: number;
  harnessErrorCount: number;
  averageLatencyMs: number;
  wolfVoteAccuracy: number;
  villageVoteAccuracy: number;
  deceptionSurvivalScore: number;
  modelUsage: Record<
    string,
    {
      calls: number;
      promptTokens: number;
      completionTokens: number;
      latencyMs: number;
    }
  >;
}
