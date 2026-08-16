/**
 * Society Season — the same characters living across games.
 *
 * One game ends, the community does not. After every room finishes, each
 * character's private mind is distilled into a dossier (roles played, who they
 * trust and resent, their strongest memories, the reputation they carried) and
 * stored by character key. When a new room starts with the same characters,
 * their dossiers are loaded back into the fresh minds: relationships start
 * where they left off, and the strongest memories surface again — a betrayal
 * in one game changes who gets trusted with the team in the next.
 *
 * Memories are carried with their game context (role, scenario) so characters
 * can tell "he plays wolves well" from "he is untrustworthy".
 */

import type { CharacterDossier, SeasonStore } from "./contracts";

export class InMemorySeasonStore implements SeasonStore {
  private readonly dossiers = new Map<string, CharacterDossier>();

  get(characterKey: string): CharacterDossier | undefined {
    const dossier = this.dossiers.get(characterKey);
    return dossier ? structuredClone(dossier) : undefined;
  }

  save(dossier: CharacterDossier): void {
    this.dossiers.set(dossier.characterKey, structuredClone(dossier));
  }

  list(): CharacterDossier[] {
    return [...this.dossiers.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((dossier) => structuredClone(dossier));
  }
}

/** How many season games a character has played. */
export function seasonGameCount(dossier: CharacterDossier | undefined): number {
  return dossier?.games.length ?? 0;
}
