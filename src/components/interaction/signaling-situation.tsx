import { ArrowRight, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { RunView } from "./api";
import { signalingPayoffText } from "@/runtime/scenarios/payoffs";

const quality = (value?: boolean) => value === undefined ? "尚未公开" : value ? "高质量" : "低质量";

export function SignalingSituation({ run }: { run: RunView }) {
  const world = run.world;
  const name = (id?: string) => run.characters.find(c => c.id === id)?.name ?? "等待入场";
  return <section className="game-situation" aria-label="信息交易真实局势">
    <div className="arena-kicker"><span>ROUND {String(world.round ?? 1).padStart(2, "0")}</span><Badge variant="outline">{world.incentives === "aligned" ? "利益一致" : "利益冲突"}</Badge></div>
    <div className="transaction-line"><div><span>发送者 · 知道真值</span><strong>{name(world.senderId)}</strong></div><div className="transaction-amount"><strong>{world.accepted === undefined ? "等待选择" : world.accepted ? "接受交易" : "拒绝交易"}</strong><ArrowRight /></div><div><span>接收者 · 判断报告</span><strong>{name(world.receiverId)}</strong></div></div>
    <div className="transaction-facts"><span>正式报告<strong>{quality(world.reportedHighQuality)}</strong></span><span>公开真值<strong>{quality(world.highQuality)}</strong></span>
      {world.reportAccurate !== undefined && <Badge variant={world.reportAccurate ? "secondary" : "outline"}>{world.reportAccurate ? "报告与真值一致" : "报告与真值不一致"}</Badge>}
    </div>
    <p className="mt-2 text-xs text-muted-foreground">{signalingPayoffText(world.incentives ?? "conflicting", world.payoffProfile ?? "legacy")}</p>
    {Boolean(world.history?.length) && <Collapsible className="mt-2"><CollapsibleTrigger asChild><Button variant="ghost" size="sm"><ChevronDown data-icon="inline-start" />逐轮核验 · {world.history!.length}</Button></CollapsibleTrigger><CollapsibleContent className="max-h-44 overflow-y-auto">
      <Table aria-label="信息交易结算记录"><TableHeader><TableRow><TableHead>轮次</TableHead><TableHead>报告 / 真值</TableHead><TableHead>选择</TableHead><TableHead>所得 · 发送 / 接收</TableHead></TableRow></TableHeader><TableBody>{world.history!.map(row => <TableRow key={row.round}><TableCell>{row.round}</TableCell><TableCell>{quality(row.reportedHighQuality)} / {quality(row.highQuality)}</TableCell><TableCell>{row.accepted ? "接受" : "拒绝"}</TableCell><TableCell>{row.payoffs[row.senderId]} / {row.payoffs[row.receiverId]}</TableCell></TableRow>)}</TableBody></Table>
    </CollapsibleContent></Collapsible>}
  </section>;
}
