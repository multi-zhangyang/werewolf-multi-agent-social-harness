export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  /** Context window in tokens, when known. */
  context?: number;
  /** Human label for the context window ("1M", "256k"...). */
  contextLabel?: string;
}

export interface CreateRoomInput {
  scenarioId: string;
  models: string[];
  rounds: number;
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
