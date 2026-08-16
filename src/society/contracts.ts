import type { Agent, MemorySession, Tool } from "@openai/agents";

export type ScenarioId =
  | "prisoners-dilemma"
  | "public-goods"
  | "trust-game"
  | "werewolf"
  | "ultimatum-game"
  | "beauty-contest"
  | "sealed-bid-auction"
  | "avalon"
  | "centipede-game"
  | "chicken-game"
  | "stag-hunt";
export type RoomStatus = "lobby" | "running" | "paused" | "finished" | "error";
export type SocialChannel = "public" | "private" | "team";
export type AgentStatus = "lobby" | "thinking" | "acting" | "speaking" | "idle" | "finished" | "error";
export type ParticipantController = "agent" | "human";
export type PlayerActionKind = "message" | "choice" | "number" | "target" | "team";
export type ReasoningEffort = "low" | "medium" | "high";

export interface ScenarioSummary {
  id: ScenarioId;
  name: string;
  shortDescription: string;
  description: string;
  players: number;
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

export interface AgentProfile {
  id: string;
  displayName: string;
  model: string;
  controller?: ParticipantController;
  persona: string;
  traits: string[];
  values: string[];
  goals: string[];
  /** Big Five (OCEAN) profile, grounded in personality-anchoring research. */
  temperament?: AgentTemperament;
  /** How this character speaks: pacing, register, verbal habits. */
  voice?: string;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
}

export interface AgentGoal {
  id: string;
  description: string;
  priority: number;
  progress: string;
  status: "active" | "satisfied" | "abandoned";
}

export interface PadState {
  pleasure: number;
  arousal: number;
  dominance: number;
}

export interface CoreEmotions {
  joy: number;
  sadness: number;
  anger: number;
  fear: number;
  surprise: number;
  disgust: number;
}

export interface AgentNeeds {
  security: number;
  connection: number;
  status: number;
  autonomy: number;
  achievement: number;
}

export interface AgentMoodState {
  label: string;
  description: string;
  pad: PadState;
  emotions: CoreEmotions;
  needs: AgentNeeds;
  energy: number;
  updatedAtTurn: number;
}

export interface AgentBelief {
  subjectId: string;
  proposition: string;
  confidence: number;
  updatedAtTurn: number;
  source: string;
}

export interface AgentRelationship {
  agentId: string;
  trust: number;
  affinity: number;
  respect: number;
  tension: number;
  familiarity: number;
  updatedAtTurn: number;
  note: string;
}

export interface AgentMemoryItem {
  id: string;
  text: string;
  tags: string[];
  salience: number;
  valence: number;
  pad?: PadState;
  turn: number;
  createdAt: string;
}

export interface AgentDeliberation {
  kind: "reflection" | "mind-read" | "plan";
  text: string;
  turn: number;
  at: string;
}

export interface AgentMindState {
  mood: AgentMoodState;
  attention: string[];
  goals: AgentGoal[];
  beliefs: AgentBelief[];
  relationships: AgentRelationship[];
  memories: AgentMemoryItem[];
  latestReflection?: string;
  /** Private analyses produced by this agent's specialist sub-agents. */
  deliberations: AgentDeliberation[];
}

export interface SocialMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  channel: SocialChannel;
  text: string;
  turn: number;
  phase: string;
  createdAt: string;
  recipientIds?: string[];
  replyTo?: string;
}

export interface AgentObservation {
  roomId: string;
  scenarioId: ScenarioId;
  turn: number;
  phase: string;
  situation: string;
  privateContext: string;
  self: {
    id: string;
    displayName: string;
    alive: boolean;
    role?: string;
    score?: number;
  };
  others: Array<{
    id: string;
    displayName: string;
    alive: boolean;
    status: AgentStatus;
    visibleRole?: string;
  }>;
  recentMessages: SocialMessage[];
  availableActions: string[];
}

export interface WorldAgentSnapshot {
  id: string;
  displayName: string;
  status: AgentStatus;
  alive: boolean;
  score?: number;
  observerRole?: string;
}

export interface WorldLogEntry {
  id: string;
  text: string;
  turn: number;
  phase: string;
  at: string;
}

export interface WorldSnapshot {
  roomId: string;
  scenarioId: ScenarioId;
  title: string;
  status: Exclude<RoomStatus, "error">;
  turn: number;
  totalTurns: number;
  phase: string;
  summary: string;
  agents: WorldAgentSnapshot[];
  messages: SocialMessage[];
  log: WorldLogEntry[];
  details: Record<string, unknown>;
}

export interface WorldActivation {
  id: string;
  label: string;
  actorIds: string[];
  mode: "parallel" | "sequential";
  instructionFor(actorId: string): string;
}

export interface PlayerActionSpec {
  name: string;
  label: string;
  description: string;
  kind: PlayerActionKind;
  field?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  channels?: SocialChannel[];
  targetFilter?: "any-living" | "other-living" | "non-wolf";
}

export interface WorldActionCommit {
  action: string;
  detail: string;
  result?: unknown;
}

export interface ActivationCompletion {
  completed: boolean;
  missingActorIds: string[];
  retryInstruction?: string;
}

export type AgentRuntimeEvent =
  | { type: "agent.status"; roomId: string; actorId: string; status: AgentStatus; at: string }
  | { type: "agent.updated"; roomId: string; actorId: string; status: AgentStatus; mind: AgentMindState; turnCount: number; totalTokens: number; lastOutput?: string; at: string }
  | { type: "agent.delta"; roomId: string; actorId: string; delta: string; at: string }
  | { type: "agent.reasoning"; roomId: string; actorId: string; delta: string; at: string }
  | { type: "agent.tool"; roomId: string; actorId: string; toolName: string; phase: "started" | "completed"; summary?: string; at: string }
  | { type: "agent.thought"; roomId: string; actorId: string; specialist: AgentDeliberation["kind"]; delta: string; at: string }
  | { type: "agent.message"; roomId: string; message: SocialMessage }
  | { type: "world.action"; roomId: string; actorId: string; action: string; detail: string; at: string }
  | { type: "world.updated"; roomId: string; snapshot: WorldSnapshot }
  | { type: "room.status"; roomId: string; status: RoomStatus; detail?: string; at: string };

export interface AgentMemoryStore {
  remember(input: Omit<AgentMemoryItem, "id" | "createdAt">): Promise<AgentMemoryItem>;
  recall(query: string, limit?: number, moodPad?: PadState): Promise<AgentMemoryItem[]>;
  list(limit?: number): Promise<AgentMemoryItem[]>;
}

export interface SocietyAgentContext {
  actorId: string;
  roomId: string;
  profile: AgentProfile;
  world: SocialWorld;
  mind: AgentMindState;
  memory: AgentMemoryStore;
  emit(event: AgentRuntimeEvent): void;
}

export interface SocialWorld {
  readonly roomId: string;
  readonly scenario: ScenarioSummary;
  start(): void;
  pause(): void;
  snapshot(): WorldSnapshot;
  snapshotFor(actorId?: string): WorldSnapshot;
  observe(actorId: string): AgentObservation;
  toolsFor(actorId: string): Tool<SocietyAgentContext>[];
  playerActions(actorId: string): PlayerActionSpec[];
  performAction(actorId: string, action: string, payload: unknown): Promise<WorldActionCommit>;
  activation(): WorldActivation | null;
  completeActivation(activation: WorldActivation): ActivationCompletion;
  experienceFor(actorId: string): string | undefined;
  sendMessage(input: {
    senderId: string;
    channel: SocialChannel;
    text: string;
    recipientIds?: string[];
    replyTo?: string;
  }): Promise<SocialMessage>;
  setAgentStatus(actorId: string, status: AgentStatus): void;
  onUpdate(listener: (snapshot: WorldSnapshot) => void): () => void;
}

export interface AgentTurnResult {
  actorId: string;
  turn: number;
  finalOutput: string;
  toolCalls: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface SocietyAgentRuntime {
  readonly profile: AgentProfile;
  readonly agent: Agent<SocietyAgentContext>;
  readonly session: MemorySession;
  readonly mind: AgentMindState;
  runTurn(input: string, options: { signal: AbortSignal; turn: number }): Promise<AgentTurnResult>;
  rememberOutcome(text: string, turn: number): Promise<void>;
}
