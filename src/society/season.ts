/**
 * Society Season — the same characters living across games.
 *
 * One game ends, the community does not. After every room finishes, each
 * character's private mind is distilled into a dossier (roles played, who they
 * trust and resent, their strongest memories, the reputation they carried) and
 * stored by STABLE CHARACTER ID (AGENTS.md §10.2) — never by display name or
 * seat. When a new room starts with the same characters, their dossiers are
 * loaded back into the fresh minds: relationships start where they left off,
 * and the strongest memories surface again — a betrayal in one game changes
 * who gets trusted with the team in the next.
 *
 * Memories are carried with their game context (role, scenario) so characters
 * can tell "he plays wolves well" from "he is untrustworthy".
 *
 * Persistence: dossiers are written atomically (temp file + rename) to
 * `SOCIETY_SEASON_FILE` (default `data/season.json`, gitignored) on every
 * save and clear, so the season survives server restarts. `clear()` starts a
 * brand-new season — a fresh community with no shared history.
 *
 * Migration: v1 files keyed dossiers by display name. On load they are
 * migrated to character ids via a resolver the server injects: a legacy key
 * that resolves to exactly one character id is adopted; zero or multiple
 * matches are NOT merged (that would fabricate history) — they are preserved
 * in the original file (backed up) and reported through `listIsolated()`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CharacterDossier, CharacterId, SeasonStore } from "./contracts";

export const SEASON_SCHEMA_VERSION = 2;

/** A v1 entry whose display-name key could not be mapped to one character. */
export interface IsolatedSeasonEntry {
  legacyKey: string;
  reason: "ambiguous" | "unknown";
  candidateIds: string[];
  at: string;
}

interface SeasonFileV1 {
  version: 1;
  updatedAt: string;
  dossiers: Record<string, CharacterDossier & { characterKey: string }>;
}

interface SeasonFile {
  version: 2;
  updatedAt: string;
  dossiers: Record<string, CharacterDossier>;
  isolated?: IsolatedSeasonEntry[];
}

export function defaultSeasonPath(): string {
  return process.env.SOCIETY_SEASON_FILE?.trim()
    || path.resolve(process.cwd(), "data", "season.json");
}

export class FileSeasonStore implements SeasonStore {
  private readonly filePath: string;
  private readonly dossiers = new Map<CharacterId, CharacterDossier>();
  private readonly isolated: IsolatedSeasonEntry[] = [];
  private readonly resolveCharacterIds: (displayName: string) => string[];

  constructor(filePath = defaultSeasonPath(), resolveCharacterIds: (displayName: string) => string[] = () => []) {
    this.filePath = filePath;
    this.resolveCharacterIds = resolveCharacterIds;
    this.load();
  }

  get(characterId: CharacterId): CharacterDossier | undefined {
    const dossier = this.dossiers.get(characterId);
    return dossier ? structuredClone(dossier) : undefined;
  }

  save(dossier: CharacterDossier): void {
    this.dossiers.set(dossier.characterId, structuredClone(dossier));
    this.persist();
  }

  list(): CharacterDossier[] {
    return [...this.dossiers.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((dossier) => structuredClone(dossier));
  }

  /** v1 entries that could not be migrated to a unique character id. */
  listIsolated(): IsolatedSeasonEntry[] {
    return structuredClone(this.isolated);
  }

  /** Start a fresh season: forget every cross-game memory at once. */
  clear(): void {
    this.dossiers.clear();
    this.isolated.length = 0;
    this.persist();
  }

  /** Forget one character's history; the rest of the table keeps theirs. */
  remove(characterId: CharacterId): boolean {
    const existed = this.dossiers.delete(characterId);
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
      const parsed = JSON.parse(raw) as SeasonFile | SeasonFileV1;
      if (parsed && typeof parsed === "object" && typeof parsed.dossiers === "object" && parsed.dossiers !== null) {
        if (parsed.version === SEASON_SCHEMA_VERSION) {
          this.loadV2(parsed as SeasonFile);
          return;
        }
        if (parsed.version === 1) {
          this.migrateV1(parsed as SeasonFileV1);
          return;
        }
      }
      throw new Error("SEASON_FILE_SCHEMA_INVALID");
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

  private loadV2(file: SeasonFile): void {
    for (const [characterId, dossier] of Object.entries(file.dossiers)) {
      if (dossier && typeof dossier === "object" && typeof dossier.characterId === "string") {
        this.dossiers.set(characterId, structuredClone(dossier));
      }
    }
    for (const entry of file.isolated ?? []) {
      if (entry && typeof entry.legacyKey === "string") this.isolated.push(structuredClone(entry));
    }
  }

  /**
   * v1 → v2: display-name keys become stable character ids. Only a UNIQUE
   * name match is adopted; ambiguous or unknown names are isolated (reported,
   * never merged) so no character inherits another's history by accident.
   */
  private migrateV1(file: SeasonFileV1): void {
    const at = new Date().toISOString();
    for (const [legacyKey, dossier] of Object.entries(file.dossiers)) {
      const candidateIds = this.resolveCharacterIds(legacyKey);
      if (candidateIds.length === 1) {
        this.dossiers.set(candidateIds[0], {
          ...structuredClone(dossier),
          characterId: candidateIds[0],
          displayName: legacyKey
        });
      } else {
        this.isolated.push({
          legacyKey,
          reason: candidateIds.length === 0 ? "unknown" : "ambiguous",
          candidateIds,
          at
        });
      }
    }
    // Preserve the pre-migration file once, then persist the migrated shape so
    // the migration runs exactly once.
    try {
      renameSync(this.filePath, `${this.filePath}.v1-backup-${Date.now()}`);
    } catch {
      // Best effort — the migrated v2 file is still written below.
    }
    this.persist();
  }

  private persist(): void {
    const payload: SeasonFile = {
      version: SEASON_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      dossiers: Object.fromEntries(this.dossiers),
      ...(this.isolated.length ? { isolated: structuredClone(this.isolated) } : {})
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