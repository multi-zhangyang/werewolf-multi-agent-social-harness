import { activeMemories, type AgentMind, type CognitiveMemory } from "./cognition";
import type { DecisionStructure } from "./decision-analysis";

const segmenter = new Intl.Segmenter("und", { granularity: "word" });
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
function words(value: string) {
  return [...segmenter.segment(normalize(value))].filter(segment => segment.isWordLike).map(segment => segment.segment);
}

/** Lexical retrieval with Unicode word segmentation and inverse document frequency. No facts are invented. */
export function rankRecall<T>(items: readonly T[], query: string, text: (item: T) => string, limit = 8): T[] {
  const terms = [...new Set(words(query))];
  if (!terms.length || limit <= 0) return [];
  const documents = items.map((item, index) => {
    const body = normalize(text(item)); const tokens = words(body);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { item, index, body, length: tokens.length, counts };
  });
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, documents.length);
  const inverseFrequency = new Map(terms.map(term => {
    const matches = documents.filter(doc => (doc.counts.get(term) ?? 0) > 0).length;
    return [term, Math.log(1 + (documents.length - matches + .5) / (matches + .5))];
  }));
  const phrase = normalize(query).trim();
  return documents.map(doc => ({ ...doc, score: terms.reduce((sum, term) => {
    const count = doc.counts.get(term) ?? 0;
    return sum + inverseFrequency.get(term)! * count * 2.2 / (count + 1.2 * (.25 + .75 * doc.length / Math.max(1, averageLength)));
  }, doc.body.includes(phrase) ? 2 : 0) })).filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index).slice(0, limit).map(doc => doc.item);
}

const memoryText = (memory: CognitiveMemory) => [memory.text, memory.when, memory.then, ...memory.tags].filter(Boolean).join(" ");
function rankMemories(mind: AgentMind, items: CognitiveMemory[], query: string, limit: number, structure?: DecisionStructure) {
  const lexical = rankRecall(items, query, memoryText, items.length);
  if (!structure) return lexical.slice(0, limit);
  // Source conditions improve retrieval, not the rule's truth or applicability.
  const sources = new Map<string, DecisionStructure[]>();
  for (const memory of activeMemories(mind)) {
    if (memory.origin !== "ledger" || !memory.observation?.decisionStructures) continue;
    sources.set(memory.observation.sourceId, memory.observation.decisionStructures);
  }
  return items.map((memory, index) => {
    const contexts = memory.sourceIds.flatMap(id => sources.get(id) ?? []);
    const matches = Math.max(0, ...contexts.map(context => Object.entries(structure).filter(([key, value]) => key !== "horizon" && context[key as keyof DecisionStructure] === value).length));
    const position = lexical.indexOf(memory);
    return { memory, index, score: (matches >= 2 ? matches : 0) + (position < 0 ? 0 : 2 / (position + 1)) };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.index - a.index).slice(0, limit).map(item => item.memory);
}
export function recallCognitiveMemories(mind: AgentMind, query: string, limit = 8, structure?: DecisionStructure) {
  return rankMemories(mind, activeMemories(mind), query, limit, structure);
}
/** Keep conditional strategies available for applicability checks, alongside related and recent experience. */
export function selectWorkingMemories(mind: AgentMind, query: string, limit = 16, structure?: DecisionStructure) {
  const count = Math.max(0, Math.floor(limit)); if (!count) return [];
  const active = activeMemories(mind);
  const portable = active.filter(memory => memory.kind === "procedural" && memory.scope === "transferable");
  const strategyCount = Math.min(portable.length, Math.max(1, Math.floor(count / 4)));
  const candidates = [...new Map([...rankMemories(mind, portable, query, strategyCount, structure), ...portable.slice(-strategyCount).reverse()]
    .map(memory => [memory.id, memory])).values()].slice(0, strategyCount);
  const relevant = rankMemories(mind, active, query, Math.ceil(count * .75), structure);
  const recent = active.slice(-Math.max(1, Math.floor(count / 4))).reverse();
  const relatedBudget = Math.max(0, count - candidates.length - recent.length);
  return [...new Map([...candidates, ...relevant.slice(0, relatedBudget), ...recent, ...relevant, ...active.slice(-count).reverse()]
    .map(memory => [memory.id, memory])).values()].slice(0, count);
}
