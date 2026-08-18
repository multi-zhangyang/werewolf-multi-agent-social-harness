export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  /** Registry model-profile id, when the listing comes from the model registry. */
  profileId?: string;
  /** Context window in tokens, when known. */
  context?: number;
  /** Human label for the context window ("1M", "256k"...). */
  contextLabel?: string;
  /** Compact capability states (e.g. "reasoning:yes,streaming:yes"). */
  capabilitySummary?: string;
}

/** A character library entry as the create-room dialog consumes it. */
export interface CharacterOption {
  id: string;
  displayName: string;
  persona: string;
  builtIn: boolean;
}

export interface CreateRoomInput {
  scenarioId: string;
  models: string[];
  /** Registry model-profile ids, round-robined per seat (server-preferred). */
  modelProfileIds?: string[];
  /** Per-seat overrides: slot index → model-profile id. */
  agentModelOverrides?: Record<string, string>;
  /** Per-seat tuning: slot index → temperature / effort. */
  agentTuning?: Record<string, {
    temperature?: number;
    reasoningEffort?: "low" | "medium" | "high";
  }>;
  rounds: number;
  /** Seat count for worlds that support more than their default table size. */
  players?: number;
  /** Character picks for the front seats (built-in or custom character ids). */
  characterIds?: string[];
  mode: "ai" | "human";
  playerName?: string;
  reasoningEffort: "low" | "medium" | "high";
  /** season = characters carry cross-game history; one-shot = no memory. */
  season: "season" | "one-shot";
}

export interface CreateRoomResult {
  roomId: string;
  playerToken?: string;
}