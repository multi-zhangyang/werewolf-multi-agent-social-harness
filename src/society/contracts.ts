import type { Agent, MemorySession, Tool } from "@openai/agents";

export type ScenarioId = "prisoners-dilemma" | "public-goods" | "trust-game" | "werewolf";
export type RoomStatus = "lobby" | "running" | "paused" | "finished" | "error";
export type SocialChannel = "public" | "private" | "team";
export type AgentStatus = "lobby" | "thinking" | "acting" | "speaking" | "idle" | "finished" | "error";
export type AgentNoteKind = "observation" | "reflection" | "decision" | "outcome";

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

export interface AgentProfile {
  id: string;
  displayName: string;
  model: string;
  persona: string;
  traits: string[];
  values: string[];
  goals: string[];
  temperature?: number;
}

export interface AgentGoal {
  id: string;
  description: string;
  priority: number;
  progress: string;
  status: "active" | "satisfied" | "abandoned";
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
  createdAt: string;
  turn: number;
}

export interface AgentMindState {
  mood: string;
  energy: number;
  attention: string[];
  goals: AgentGoal[];
  beliefs: AgentBelief[];
  relationships: AgentRelationship[];
  memories: AgentMemoryItem[];
  latestReflection?: string;
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

export interface StoryBeat {
  id: string;
  title: string;
  text: string;
  tone: "neutral" | "positive" | "warning" | "danger" | "complete";
  turn: number;
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
  story: StoryBeat[];
  details: Record<string, unknown>;
}

export interface WorldActivation {
  id: string;
  label: string;
  actorIds: string[];
  mode: "parallel" | "sequential";
  instructionFor(actorId: string): string;
}

export interface ActivationCompletion {
  completed: boolean;
  missingActorIds: string[];
  retryInstruction?: string;
}

export type AgentRuntimeEvent =
  | { type: "agent.status"; roomId: string; actorId: string; status: AgentStatus; at: string }
  | { type: "agent.updated"; roomId: string; actorId: string; status: AgentStatus; mind: AgentMindState; turnCount: number; totalTokens: number; lastOutput?: string; at: string }
  | { type: "agent.note"; roomId: string; actorId: string; kind: AgentNoteKind; text: string; at: string }
  | { type: "agent.delta"; roomId: string; actorId: string; delta: string; at: string }
  | { type: "agent.tool"; roomId: string; actorId: string; toolName: string; phase: "started" | "completed"; summary?: string; at: string }
  | { type: "agent.message"; roomId: string; message: SocialMessage }
  | { type: "world.action"; roomId: string; actorId: string; action: string; detail: string; at: string }
  | { type: "world.updated"; roomId: string; snapshot: WorldSnapshot }
  | { type: "room.status"; roomId: string; status: RoomStatus; detail?: string; at: string };

export interface AgentMemoryStore {
  remember(input: Omit<AgentMemoryItem, "id" | "createdAt">): Promise<AgentMemoryItem>;
  recall(query: string, limit?: number): Promise<AgentMemoryItem[]>;
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
  observe(actorId: string): AgentObservation;
  toolsFor(actorId: string): Tool<SocietyAgentContext>[];
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
