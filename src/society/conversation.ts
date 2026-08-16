/**
 * Dynamic conversation direction (turn-taking as response pressure).
 *
 * Grounded in Sacks/Schegloff/Jefferson turn-taking (1974) and the agenda of
 * "conversation as adjacency pairs": a message creates obligations — questions
 * expect answers, accusations expect defense, new evidence invites reaction.
 * Instead of a fixed "everyone speaks once" round, the director watches every
 * public utterance, computes each participant's response urgency, and lets the
 * conversation continue wave after wave until nobody has a reason to speak.
 * Silence is a legitimate move, not a failure.
 *
 * The director is deterministic (no LLM calls): it reads mentions, questions,
 * accusations and reply chains from the message text, then lets personality
 * (extraversion, dominance) modulate the resulting urgency. Worlds consume it
 * during discussion phases; observers can read `state()` to watch the social
 * temperature of the room.
 */

export interface DiscussionMessage {
  senderId: string;
  text: string;
  replyTo?: string;
}

export interface DiscussionOptions {
  actorIds: string[];
  displayName(id: string): string;
  /** Personality signal per actor: how eager they are to hold the floor. */
  talkativeness?: (actorId: string) => number;
  /** How strongly this actor fights for the agenda / pushes back. */
  dominance?: (actorId: string) => number;
  /** How anxious this actor is under adversarial pressure. */
  sensitivity?: (actorId: string) => number;
  /** Maximum waves (one opening round + response rounds). Default 5. */
  maxWaves?: number;
  /** Hard cap on messages per actor per discussion. Default 3. */
  maxMessagesPerActor?: number;
  /** Total message budget for the discussion. Default 3×players + 6. */
  totalMessageBudget?: number;
  /** Urgency above which an actor gets a speaking slot. Default 1.4. */
  urgencyThreshold?: number;
  /** How many responders may speak in one response wave. Default 3. */
  waveSizeCap?: number;
  /** Urgency decay between waves. Default 0.6. */
  urgencyDecay?: number;
}

export interface DiscussionSnapshot {
  wave: number;
  open: boolean;
  messageCount: number;
  /** Per-actor urgency on a 0..1 scale (0 = nothing to say). */
  urgency: Record<string, number>;
  /** How many times each actor has already spoken. */
  spokeCounts: Record<string, number>;
}

const ACCUSATION_PATTERN =
  /怀疑|是狼|狼人|铁狼|出局|投你|投票|说谎|撒谎|骗|小丑|预言家|查杀|金水|带节奏|站队|装好人|伪/;

const QUESTION_HINT = /？|\?|吗|呢|吧|怎么|为什么|凭什么|谁/;

export class DiscussionDirector {
  readonly actorIds: string[];
  readonly maxWaves: number;
  readonly maxMessagesPerActor: number;
  readonly totalMessageBudget: number;
  readonly urgencyThreshold: number;
  readonly waveSizeCap: number;

  private readonly displayName: (id: string) => string;
  private readonly talkativeness: (actorId: string) => number;
  private readonly dominance: (actorId: string) => number;
  private readonly sensitivity: (actorId: string) => number;

  private readonly messages: DiscussionMessage[] = [];
  private readonly urgency = new Map<string, number>();
  private readonly spokeCounts = new Map<string, number>();
  private readonly maxUrgency = 6;
  private wave = 0;
  private messageCount = 0;

  /** Current wave number (1 = opening round). */
  get waveNumber(): number {
    return this.wave;
  }

  constructor(options: DiscussionOptions) {
    this.actorIds = [...options.actorIds];
    this.displayName = options.displayName;
    this.talkativeness = options.talkativeness ?? (() => 0.5);
    this.dominance = options.dominance ?? (() => 0.5);
    this.sensitivity = options.sensitivity ?? (() => 0.5);
    this.maxWaves = options.maxWaves ?? 5;
    this.maxMessagesPerActor = options.maxMessagesPerActor ?? 3;
    this.totalMessageBudget = options.totalMessageBudget ?? this.actorIds.length * 3 + 6;
    this.urgencyThreshold = options.urgencyThreshold ?? 1.4;
    this.waveSizeCap = options.waveSizeCap ?? 3;
  }

  /** Feed a public utterance; raises response pressure on those it concerns. */
  onMessage(message: DiscussionMessage): void {
    this.messages.push({ senderId: message.senderId, text: message.text, ...(message.replyTo ? { replyTo: message.replyTo } : {}) });
    this.messageCount += 1;
    const spoke = this.spokeCounts.get(message.senderId) ?? 0;
    this.spokeCounts.set(message.senderId, spoke + 1);

    const text = message.text;
    const replySender = message.replyTo
      ? this.messages.find((entry) => entry.replyTo === message.replyTo)?.senderId
      : undefined;
    for (const actorId of this.actorIds) {
      if (actorId === message.senderId) continue;
      let pressure = 0;
      const mentioned = text.includes(this.displayName(actorId)) || text.includes(actorId);
      if (mentioned) pressure += 2.4;
      if (replySender === actorId) pressure += 2.0;
      if (QUESTION_HINT.test(text)) pressure += mentioned ? 1.2 : 0.5;
      if (ACCUSATION_PATTERN.test(text)) pressure += mentioned ? 1.8 : 0.4;
      if (pressure > 0) {
        const base = this.urgency.get(actorId) ?? 0;
        this.urgency.set(actorId, Math.min(this.maxUrgency, base + pressure));
      }
    }
  }

  /**
   * Return the actors who should speak in the next wave. The first wave is the
   * opening round: everyone alive gets the floor once. Later waves only
   * activate those with real response pressure.
   */
  nextWave(): string[] {
    this.wave += 1;
    if (this.wave === 1) return [...this.actorIds];
    const candidates = this.actorIds
      .filter((actorId) => (this.urgency.get(actorId) ?? 0) >= this.urgencyThreshold)
      .filter((actorId) => (this.spokeCounts.get(actorId) ?? 0) < this.maxMessagesPerActor)
      .sort((left, right) => {
        const urgencyDiff = (this.urgency.get(right) ?? 0) - (this.urgency.get(left) ?? 0);
        if (urgencyDiff !== 0) return urgencyDiff;
        return (this.spokeCounts.get(left) ?? 0) - (this.spokeCounts.get(right) ?? 0);
      });
    return candidates.slice(0, this.waveSizeCap);
  }

  /**
   * End of the current wave: decay urgency, and let personalities keep a low
   * residual desire to speak (extraverts linger on the floor).
   */
  endWave(): void {
    for (const actorId of this.actorIds) {
      const residual = 0.25 + this.talkativeness(actorId) * 0.5;
      const next = ((this.urgency.get(actorId) ?? 0) + residual * 0.4) * 0.6;
      this.urgency.set(actorId, next > 0.25 ? next : 0);
    }
  }

  /**
   * Adversarial pressure raises the stakes for the sensitive: accusations
   * carry more weight for anxious actors, and dominant actors fight to answer.
   */
  urgencyFor(actorId: string): number {
    const raw = this.urgency.get(actorId) ?? 0;
    if (raw <= 0) return 0;
    const personality = 0.75 + this.talkativeness(actorId) * 0.45 + this.dominance(actorId) * 0.35 + this.sensitivity(actorId) * 0.25;
    return Math.min(this.maxUrgency, raw * personality);
  }

  /** Whether the discussion should end: budget, waves, or nobody cares. */
  done(): boolean {
    if (this.wave >= this.maxWaves) return true;
    if (this.messageCount >= this.totalMessageBudget) return true;
    if (this.wave >= 2) {
      const anyPressure = this.actorIds.some(
        (actorId) =>
          this.urgencyFor(actorId) >= this.urgencyThreshold &&
          (this.spokeCounts.get(actorId) ?? 0) < this.maxMessagesPerActor
      );
      if (!anyPressure) return true;
    }
    return false;
  }

  state(): DiscussionSnapshot {
    const urgency: Record<string, number> = {};
    const spokeCounts: Record<string, number> = {};
    for (const actorId of this.actorIds) {
      urgency[actorId] = Math.round(Math.min(1, this.urgencyFor(actorId) / this.maxUrgency) * 100) / 100;
      spokeCounts[actorId] = this.spokeCounts.get(actorId) ?? 0;
    }
    return {
      wave: this.wave,
      open: !this.done(),
      messageCount: this.messageCount,
      urgency,
      spokeCounts
    };
  }
}
