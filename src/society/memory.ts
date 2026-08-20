import type { PadState } from "./contracts";
import { padDistance } from "./affect";

import { randomUUID } from "node:crypto";
import type { AgentMemoryItem, AgentMemoryStore, MemoryLink } from "./contracts";

export class AssociativeMemory implements AgentMemoryStore {
  private readonly entries: AgentMemoryItem[];

  constructor(initial: AgentMemoryItem[] = []) {
    this.entries = structuredClone(initial);
  }

  async remember(input: Omit<AgentMemoryItem, "id" | "createdAt" | "links">): Promise<AgentMemoryItem> {
    const idempotencySource = input.sourceRefs?.find((sourceId) => sourceId.startsWith("memory-suggestion-"));
    if (idempotencySource) {
      const existing = this.entries.find((entry) => entry.sourceRefs?.includes(idempotencySource));
      if (existing) return structuredClone(existing);
    }
    const entry: AgentMemoryItem = {
      ...input,
      id: randomUUID(),
      text: input.text.trim(),
      tags: [...input.tags],
      ...(input.sourceRefs ? { sourceRefs: [...new Set(input.sourceRefs)] } : {}),
      links: [],
      createdAt: new Date().toISOString()
    };
    this.entries.push(entry);
    // Deterministic link building (§5.4.7): find related older memories by
    // shared thematic tags (people, promises, deceits) and valence direction.
    this.autoLink(entry);
    if (this.entries.length > 320) {
      this.entries.sort((left, right) => memoryValue(right) - memoryValue(left));
      this.entries.splice(260);
    }
    return structuredClone(entry);
  }

  async link(fromMemoryId: string, toMemoryId: string, kind: MemoryLink["kind"]): Promise<void> {
    const from = this.entries.find((entry) => entry.id === fromMemoryId);
    const to = this.entries.find((entry) => entry.id === toMemoryId);
    if (!from || !to || fromMemoryId === toMemoryId) return;
    const now = new Date().toISOString();
    from.links = from.links ?? [];
    const existing = from.links.find((link) => link.toMemoryId === toMemoryId && link.kind === kind);
    if (existing) {
      existing.weight = Math.min(1, existing.weight + 0.15);
      existing.lastReinforcedAt = now;
      return;
    }
    from.links.push({ toMemoryId, kind, weight: 0.5, lastReinforcedAt: now });
  }

  /** Shared thematic tags, ignoring bookkeeping tags like `turn:N`. */
  private sharedThemes(entry: AgentMemoryItem, other: AgentMemoryItem): string[] {
    const meaningful = (tag: string): boolean => !/^turn:/.test(tag) && tag.length > 0;
    const mine = new Set(entry.tags.filter(meaningful));
    return other.tags.filter((tag) => mine.has(tag));
  }

  private autoLink(entry: AgentMemoryItem): void {
    if (this.entries.length < 2) return;
    const peers = this.entries.slice(0, -1);
    for (const peer of peers) {
      const shared = this.sharedThemes(entry, peer);
      if (!shared.length) continue;
      if (peer.links?.some((link) => link.toMemoryId === entry.id)) {
        // The peer already points here (re-enforced on re-consolidation).
        this.link(entry.id, peer.id, entry.links?.some((link) => link.toMemoryId === peer.id) ? entry.links.find((link) => link.toMemoryId === peer.id)!.kind : "similar-situation");
        continue;
      }
      let kind: MemoryLink["kind"] = "similar-situation";
      if (shared.some((tag) => /承诺|promise|答应|约定/.test(tag))) kind = "promise-chain";
      else if (shared.some((tag) => /骗|谎言|欺骗|decei/.test(tag))) kind = "deception-chain";
      else if (Math.sign(entry.valence) === -Math.sign(peer.valence) && entry.valence !== 0 && peer.valence !== 0) kind = "contradicts";
      else if (entry.valence !== 0 && peer.valence !== 0) kind = "supports";
      this.link(entry.id, peer.id, kind);
    }
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
  // Linked memories surface together (§5.4.7 / PsychoAgent conflict salience):
  // a memory with active links is part of a living web, not a stray note.
  const linkBonus = (entry.links?.length ?? 0) > 0 ? Math.min(0.5, (entry.links?.length ?? 0) * 0.12) : 0;
  return relevance * 2.2 + entry.salience * 1.4 + Math.abs(entry.valence) * 0.35 + recency * 0.45 * recencyBoost + congruence * 0.5 + linkBonus;
}

function memoryValue(entry: AgentMemoryItem): number {
  return entry.salience * 2 + Math.abs(entry.valence) + entry.turn / 100;
}

function tokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1))];
}
