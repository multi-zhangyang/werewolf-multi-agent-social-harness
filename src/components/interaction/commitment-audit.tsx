import { commitmentAudit } from "@/runtime/commitment-audit";
import type { Character, WorldEvent } from "@/runtime/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function CommitmentAudit({ events, characters }: { events: WorldEvent[]; characters: Character[] }) {
  const rows = commitmentAudit(events);
  if (!rows.length) return <Empty><EmptyHeader><EmptyTitle>等待第一份公开承诺</EmptyTitle><EmptyDescription>新局会先保存 AI 的私下返还计划，随后对照公开承诺和真实结算。旧记录不补造意图。</EmptyDescription></EmptyHeader></Empty>;
  return <div className="flex flex-col gap-4"><p className="text-sm text-muted-foreground">私下计划是模型在承诺前的自述。承诺高于计划是值得检查的误导信号；低返还或违约本身不能证明欺骗。</p>{rows.map(row => <Card key={row.id}><CardHeader><CardDescription>第 {row.round} 轮 · {characters.find(c => c.id === row.actorId)?.name}</CardDescription><CardTitle><Badge variant="outline">{row.promiseAbovePlan ? "公开承诺高于私下计划" : row.intent ? "公开承诺未高于私下计划" : "缺少承诺前意图记录"}</Badge><Badge variant="secondary">{{ pending: "等待结算", kept: "已兑现", breached: "未兑现" }[row.status]}</Badge></CardTitle></CardHeader><CardContent className="flex flex-col gap-3"><Table><TableHeader><TableRow><TableHead>私下打算返还</TableHead><TableHead>公开承诺</TableHead><TableHead>最低承诺 / 实际返还</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell>{row.plannedPercent === undefined ? "未记录" : `${row.plannedPercent}%`}</TableCell><TableCell>{row.declaredPercent}%</TableCell><TableCell>{row.promisedPoints ?? "未结算"} / {row.returnedPoints ?? "未结算"}</TableCell></TableRow></TableBody></Table>{row.intent && <p className="text-sm">当时希望对方投 {row.intent.expectedInvestment} 点。{row.intent.purpose}</p>}<p className="text-xs text-muted-foreground">证据：{row.sourceIds.map(id => `#${events.find(e => e.id === id)?.seq}`).join(" · ")}</p></CardContent></Card>)}</div>;
}
