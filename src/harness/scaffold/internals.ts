import type { EvidenceRef } from "../socialState";

export function numericScore(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function addScore(value: number | undefined, delta: number): number | undefined {
  if (delta === 0 && value === undefined) return undefined;
  return round3(numericScore(value) + delta);
}

export function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function uniqueEvidence(evidenceRefs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const unique: EvidenceRef[] = [];
  for (const ref of evidenceRefs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(cloneJson(ref));
  }
  return unique;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
