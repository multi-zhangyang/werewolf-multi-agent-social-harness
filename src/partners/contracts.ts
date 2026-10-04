/** Contracts for the isolated Partners world. Private state never doubles as an actor observation. */
export type ActorId = "a" | "b";
export type ActorKind = "human" | "ai";
export type Phase = "offer" | "invest" | "settle" | "repair" | "respond" | "finished";
export type Visibility = "public" | ActorId | "research";

export interface ActorSpec {
  name: string;
  kind: ActorKind;
  agreeableness?: number;
  initialWallet?: number;
  burden?: number;
  productivity?: 2 | 3;
  privateObjective?: string;
}

export interface WorldSpec {
  actors: Record<ActorId, ActorSpec>;
  maxRounds?: number;
  seed?: number;
}

export interface WorldActor {
  id: ActorId;
  name: string;
  kind: ActorKind;
  agreeableness: number;
  initialWallet: number;
  wallet: number;
  burden: number;
  productivity: 2 | 3;
  privateObjective: string;
  obligationPaid: number;
  obligationShortfall: number;
}

export interface PublicActor {
  id: ActorId;
  name: string;
  kind: ActorKind;
}

export interface Deal {
  id: string;
  round: number;
  investor: ActorId;
  trustee: ActorId;
  promiseRatio: number | null;
  collateral: number;
  collateralLocked: number;
  collateralForfeited: number;
  investment: number | null;
  grossIncome: number | null;
  returned: number | null;
  compensation: number;
  claimedIncome: number | null;
  incomeRevealed: boolean;
  breached: boolean | null;
}

export interface WorldEvent {
  id: string;
  seq: number;
  revision: number;
  round: number;
  phase: Phase;
  kind: "opening" | "offer" | "investment" | "income" | "settlement" | "collateral" | "repair" | "response" | "message" | "intent" | "round" | "closed" | "obligation";
  actor: ActorId | null;
  visibility: Visibility;
  summary: string;
  data: Record<string, unknown>;
}

export interface ActionBase {
  /** A public utterance: claims are never promoted to ledger facts. */
  message?: string;
  /** A contemporaneous private declaration; disagreement is evidence, not a deception verdict. */
  intent?: string;
}

export type Action =
  | (ActionBase & { type: "offer"; promiseRatio: number; collateral: number })
  | (ActionBase & { type: "invest"; amount: number })
  | (ActionBase & { type: "settle"; returnAmount: number; claimedIncome?: number; revealIncome?: boolean })
  | (ActionBase & { type: "repair"; compensation: number })
  | (ActionBase & { type: "respond"; choice: "continue" | "exit" })
  | (ActionBase & { type: "exit" });

export interface LegalAction {
  type: Action["type"];
  label: string;
  description: string;
  fields: Record<string, { min?: number; max?: number; step?: number; choices?: string[]; optional?: boolean }>;
}

export interface AppliedCommand {
  id: string;
  actor: ActorId;
  signature: string;
  revision: number;
}

export interface WorldState {
  schemaVersion: 1;
  id: string;
  revision: number;
  round: number;
  maxRounds: number;
  phase: Phase;
  actors: Record<ActorId, WorldActor>;
  investor: ActorId;
  trustee: ActorId;
  deal: Deal;
  completedDeals: Deal[];
  events: WorldEvent[];
  commands: AppliedCommand[];
  ledger: { initialTotal: number; minted: number; externalCosts: number };
  finishReason: "completed" | "exit" | null;
  exitedBy: ActorId | null;
}

export type World = WorldState;

/** All fields in this projection are safe for this actor's model and player UI. */
export interface ActorObservation {
  schemaVersion: 1;
  worldId: string;
  revision: number;
  actorId: ActorId;
  round: number;
  maxRounds: number;
  phase: Phase;
  currentActor: ActorId | null;
  investor: ActorId;
  trustee: ActorId;
  self: WorldActor;
  actors: Record<ActorId, PublicActor>;
  /** grossIncome is null unless received by this actor or publicly disclosed. */
  deal: Deal;
  completedDeals: Deal[];
  events: WorldEvent[];
  legalActions: LegalAction[];
  rules: string[];
  finishReason: WorldState["finishReason"];
}

export interface ActionPreview {
  legal: boolean;
  reason?: string;
  /** Local counterfactual only; it never mutates the source world. */
  observation?: ActorObservation;
  walletChange?: number;
  newEvents?: WorldEvent[];
}

/** Spectator projection: no private wallet, traits, income, objective, or declarations. */
export interface PublicObservation extends Omit<ActorObservation, "actorId" | "self" | "legalActions"> {
  legalActions: [];
}
