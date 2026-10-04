import { memo, useState } from "react";
import { LockKeyhole } from "lucide-react";
import type { PublicActor } from "@/partners/contracts";
import type { ToolActivity } from "@/partners/api-types";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";

const toolTitles: Record<string, string> = { recall: "查阅自己的经历", preview_action: "计算行动后果", revise_mind: "修订判断与计划", submit_action: "提交行动",
  appraise_event: "评价可见事件", create_plan: "建立持续计划", revise_plan: "修订计划", keep_plan: "确认继续计划", close_plan: "结束计划", forecast: "登记行为预测",
  offer: "提出报价", invest: "决定投资", settle: "实际返还与披露", repair: "决定补偿", respond: "回应合作", exit: "结束合作", finish_record: "完成独立心理记录",
  prepare_decision: "评价事件与准备候选", commit_action: "提交行动", choose_candidate: "选择已准备的行动", record_appraisal: "独立记录心理" };

/** Display-only incomplete string decoding. It is never a decision parser or a world input. */
export function streamedMessageDraft(output: string): string {
  const match = /(?<!\\)"message"\s*:\s*"/.exec(output);
  if (!match) return "";
  const tail = output.slice(match.index + match[0].length); let quoted = '"';
  for (let i = 0; i < tail.length; i++) {
    const char = tail[i]; if (char === '"') break;
    if (char === "\\") {
      if (i + 1 >= tail.length || tail[i + 1] === "u" && i + 5 >= tail.length) break;
      quoted += char + tail[++i];
      if (tail[i] === "u") { quoted += tail.slice(i + 1, i + 5); i += 4; }
    } else quoted += char;
  }
  try { return JSON.parse(quoted + '"') as string; } catch { return ""; }
}

export const RuntimeTool = memo(function RuntimeTool({ activity }: { activity: ToolActivity }) {
  return <Tool className="mb-0" data-activity-id={activity.id}><ToolHeader className="px-3 py-2" type="dynamic-tool" toolName={activity.name} title={toolTitles[activity.name] ?? activity.name}
    state={activity.status === "running" ? "input-available" : activity.status === "failed" ? "output-error" : "output-available"} />
    <ToolContent><ToolInput input={activity.input ?? null} /><ToolOutput output={activity.status === "failed" ? null : activity.output ?? null}
      errorText={activity.status === "failed" ? typeof activity.output === "string" ? activity.output : "本次调用未完成" : undefined} /></ToolContent></Tool>;
});

const RuntimeModel = memo(function RuntimeModel({ activity }: { activity: ToolActivity }) {
  const running = activity.status === "running";
  const [open, setOpen] = useState(running);
  const seconds = activity.finishedAt ? Math.max(0, (+new Date(activity.finishedAt) - +new Date(activity.startedAt)) / 1000) : undefined;
  return <div className="flex min-w-0 flex-col gap-3" data-model-stream-id={activity.id}>
    <Reasoning className="mb-0" isStreaming={running} open={open} onOpenChange={setOpen} defaultOpen={false} autoClose={false} duration={seconds}>
      <ReasoningTrigger getThinkingMessage={() => <span>{running ? activity.stream?.reasoning ? "正在思考" : "等待模型响应" : activity.status === "failed" ? "本次思考中断" : "查看思考内容"}{seconds !== undefined ? ` · ${seconds.toFixed(1)} 秒` : ""}</span>} />
      <ReasoningContent>{activity.stream?.reasoning || (running ? "等待思考内容…" : "模型未返回思考内容")}</ReasoningContent>
      {open && (activity.stream?.outputText || activity.stream?.toolCalls?.length) && <Tool className="mb-0 mt-2"><ToolHeader className="px-3 py-2" type="dynamic-tool" toolName="model-output" title={running ? "正在生成工具参数" : "本次模型输出"} state={running ? "input-streaming" : activity.status === "failed" ? "output-error" : "output-available"} /><ToolContent><ToolOutput output={activity.stream.toolCalls?.length ? activity.stream.toolCalls : activity.stream.outputText} errorText={activity.status === "failed" && typeof activity.output === "string" ? activity.output : undefined} /></ToolContent></Tool>}
    </Reasoning>
  </div>;
});

export function AgentRuntime({ actor, activities, revision }: { actor: PublicActor; activities: ToolActivity[]; revision: number }) {
  const content = activities.filter(item => item.kind === "model" || item.kind === "tool" || item.kind === "retry" || (!item.kind && item.name !== "角色 Agent"));
  const models = content.filter(item => item.kind === "model" || item.name === "模型决策");
  const tools = content.filter(item => !models.includes(item));
  const toolsRunning = tools.some(item => item.status === "running");
  const toolsFailed = tools.some(item => item.status === "failed");
  return <div className="flex min-w-0 flex-col gap-2" data-runtime-id={`${revision}:${actor.id}`} aria-label={`${actor.name} 的运行过程`}>
    <span className="sr-only">{actor.name} 的运行过程。模型返回的思考与草稿仅研究者可见，对方 Agent 无法读取。</span>
    {models.map(activity => <div key={activity.id} className="min-w-0">{activity.channel === "shadow" && <Badge variant="outline" className="mb-2"><LockKeyhole />独立记录 · 不参与行动</Badge>}<RuntimeModel activity={activity} /></div>)}
    {tools.length > 0 && <Tool className="mb-0 rounded-none border-0" defaultOpen={toolsRunning}>
      <ToolHeader className="gap-2 px-0 py-1" type="dynamic-tool" toolName="tool-activity" title={`工具调用 · ${tools.length} 次`} state={toolsRunning ? "input-available" : toolsFailed ? "output-error" : "output-available"} />
      <ToolContent className="gap-2 px-0 pb-1 pt-2">{tools.map(activity => <RuntimeTool key={activity.id} activity={activity} />)}</ToolContent>
    </Tool>}
  </div>;
}
