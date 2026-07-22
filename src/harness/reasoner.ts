import { ROLE_DEFINITIONS } from "../core/roles";
import type { ModelClient } from "../agents/modelClient";
import type { ChatMessage } from "../agents/schema";
import { z } from "zod";
import type {
  HarnessReasoner,
  ReasonerActionProposal,
  ReasonerInput,
  ReasonerOutput,
  ReasonerSocialSpeechActDraft
} from "./types";

const actionProposalSchema = z
  .object({
    commandType: z.string().min(1).max(80).optional(),
    targetId: z.string().min(1).max(120).optional(),
    saveTargetId: z.string().min(1).max(120).optional(),
    poisonTargetId: z.string().min(1).max(120).optional(),
    abstain: z.boolean().optional(),
    confidence: z.number().min(0).max(1).optional(),
    rationale: z.string().max(400).optional()
  })
  .strict();

const socialSpeechActDraftSchema = z
  .object({
    kind: z.enum([
      "claim",
      "request",
      "agreement",
      "disagreement",
      "commitment",
      "coalition_signal",
      "threat",
      "trust_repair"
    ]),
    targetId: z.string().min(1).max(120).optional(),
    value: z.string().min(1).max(240).optional(),
    confidence: z.number().min(0).max(1).optional(),
    memberIds: z.array(z.string().min(1).max(120)).max(12).optional()
  })
  .strict();

const socialSpeechActDraftsSchema = z.array(socialSpeechActDraftSchema).max(4);

export class OpenAIHarnessReasoner implements HarnessReasoner {
  constructor(private readonly client: ModelClient) {}

  async think(input: ReasonerInput): Promise<ReasonerOutput> {
    const completion = await this.client.complete({
      model: input.agent.model,
      temperature: input.agent.temperature,
      messages: buildHarnessMessages(input),
      stream: true
    });
    if (!completion.content.trim()) {
      throw new Error(`Model ${input.agent.model} returned empty harness cognition.`);
    }
    const parsed = parseReasonerOutput(completion.content, input.action.kind);
    return {
      content: parsed.content,
      completion,
      actionProposal: parsed.actionProposal,
      speechActDrafts: parsed.speechActDrafts
    };
  }
}

function buildHarnessMessages(input: ReasonerInput): ChatMessage[] {
  const speechMode = input.action.kind === "speech" || input.action.kind === "last_words" || input.action.kind === "whisper";
  return [
    {
      role: "system",
      content: speechMode
        ? [
            "你是狼人杀 Agent 的语言生成器，不是动作控制器。",
            input.action.kind === "whisper"
              ? "Harness 已经完成观测、信念更新、策略选择和动作仲裁；你只负责生成给狼人同伴的私密协调消息。"
              : "Harness 已经完成观测、信念更新、策略选择和动作仲裁；你只负责生成该 Agent 的公开发言。",
            "正文不要输出 JSON、Markdown、字段表或私密思维链。",
            input.action.kind === "whisper"
              ? "正文是一条给狼队同伴的私密消息，60 到 180 个汉字；可以提出目标、风险和白天协作，但不要假装已经执行行动。"
              : input.action.kind === "last_words"
              ? "这是被淘汰玩家仅一次的遗言。正文必须就是可公开说出的遗言，80 到 220 个汉字。"
              : "正文必须就是玩家可公开说出的话，80 到 220 个汉字。",
            "正文后可选地单独一行写 SOCIAL_ACTS: 后接 JSON array，最多 4 项。该数组只是待验证社会意图，不是命令。",
            "每项字段只能是 kind、targetId、value、confidence、memberIds；kind 只能是 claim、request、agreement、disagreement、commitment、coalition_signal、threat、trust_repair。",
            "不要写 sender、subject、audience、visibility、id、evidence、metadata 或任何隐藏身份；这些只能由 policy 和 harness 根据可见信息分配。"
          ].join("\n")
        : [
            "你是狼人杀 Agent 的战术顾问，不是动作控制器。",
            "Harness 已经负责环境、信念、策略、动作仲裁和执行；你只写一段私密战术备忘，帮助复盘该 Agent 的局势理解。",
            "先用 60 到 180 个汉字说明当前局势、风险和策略依据。",
            "最后单独一行可选地写 ACTION_CANDIDATE: 后接一个 JSON object；字段只能是 commandType、targetId、saveTargetId、poisonTargetId、abstain、confidence、rationale。",
            "该对象只是候选证据，会被 policy 仲裁和环境验证，不能直接改变世界。"
          ].join("\n")
    },
    {
      role: "user",
      content: [
        `trace=${input.traceId}`,
        `身份=${ROLE_DEFINITIONS[input.view.you.role].displayName}`,
        `阵营=${input.view.you.team}`,
        `阶段=${input.view.phase}, day=${input.view.day}, action=${input.action.kind}`,
        `Harness策略=${input.policyPlan.policyName}`,
        `Harness意图=${input.policyPlan.intent}`,
        `Harness目标=${input.policyPlan.targetId ?? "none"}`,
        `当前技能=${JSON.stringify(input.view.you.ability)}`,
        `当前私有事实=${privateFactSummary(input)}`,
        `信念Top=${beliefSummary(input.agent.beliefs)}`,
        `已检索记忆=${recalledMemorySummary(input)}`,
        `公开玩家=${input.view.publicPlayers
          .map((player) => `${player.id}/${player.name}/${player.alive ? "alive" : "dead"}/${player.revealedRole ?? "hidden"}`)
          .join("; ")}`,
        `最近发言=${input.view.speeches
          .slice(-8)
          .map((speech) => `${speech.playerId}: ${speech.text}`)
          .join(" | ") || "none"}`,
        `可见社会消息=${input.view.social.messages
          .slice(-10)
          .map((message) => `${message.visibility}/${message.channelId}/${message.senderId}->${message.recipientIds.join(",") || "all"}: ${message.content}`)
          .join(" | ") || "none"}`,
        `最近投票=${input.view.votes
          .slice(-12)
          .map((vote) => `${vote.voterId}->${vote.abstain ? "abstain" : vote.targetId}`)
          .join(" | ") || "none"}`,
        speechMode
          ? input.action.kind === "whisper"
            ? "现在生成仅对狼人同伴可见的协调消息。不要提到 harness、模型、概率表或系统。"
            : "现在生成公开发言。必须像真实玩家，不要提到 harness、模型、概率表或系统。"
          : "现在生成私密战术备忘。不要编造不可见信息。"
      ].join("\n")
    }
  ];
}

function privateFactSummary(input: ReasonerInput): string {
  const facts: string[] = [];
  if (input.view.privateInfo.werewolfAllies?.length) {
    facts.push(`狼人同伴=${input.view.privateInfo.werewolfAllies.join(",")}`);
  }
  if (input.view.privateInfo.lastInspection) {
    const inspection = input.view.privateInfo.lastInspection;
    facts.push(`查验=${inspection.targetId}:${inspection.resultTeam}`);
  }
  if (input.view.privateInfo.witchNightVictimId) {
    facts.push(`女巫刀口=${input.view.privateInfo.witchNightVictimId}`);
  }
  return facts.join("; ") || "none";
}

function parseReasonerOutput(content: string, actionKind: ReasonerInput["action"]["kind"]): {
  content: string;
  actionProposal?: ReasonerActionProposal;
  speechActDrafts?: ReasonerSocialSpeechActDraft[];
} {
  const normalized = content.trim();
  if (isSpeechActionKind(actionKind)) {
    const marker = "SOCIAL_ACTS:";
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex < 0) return { content: normalized };
    const speech = normalized.slice(0, markerIndex).trim();
    return {
      content: speech || normalized,
      speechActDrafts: parseSocialSpeechActDrafts(normalized.slice(markerIndex + marker.length))
    };
  }
  const marker = "ACTION_CANDIDATE:";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return { content: normalized };
  const memo = normalized.slice(0, markerIndex).trim();
  const actionProposal = parseActionProposal(normalized.slice(markerIndex + marker.length));
  return {
    content: memo || normalized,
    actionProposal
  };
}

function isSpeechActionKind(kind: ReasonerInput["action"]["kind"]): boolean {
  return kind === "speech" || kind === "last_words" || kind === "whisper";
}

function parseSocialSpeechActDrafts(content: string): ReasonerSocialSpeechActDraft[] | undefined {
  const parsed = tryParseArray(content.trim());
  const result = socialSpeechActDraftsSchema.safeParse(parsed);
  if (!result.success || !result.data.length) return undefined;
  return result.data.filter((draft) => {
    if ((draft.kind === "claim" || draft.kind === "commitment") && !draft.value) return false;
    if (draft.kind === "coalition_signal" && (!draft.memberIds?.length || !draft.value)) return false;
    if ((draft.kind === "request" || draft.kind === "threat" || draft.kind === "trust_repair") && !draft.targetId) return false;
    return true;
  });
}

function parseActionProposal(content: string): ReasonerActionProposal | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed, trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  for (const candidate of candidates) {
    const parsed = tryParseObject(candidate);
    const result = actionProposalSchema.safeParse(parsed);
    if (result.success) return result.data;
  }
  return undefined;
}

function tryParseObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(value.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function tryParseArray(value: string): unknown {
  const candidates = [value, value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      const start = candidate.indexOf("[");
      const end = candidate.lastIndexOf("]");
      if (start < 0 || end <= start) continue;
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // Try the next bounded representation.
      }
    }
  }
  return undefined;
}

function beliefSummary(beliefs: ReasonerInput["agent"]["beliefs"]): string {
  return Object.entries(beliefs)
    .sort((a, b) => b[1].wolfProb - a[1].wolfProb)
    .slice(0, 5)
    .map(([playerId, belief]) => `${playerId}:${Math.round(belief.wolfProb * 100)}%(${belief.rationaleTags.join("/") || "无证据"})`)
    .join(", ");
}

/**
 * The actor already selected these entries deterministically. This rendering
 * is bounded and read-only: it neither exposes a memory store nor lets model
 * text mutate memory, policy, or the environment.
 */
function recalledMemorySummary(input: ReasonerInput): string {
  const entries = input.recalledMemory ?? [];
  if (!entries.length) return "none";
  return entries
    .slice(0, 6)
    .map((entry) => {
      const content = entry.content?.replace(/\s+/g, " ").slice(0, 480);
      return `#${entry.memorySeq}/${entry.kind}/${entry.source}/${entry.tags.join(",") || "untagged"}${content ? `:${content}` : ""}`;
    })
    .join(" | ");
}
