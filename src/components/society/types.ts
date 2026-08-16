export interface ModelOption {
  id: string;
  name: string;
  provider: string;
}

export interface CreateRoomInput {
  scenarioId: string;
  models: string[];
  rounds: number;
  mode: "ai" | "human";
  playerName?: string;
  reasoningEffort: "low" | "medium" | "high";
}

export interface CreateRoomResult {
  roomId: string;
  playerToken?: string;
}
