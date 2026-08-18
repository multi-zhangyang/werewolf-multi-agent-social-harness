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
 *
 * Persistence: dossiers are written atomically (temp file + rename) to
 * `SOCIETY_SEASON_FILE` (default `data/season.json`, gitignored) on every
 * save and clear, so the season survives server restarts. `clear()` starts a
 * brand-new season — a fresh community with no shared history.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CharacterDossier, SeasonStore } from "./contracts";

interface SeasonFile {
  version: 1;
  updatedAt: string;
  dossiers: Record<string, CharacterDossier>;
}

export function defaultSeasonPath(): string {
  return process.env.SOCIETY_SEASON_FILE?.trim()
    || path.resolve(process.cwd(), "data", "season.json");
}

export class FileSeasonStore implements SeasonStore {
  private readonly filePath: string;
  private readonly dossiers = new Map<string, CharacterDossier>();

  constructor(filePath = defaultSeasonPath()) {
    this.filePath = filePath;
    this.load();
  }

  get(characterKey: string): CharacterDossier | undefined {
    const dossier = this.dossiers.get(characterKey);
    return dossier ? structuredClone(dossier) : undefined;
  }

  save(dossier: CharacterDossier): void {
    this.dossiers.set(dossier.characterKey, structuredClone(dossier));
    this.persist();
  }

  list(): CharacterDossier[] {
    return [...this.dossiers.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((dossier) => structuredClone(dossier));
  }

  /** Start a fresh season: forget every cross-game memory at once. */
  clear(): void {
    this.dossiers.clear();
    this.persist();
  }

  /** Forget one character's history; the rest of the table keeps theirs. */
  remove(characterKey: string): boolean {
    const existed = this.dossiers.delete(characterKey);
    if (existed) this.persist();
    return existed;
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return; // No history yet — a brand-new season.
    }
    try {
      const parsed = JSON.parse(raw) as SeasonFile;
      if (!parsed || parsed.version !== 1 || typeof parsed.dossiers !== "object" || parsed.dossiers === null) {
        throw new Error("SEASON_FILE_SCHEMA_INVALID");
      }
      for (const [key, dossier] of Object.entries(parsed.dossiers)) {
        if (dossier && typeof dossier === "object" && typeof dossier.characterKey === "string") {
          this.dossiers.set(key, structuredClone(dossier));
        }
      }
    } catch {
      // A corrupted season file must never sink the server: quarantine it and
      // start clean rather than crashing on boot.
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        // Best effort; the in-memory store simply starts empty.
      }
    }
  }

  private persist(): void {
    const payload: SeasonFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      dossiers: Object.fromEntries(this.dossiers)
    };
    const tmp = `${this.filePath}.tmp`;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }
}

/** How many season games a character has played. */
export function seasonGameCount(dossier: CharacterDossier | undefined): number {
  return dossier?.games.length ?? 0;
}