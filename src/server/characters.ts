/**
 * Local character library (AGENTS.md §7.2): built-in characters plus
 * user-defined ones persisted to data/characters.json (gitignored). A
 * character here is a person — persona, values, biases, voice, formative
 * memories. Roles, models and controllers stay separate concerns and never
 * enter this store.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import { z } from "zod";
import type { CharacterDefinition } from "../society/contracts";
import { builtinCharacter, builtinCharacters } from "../society/profiles";
import { requireGlobalOperator } from "./auth";
import type { ServerContext } from "./context";

const MAX_CUSTOM_CHARACTERS = 100;
const MAX_ANCHORS = 12;

export function defaultCharacterLibraryPath(): string {
  return process.env.SOCIETY_CHARACTERS_FILE?.trim() || path.resolve("data/characters.json");
}

const temperamentSchema = z.object({
  openness: z.number().min(0).max(1),
  conscientiousness: z.number().min(0).max(1),
  extraversion: z.number().min(0).max(1),
  agreeableness: z.number().min(0).max(1),
  neuroticism: z.number().min(0).max(1)
}).strict();

const characterInputSchema = z.object({
  displayName: z.string().trim().min(1).max(24),
  persona: z.string().trim().min(4).max(400),
  traits: z.array(z.string().trim().min(1).max(12)).min(1).max(8),
  values: z.array(z.string().trim().min(1).max(16)).min(1).max(6),
  goals: z.array(z.string().trim().min(2).max(80)).min(1).max(5),
  temperament: temperamentSchema.optional(),
  decisionBiases: z.array(z.enum([
    "confirmation", "loss-aversion", "sunk-cost", "in-group", "authority-sensitivity",
    "betrayal-hypervigilance", "overconfident-lie-detection", "self-consistency", "recency-weighting"
  ])).max(3).optional(),
  voice: z.string().trim().max(240).optional(),
  regulation: z.enum(["reappraise", "suppress", "ruminate", "act-out", "repair"]).optional(),
  autobiographicalAnchors: z.array(z.string().trim().min(4).max(120)).max(MAX_ANCHORS).optional()
}).strict();

export type CharacterInput = z.infer<typeof characterInputSchema>;

const importSchema = z.object({
  characters: z.array(characterInputSchema).min(1).max(50)
}).strict();

export class CharacterLibrary {
  private readonly file: string;
  private customs: CharacterDefinition[] = [];

  constructor(file = defaultCharacterLibraryPath()) {
    this.file = file;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { characters?: CharacterDefinition[] };
      const characters = Array.isArray(raw?.characters) ? raw.characters : [];
      this.customs = characters
        .filter((entry) => entry && typeof entry.id === "string" && !entry.builtIn)
        .slice(0, MAX_CUSTOM_CHARACTERS);
    } catch (error) {
      console.warn("[society] character library unreadable; starting empty:", error instanceof Error ? error.message : error);
      this.customs = [];
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temp, JSON.stringify({ characters: this.customs }, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  list(): { builtins: CharacterDefinition[]; customs: CharacterDefinition[] } {
    return { builtins: builtinCharacters(), customs: structuredClone(this.customs) };
  }

  /**
   * All character ids registered under a display name — used by the season
   * migration to resolve legacy display-name keys to stable character ids.
   * Duplicates are legal (same-name characters coexist), so callers must
   * treat an ambiguous match as unresolvable.
   */
  idsForDisplayName(displayName: string): string[] {
    const ids: string[] = [];
    for (const character of builtinCharacters()) {
      if (character.displayName === displayName) ids.push(character.id);
    }
    for (const character of this.customs) {
      if (character.displayName === displayName) ids.push(character.id);
    }
    return [...new Set(ids)];
  }

  resolve(id: string): CharacterDefinition | undefined {
    if (!id) return undefined;
    const builtin = builtinCharacter(id);
    if (builtin) return builtin;
    const custom = this.customs.find((entry) => entry.id === id);
    return custom ? structuredClone(custom) : undefined;
  }

  create(input: CharacterInput): CharacterDefinition {
    if (this.customs.length >= MAX_CUSTOM_CHARACTERS) {
      throw new Error("CHARACTER_LIBRARY_FULL: Delete a custom character before adding more.");
    }
    if (this.customs.some((entry) => entry.displayName === input.displayName)) {
      throw new Error(`CHARACTER_NAME_TAKEN: A character named ${input.displayName} already exists.`);
    }
    const character: CharacterDefinition = {
      id: `char-${randomUUID().slice(0, 8)}`,
      ...input,
      builtIn: false
    };
    this.customs.push(character);
    this.persist();
    return structuredClone(character);
  }

  update(id: string, input: CharacterInput): CharacterDefinition {
    const index = this.customs.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("CHARACTER_NOT_FOUND: Only custom characters can be edited.");
    if (this.customs.some((entry) => entry.id !== id && entry.displayName === input.displayName)) {
      throw new Error(`CHARACTER_NAME_TAKEN: A character named ${input.displayName} already exists.`);
    }
    this.customs[index] = { id, ...input, builtIn: false };
    this.persist();
    return structuredClone(this.customs[index]);
  }

  remove(id: string): void {
    const index = this.customs.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("CHARACTER_NOT_FOUND: Only custom characters can be deleted.");
    this.customs.splice(index, 1);
    this.persist();
  }

  copy(id: string): CharacterDefinition {
    const source = this.resolve(id);
    if (!source) throw new Error("CHARACTER_NOT_FOUND: Unknown character to copy.");
    const copyName = uniqueName(source.displayName, this.customs.map((entry) => entry.displayName));
    return this.create({
      displayName: copyName,
      persona: source.persona,
      traits: [...source.traits],
      values: [...source.values],
      goals: [...source.goals],
      ...(source.temperament ? { temperament: { ...source.temperament } } : {}),
      ...(source.decisionBiases ? { decisionBiases: [...source.decisionBiases] } : {}),
      ...(source.voice ? { voice: source.voice } : {}),
      ...(source.regulation ? { regulation: source.regulation } : {}),
      ...(source.autobiographicalAnchors ? { autobiographicalAnchors: [...source.autobiographicalAnchors] } : {})
    });
  }

  /** Builds the seat roster for one room: explicit picks first, then built-ins. */
  roster(characterIds: string[] | undefined, seatCount: number): CharacterDefinition[] {
    const picks = (characterIds ?? []).slice(0, seatCount);
    const resolved = picks.map((id) => this.resolve(id));
    const missing = picks.find((id, index) => !resolved[index]);
    if (missing) throw new Error(`CHARACTER_NOT_FOUND: '${missing}' is not a known character.`);
    const taken = new Set(picks);
    const fallback = builtinCharacters().filter((entry) => !taken.has(entry.id));
    return [...(resolved as CharacterDefinition[]), ...fallback].slice(0, seatCount);
  }
}

export function registerCharacterRoutes(app: express.Express, context: ServerContext): void {
  const library = context.characters;
  const gate = (request: express.Request, response: express.Response): boolean =>
    requireGlobalOperator(request, response, context.auth);

  app.get("/api/characters", (_request, response) => {
    response.json(library.list());
  });

  app.post("/api/characters", (request, response) => {
    if (!gate(request, response)) return;
    response.status(201).json(library.create(characterInputSchema.parse(request.body)));
  });

  app.put("/api/characters/:id", (request, response) => {
    if (!gate(request, response)) return;
    response.json(library.update(request.params.id, characterInputSchema.parse(request.body)));
  });

  app.delete("/api/characters/:id", (request, response) => {
    if (!gate(request, response)) return;
    library.remove(request.params.id);
    response.json({ deleted: true });
  });

  app.post("/api/characters/:id/copy", (request, response) => {
    if (!gate(request, response)) return;
    response.status(201).json(library.copy(request.params.id));
  });

  app.get("/api/characters/export", (_request, response) => {
    const { customs } = library.list();
    const payload = JSON.stringify({ characters: customs }, null, 2);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="society-characters-${new Date().toISOString().slice(0, 10)}.json"`);
    response.send(payload);
  });

  app.post("/api/characters/import", (request, response) => {
    if (!gate(request, response)) return;
    const { characters } = importSchema.parse(request.body);
    const added: CharacterDefinition[] = [];
    for (const input of characters) {
      if (library.list().customs.some((entry) => entry.displayName === input.displayName)) continue;
      if (library.list().customs.length >= MAX_CUSTOM_CHARACTERS) break;
      added.push(library.create(input));
    }
    response.status(201).json({ added: added.length, characters: added });
  });
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let index = 2;
  while (taken.includes(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}
