import { randomUUID } from "node:crypto";
import type { ModelRegistry } from "../society/models/registry";
import { defaultAgentModel, defaultAgentContext, nativeConfiguration, runNativeAgent, NativeAgentError,
  nativeError, redactNative, type NativeTranscript } from "../agents/sdk";
import { agentSourceHash } from "../agents/provenance";
import { PartnerAgentContext } from "./agent-context";
import { createPartnerTools, decisionInstructions, shadowInstructions } from "./agent-tools";
import { PartnerDecisionError, type PartnerAgentOptions, type PartnerDecisionCase, type PartnerDecisionInput,
  type PartnerActivity, type PartnerDecisionResult, type PartnerParticipant } from "./agent-types";
import { createMind } from "./mind";
import { observeWorld } from "./world";

export * from "./agent-types";
export { redactNative as redactPartnerRecord } from "../agents/sdk";
export const partnerHarnessVersion = "partners-responses-v1";
export const partnerModelId = defaultAgentModel;
export const partnerContextWindow = defaultAgentContext;
let sourceDigest: string | undefined;
function newCase(input: PartnerDecisionInput, configuration: Record<string, unknown>): PartnerDecisionCase {
  const observation = observeWorld(input.world, input.actorId);
  return { id: randomUUID(), worldId: input.world.id, actorId: input.actorId, revision: observation.revision,
    createdAt: new Date().toISOString(), sourceHash: sourceDigest ??= agentSourceHash(), harnessVersion: partnerHarnessVersion,
    observation: redactNative(observation), before: structuredClone(input.mind ?? createMind(input.actorId, observation.self.privateObjective)),
    configuration, exchanges: [], activities: [], status: "failed", inputTokens: 0, outputTokens: 0, durationMs: 0, retries: 0, failures: 0 };
}
function recordTranscript(record: PartnerDecisionCase, transcript: NativeTranscript) {
  record.exchanges = transcript.exchanges; record.activities = transcript.activities as PartnerActivity[];
  record.inputTokens = transcript.inputTokens; record.outputTokens = transcript.outputTokens;
  record.toolFailures = transcript.toolFailures;
  record.failures = transcript.toolFailures + transcript.exchanges.filter(exchange => exchange.error).length;
}
export function createSdkParticipant(registry: ModelRegistry, options: PartnerAgentOptions = {}): PartnerParticipant {
  const psychology = options.psychology ?? "hybrid";
  const configuration = { ...nativeConfiguration(registry, options), harnessVersion: partnerHarnessVersion, protocol: "responses-v1", psychology,
    ...(psychology === "record-only" ? { shadowPolicy: "action first; isolated psychological record before world settlement" } : {}) };
  async function run(context: PartnerAgentContext) {
    try {
      const result = await runNativeAgent(registry, options, { name: context.observation.self.name, actorId: context.input.actorId,
        sessionId: `${context.input.world.id}:${context.input.actorId}:${context.shadow ? "shadow" : "decision"}:${randomUUID()}`,
        instructions: context.shadow ? shadowInstructions : decisionInstructions, input: context.modelInput(), context,
        tools: reportError => createPartnerTools(context, reportError), done: () => context.finished, signal: context.input.signal,
        channel: context.shadow ? "shadow" : "decision", onActivity: event => context.input.onActivity?.(event as PartnerActivity) });
      recordTranscript(context.record, result.transcript); return result.sessionItems;
    } catch (error) {
      if (error instanceof NativeAgentError) recordTranscript(context.record, error.transcript);
      throw error;
    }
  }
  return { configuration, async decide(input): Promise<PartnerDecisionResult> {
    const started = Date.now(); const record = newCase(input, configuration);
    try {
      if (record.observation.currentActor !== input.actorId || !record.observation.legalActions.length) throw new Error("当前人物没有合法行动机会");
      const context = new PartnerAgentContext(input, psychology === "record-only" ? "off" : psychology, record);
      const sessionItems = await run(context);
      record.status = "completed"; record.action = context.action;
      let mind = context.mode === "off" ? structuredClone(context.originalMind) : context.mind;
      let memories = context.memories;
      if (psychology === "record-only") {
        const shadowStarted = Date.now(); const shadowRecord = newCase(input, configuration);
        const shadowContext = new PartnerAgentContext(input, "hybrid", shadowRecord, true);
        try {
          await run(shadowContext); mind = shadowContext.mind; memories = shadowContext.memories;
          shadowRecord.status = "completed"; shadowRecord.after = structuredClone(mind);
        } catch (error) { shadowRecord.error = nativeError(error); }
        record.shadow = { timing: "after-decision-before-settlement", status: shadowRecord.status, error: shadowRecord.error,
          inputTokens: shadowRecord.inputTokens, outputTokens: shadowRecord.outputTokens, durationMs: Date.now() - shadowStarted,
          before: shadowRecord.before, after: shadowRecord.after, exchanges: shadowRecord.exchanges, activities: shadowRecord.activities };
        record.inputTokens += shadowRecord.inputTokens; record.outputTokens += shadowRecord.outputTokens;
      }
      record.after = structuredClone(mind); record.durationMs = Date.now() - started;
      return { action: context.action!, mind, memories, sessionItems, decisionCase: redactNative(record) };
    } catch (error) {
      record.status = "failed"; record.error = nativeError(error); record.durationMs = Date.now() - started;
      delete record.action; delete record.actionMind; delete record.after; delete record.receipt;
      if (!record.failures) record.failures = 1;
      throw new PartnerDecisionError(record.error, redactNative(record));
    }
  } };
}
