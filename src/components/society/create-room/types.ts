/** Shared types for the create-room dialog and its section components. */
import type { CharacterOption } from "../types";

/** How models are assigned to seats (§ 建房模型分配). */
export type ModelAssignMode = "unified" | "per-seat" | "random";

/** Lightweight create-form preferences remembered across visits. */
export interface ModelAssignPrefs {
  mode?: ModelAssignMode;
  unifiedProfileId?: string;
  randomPoolIds?: string[];
}

export const MODEL_PREFS_KEY = "society:model-assign-prefs";

/** A saved create-room configuration (§6.4 阵容模板). */
export interface RosterTemplateOption {
  id: string;
  name: string;
  scenarioId: string;
  models: string[];
  modelProfileIds?: string[];
  agentModelOverrides?: Record<string, string>;
  agentTuning?: Record<string, { temperature?: number; reasoningEffort?: "low" | "medium" | "high" | "xhigh" }>;
  players?: number;
  characterIds?: string[];
  rounds?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  season?: "season" | "one-shot";
}

/** One row of the seat table shown in the final-roster preview. */
export interface RosterPreviewRow {
  index: number;
  characterLabel: string;
  modelLabel: string;
}

export type { CharacterOption };
