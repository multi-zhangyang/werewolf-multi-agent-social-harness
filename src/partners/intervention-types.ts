import { z } from "zod";
import type { Action, ActorId } from "./contracts";
import type { RunStatus } from "./api-types";
import type { Forecast } from "./mind";
import type { Distribution } from "./analysis";

export const interventionSpecSchema = z.object({
  sourceRunId: z.string().min(1).optional(), checkpointId: z.string().min(1).optional(), actorId: z.enum(["a", "b"]).default("a"),
  construct: z.enum(["willingness", "capability"]).default("willingness"),
  values: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).default([0.2, 0.8]),
  mechanisms: z.array(z.enum(["full", "record-only"])).min(1).max(2).default(["full", "record-only"]),
  repeats: z.number().int().min(1).max(5).default(3), horizon: z.enum(["decision", "game"]).default("decision"),
  seed: z.number().int().min(0).max(2147483647).default(1),
}).strict().refine(value => Boolean(value.sourceRunId) === Boolean(value.checkpointId), "原局和检查点需同时提供")
  .refine(value => value.values[0] < value.values[1], "两档数值按低到高排列且不能相同")
  .refine(value => new Set(value.mechanisms).size === value.mechanisms.length, "机制不能重复");
export type InterventionSpec = z.infer<typeof interventionSpecSchema>;
export type InterventionRowStatus = "pending" | "running" | "completed" | "failed" | "stopped";
export interface StoredInterventionRow {
  runId: string; value: number; mechanism: "full" | "record-only"; repeat: number;
  sourceRevision: number; manipulation: { path: string; before: number; after: number; previousMindVersion: number; mindVersion: number };
}
export interface StoredIntervention {
  id: string; createdAt: string; ownerHash: string; status: "paused" | "running" | "completed" | "stopped";
  spec: InterventionSpec; sourceRunId: string; checkpointId: string; sourceHash: string;
  rows: StoredInterventionRow[]; note: string;
}
export interface InterventionRow extends StoredInterventionRow {
  status: InterventionRowStatus; runStatus: RunStatus; error?: string; caseId?: string;
  action?: Action; decisionBelief: number | null; shadowBelief: number | null; shadowFailed: boolean;
  forecast?: Forecast; durationMs: number; retries: number; inputTokens: number; outputTokens: number;
  immediateWalletChange: number | null; payoff: number | null;
}
export interface InterventionView {
  id: string; createdAt: string; status: StoredIntervention["status"]; spec: InterventionSpec;
  sourceRunId: string; checkpointId: string; sourceHash: string; note: string;
  total: number; completed: number; failed: number; stopped: number; shadowFailures: number; rows: InterventionRow[];
}
export interface InterventionAnalysis {
  exploratory: true; actorId: ActorId; note: string;
  groups: { mechanism: "full" | "record-only"; value: number; total: number; completed: number; failed: number;
    actions: { action: string; count: number }[]; walletChange: Distribution; payoff: Distribution }[];
  paired: { mechanism: "full" | "record-only"; matched: number; missing: number;
    actionChanged: Distribution; walletDifference: Distribution; pairs: { repeat: number; lowRunId: string; highRunId: string; changed: boolean }[] }[];
}
