import { useEffect, useState } from "react";
import { Download, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { headersFor, json } from "./api";
import type { DecisionCase } from "@/runtime/cases";

const casePreview = (value: unknown) => JSON.stringify(value, (key, item) => key === "encrypted_content" && typeof item === "string"
  ? `[供应商加密内容，${item.length} 个字符；完整值保留在下载的案例中]` : item, 2);
function downloadCase(record: DecisionCase) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `decision-case-${record.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DecisionCases({ runId, studyId, trialId }: { runId?: string; studyId?: string; trialId?: string }) {
  const [cases, setCases] = useState<Array<Pick<DecisionCase, "id" | "phase" | "actorId" | "durationMs" | "error" | "originCaseId"> & { sharedPrefix?: boolean }>>();
  const [detail, setDetail] = useState<DecisionCase>(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const endpoint = studyId && trialId ? `/api/v2/studies/${studyId}/trials/${trialId}/decision-cases` : `/api/v2/runs/${runId}/decision-cases`;
  useEffect(() => { void json<{ cases: NonNullable<typeof cases> }>(endpoint, { headers: headersFor(runId) }).then(r => setCases(r.cases)).catch(e => setError(e.message)); }, [runId, endpoint]);
  async function open(id: string) { try { setDetail(await json<DecisionCase>(`/api/v2/decision-cases/${id}`, { headers: headersFor(runId) })); } catch (e) { setError((e as Error).message); } }
  async function replay(overrides: { effort?: "low" | "medium" }) {
    if (!detail) return; setBusy(true);
    try { const result = await json<DecisionCase>(`/api/v2/decision-cases/${detail.id}/replay`, { method: "POST", headers: headersFor(runId), body: JSON.stringify(overrides) }); setDetail(result); setCases(current => [...(current ?? []), result]); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="flex flex-col gap-4 pt-4">{error && <Alert><AlertDescription>{error}</AlertDescription></Alert>}{cases ? cases.length ? <Table><TableHeader><TableRow><TableHead>人物 / 阶段</TableHead><TableHead>耗时</TableHead><TableHead>状态</TableHead><TableHead>请求与响应</TableHead></TableRow></TableHeader><TableBody>{cases.map(c => <TableRow key={c.id}><TableCell>{c.actorId} · {c.phase === "psychology" ? "心理评价" : c.phase === "action" ? "行动" : "交流"}</TableCell><TableCell>{(c.durationMs / 1000).toFixed(1)} 秒</TableCell><TableCell><Badge variant="outline">{c.error ? "失败" : "已返回"}{c.originCaseId ? " · 复测" : ""}{c.sharedPrefix ? " · 共同前段" : ""}</Badge></TableCell><TableCell><Button variant="ghost" size="sm" onClick={() => void open(c.id)}>查看案例</Button></TableCell></TableRow>)}</TableBody></Table> : <Empty><EmptyHeader><EmptyTitle>这份记录没有决策案例</EmptyTitle><EmptyDescription>新运行会保存完整输入、工具定义、响应与失败；旧档案保持原貌。</EmptyDescription></EmptyHeader></Empty> : !error && <Skeleton className="h-48 w-full" />}
    <Sheet open={Boolean(detail)} onOpenChange={open => { if (!open) setDetail(undefined); }}><SheetContent className="w-full overflow-y-auto sm:max-w-3xl"><SheetHeader><SheetTitle>固定输入 · 隔离复测</SheetTitle></SheetHeader>{detail && <div className="flex flex-col gap-4 p-5"><p className="text-sm text-muted-foreground">复测只请求模型，不执行返回的工具调用，不改动原局资金、记忆与事件。</p><Button variant="outline" className="w-fit" onClick={() => downloadCase(detail)}><Download data-icon="inline-start" />下载完整案例</Button><ReplayControls key={detail.id} busy={busy} replay={replay} />{detail.error && <Alert><AlertDescription>{detail.error}</AlertDescription></Alert>}<Tabs defaultValue="response"><TabsList><TabsTrigger value="response">响应</TabsTrigger><TabsTrigger value="request">完整输入</TabsTrigger><TabsTrigger value="configuration">版本与配置</TabsTrigger></TabsList><TabsContent value="response"><pre className="data-panel">{casePreview(detail.response ?? { error: detail.error })}</pre></TabsContent><TabsContent value="request"><pre className="data-panel">{casePreview(detail.providerRequest ?? detail.request)}</pre></TabsContent><TabsContent value="configuration"><pre className="data-panel">{JSON.stringify({ sourceHash: detail.sourceHash, configuration: detail.configuration, originCaseId: detail.originCaseId }, null, 2)}</pre></TabsContent></Tabs></div>}</SheetContent></Sheet>
  </div>;
}

function ReplayControls({ busy, replay }: { busy: boolean; replay(overrides: { effort?: "low" | "medium" }): Promise<void> }) {
  const [effort, setEffort] = useState("original");
  return <FieldGroup>
    <Field><FieldLabel>思考强度</FieldLabel><ToggleGroup type="single" variant="outline" value={effort} disabled={busy} onValueChange={v => { if (v) setEffort(v); }} aria-label="复测思考强度"><ToggleGroupItem value="original">原配置</ToggleGroupItem><ToggleGroupItem value="low">Low</ToggleGroupItem><ToggleGroupItem value="medium">Medium</ToggleGroupItem></ToggleGroup></Field>
    <Button disabled={busy} onClick={() => void replay(effort === "original" ? {} : { effort: effort as "low" | "medium" })}><RotateCw data-icon="inline-start" />{busy ? "正在复测" : "使用固定输入复测"}</Button>
  </FieldGroup>;
}
