import { z } from "zod";
import type { ModelReceipt } from "./model";
import type { CharacterDefinition } from "../society/contracts";
import { psychologySetupSchema } from "./psychology-setup";

export const scenarioIds = ["trust-game", "public-goods", "werewolf", "signaling-game"] as const;
export const signalingIncentives = ["aligned", "conflicting"] as const;
export type SignalingIncentives = typeof signalingIncentives[number];
export const cognitivePhaseSchema = z.object({ effort: z.enum(["low", "medium"]) });
export const cognitivePhasesSchema = z.object({ psychology: cognitivePhaseSchema.optional(), discussion: cognitivePhaseSchema.optional(), action: cognitivePhaseSchema.optional() });
export const runSpecSchema = z.object({
  scenario: z.enum(scenarioIds),
  roster: z.array(z.object({ characterId: z.string().min(1), modelProfileId: z.string().optional(), human: z.boolean().default(false) })).min(2).max(12),
  mode: z.enum(["continuity", "experiment"]).default("continuity"),
  worldId: z.string().min(1).max(100).default("society"),
  initialSnapshots: z.record(z.string(), z.string()).default({}),
  psychologySetup: z.record(z.string(), psychologySetupSchema).optional(),
  seed: z.number().int().default(1),
  rounds: z.number().int().min(2).max(16).default(3),
  trustProtocol: z.enum(["classic", "pledge-repair"]).default("classic"),
  signalingIncentives: z.enum(signalingIncentives).default("conflicting"),
  cognition: z.object({
    inertia: z.number().min(0).max(1).default(.6),
    decay: z.number().min(0).max(1).default(.1),
    context: z.enum(["compact", "expanded"]).default("compact"),
    phases: cognitivePhasesSchema.default({}),
    requestTimeoutMs: z.number().int().min(1000).max(360000).optional(),
  }).optional(),
  budgets: z.object({
    discussionTurns: z.number().int().min(2).max(100).default(16),
    maxTurns: z.number().int().min(2).max(24).default(8),
    humanTimeoutMs: z.number().int().min(1000).max(3600000).default(300000),
  }).default({ discussionTurns: 16, maxTurns: 8, humanTimeoutMs: 300000 }),
  experiment: z.object({
    relationshipMemory: z.boolean().default(true),
    speaking: z.enum(["ready-queue", "round-robin"]).default("ready-queue"),
    personality: z.enum(["full", "persona-only"]).default("full"),
    psychology: z.enum(["appraisal", "hybrid", "off"]).default("appraisal"),
  }).default({ relationshipMemory: true, speaking: "ready-queue", personality: "full", psychology: "appraisal" }),
}).strict().superRefine((spec, ctx) => {
  if (spec.scenario === "signaling-game" && spec.roster.length !== 2) ctx.addIssue({ code: "custom", path: ["roster"], message: "信息交易需要一位发送者和一位接收者" });
  for (const [actorId, setup] of Object.entries(spec.psychologySetup ?? {})) {
    if (spec.mode !== "experiment" || spec.experiment.psychology !== "hybrid") ctx.addIssue({ code: "custom", path: ["psychologySetup"], message: "心理初态注入仅用于开启混合心理的独立实验" });
    const seat = spec.roster.find(s => s.characterId === actorId);
    if (!seat || seat.human) ctx.addIssue({ code: "custom", path: ["psychologySetup", actorId], message: "只能给本局 AI 参与者设置心理初态" });
    if (setup.relationship && (setup.relationship.targetId === actorId || !spec.roster.some(s => s.characterId === setup.relationship!.targetId))) ctx.addIssue({ code: "custom", path: ["psychologySetup", actorId, "relationship"], message: "关系判断必须指向本局另一位参与者" });
  }
});
export type RunSpec = z.infer<typeof runSpecSchema>;
export type Visibility = "public" | "research" | string[];
export type Channel = "public" | "private" | "team";
export type RunStatus = "running" | "paused" | "completed" | "incomplete" | "stopped" | "interrupted";

export interface Character extends Pick<CharacterDefinition, "temperament" | "decisionBiases" | "regulation" | "autobiographicalAnchors"> {
  id: string;
  name: string;
  persona: string;
  values: string[];
  goals: string[];
  voice: string;
  traits?: string[];
}
export interface WorldEvent {
  id: string;
  runId: string;
  seq: number;
  at: string;
  type: "message" | "action" | "fact" | "phase" | "status" | "note" | "trace";
  actorId?: string;
  visibility: Visibility;
  text: string;
  data: Record<string, unknown>;
}
export type EventDraft = Omit<WorldEvent, "id" | "runId" | "seq" | "at">;
export interface Memory {
  id: string;
  characterId: string;
  runId: string;
  kind: "experience" | "note";
  text: string;
  sourceIds: string[];
  about: string[];
  at: string;
  sources?: WorldEvent[];
}
export interface CharacterSnapshot {
  id: string;
  characterId: string;
  worldId: string;
  runId: string;
  parentId?: string;
  at: string;
  memoryIds: string[];
  cognition?: import("../agents/cognition").AgentMind;
}
export interface ActionSpec {
  name: string;
  label: string;
  description: string;
  parameters: z.ZodObject;
  fields: Array<{ name: string; label: string; type: "number" | "choice"; min?: number; max?: number; options?: Array<{ label: string; value: string | number | boolean | null }> }>;
}
export interface Stage {
  id: string;
  label: string;
  round: number;
  kind: "discussion" | "action";
  actors: string[];
  channel: Channel;
  turnLimit?: number;
}
export interface ScenarioAdapter {
  checkpoint(): unknown;
  restore(checkpoint: unknown): void;
  stage(): Stage | undefined;
  observe(actorId: string): string;
  observation?(actorId: string): ActorObservation;
  actions(actorId: string): ActionSpec[];
  apply(actorId: string, name: string, input: unknown): EventDraft[];
  advance(): EventDraft[];
  publicState(): Record<string, unknown>;
  canMessage(actorId: string, channel: Channel, recipients: string[]): boolean;
}
export interface ActorObservation {
  actorId: string;
  stageId: string;
  round: number;
  rules: string;
  facts: Record<string, unknown>;
  legalActions: Array<{ name: string; description: string }>;
}
export interface Opportunity {
  id: string;
  actorId: string;
  stage: Stage;
  channel: Channel;
  recipients: string[];
  actions: ActionSpec[];
  communications: Array<{ channel: Channel; recipients: string[] }>;
}
export interface TurnContext {
  character: Character;
  opportunity: Opportunity;
  observation: string;
  worldObservation?: ActorObservation;
  /** Research preparation: save appraisal without speaking or taking an action. */
  appraisalOnly?: boolean;
  /** Private learning opportunity after the world's final outcome; no world actions or messages. */
  episodeReview?: boolean;
  inbox: WorldEvent[];
  recent: WorldEvent[];
  memories: Memory[];
  /** Read-only source lookup; callers must enforce the current actor's visibility. */
  lookupEvidence?(id: string): WorldEvent | undefined;
  psychology?: import("./psychology").PsychologicalState;
  cognition?: import("../agents/cognition").AgentMind;
  /** Commit the complete, validated activation once, after the SDK has finished. */
  commitActivation?(activation: StagedActivation): void;
  signal: AbortSignal;
  recordModelResponse?(receipt: ModelReceipt): void;
  recordToolError?(toolName: string, message: string): void;
  recordDecisionCase?(record: import("./cases").DecisionCase): void;
  recordHarnessEvent?(event: import("./harness").HarnessEvent): void;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface TurnResult { text?: string; waited?: boolean; inputTokens?: number; outputTokens?: number; }
export interface StagedActivation {
  id: string; actorId: string; stageId: string;
  cognition?: import("../agents/cognition").AgentMind;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  text?: string; waited?: boolean;
}
export interface Participant {
  configuration?: Record<string, unknown>;
  reviewAtEpisodeEnd?: boolean;
  turn(context: TurnContext): Promise<TurnResult>;
}
export type ParticipantFactory = (character: Character, spec: RunSpec, runId: string) => Participant;
export type Viewer = { research?: boolean; actorId?: string };
export function visible(event: WorldEvent, viewer: Viewer): boolean {
  return Boolean(viewer.research || event.visibility === "public" || (viewer.actorId && Array.isArray(event.visibility) && event.visibility.includes(viewer.actorId)));
}
export class RunError extends Error {
  constructor(message: string, public statusCode = 409) { super(message); }
}
export function fact(text: string, data: Record<string, unknown> = {}, visibility: Visibility = "public"): EventDraft {
  return { type: "fact", text, data, visibility };
}
