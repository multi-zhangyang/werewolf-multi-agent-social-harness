import type { PadState } from "./contracts";
import { padDistance } from "./affect";

import { randomUUID } from "node:crypto";
import type { AgentMemoryItem, AgentMemoryStore } from "./contracts";

export class AssociativeMemory implements AgentMemoryStore {
  private readonly entries: AgentMemoryItem[];

  constructor(initial: AgentMemoryItem[] = []) {
    this.entries = structuredClone(initial);
  }

  async remember(input: Omit<AgentMemoryItem, "id" | "createdAt">): Promise<AgentMemoryItem> {
    const entry: AgentMemoryItem = {
      ...input,
      id: randomUUID(),
      text: input.text.trim(),
      tags: [...input.tags],
      createdAt: new Date().toISOString()
    };
    this.entries.push(entry);
    if (this.entries.length > 320) {
      this.entries.sort((left, right) => memoryValue(right) - memoryValue(left));
      this.entries.splice(260);
    }
    return structuredClone(entry);
  }

  async recall(query: string, limit = 8, moodPad?: PadState, recencyBoost = 1): Promise<AgentMemoryItem[]> {
    const terms = tokens(query);
    return this.entries
      .map((entry) => ({ entry, score: recallScore(entry, terms, moodPad, recencyBoost) }))
      .sort((left, right) => right.score - left.score || right.entry.turn - left.entry.turn)
      .slice(0, Math.max(1, Math.min(limit, 16)))
      .map(({ entry }) => structuredClone(entry));
  }

  async list(limit = 48): Promise<AgentMemoryItem[]> {
    return this.entries
      .slice()
      .sort((left, right) => right.turn - left.turn || right.salience - left.salience)
      .slice(0, Math.max(1, limit))
      .map((entry) => structuredClone(entry));
  }
}

/**
 * @param recencyBoost  Multiplier on the recency term. Characters living with
 *                      the recency-weighting bias (§4.2.7) recall recent
 *                      events with extra weight, letting them crowd out older
 *                      patterns the way they would for such a person.
 */
function recallScore(entry: AgentMemoryItem, terms: string[], moodPad?: PadState, recencyBoost = 1): number {
  const text = `${entry.text} ${entry.tags.join(" ")}`.toLocaleLowerCase();
  const relevance = terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
  const recency = 1 / (1 + Math.max(0, Date.now() - Date.parse(entry.createdAt)) / 3_600_000);
  // Mood-congruent recall (Bower-style state-dependent memory): memories stored
  // in an emotional state similar to the current one resurface more easily.
  const congruence = moodPad && entry.pad ? Math.max(0, 1 - padDistance(moodPad, entry.pad) / 3) : 0;
  return relevance * 2.2 + entry.salience * 1.4 + Math.abs(entry.valence) * 0.35 + recency * 0.45 * recencyBoost + congruence * 0.5;
}

function memoryValue(entry: AgentMemoryItem): number {
  return entry.salience * 2 + Math.abs(entry.valence) + entry.turn / 100;
}

function tokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1))];
}
