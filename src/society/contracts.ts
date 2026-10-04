export type CharacterId = string;

export type ScenarioId =
  | "prisoners-dilemma"
  | "public-goods"
  | "trust-game"
  | "signaling-game"
  | "werewolf"
  | "ultimatum-game"
  | "beauty-contest"
  | "sealed-bid-auction"
  | "avalon"
  | "centipede-game"
  | "chicken-game"
  | "stag-hunt"
  | "negotiation-game"
  | "liars-dice";

export interface ScenarioSummary {
  id: ScenarioId;
  name: string;
  shortDescription: string;
  description: string;
  /** Default seat count when the creator does not choose one. */
  players: number;
  /**
   * Supported seat counts for this world, following the game's own table
   * conventions (werewolf 6-12, avalon 5-10, dice 2-6, …). Absent for games
   * whose identity is two-player.
   */
  playerRange?: { min: number; max: number };
  defaultRounds: number;
  minRounds: number;
  maxRounds: number;
  capabilities: string[];
}

export interface AgentTemperament {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
}

export type DecisionBias =
  | "confirmation"
  | "loss-aversion"
  | "sunk-cost"
  | "in-group"
  | "authority-sensitivity"
  | "betrayal-hypervigilance"
  | "overconfident-lie-detection"
  | "self-consistency"
  | "recency-weighting";

export interface CharacterDefinition {
  id: string;
  displayName: string;
  persona: string;
  traits: string[];
  values: string[];
  goals: string[];
  temperament?: AgentTemperament;
  decisionBiases?: DecisionBias[];
  voice?: string;
  regulation?: "reappraise" | "suppress" | "ruminate" | "act-out" | "repair";
  autobiographicalAnchors?: string[];
  builtIn: boolean;
}
