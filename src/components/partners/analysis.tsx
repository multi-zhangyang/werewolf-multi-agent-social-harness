import { useState } from "react";
import { ChartNoAxesColumnIncreasing, ChevronDown, RefreshCw } from "lucide-react";
import type { Distribution, StudyAnalysis } from "@/partners/analysis";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { request } from "./api";

const conditions = { none: "无道歉", apology: "只有道歉", compensation: "道歉 + 补偿 9" };
const mechanisms = { full: "完整机制", "no-inertia": "关闭惯性", "no-mind": "关闭心理", "record-only": "只记录心理" };
const percent = (value: number | null) => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const interval = (distribution: Distribution) => distribution.ci95 ? `${percent(distribution.ci95[0])} – ${percent(distribution.ci95[1])}` : "—（有效样本不足）";

export function StudyStatistics({ id }: { id: string }) {
  const [analysis, setAnalysis] = useState<StudyAnalysis>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function load() { setPending(true); try { setAnalysis(await request<StudyAnalysis>(`/api/partners/studies/${id}/analysis`, {}, id)); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "统计读取失败"); } finally { setPending(false); } }
  return <section className="flex flex-col gap-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-medium">分布与不确定性</h2></div><Button variant="outline" disabled={pending} onClick={() => void load()}>{pending ? <Spinner data-icon="inline-start" /> : analysis ? <RefreshCw data-icon="inline-start" /> : <ChartNoAxesColumnIncreasing data-icon="inline-start" />}{analysis ? "更新统计" : "查看统计"}</Button></div>{error && <Alert><AlertDescription>{error}</AlertDescription></Alert>}{analysis && <><p className="text-xs text-muted-foreground">返还比例 = 实际返还 / 真实到账。区间为均值的 95% bootstrap 区间，至少需要 {analysis.method.minimumForInterval} 个有效样本。</p><Table><TableHeader><TableRow><TableHead>条件</TableHead><TableHead>宜人性</TableHead><TableHead>机制</TableHead><TableHead>有效 / 缺失</TableHead><TableHead>返还比例均值</TableHead><TableHead>95% 区间</TableHead></TableRow></TableHeader><TableBody>{analysis.groups.map(group => <TableRow key={`${group.condition}:${group.agreeableness}:${group.mechanism}`}><TableCell>{conditions[group.condition]}</TableCell><TableCell>{group.agreeableness}</TableCell><TableCell>{mechanisms[group.mechanism]}</TableCell><TableCell>{group.metrics.returnRatio.n} / {group.metrics.returnRatio.missing}</TableCell><TableCell>{percent(group.metrics.returnRatio.mean)}</TableCell><TableCell>{interval(group.metrics.returnRatio)}</TableCell></TableRow>)}</TableBody></Table><Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />相对「无道歉」的配对差异</Button></CollapsibleTrigger><CollapsibleContent className="pt-3"><Table><TableHeader><TableRow><TableHead>修复</TableHead><TableHead>宜人性 / 机制</TableHead><TableHead>有效配对</TableHead><TableHead>返还比例均值差</TableHead><TableHead>95% 区间</TableHead><TableHead>Cohen's dz</TableHead></TableRow></TableHeader><TableBody>{analysis.pairedRepairEffects.map(effect => <TableRow key={`${effect.treatment}:${effect.agreeableness}:${effect.mechanism}`}><TableCell>{conditions[effect.treatment]}</TableCell><TableCell>{effect.agreeableness} / {mechanisms[effect.mechanism]}</TableCell><TableCell>{effect.metrics.returnRatio.n}</TableCell><TableCell>{percent(effect.metrics.returnRatio.mean)}</TableCell><TableCell>{interval(effect.metrics.returnRatio)}</TableCell><TableCell>{effect.metrics.returnRatio.cohensDz?.toFixed(3) ?? "—"}</TableCell></TableRow>)}</TableBody></Table></CollapsibleContent></Collapsible><Collapsible><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />计算口径与解释边界</Button></CollapsibleTrigger><CollapsibleContent className="flex flex-col gap-3 pt-3">{analysis.notes.map((note, index) => <p key={index} className="text-xs text-muted-foreground">{note}</p>)}</CollapsibleContent></Collapsible></>}</section>;
}
