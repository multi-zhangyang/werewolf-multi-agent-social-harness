import { BookOpen, Check, ChevronDown, CircleAlert, Coins, FileText, Search, Send, Wrench } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Character, WorldEvent } from "@/runtime/types";
export { isActivityEvent } from "@/runtime/behavior";

const tools = {
  appraise_event: { title: "评价眼前的经历", icon: BookOpen },
  update_opponent: { title: "修订对他人的判断", icon: BookOpen },
  set_plan: { title: "制定或修订计划", icon: BookOpen },
  close_plan: { title: "结束一项计划", icon: Check },
  forecast: { title: "登记待验证的预测", icon: Search },
  recall: { title: "检索自己的经历", icon: Search },
  speak: { title: "准备对外发言", icon: Send },
  wait: { title: "暂不发言", icon: Check },
  finish_record: { title: "完成独立心理记录", icon: Check },
  finish_episode_review: { title: "完成整局私有复盘", icon: BookOpen },
  recall_memory: { title: "检索自己的经历", icon: Search },
  remember: { title: "记下一段经历", icon: BookOpen },
  update_mind: { title: "更新主观心理状态", icon: BookOpen },
  pledge_return: { title: "公开承诺返还", icon: Coins },
  repair_transfer: { title: "付出实际补偿", icon: Coins },
  send_message: { title: "发出一条消息", icon: Send },
  invest: { title: "提交投资", icon: Coins },
  return_funds: { title: "返还资金", icon: Coins },
  contribute: { title: "投入公共池", icon: Coins },
};

/** Uses the same official shadcn primitives for committed actions, notes and SDK tools. */
export function AgentActivity({ event, character, compact = false }: { event: WorldEvent; character?: Character; compact?: boolean }) {
  const sdk = Boolean(event.data.harness);
  const kind = String(event.data.kind ?? "");
  const running = sdk && ["model_start", "model_delta", "tool_start"].includes(kind);
  const retry = sdk && kind === "retry";
  const action = String(event.data.toolName ?? event.data.action ?? event.text);
  const metadata = tools[action as keyof typeof tools];
  const failed = Boolean(event.data.toolError || event.data.error || event.text === "missing-action" || sdk && ["model_error", "tool_error", "tool_rejected"].includes(kind));
  const note = event.type === "note" || event.text === "action-response";
  const title = sdk && kind.startsWith("model_") ? event.data.phase === "episode-review" ? "比较整局经历" : event.data.phase === "psychology" ? "形成心理评价" : "选择回应与行动" : retry ? "重试未提交的调用" : metadata?.title ?? (event.type === "action" ? "提交行动" : note ? event.type === "note" ? "留下一条笔记" : "行动说明" : failed ? "这次调用未完成" : "调用工具");
  const Icon = failed ? CircleAlert : metadata?.icon ?? (note ? FileText : Wrench);
  const receiptText = Array.isArray(event.data.result) ? event.data.result.map((r: { text?: string }) => r?.text).filter(Boolean).join("；") : undefined;
  const summary = sdk ? [event.data.phase === "episode-review" ? "整局复盘" : event.data.phase === "psychology" ? "心理评价" : "决策", `第 ${event.data.attempt} 次尝试 · 第 ${event.data.step} 步`, event.data.durationMs === undefined ? undefined : `${(Number(event.data.durationMs) / 1000).toFixed(1)} 秒`, event.data.message ? String(event.data.message) : undefined].filter(Boolean).join(" · ") : event.type === "action" || note ? event.text === "action-response" ? String(event.data.text ?? "") : event.text
    : failed ? String(event.data.message ?? event.text) : action === "recall_memory" && Array.isArray(event.data.result) ? `找到 ${event.data.result.length} 条自己的经历` : receiptText || (metadata ? "已返回结果，可展开查看" : action);
  const contents = <Collapsible><ItemGroup><Item variant="outline" size="sm"><ItemMedia variant="icon"><Icon /></ItemMedia><ItemContent><ItemTitle>{title}<Badge variant={failed ? "destructive" : running || retry ? "outline" : "secondary"}>{running ? <><Spinner data-icon="inline-start" />运行中</> : failed ? kind === "tool_rejected" ? "已拦截" : "未完成" : retry ? "重试" : note ? "已记录" : <><Check data-icon="inline-start" />已完成</>}</Badge></ItemTitle><ItemDescription>{summary}</ItemDescription></ItemContent><CollapsibleTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`展开${title}`}><ChevronDown /></Button></CollapsibleTrigger></Item></ItemGroup><CollapsibleContent><Bubble variant="outline" className="w-full max-w-full"><BubbleContent className="w-full"><div className="flex flex-col gap-4 p-2"><div className="flex items-center justify-between text-xs text-muted-foreground"><span>事件 #{event.seq}</span><span>{event.visibility === "public" ? "公开可见" : "仅授权视角可见"}</span></div><Separator />{note ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{summary}</p> : <Tabs defaultValue="result"><TabsList><TabsTrigger value="result">结果</TabsTrigger><TabsTrigger value="input">输入</TabsTrigger><TabsTrigger value="raw">原始记录</TabsTrigger></TabsList><TabsContent value="result"><ToolValues value={event.data.result ?? event.data} /></TabsContent><TabsContent value="input"><ToolValues value={event.data.input ?? event.data} /></TabsContent><TabsContent value="raw"><pre className="max-h-64">{JSON.stringify(event.data, null, 2)}</pre></TabsContent></Tabs>}</div></BubbleContent></Bubble></CollapsibleContent></Collapsible>;
  if (compact) return contents;
  return <Message><MessageAvatar><Avatar><AvatarFallback>{character?.name.slice(-2) ?? "·"}</AvatarFallback></Avatar></MessageAvatar><MessageContent><MessageHeader>{character?.name ?? "系统"}</MessageHeader>{contents}</MessageContent></Message>;
}

function ToolValues({ value }: { value: unknown }) {
  const entries: Array<[string, unknown]> = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [["value", value]];
  const labels: Record<string, string> = { amount: "金额 / 比例", action: "行动", round: "轮次", targetId: "对象", query: "检索词", about: "相关人物", sourceIds: "来源事件", result: "工具结果", remainingActions: "剩余行动", text: "内容", value: "返回值" };
  return <div className="max-h-80 overflow-auto"><Table><TableHeader><TableRow><TableHead>字段</TableHead><TableHead>值</TableHead></TableRow></TableHeader><TableBody>{entries.length ? entries.map(([key, item]) => <TableRow key={key}><TableCell className="align-top">{labels[key] ?? key}</TableCell><TableCell className="min-w-0 whitespace-normal break-all">{typeof item === "object" && item !== null ? <pre className="max-h-56 whitespace-pre-wrap break-all">{JSON.stringify(item, null, 2)}</pre> : String(item ?? "—")}</TableCell></TableRow>) : <TableRow><TableCell colSpan={2}>没有字段</TableCell></TableRow>}</TableBody></Table></div>;
}
