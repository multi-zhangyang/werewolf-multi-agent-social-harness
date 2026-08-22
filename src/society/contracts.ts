import type { Agent, ModelProvider, Session, Tool } from "@openai/agents";
import type { ResolvedModelConfig } from "./models";

/**
 * A character's permanent identity (AGENTS.md §10.2/§15): stable across
 * rooms, seats, models and game roles. Never derived from a display name.
 */
export type CharacterId = string;

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
export type AgentStatus = "lobby" | "thinking" | "acting" | "speaking" | "idle" | "paused" | "finished" | "error";
export type ParticipantController = "agent" | "human";
export type PlayerActionKind = "message" | "choice" | "number" | "target" | "team";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

/**
 * Spectator information modes (AGENTS.md §8.3). Visibility projection happens
 * server-side: a mode never lets data leak across its boundary.
 */
export type SpectatorMode = "public" | "omniscient" | "agent-pov" | "postgame";

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

/**
 * Stable judgment biases (AGENTS.md §4.2.7): bounded rationality comes from
 * the character, not from random error. Each character owns only a few of
 * these, fixed for its lifetime — never the whole list, never shuffled per
 * round. Some biases are measurable in the appraisal engine (hypervigilance
 * deepens trust drops, loss-aversion amplifies negative affect, recency
 * weighting boosts memory salience); the rest shape how the model weighs
 * evidence through the instructions.
 */
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

export interface AgentProfile {
  id: string;
  displayName: string;
  /** The permanent character behind this seat — display names may change. */
  characterId: CharacterId;
  model: string;
  controller?: ParticipantController;
  persona: string;
  traits: string[];
  values: string[];
  goals: string[];
  /** Big Five (OCEAN) profile, grounded in personality-anchoring research. */
  temperament?: AgentTemperament;
  /** A few stable judgment biases this character lives with (§4.2.7). */
  decisionBiases?: DecisionBias[];
  /**
   * Autobiographical anchors (§4.2.1): short formative memories — childhood,
   * key wins, betrayals, the source of this character's values. Seeded into
   * the agent's associative memory as high-salience identity memories so a
   * situation that echoes them can surface why this person reacts this way.
   */
  autobiographicalAnchors?: string[];
  /** How this character speaks: pacing, register, verbal habits. */
  voice?: string;
  /** Emotion-regulation strategy, per Gross-style process model research. */
  regulation?: "reappraise" | "suppress" | "ruminate" | "act-out" | "repair";
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
}

/**
 * A character is the person (§7.1/§7.2): identity, values, voice, biases and
 * formative memories — never a game role, never a model. Built-ins ship with
 * the product; user-defined characters live in the local library and can be
 * imported/exported without secrets.
 */
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
  regulation?: NonNullable<AgentProfile["regulation"]>;
  autobiographicalAnchors?: string[];
  builtIn: boolean;
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
  /** Subjective probability and confidence are distinct (§6.3). */
  probability?: number;
  confidence: number;
  updatedAtTurn: number;
  source: string;
}

export interface AgentRelationship {
  /** The OTHER character this directed feeling points at (stable id). */
  targetCharacterId: CharacterId;
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
  /** Canonical decision/outcome/suggestion ids authorizing this write. */
  sourceRefs?: string[];
  sourceKind?: "agent-authored" | "outcome-reconciliation" | "appraisal" | "legacy";
  /** Links to related memories (AGENTS.md §5.4.7). Built deterministically
   *  on write; the fact layer stays stable, only interpretation links move. */
  links?: MemoryLink[];
}

export interface MemoryLink {
  toMemoryId: string;
  kind:
    | "same-person"
    | "supports"
    | "contradicts"
    | "caused-by"
    | "resolved-by"
    | "similar-situation"
    | "promise-chain"
    | "deception-chain";
  weight: number;
  lastReinforcedAt: string;
}

/**
 * A private cognitive pass recorded by the agent itself: the same identity
 * running an internal phase (reflection / theory-of-mind / planning) inside
 * its own session and writing the result into its own mind. It is not a
 * separate agent and has no identity of its own.
 */
export interface AgentCognitivePass {
  kind: "reflection" | "mind-read" | "plan";
  text: string;
  turn: number;
  at: string;
}

/**
 * Slow personality adaptation (AGENTS.md §4.2.8). A character's Big Five
 * baseline does not flip after one game; repeated, high-intensity experiences
 * only shift a small bounded adaptation that decays back toward the baseline
 * unless reinforced. `effective = baseline + bounded(adaptation)`, and every
 * movement records why, so changes stay explainable and observable.
 */
export interface TraitState {
  baseline: number;
  adaptation: number;
  effective: number;
  /** Human-readable causes of the current adaptation, newest first. */
  lastCauses: string[];
  updatedAtTurn: number;
}

export type AdaptableTrait = keyof AgentTemperament;

/**
 * A structured, observable beat from an agent's own cognition — what it
 * noticed, hypothesized, planned or decided. Produced by the same agent that
 * acts (never by a spectator or a specialist), tied to a real activation, and
 * carrying real references where available. Raw hidden chain-of-thought is
 * never a ThoughtBeat.
 */
export type ThoughtBeatKind =
  | "notice"
  | "recall"
  | "doubt"
  | "goal"
  | "hypothesis"
  | "conflict"
  | "plan"
  | "decision"
  | "regret"
  | "realization";

export interface ThoughtBeat {
  id: string;
  roomId: string;
  agentId: string;
  activationId?: string;
  kind: ThoughtBeatKind;
  title: string;
  summary: string;
  confidence?: number;
  targetIds?: string[];
  memoryIds?: string[];
  visibility: "private" | "omniscient" | "postgame" | "public";
  createdAt: string;
}

/**
 * A strategic deception this agent has planned. Recorded through the private
 * `log_deception_plan` tool, so deception is a typed, audience-aware goal —
 * never an invisible lie (AGENTS.md §10: goal, audience, intended belief,
 * cover story, cost review).
 */
export interface AgentDeceptionPlan {
  /** Canonical private episode id; cite it when a later message executes the plan. */
  deceptionId?: string;
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

/**
 * Deterministic tension signal derived from real events. Presentation-only:
 * it drives camera and pacing, never the game (AGENTS.md §8.6).
 */
export type TensionReason =
  | "direct-accusation"
  | "contradiction"
  | "betrayal"
  | "alliance-break"
  | "vote-swing"
  | "role-action"
  | "deception-exposed"
  | "save"
  | "elimination"
  | "win-condition-near"
  | "emotional-spike";

export interface TensionSignal {
  eventId: string;
  score: number;
  reasons: TensionReason[];
  primaryAgentIds: string[];
}

export type CameraMode =
  | "wide-table"
  | "speaker"
  | "duel"
  | "agent-mind"
  | "tool-action"
  | "vote-board"
  | "relationship"
  | "role-reveal"
  | "endgame";

/**
 * A presentational camera cue derived from real events; re-derivable and
 * never part of the world truth (AGENTS.md §10.6).
 */
export interface CinematicCue {
  id: string;
  roomId: string;
  sourceEventIds: string[];
  camera: CameraMode;
  focusAgentIds: string[];
  priority: number;
  minimumDurationMs: number;
  maximumDurationMs: number;
  title?: string;
  subtitle?: string;
  effect?: string;
  sound?: string;
  skippable: boolean;
  createdAt: string;
}

export interface AgentMindState {
  mood: AgentMoodState;
  attention: string[];
  goals: AgentGoal[];
  beliefs: AgentBelief[];
  relationships: AgentRelationship[];
  memories: AgentMemoryItem[];
  latestReflection?: string;
  /** Private analyses produced by this agent's own internal cognitive passes. */
  cognitivePasses: AgentCognitivePass[];
  /** Planned strategic deceptions, typed and audience-scoped. */
  deceptions: AgentDeceptionPlan[];
  /** Role-probability hypotheses in hidden-identity worlds. */
  roleHypotheses: AgentRoleHypothesis[];
  /** The causal notes behind recent appraisal-driven mood changes. */
  lastAppraisals: AgentAppraisalNote[];
  /**
   * Slow, bounded personality adaptation (AGENTS.md §4.2.8). Effective Big
   * Five values = baseline + bounded adaptation; adaptation decays back toward
   * baseline unless reinforced by repeated high-intensity experiences.
   */
  traitAdaptations?: Record<AdaptableTrait, TraitState>;
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
  /** The permanent character behind this seat — survives seat swaps. */
  characterId: CharacterId;
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
  | "win"               // decisive, game-changing strike
  // P0-09: neutral outcome labels. The strong labels above require social
  // evidence (a Commitment or DeceptionEpisode); until the spine records it,
  // scenarios report only what the world results prove.
  | "cooperative-outcome"   // coordinated success, no promise implied
  | "high-return"           // a payoff above the reciprocal line
  | "low-return"            // a payoff below it
  | "commitment-unresolved" // a known commitment that has not been settled
  | "unilateral-defection"  // one side left a cooperative structure
  | "free-riding"           // profiting from the group without contributing
  | "adverse-outcome"       // a bad result that proves no one's character
  | "agreement-reached"     // a deal was struck; not an alliance
  | "negotiation-failed"    // talks broke down; not a misplay
  | "hidden-role-revealed"; // a hidden identity surfaced; not a caught lie

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
  /** Private canonical social-event ids that persist this observation across restart. */
  sourceEventIds?: string[];
  type:
    | "accused"          // someone publicly accused this agent
    | "defended"         // someone publicly stood up for this agent
    | "threatened"       // someone directly threatened this agent
    | "endorsed"         // someone backed this agent
    | "apologized-to"    // someone directly apologized to this agent
    | "warning-received" // someone warned this agent about a risk
    | "socially-accepted" // someone accepted this agent's proposal in speech
    | "socially-rejected" // someone rejected this agent's proposal in speech
    | "vote-against"     // someone voted to eliminate this agent
    | "vote-cast"        // this agent cast a vote
    | "voted-with"       // someone voted for the same target as this agent
    | "eliminated"       // this agent was eliminated
    | "eliminated-other" // another participant was eliminated
    | "revealed"        // this agent's role was publicly revealed (e.g. idiot flip)
    | "investigation"    // seer result, private
    | "night-kill"       // this agent (wolf) helped kill someone at night
    | "included"         // this agent was chosen for a quest team
    | "excluded"         // this agent was left out of a quest team
    | "alliance-proposed" // cooperation was proposed; no alliance exists yet
    | "agreement-reached" // a typed offer was accepted; not an alliance
    | "negotiation-failed" // no transaction was reached; not automatically a mistake
    | "offer-proposed"    // a typed commercial offer was made
    | "offer-rejected"    // a typed offer was declined
    | "quest-passed"     // a quest this agent was (or wasn't) on succeeded
    | "quest-failed"     // a quest this agent was (or wasn't) on failed
    | "assassinated"     // this agent was killed in the final assassination
    | "commitment-proposed"  // someone declared a promise involving this agent
    | "commitment-accepted"  // a recipient explicitly accepted a proposed promise
    | "commitment-fulfilled" // a promise made to this agent was kept
    | "commitment-violated"  // a promise made to this agent was broken
    | "opponent-cooperated"  // the other actor chose cooperation in a resolved PD round
    | "opponent-defected"    // the other actor chose defection; no betrayal is implied
    | "competitive-bid-received" // the next actor must answer a binding public bid
    | "bid-challenged"       // this actor's binding bid was challenged and resolved
    | "investment-made"      // the trust-game investment was sealed
    | "return-made"          // the trust-game return was sealed
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
  targetFilter?: "any-living" | "other-living" | "non-wolf" | "any-dead";
}

/**
 * A first-class promise inside a scenario (§8.1, Phase 1 minimal slice).
 * Created only through an explicit typed tool (`make_commitment`), then
 * settled by the world rules when the promised action's condition comes due.
 * A commitment is the only evidence that may upgrade a neutral outcome label
 * into promise-kept / promise-broken.
 */
export interface Commitment {
  commitmentId: string;
  round: number;
  /** The promisor's seat and permanent character (§15.2). */
  promisorActorId: string;
  promisorCharacterId: string;
  /** Who the declaration was made to. */
  audienceActorIds: string[];
  /** What was promised, in words the promisee can check. */
  proposition: string;
  promisedAction:
    | {
        actionType: "return-at-least" | "invest-at-least" | "contribute-at-least" | "return-ratio";
        /** Absolute amount for amount-based promises; percent (0-100] for return-ratio. */
        amount: number;
        condition?: string;
      }
      | {
          actionType: "choose-move";
          choice: "cooperate" | "defect";
          condition?: string;
        }
      | {
          actionType: "demand-exactly";
          amount: number;
          condition?: string;
        };
  state: "proposed" | "accepted" | "fulfilled" | "violated" | "void";
  /** Present on current records; optional only while reading legacy checkpoints. */
  acceptedByActorIds?: string[];
  acceptedByCommandIds?: string[];
  /** The idempotent command that created this commitment. */
  createdByCommandId?: string;
  settledByCommandId?: string;
  createdAtTurn: number;
  acceptedAtTurn?: number;
  settledAtTurn?: number;
  schemaVersion: number;
}

export interface OpenCommitmentView {
  commitmentId: string;
  promisorActorId: string;
  promisorCharacterId: string;
  audienceActorIds: string[];
  proposition: string;
  promisedAction: {
    actionType: string;
    amount?: number;
    choice?: string;
    condition?: string;
  };
  state: Commitment["state"];
  acceptedByActorIds?: string[];
  acceptedByCommandIds?: string[];
}

/**
 * A structured, auditable decision record for one binding action (§5.4,
 * Phase 1 minimal slice). Written by the world at command-commit time; it
 * cites the commitments and beliefs the actor explicitly referenced, never
 * raw chain-of-thought.
 */
export interface DecisionRecord {
  decisionId: string;
  actorId: string;
  characterId: string;
  turn: number;
  phase: string;
  action: string;
  commandId?: string;
  payloadSummary: string;
  referencedCommitmentIds: string[];
  beliefPropositions?: string[];
}

export interface WorldActionCommit {
  action: string;
  detail: string;
  result?: unknown;
  /**
   * Stable command receipt (§16.6): a retry of the same command inside the
   * same activation epoch returns the original receipt instead of applying
   * the world action twice.
   */
  commandId?: string;
}

export interface ActivationCompletion {
  completed: boolean;
  missingActorIds: string[];
  retryInstruction?: string;
}

export type AgentRuntimeEvent =
  | { type: "agent.status"; roomId: string; actorId: string; status: AgentStatus; at: string }
  | { type: "agent.updated"; roomId: string; actorId: string; status: AgentStatus; mind: AgentMindState; turnCount: number; totalTokens: number; lastOutput?: string; at: string }
  | {
      type: "agent.delta";
      roomId: string;
      actorId: string;
      delta: string;
      /** True while the current phase is sealed (night actions, simultaneous
       *  votes): public spectators must not see the token stream, because the
       *  text would reveal hidden choices before resolution (§8.3). */
      sealed?: boolean;
      at: string;
    }
  | { type: "agent.reasoning-content"; roomId: string; actorId: string; delta: string; elapsedMs: number; done: boolean; at: string }
  | { type: "agent.reasoning-summary"; roomId: string; actorId: string; delta: string; at: string }
  /** @deprecated Read-only compatibility for archives created before schema v3. */
  | { type: "agent.reasoning"; roomId: string; actorId: string; delta: string; at: string }
  | {
      type: "runtime.notice";
      roomId: string;
      actorId?: string;
      category: "reasoning" | "provider" | "persistence";
      severity: "info" | "warning" | "error";
      code: string;
      message: string;
      modelId?: string;
      requestedEffort?: "xhigh" | "high";
      effectiveEffort?: "high" | "provider-default";
      retrying?: boolean;
      at: string;
    }
  | {
      type: "agent.tool";
      roomId: string;
      actorId: string;
      /** Stable trace id for this tool invocation. */
      toolCallId: string;
      toolName: string;
      /** Human-readable action label for the stage, e.g. "投出白昼票". */
      label?: string;
      phase: "queued" | "started" | "streaming" | "succeeded" | "failed";
      safeInputSummary?: string;
      safeOutputSummary?: string;
      worldEffect?: string;
      errorCode?: string;
      /** Sealed while hidden-choice phases run: public sees only the pulse. */
      sealed?: boolean;
      at: string;
    }
  | { type: "agent.thought-beat"; roomId: string; actorId: string; beat: ThoughtBeat; at: string }
  | { type: "agent.compacted"; roomId: string; actorId: string; estimatedTokens: number; threshold: number; digest: string; level: string; pressureAfter: number; at: string }
  | { type: "agent.memory.recalled"; roomId: string; actorId: string; count: number; query: string; at: string }
  | { type: "agent.memory.consolidated"; roomId: string; actorId: string; memoryId: string; summary: string; at: string }
  | {
      type: "agent.context.pressure";
      roomId: string;
      actorId: string;
      level: "normal" | "watch" | "retrieval-tight" | "soft-compact" | "deep-compact" | "emergency" | "hard-guard";
      pressureRatio: number;
      usableInputTokens: number;
      currentInputTokens: number;
      contextWindow: number;
      at: string;
    }
  | { type: "agent.guardrail"; roomId: string; actorId: string; label: string; snippet: string; at: string }
  | { type: "agent.paused"; roomId: string; actorId: string; reason: string; at: string }
  | { type: "agent.resumed"; roomId: string; actorId: string; at: string }
  | { type: "agent.model.switched"; roomId: string; actorId: string; previousModel: string; model: string; at: string }
  | { type: "agent.message"; roomId: string; message: SocialMessage }
  | {
      type: "agent.pov-frame";
      roomId: string;
      actorId: string;
      activationId: string;
      observation: AgentObservation;
      socialCausality: import("./social/contracts").SocialCausalityProjection;
      at: string;
    }
  | {
      type: "world.operator-frame";
      roomId: string;
      activationId: string;
      snapshot: WorldSnapshot;
      at: string;
    }
  | {
      type: "world.public-frame";
      roomId: string;
      activationId: string;
      snapshot: WorldSnapshot;
      at: string;
    }
  | { type: "world.action"; roomId: string; actorId: string; action: string; detail: string; at: string }
  | { type: "world.updated"; roomId: string; snapshot: WorldSnapshot }
  | {
      type: "tension.changed";
      roomId: string;
      score: number;
      level: "calm" | "warm" | "tense" | "climax";
      reasons: TensionReason[];
      primaryAgentIds: string[];
      at: string;
    }
  | { type: "cinematic.cue"; roomId: string; cue: CinematicCue; at: string }
  | { type: "room.status"; roomId: string; status: RoomStatus; detail?: string; at: string };

export interface AgentMemoryStore {
  remember(input: Omit<AgentMemoryItem, "id" | "createdAt">): Promise<AgentMemoryItem>;
  /** Link two existing memories by id (AGENTS.md §5.4.7). */
  link(fromMemoryId: string, toMemoryId: string, kind: MemoryLink["kind"]): Promise<void>;
  /** `recencyBoost` weights fresh memories higher for recency-weighting characters (§4.2.7). */
  recall(query: string, limit?: number, moodPad?: PadState, recencyBoost?: number): Promise<AgentMemoryItem[]>;
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
  /**
   * Command epoch gate (§16.6 / §17.1): the room opens a window for each
   * activation (including retries and human waits). Tool calls that arrive
   * after the window closed — e.g. from a request the room already gave up
   * on — are rejected instead of mutating a later phase.
   */
  beginActivation(activation: WorldActivation): void;
  /** Close the command window; late commands are rejected from now on. */
  endActivation(): void;
  activation(): WorldActivation | null;
  completeActivation(activation: WorldActivation): ActivationCompletion;
  experienceFor(actorId: string): string | undefined;
  /** Pending appraisal events for one participant; returns and clears them. */
  eventsFor(actorId: string): SocialEvent[];
  /** Evaluate pending reconciliation-backed memory candidates exactly once. */
  applyMemoryWritePolicy(actorId: string): import("./social/contracts").MemoryWritePolicyResult;
  /** True once every outcome-memory path in this scenario is reconciliation-backed. */
  reconciliationOwnsOutcomeMemory(): boolean;
  /** Open (proposed, unsettled) commitments this participant is party to. */
  openCommitmentsFor(actorId: string): OpenCommitmentView[];
  /** Auditable decision records for binding actions; [] where none exist. */
  decisionRecords(): DecisionRecord[];
  /** Viewer-scoped canonical social causality; private cognition stays owner-only. */
  socialCausalityFor(actorId?: string, omniscient?: boolean): import("./social/contracts").SocialCausalityProjection;
  /**
   * Optional message sidecar: when installed, each persisted message is
   * analyzed off-thread and structured social acts are recorded via
   * `recordExtractedSocialActs` with `model-extracted` provenance. Failures
   * must never reach the send path.
   */
  socialActExtractor?: (message: SocialMessage) => Promise<void>;
  /** Record sidecar-extracted social acts for a persisted message; idempotent per message. */
  recordExtractedSocialActs(messageId: string, declarations: import("./social/contracts").SocialActDeclaration[]): string[];
  /**
   * Whether agent token streams may be shown to public spectators right now
   * (§8.3). Scenarios seal hidden-choice phases (night actions, simultaneous
   * votes) so the live text cannot leak unresolved secrets; discussion and
   * open phases stream freely.
   */
  publicStreamingAllowed(): boolean;
  /** Persist the immutable, secret-free runtime policy behind this actor's decisions. */
  recordStrategyProfileSnapshot(input: import("./social/contracts").StrategyProfileSnapshot): import("./social/contracts").StrategyProfileSnapshot;
  /** Persist a sanitized runtime downgrade/failure as AgentTrace, never raw provider content. */
  recordRuntimeNotice(input: Extract<AgentRuntimeEvent, { type: "runtime.notice" }>): void;
  /** Record one actor's structured belief update with visible source checks. */
  recordBeliefUpdate(actorId: string, input: import("./social/contracts").BeliefSelfReportInput): import("./social/contracts").BeliefUpdateRecord;
  /** Update one actor's private, evidence-linked model of another participant. */
  recordActorModel(actorId: string, input: import("./social/contracts").ActorModelInput): import("./social/contracts").ActorModel;
  /** Persist one actor's private A-to-B relationship change. */
  recordRelationshipUpdate(actorId: string, input: import("./social/contracts").RelationshipUpdateInput): import("./social/contracts").RelationshipDeltaRecord;
  /** Record a private deception plan owned by this actor. */
  recordDeceptionPlan(actorId: string, input: import("./social/contracts").DeceptionPlanInput): import("./social/contracts").DeceptionEpisode;
  sendMessage(input: {
    senderId: string;
    channel: SocialChannel;
    text: string;
    recipientIds?: string[];
    replyTo?: string;
    socialActs?: import("./social/contracts").SocialActDeclaration[];
  }): Promise<SocialMessage>;
  setAgentStatus(actorId: string, status: AgentStatus): void;
  /** Append a public world-log entry (shown in the observer timeline). */
  addWorldLog(text: string): void;
  onUpdate(listener: (snapshot: WorldSnapshot) => void): () => void;
  /** Restart recovery (P3): serialize / rehydrate the full rules state. */
  exportState(): import("./world").WorldSerializedState;
  restoreState(state: import("./world").WorldSerializedState): void;
}

/**
 * A character's cross-game dossier: what the season remembers about them
 * after a game ends — the roles they played, who they trusted or resented,
 * their strongest memories, and the reputation they earned.
 */
export interface CharacterDossier {
  /** The permanent character id this history belongs to (AGENTS.md §10.2). */
  characterId: CharacterId;
  /** Display name at the time of the latest game — for the UI, not the key. */
  displayName: string;
  games: Array<{
    scenarioId: string;
    role?: string;
    outcome?: "win" | "lose";
    at: string;
  }>;
  relationships: Array<{
    targetCharacterId: CharacterId;
    trust: number;
    affinity: number;
    respect: number;
    tension: number;
    familiarity?: number;
    note: string;
  }>;
  beliefs: Array<{ subjectId: string; proposition: string; confidence: number }>;
  memories: Array<{ text: string; salience: number; valence: number }>;
  /**
   * Slow personality drift carried across games (§4.2.8): the bounded
   * adaptation each Big Five trait accumulated, with its recorded causes.
   * Loaded back with a season-boundary decay so drift survives a game but
   * erodes while the character is away from the table.
   */
  traitAdaptations?: Record<AdaptableTrait, TraitState>;
  updatedAt: string;
}

/** Cross-game memory: dossiers keyed by character, shared by a season. */
export interface SeasonStore {
  get(characterId: CharacterId): CharacterDossier | undefined;
  save(dossier: CharacterDossier): void;
  list(): CharacterDossier[];
  /** Forget all dossiers — the operator starts a brand-new season. */
  clear(): void;
  /** Forget one character's cross-game memory (§7.2 重置长期记忆). */
  remove(characterId: CharacterId): boolean;
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
  readonly session: Session;
  readonly mind: AgentMindState;
  runTurn(input: string, options: { signal: AbortSignal; turn: number }): Promise<AgentTurnResult>;
  rememberOutcome(text: string, turn: number, source: {
    suggestionId: string;
    importance: number;
    sourceIds: string[];
  }): Promise<void>;
  /** Process world-appraisal events into emotion, relationship and memory. */
  appraise(events: SocialEvent[], turn: number): Promise<void>;
  /**
   * Model switch (§12.4): keeps this agent's identity, session, mind and
   * memory; swaps the model binding and recomputes the context budget.
   */
  switchModel(next: { provider: ModelProvider; resolvedConfig: ResolvedModelConfig }): Promise<{ previousModel: string; model: string }>;
  /** Distill this character's private mind into a season dossier. */
  exportDossier(role?: string, outcome?: "win" | "lose"): CharacterDossier;
}
