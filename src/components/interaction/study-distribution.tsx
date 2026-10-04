import { useState } from "react";
import { CartesianGrid, Scatter, ScatterChart, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { interval } from "@/runtime/study-metrics";
import type { TrialSummary } from "@/runtime/studies";

const metrics = { returnedShare: "返还比例", repair: "主动补偿", investment: "后续投资", score: "累计收益" };
const conditions = ["silence", "apology", "compensation"];
const labels = ["没有回应", "只有道歉", "道歉 + 补偿"];
type Metric = keyof typeof metrics;
const number = (n?: number) => n === undefined ? "—" : n.toFixed(2);
const range = (value: ReturnType<typeof interval>) => value?.low == null ? "样本不足" : `${number(value.low)} – ${number(value.high!)}`;

export function StudyDistribution({ trials, mechanism, trait }: { trials: TrialSummary[]; mechanism: string; trait: string }) {
  const [metric, setMetric] = useState<Metric>("returnedShare");
  const eligible = trials.filter(t => t.status === "completed" && t.mechanism === mechanism && t[metric] !== undefined);
  const selected = eligible.filter(t => t.agreeableness === Number(trait));
  const groups = conditions.map(condition => {
    const rows = selected.filter(t => t.condition === condition);
    const values = rows.map(t => t[metric]!);
    const differences = eligible.filter(t => t.agreeableness === .2 && t.condition === condition).flatMap(low => {
      const high = eligible.find(t => t.agreeableness === .8 && t.condition === condition && t.repeat === low.repeat && t.context === low.context && t.effort === low.effort);
      return high ? [high[metric]! - low[metric]!] : [];
    });
    return { condition, values, summary: interval(values), difference: interval(differences) };
  });
  const points = groups.flatMap((g, x) => g.values.map((value, i) => ({ x: x + (i - (g.values.length - 1) / 2) * .07, value, label: labels[x], repeat: selected.filter(t => t.condition === g.condition)[i].repeat + 1 })));
  return <Card><CardHeader><CardTitle>每一次真实选择</CardTitle><CardDescription>一个点是一条已完成分支。水平错开仅用于区分重叠样本；失败和缺失不计为零。</CardDescription></CardHeader><CardContent className="flex flex-col gap-5">
    <ToggleGroup type="single" variant="outline" value={metric} onValueChange={v => { if (v) setMetric(v as Metric); }} className="flex-wrap">{Object.entries(metrics).map(([key, label]) => <ToggleGroupItem key={key} value={key}>{label}</ToggleGroupItem>)}</ToggleGroup>
    {points.length ? <ChartContainer config={{ value: { label: metrics[metric], color: "var(--foreground)" } }} className="h-64 w-full"><ScatterChart accessibilityLayer margin={{ top: 12, right: 16, bottom: 8, left: 0 }}><CartesianGrid vertical={false} /><XAxis type="number" dataKey="x" domain={[-.5, 2.5]} ticks={[0, 1, 2]} tickFormatter={x => labels[x] ?? ""} tickLine={false} axisLine={false} /><YAxis type="number" dataKey="value" domain={metric === "returnedShare" ? [0, 1] : [0, "auto"]} tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent hideLabel formatter={(value, name, item) => name === "value" ? <span>{item.payload.label} · 重复 {item.payload.repeat}<br />{metrics[metric]}：{Number(value).toFixed(2)}</span> : null} />} /><Scatter data={points} fill="var(--color-value)" isAnimationActive={false} /></ScatterChart></ChartContainer> : <Empty><EmptyHeader><EmptyTitle>等待实际行动</EmptyTitle><EmptyDescription>完成试验后，这里会显示完整分布。</EmptyDescription></EmptyHeader></Empty>}
    <Table><TableHeader><TableRow><TableHead>条件</TableHead><TableHead>全部有效值</TableHead><TableHead>均值</TableHead><TableHead>95% 区间</TableHead><TableHead>高 − 低宜人性</TableHead><TableHead>差值 95% 区间 / 配对数</TableHead></TableRow></TableHeader><TableBody>{groups.map((g, i) => <TableRow key={g.condition}><TableCell>{labels[i]}</TableCell><TableCell>{g.values.map(v => number(v)).join(" · ") || "—"}</TableCell><TableCell>{number(g.summary?.mean)}</TableCell><TableCell>{range(g.summary)}</TableCell><TableCell>{number(g.difference?.mean)}</TableCell><TableCell>{range(g.difference)} / {g.difference?.n ?? 0}</TableCell></TableRow>)}</TableBody></Table>
    <p className="text-xs text-muted-foreground">探索性结果；差值按相同重复编号配对，区间为描述性 bootstrap，未校正多重比较。补偿条件同时改变资源与社会信号。</p>
  </CardContent></Card>;
}
