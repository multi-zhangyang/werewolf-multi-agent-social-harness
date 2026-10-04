import { useEffect, useState } from "react";
import { ChevronDown, FileCode2, GitBranch } from "lucide-react";
import { toast } from "sonner";
import type { PartnerDecisionCase } from "@/partners/agent";
import type { CreatedRun } from "@/partners/api-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { post, rememberRun, request } from "./api";

export function DecisionCases({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const [cases, setCases] = useState<PartnerDecisionCase[]>();
  const [error, setError] = useState("");
  const [replaying, setReplaying] = useState("");
  useEffect(() => { if (!open) return; const controller = new AbortController(); void request<{ cases: PartnerDecisionCase[] }>(`/api/partners/${id}/cases`, { signal: controller.signal }, id).then(value => { setCases(value.cases); setError(""); }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); }); return () => controller.abort(); }, [id, open]);
  async function replay(caseId: string) {
    setReplaying(caseId);
    try { const child = await post<CreatedRun>(`/api/partners/${id}/cases/${caseId}/replay`, {}, id); rememberRun(child); setOpen(false); location.hash = `#/partners/${child.id}`; } catch (cause) { toast.error(cause instanceof Error ? cause.message : "隔离复测失败"); } finally { setReplaying(""); }
  }
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="outline" size="sm"><FileCode2 data-icon="inline-start" />决策案例</Button></DialogTrigger><DialogContent className="flex max-h-[88dvh] flex-col sm:max-w-4xl"><DialogHeader><DialogTitle>决策案例</DialogTitle><DialogDescription>模型输入、正式状态与调用记录</DialogDescription></DialogHeader><ScrollArea className="min-h-0 flex-1"><div className="flex flex-col gap-3 pr-4">{error ? <p className="text-sm text-destructive">{error}</p> : !cases ? <Spinner /> : !cases.length ? <Empty><EmptyHeader><EmptyTitle>还没有完成的模型调用</EmptyTitle><EmptyDescription>调用结束后，包括失败，会保存到这里。</EmptyDescription></EmptyHeader></Empty> : cases.map(item => <Collapsible key={item.id} className="rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-3"><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />{item.observation.self.name} · 第 {item.observation.round} 轮 · #{item.revision}<Badge variant="outline">{item.status === "completed" ? "已提交" : "失败"}</Badge></Button></CollapsibleTrigger><Button variant="outline" size="sm" disabled={Boolean(replaying)} onClick={() => void replay(item.id)}>{replaying === item.id ? <Spinner data-icon="inline-start" /> : <GitBranch data-icon="inline-start" />}隔离复测</Button></div><p className="mt-2 text-xs text-muted-foreground">{(item.durationMs / 1000).toFixed(1)} 秒 · 输入 {item.inputTokens.toLocaleString()} / 输出 {item.outputTokens.toLocaleString()} tokens · 重试 {item.retries} · 失败 {item.failures}</p>{item.error && <p className="mt-3 text-sm text-destructive">{item.error}</p>}<CollapsibleContent className="pt-4"><Table><TableHeader><TableRow><TableHead>字段</TableHead><TableHead>记录</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell>源码版本</TableCell><TableCell className="break-all font-mono text-xs">{item.sourceHash}</TableCell></TableRow><TableRow><TableCell>参数</TableCell><TableCell><pre>{JSON.stringify(item.configuration, null, 2)}</pre></TableCell></TableRow><TableRow><TableCell>完整案例</TableCell><TableCell><pre className="max-h-96">{JSON.stringify(item, null, 2)}</pre></TableCell></TableRow></TableBody></Table></CollapsibleContent></Collapsible>)}</div></ScrollArea></DialogContent></Dialog>;
}
