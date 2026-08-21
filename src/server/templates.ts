/**
 * Room roster templates (AGENTS.md §6.4): saved create-room configurations —
 * world, model picks, per-seat model/tuning overrides, character casting,
 * rounds and season mode. Persisted to data/room-templates.json (gitignored).
 * Templates hold configuration only: no secrets, no runtime state.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { requireGlobalOperator } from "./auth";
import type { ServerContext } from "./context";
import path from "node:path";
import express from "express";
import { z } from "zod";

const MAX_TEMPLATES = 50;

export function defaultTemplatePath(): string {
  return process.env.SOCIETY_TEMPLATES_FILE?.trim() || path.resolve("data", "room-templates.json");
}

const templateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  scenarioId: z.string().min(1).max(60),
  models: z.array(z.string().min(1).max(160)).min(1).max(16),
  modelProfileIds: z.array(z.string().min(1).max(120)).max(16).optional(),
  agentModelOverrides: z.record(z.string().min(1).max(4), z.string().min(1).max(120)).optional(),
  agentTuning: z.record(z.string().min(1).max(4), z.object({
    temperature: z.number().min(0).max(2).optional(),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional()
  }).strict()).optional(),
  players: z.number().int().positive().max(12).optional(),
  characterIds: z.array(z.string().min(1).max(120)).max(12).optional(),
  rounds: z.number().int().positive().max(20).optional(),
  mode: z.enum(["ai", "human"]).default("ai"),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
  season: z.enum(["season", "one-shot"]).default("season")
}).strict();

export type RosterTemplateInput = z.infer<typeof templateSchema>;

export interface RosterTemplate extends RosterTemplateInput {
  id: string;
  createdAt: string;
}

export class RosterTemplateStore {
  private templates: RosterTemplate[] = [];

  constructor(private readonly file = defaultTemplatePath()) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { templates?: RosterTemplate[] };
      this.templates = Array.isArray(parsed?.templates) ? parsed.templates.slice(0, MAX_TEMPLATES) : [];
    } catch {
      this.templates = [];
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ templates: this.templates }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  list(): RosterTemplate[] {
    return structuredClone(this.templates);
  }

  create(input: RosterTemplateInput): RosterTemplate {
    if (this.templates.length >= MAX_TEMPLATES) {
      throw new Error("TEMPLATE_LIMIT_REACHED: Delete a template before saving more.");
    }
    if (this.templates.some((template) => template.name === input.name)) {
      throw new Error(`TEMPLATE_NAME_TAKEN: A template named ${input.name} already exists.`);
    }
    const template: RosterTemplate = { id: `tpl-${randomUUID().slice(0, 8)}`, createdAt: new Date().toISOString(), ...input };
    this.templates.unshift(template);
    this.persist();
    return structuredClone(template);
  }

  remove(id: string): boolean {
    const before = this.templates.length;
    this.templates = this.templates.filter((template) => template.id !== id);
    const removed = this.templates.length < before;
    if (removed) this.persist();
    return removed;
  }
}

export function registerTemplateRoutes(app: express.Express, context: ServerContext): void {
  const store = context.templates;
  const gate = (request: express.Request, response: express.Response): boolean =>
    requireGlobalOperator(request, response, context.auth);

  app.get("/api/room-templates", (_request, response) => {
    response.json({ templates: store.list() });
  });

  app.post("/api/room-templates", (request, response) => {
    if (!gate(request, response)) return;
    response.status(201).json(store.create(templateSchema.parse(request.body)));
  });

  app.delete("/api/room-templates/:id", (request, response) => {
    if (!gate(request, response)) return;
    const removed = store.remove(request.params.id);
    if (!removed) {
      response.status(404).json({ error: "TEMPLATE_NOT_FOUND", message: "No such template." });
      return;
    }
    response.json({ removed: true, templates: store.list() });
  });
}
