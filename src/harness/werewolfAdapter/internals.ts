import type { AgentPendingAction } from "../../core/pending";
import { hashStableState } from "../hash";
import type {
  AgentHarnessState,
  HarnessTurnTrace,
  PolicyPlan,
  ReasonerAgentContext,
  ReasonerOutputSummary
} from "../types";
import type { WerewolfSocialActorAdapter } from "./actorAdapter";

export function snapshotAgentStates(actors: readonly Pick<WerewolfSocialActorAdapter, "state">[]): AgentHarnessState[] {
  return actors.map((actor) => cloneJson(actor.state));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toReasonerAgentContext(agent: AgentHarnessState): ReasonerAgentContext {
  return {
    playerId: agent.playerId,
    profileId: agent.profileId,
    model: agent.model,
    temperature: agent.temperature,
    policyName: agent.policyName,
    turns: agent.turns,
    observations: agent.observations,
    beliefs: cloneJson(agent.beliefs),
    lastIntent: agent.lastIntent,
    socialStateHash: agent.socialStateHash
  };
}

export function normalizeSpeech(content: string): string {
  const text = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^【?公开发言】?[：:]\s*/u, "")
    .trim();
  if (text.length < 20) {
    throw new Error("Speech reasoner output is too short to submit as a public speech.");
  }
  return text.slice(0, 500);
}

export function requiresWerewolfSpeech(pending: AgentPendingAction): boolean {
  return pending.kind === "speech" || pending.kind === "last_words" || pending.kind === "whisper";
}

/**
 * Deterministic, public-safe policy language for operation without an
 * optional reasoner. It relies only on the already selected policy plan and
 * never claims a model completion or introduces a new action candidate.
 */
export function deterministicPolicySpeech(pending: AgentPendingAction, plan: PolicyPlan): string {
  if (pending.kind === "whisper") {
    return plan.targetId
      ? `建议优先关注 ${plan.targetId}，夜间行动和白天发言保持一致，并继续观察公开票型。`
      : "请同步当前夜间风险判断，白天发言保持一致，并继续观察公开票型。";
  }
  if (pending.kind === "last_words") {
    return "请复核公开发言、投票与行动顺序；不要只凭单点指控，优先保留可复查的判断依据。";
  }
  return plan.pressureTargetId
    ? `我会优先核对 ${plan.pressureTargetId} 的公开发言与票型。请大家给出可复查的依据，避免只凭情绪跟票。`
    : "我会结合公开发言、投票与行动顺序继续判断。请大家给出可复查的依据，避免只凭情绪跟票。";
}

export function deterministicPolicyMemo(pending: AgentPendingAction, plan: PolicyPlan): string {
  return `确定性策略已选择 ${plan.command.type}（${pending.kind}）；${plan.intent}。`;
}

export function summarizePolicyOnlyOutput(content: string): ReasonerOutputSummary {
  return {
    content,
    cognitionSource: "policy",
    latencyMs: 0
  };
}

/**
 * `commitWerewolfAgentTurn` predates policy-only execution and records every
 * private memo as `reasoner` memory. Keep its legacy API stable while making
 * the adapter's committed canonical state truthful: a deterministic template
 * is a policy memo, not hidden model cognition.
 */
export function normalizePolicyOnlyMemoState(
  state: AgentHarnessState,
  trace: Pick<HarnessTurnTrace, "cognitionSource" | "privateMemo">
): void {
  if (trace.cognitionSource !== "policy") return;
  const social = state.social;
  if (!social) throw new Error(`Policy-only Werewolf actor ${state.playerId} is missing social state after commit.`);
  const memo = [...social.memory.entries]
    .reverse()
    .find((entry) => entry.kind === "memo" && entry.content === trace.privateMemo);
  if (!memo) throw new Error(`Policy-only Werewolf actor ${state.playerId} is missing its committed policy memo.`);
  memo.source = "policy";
  memo.tags = [...new Set([...memo.tags.filter((tag) => tag !== "reasoner-memo"), "policy-memo"])];
  memo.evidenceRefs = memo.evidenceRefs.map((ref) =>
    ref.description?.startsWith("reasoner memo")
      ? { ...ref, description: `policy memo for ${state.playerId}` }
      : ref
  );
  memo.metadata = {
    ...memo.metadata,
    cognitionSource: "policy"
  };
  state.socialStateHash = hashStableState(social);
}

export function summarizeReasonerOutput(
  content: string,
  completion: {
    latencyMs: number;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    attempts?: number;
    retryHistory?: ReasonerOutputSummary["retryHistory"];
    stream?: ReasonerOutputSummary["stream"];
  },
  actionProposal?: ReasonerOutputSummary["actionProposal"],
  speechActDrafts?: ReasonerOutputSummary["speechActDrafts"]
): ReasonerOutputSummary {
  return {
    content,
    cognitionSource: "reasoner",
    latencyMs: completion.latencyMs,
    promptTokens: completion.usage?.promptTokens,
    completionTokens: completion.usage?.completionTokens,
    totalTokens: completion.usage?.totalTokens,
    attempts: completion.attempts,
    retryHistory: cloneJson(completion.retryHistory),
    stream: cloneJson(completion.stream),
    actionProposal: cloneJson(actionProposal),
    speechActDrafts: cloneJson(speechActDrafts)
  };
}

export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Replace the canonical actor snapshot only after an environment commit. */
export function replaceAgentHarnessState(target: AgentHarnessState, source: AgentHarnessState): void {
  const targetRecord = target as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) delete targetRecord[key];
  Object.assign(targetRecord, cloneJson(source) as unknown as Record<string, unknown>);
}
