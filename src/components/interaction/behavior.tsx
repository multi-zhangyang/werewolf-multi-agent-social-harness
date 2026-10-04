import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { summarizeBehavior } from "@/runtime/behavior";
import type { RunView } from "./api";

export function BehaviorComparison({ run }: { run: RunView }) {
  const rows = summarizeBehavior(run.characters, run.events);
  const actions = run.events.filter(e => e.type === "action");
  return <div className="flex flex-col gap-6 pt-6">
    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{run.spec?.experiment.personality === "persona-only" ? "仅文字人设" : run.spec?.experiment.personality === "full" ? "完整人格" : "历史版本 · 人格条件未记录"}</Badge><p className="text-xs text-muted-foreground">比较设定与实际行为；单局差异不能证明人格的因果效应。</p></div>
    <div className="behavior-grid">{rows.map((row, i) => <Card key={row.character.id}><CardHeader><div className="mb-2 flex items-center gap-3"><Avatar data-tone={i % 5}><AvatarFallback>{row.character.name.slice(-2)}</AvatarFallback></Avatar><CardTitle>{row.character.name}</CardTitle></div><CardDescription>{row.character.traits?.join(" · ") || row.character.values.join(" · ")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-5"><dl className="behavior-counts"><div><dt>公开发言</dt><dd>{row.publicMessages}</dd></div><div><dt>私聊 / 队内</dt><dd>{row.privateMessages}</dd></div><div><dt>实际行动</dt><dd>{row.actions.length}</dd></div></dl><p className="text-xs text-muted-foreground">平均 {row.averageCharacters ?? "—"} 字 / 条 · 完全文字重复 {row.exactRepeats} 次</p>{row.latestMessage ? <blockquote className="evidence-quote"><p>{row.latestMessage.text}</p><cite>最近一次发言 · 事件 #{row.latestMessage.seq}</cite></blockquote> : <p className="text-sm text-muted-foreground">还没有发言记录</p>}</CardContent></Card>)}</div>
    <Card><CardHeader><CardTitle>他们最后做了什么</CardTitle><CardDescription>金额、目标和时序来自实际提交事件。发言中的意向不计为行动。</CardDescription></CardHeader><CardContent>{actions.length ? <Table><TableHeader><TableRow><TableHead>轮次</TableHead><TableHead>人物</TableHead><TableHead>行动结果</TableHead><TableHead>证据</TableHead></TableRow></TableHeader><TableBody>{actions.map(e => <TableRow key={e.id}><TableCell>{typeof e.data.round === "number" ? e.data.round : "—"}</TableCell><TableCell>{run.characters.find(c => c.id === e.actorId)?.name ?? "—"}</TableCell><TableCell className="whitespace-normal">{e.text}</TableCell><TableCell>#{e.seq}</TableCell></TableRow>)}</TableBody></Table> : <Empty><EmptyHeader><EmptyTitle>等待第一次行动</EmptyTitle><EmptyDescription>行动提交后，可以在这里对照人物的说法与选择。</EmptyDescription></EmptyHeader></Empty>}</CardContent></Card>
  </div>;
}
