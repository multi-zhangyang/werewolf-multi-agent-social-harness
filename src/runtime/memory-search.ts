/** Literal, whitespace-separated keywords; user text is never an FTS operator. */
export function memoryQueryTerms(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/u).filter(Boolean))];
}

/** Rank only already-visible memories. A match never changes their evidence type. */
export function memoryMatchScore(text: string, terms: string[]): number {
  const normalized = text.toLowerCase();
  if (!terms.length) return 1;
  return terms.reduce((score, term) => score + Number(normalized.includes(term)), 0);
}
