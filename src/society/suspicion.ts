/**
 * Suspicion climate — the room's public opinion thermometer.
 *
 * Grounded in "perceived opinion climate" (Think-Before-Speak, arXiv:2606.03137):
 * participants do not just hold private doubts, they perceive how the group is
 * leaning. Every public accusation and every public vote is heard by everyone,
 * so the world can deterministically track who is under suspicion — no model
 * calls, no private information. The climate is injected into each agent's
 * observation ("who is being accused right now") and rendered for observers as
 * live suspicion bars.
 *
 * This is public knowledge by construction: everything here derives from
 * speech and votes that were already visible to all living participants.
 */

export interface SuspicionEntry {
  turn: number;
  /** Who raised the suspicion: a participant id, or a world source like "quest". */
  accuser: string;
  target: string;
  kind: "speech" | "vote" | "outcome";
}

export interface SuspicionSnapshot {
  /** Normalized 0..1 per participant (1 = most suspected in the room). */
  scores: Record<string, number>;
  entries: SuspicionEntry[];
}

export class SuspicionClimate {
  private readonly scores = new Map<string, number>();
  private readonly entries: SuspicionEntry[] = [];
  private maxScore = 0;

  /** A public accusation: the target's stock jumps. */
  noteAccusation(turn: number, accuser: string, target: string): void {
    this.bump(target, 0.22, turn, accuser, "speech");
  }

  /** A public vote: votes carry more weight than words. */
  noteVote(turn: number, voter: string, target: string): void {
    this.bump(target, 0.14, turn, voter, "vote");
  }

  /** A quest or mission outcome implicates its participants. */
  noteOutcome(turn: number, source: string, target: string): void {
    this.bump(target, 0.3, turn, source, "outcome");
  }

  /** The target was eliminated / vindicated: their score is settled and cleared. */
  noteResolved(turn: number, target: string): void {
    this.scores.delete(target);
    this.entries.push({ turn, accuser: "world", target, kind: "outcome" });
    this.trim();
  }

  /** Time passes, grudges cool: decay every open score. */
  decay(factor: number): void {
    for (const [target, score] of this.scores) {
      const next = score * factor;
      if (next < 0.02) this.scores.delete(target);
      else this.scores.set(target, next);
    }
  }

  normalized(): Record<string, number> {
    const max = Math.max(this.maxScore, 0.001);
    return Object.fromEntries(
      [...this.scores].map(([target, score]) => [target, Math.round(Math.min(1, score / max) * 100) / 100])
    );
  }

  entryList(): SuspicionEntry[] {
    return this.entries.slice(-40);
  }

  snapshot(): SuspicionSnapshot {
    return { scores: this.normalized(), entries: this.entryList() };
  }

  /** In-memory state handoff: the climate's full working state as plain data. */
  exportState(): { scores: Array<[string, number]>; entries: SuspicionEntry[]; maxScore: number } {
    return {
      scores: [...this.scores.entries()],
      entries: structuredClone(this.entries.slice(-120)),
      maxScore: this.maxScore
    };
  }

  restoreState(state: unknown): void {
    const value = state as Partial<ReturnType<SuspicionClimate["exportState"]>> | undefined;
    if (!value) return;
    this.scores.clear();
    for (const [target, score] of value.scores ?? []) this.scores.set(target, score);
    this.entries.length = 0;
    this.entries.push(...structuredClone(value.entries ?? []));
    this.maxScore = value.maxScore ?? 0;
  }

  /** Human-readable climate line for observations, e.g. "陈策 ██████ · 唐妍 ██". */
  climateText(displayName: (id: string) => string): string {
    const ranked = [...this.scores].sort((left, right) => right[1] - left[1]).slice(0, 3);
    if (!ranked.length) return "No one is under suspicion right now.";
    return ranked
      .map(([target, score]) => `${displayName(target)} ${"█".repeat(Math.max(1, Math.round(score / this.maxScore * 6)))}`)
      .join(" · ");
  }

  private bump(target: string, amount: number, turn: number, accuser: string, kind: SuspicionEntry["kind"]): void {
    const next = (this.scores.get(target) ?? 0) + amount;
    this.scores.set(target, next);
    if (next > this.maxScore) this.maxScore = next;
    this.entries.push({ turn, accuser, target, kind });
    this.trim();
  }

  private trim(): void {
    if (this.entries.length > 120) this.entries.splice(0, this.entries.length - 120);
  }
}
