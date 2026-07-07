import { ROLE_DEFINITIONS } from "../core/roles";
import type { ModelClient } from "../agents/modelClient";
import type { ChatMessage } from "../agents/schema";
import type { HarnessReasoner, ReasonerInput, ReasonerOutput } from "./types";

export class OpenAIHarnessReasoner implements HarnessReasoner {
  constructor(private readonly client: ModelClient) {}

  async think(input: ReasonerInput): Promise<ReasonerOutput> {
    const completion = await this.client.complete({
      model: input.agent.model,
      temperature: input.agent.temperature,
      messages: buildHarnessMessages(input)
    });
    if (!completion.content.trim()) {
      throw new Error(`Model ${input.agent.model} returned empty harness cognition.`);
    }
    return {
      content: completion.content.trim(),
      completion
    };
  }
}

function buildHarnessMessages(input: ReasonerInput): ChatMessage[] {
  const speechMode = input.action.kind === "speech";
  return [
    {
      role: "system",
      content: speechMode
        ? [
            "你是狼人杀 Agent 的语言生成器，不是动作控制器。",
            "Harness 已经完成观测、信念更新、策略选择和动作仲裁；你只负责生成该 Agent 的公开发言。",
            "不要输出 JSON、Markdown、字段表或私密思维链。",
            "整条回复必须就是玩家可公开说出的话，80 到 220 个汉字。"
          ].join("\n")
        : [
            "你是狼人杀 Agent 的战术顾问，不是动作控制器。",
            "Harness 已经负责环境、信念、策略、动作仲裁和执行；你只写一段私密战术备忘，帮助复盘该 Agent 的局势理解。",
            "不要输出 JSON、Markdown、字段表或命令。",
            "用 60 到 180 个汉字说明当前局势、风险和策略依据。"
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
        `信念Top=${beliefSummary(input.agent.beliefs)}`,
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
          ? "现在生成公开发言。必须像真实玩家，不要提到 harness、模型、概率表或系统。"
          : "现在生成私密战术备忘。不要编造不可见信息。"
      ].join("\n")
    }
  ];
}

function beliefSummary(beliefs: ReasonerInput["agent"]["beliefs"]): string {
  return Object.entries(beliefs)
    .sort((a, b) => b[1].wolfProb - a[1].wolfProb)
    .slice(0, 5)
    .map(([playerId, belief]) => `${playerId}:${Math.round(belief.wolfProb * 100)}%(${belief.rationaleTags.join("/") || "无证据"})`)
    .join(", ");
}
