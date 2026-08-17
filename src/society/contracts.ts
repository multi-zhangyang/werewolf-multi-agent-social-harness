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
  | "stag-hunt"
  | "negotiation-game"
  | "liars-dice";
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
  /** Emotion-regulation strategy, per Gross-style process model research. */
  regulation?: "reappraise" | "suppress" | "ruminate" | "act-out" | "repair";
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

/**
 * Social emotions (OCC/EMA style): appraisal-driven feelings that exist
 * because of other people — what someone did to us, what we owe, what we
 * caused. Kept as structured intensities so they can modulate attention and
 * expression without relying on the model to self-report.
 */
export interface SocialEmotions {
  gratitude: number;
  guilt: number;
  shame: number;
  embarrassment: number;
  pride: number;
  envy: number;
  jealousy: number;
  contempt: number;
  admiration: number;
  relief: number;
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
  socialEmotions: SocialEmotions;
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

/**
 * A strategic deception this agent has planned. Recorded through the private
 * `log_deception_plan` tool, so deception is a typed, audience-aware goal —
 * never an invisible lie (AGENTS.md §10: goal, audience, intended belief,
 * cover story, cost review).
 */
export interface AgentDeceptionPlan {
  type: "lying" | "bluff" | "paltering" | "omission" | "false-promise";
  targetIds: string[];
  intendedBelief: string;
  coverStory: string;
  fallback: string;
  turn: number;
  at: string;
}

/** A probability judgment about another participant's hidden role. */
export interface AgentRoleHypothesis {
  subjectId: string;
  role: string;
  probability: number;
  updatedAtTurn: number;
}

/** Why the mood just moved: the event behind each appraisal change. */
export interface AgentAppraisalNote {
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
  /** Planned strategic deceptions, typed and audience-scoped. */
  deceptions: AgentDeceptionPlan[];
  /** Role-probability hypotheses in hidden-identity worlds. */
  roleHypotheses: AgentRoleHypothesis[];
  /** The causal notes behind recent appraisal-driven mood changes. */
  lastAppraisals: AgentAppraisalNote[];
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
  /** Discussion wave this message belongs to, when inside a dynamic discussion. */
  wave?: number;
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

export type StoryBeatKind =
  | "betrayal"          // a trust that existed was broken
  | "deception-exposed" // a lie or bluff got called out
  | "alliance"          // two sides publicly bound themselves together
  | "promise-kept"      // a commitment survived contact with self-interest
  | "promise-broken"    // a commitment was dropped when it mattered
  | "comeback"          // someone behind the curve turned the game
  | "misplay"           // a self-inflicted, costly error
  | "win";              // decisive, game-changing strike

export interface WorldLogEntry {
  id: string;
  text: string;
  turn: number;
  phase: string;
  at: string;
  /** Optional story-node tag: the beat this log marks, for the timeline. */
  beat?: StoryBeatKind;
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

/**
 * A structured, observer-scoped social event. The world translates raw
 * happenings (a vote, a kill, an accusation) into the meaning they have for
 * one specific participant, so appraisal never needs the god's-eye view.
 */
export interface SocialEvent {
  id: string;
  type:
    | "accused"          // someone publicly accused this agent
    | "defended"         // someone publicly stood up for this agent
    | "vote-against"     // someone voted to eliminate this agent
    | "vote-cast"        // this agent cast a vote
    | "voted-with"       // someone voted for the same target as this agent
    | "eliminated"       // this agent was eliminated
    | "eliminated-other" // another participant was eliminated
    | "investigation"    // seer result, private
    | "night-kill"       // this agent (wolf) helped kill someone at night
    | "included"         // this agent was chosen for a quest team
    | "excluded"         // this agent was left out of a quest team
    | "quest-passed"     // a quest this agent was (or wasn't) on succeeded
    | "quest-failed"     // a quest this agent was (or wasn't) on failed
    | "assassinated"     // this agent was killed in the final assassination
    | "win"              // this agent's faction won
    | "lose";            // this agent's faction lost
  turn: number;
  phase: string;
  /** The other participant involved, if any (accuser, voter, defender...). */
  actorId?: string;
  targetId?: string;
  /** Extra facts: revealed role, investigation result, involvement flags. */
  facts?: Record<string, unknown>;
  /** Human-readable summary; becomes the seed of a personal memory. */
  detail: string;
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
  | { type: "agent.compacted"; roomId: string; actorId: string; estimatedTokens: number; threshold: number; digest: string; at: string }
  | { type: "agent.guardrail"; roomId: string; actorId: string; label: string; snippet: string; at: string }
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
  /** Pending appraisal events for one participant; returns and clears them. */
  eventsFor(actorId: string): SocialEvent[];
  sendMessage(input: {
    senderId: string;
    channel: SocialChannel;
    text: string;
    recipientIds?: string[];
    replyTo?: string;
  }): Promise<SocialMessage>;
  setAgentStatus(actorId: string, status: AgentStatus): void;
  /** Append a public world-log entry (shown in the observer timeline). */
  addWorldLog(text: string): void;
  onUpdate(listener: (snapshot: WorldSnapshot) => void): () => void;
}

/**
 * A character's cross-game dossier: what the season remembers about them
 * after a game ends — the roles they played, who they trusted or resented,
 * their strongest memories, and the reputation they earned.
 */
export interface CharacterDossier {
  /** Stable character key (display name). */
  characterKey: string;
  games: Array<{
    scenarioId: string;
    role?: string;
    outcome?: "win" | "lose";
    at: string;
  }>;
  relationships: Array<{
    agentId: string;
    trust: number;
    affinity: number;
    respect: number;
    tension: number;
    familiarity?: number;
    note: string;
  }>;
  beliefs: Array<{ subjectId: string; proposition: string; confidence: number }>;
  memories: Array<{ text: string; salience: number; valence: number }>;
  updatedAt: string;
}

/** Cross-game memory: dossiers keyed by character, shared by a season. */
export interface SeasonStore {
  get(characterKey: string): CharacterDossier | undefined;
  save(dossier: CharacterDossier): void;
  list(): CharacterDossier[];
  /** Forget all dossiers — the operator starts a brand-new season. */
  clear(): void;
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
  /** Process world-appraisal events into emotion, relationship and memory. */
  appraise(events: SocialEvent[], turn: number): Promise<void>;
  /** Distill this character's private mind into a season dossier. */
  exportDossier(role?: string, outcome?: "win" | "lose"): CharacterDossier;
}
