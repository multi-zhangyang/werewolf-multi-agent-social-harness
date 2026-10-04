import { activeMemories, type AgentMind, type CognitiveMemory } from "./cognition";

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
export function recallCognitiveMemories(mind: AgentMind, query: string, limit = 8) {
  return rankRecall(activeMemories(mind), query, memoryText, limit);
}
/** Keep conditional strategies available for applicability checks, alongside related and recent experience. */
export function selectWorkingMemories(mind: AgentMind, query: string, limit = 16) {
  const count = Math.max(0, Math.floor(limit)); if (!count) return [];
  const active = activeMemories(mind);
  const portable = active.filter(memory => memory.kind === "procedural" && memory.scope === "transferable");
  const strategyCount = Math.min(portable.length, Math.max(1, Math.floor(count / 4)));
  const candidates = [...new Map([...rankRecall(portable, query, memoryText, strategyCount), ...portable.slice(-strategyCount).reverse()]
    .map(memory => [memory.id, memory])).values()].slice(0, strategyCount);
  const relevant = rankRecall(active, query, memoryText, Math.ceil(count * .75));
  const recent = active.slice(-Math.max(1, Math.floor(count / 4))).reverse();
  const relatedBudget = Math.max(0, count - candidates.length - recent.length);
  return [...new Map([...candidates, ...relevant.slice(0, relatedBudget), ...recent, ...relevant, ...active.slice(-count).reverse()]
    .map(memory => [memory.id, memory])).values()].slice(0, count);
}
