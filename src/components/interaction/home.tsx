import { useState } from "react";
import { ArrowRight, ArrowUpRight, FlaskConical, Play, Settings2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createRun, scenarioNames, statusNames, type Catalog, type RunSummary } from "./api";
import { initialHybridCognition } from "./cognition-settings";

export function InteractionHome({ catalog, runs, archives }: { catalog: Catalog; runs: RunSummary[]; archives: Array<{ id: string; title: string; finishedAt: string }> }) {
  const [first, setFirst] = useState(catalog.characters[0]?.id ?? "");
  const [second, setSecond] = useState(catalog.characters[2]?.id ?? catalog.characters[1]?.id ?? "");
  const [busy, setBusy] = useState<"play" | "observe">(); const [error, setError] = useState("");
  async function start(mode: "play" | "observe") {
    setBusy(mode); setError("");
    try { await createRun({ scenario: "trust-game", trustProtocol: "pledge-repair", mode: "experiment", worldId: "trust-play", rounds: 3, seed: 1,
      roster: [first, second].map((characterId, index) => ({ characterId, modelProfileId: catalog.defaultModel, human: mode === "play" && index === 0 })),
      experiment: { personality: "full", objective: "character", psychology: "hybrid", relationshipMemory: true, speaking: "round-robin" }, cognition: initialHybridCognition,
      budgets: { discussionTurns: 2, maxTurns: 8, humanTimeoutMs: 300000 } }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(undefined); }
  }
  const disabled = Boolean(busy) || !first || !second || first === second || !catalog.defaultModel;
  return <div className="lab-home flex flex-col gap-8">
    <header className="lab-header"><div><span className="eyebrow">SOCIETY</span><h1>心理博弈工作台</h1><p className="text-sm text-muted-foreground">同一个人物，在不同处境中判断、博弈并从结果中学习。</p></div><Badge variant="outline">{catalog.models.length} 个可用模型</Badge></header>
    <section className="flex flex-col gap-4" aria-label="多场景互动"><div className="section-heading"><h2>选择下一段经历</h2><Badge variant="secondary">连续人物 · 跨场景记忆</Badge></div><p className="text-sm text-muted-foreground">连续互动会继承这个世界中人物最新的经历、关系判断与学习记录。新局重新分配的身份保持独立。</p><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{catalog.scenarios.map(s => <Card key={s.id}><CardHeader><CardTitle>{s.name}</CardTitle><CardDescription>{{ "trust-game": "承诺、兑现与关系修复", "public-goods": "多人合作、搭便车与集体收益", werewolf: "隐藏身份、推断与策略性表达", "signaling-game": "私有真值、报告核验与利益冲突" }[s.id]}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3"><p className="text-sm text-muted-foreground">{s.playerRange ? `${s.playerRange.min}–${s.playerRange.max}` : s.players} 位参与者</p><Button variant="outline" asChild><a href={`#/create?scenario=${s.id}&mode=continuity`}>配置互动<ArrowRight data-icon="inline-end" /></a></Button></CardContent></Card>)}</div><Button variant="ghost" className="w-fit" asChild><a href="#/partners">合伙人专项实验与历史记录<ArrowUpRight data-icon="inline-end" /></a></Button></section>
    <div className="grid gap-6 xl:grid-cols-2">
      <Card><CardHeader><CardDescription>PLAY · 承诺与修复</CardDescription><CardTitle>和 AI 对局</CardTitle></CardHeader><CardContent><FieldGroup>
        <Field><FieldLabel>我扮演谁 / AI 对手</FieldLabel><div className="grid grid-cols-2 gap-3">{[first, second].map((id, i) => <Select key={i} value={id} onValueChange={i ? setSecond : setFirst}><SelectTrigger aria-label={i ? "AI 对手" : "我扮演的人物"}><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{catalog.characters.filter(c => c.id !== (i ? first : second)).map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectGroup></SelectContent></Select>)}</div><FieldDescription>你控制第一个人物的发言和金额，AI 控制另一位。</FieldDescription></Field>
        <div className="flex flex-col gap-2 text-sm"><p>每轮投资者有 10 点，投入会变成 3 倍交给对方。对方先承诺比例，再自主决定实际返还，也可以违约或事后补偿。</p><p className="text-muted-foreground">共三轮，双方轮换角色。你可以追问、试探、守约或反悔；最后比较真实所得。</p></div>
        {error && <Alert><AlertDescription>{error}<Button variant="link" asChild><a href="#/settings">检查管理访问与模型设置</a></Button></AlertDescription></Alert>}
        <div className="flex flex-wrap gap-2"><Button size="lg" disabled={disabled} onClick={() => void start("play")}>{busy === "play" ? <Spinner /> : <Play data-icon="inline-start" />}我来对局</Button><Button variant="outline" size="lg" disabled={disabled} onClick={() => void start("observe")}>{busy === "observe" ? <Spinner /> : null}观察 AI 对局</Button></div>
        <Button variant="ghost" className="w-fit" asChild><a href="#/create?mode=experiment&play=true"><Settings2 data-icon="inline-start" />自定义人物与对局</a></Button>
      </FieldGroup></CardContent></Card>
      <Card><CardHeader><CardDescription>RESEARCH · 干预与证据</CardDescription><CardTitle>设置心理实验</CardTitle></CardHeader><CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2"><strong className="text-sm">心理初态与私下目标</strong><p className="text-sm text-muted-foreground">设置人物的初始情绪、对对方意愿和能力的判断，以及只给本人知道的目标。每次注入都有记录，随后由 Agent 自主评价与决策。</p><Button variant="outline" className="w-fit" asChild><a href="#/create?mode=experiment"><FlaskConical data-icon="inline-start" />配置心理实验<ArrowRight data-icon="inline-end" /></a></Button></div>
        <div className="flex flex-col gap-2"><strong className="text-sm">同一场背叛，三个修复条件</strong><p className="text-sm text-muted-foreground">比较无道歉、只有道歉、道歉加真实补偿。固定条件、独立分支、保留失败，导出返还、收益及预测结果。</p><Button variant="outline" className="w-fit" asChild><a href="#/studies">受控修复实验<ArrowRight data-icon="inline-end" /></a></Button></div>
        <p className="text-sm text-muted-foreground">研究视角可对照人物的私有意图、公开表达和实际结果；预测误差与回报会进入后续学习记录。</p>
      </CardContent></Card>
    </div>
    <section><div className="section-heading"><h2>对局与回放</h2><Button variant="ghost" asChild><a href="#/research">研究记录</a></Button></div>
      {runs.length ? <Table><TableHeader><TableRow><TableHead>参与者</TableHead><TableHead>场景</TableHead><TableHead>状态</TableHead><TableHead>打开</TableHead></TableRow></TableHeader><TableBody>{runs.map(run => <TableRow key={run.id}><TableCell><a className="flex items-center gap-3" href={`#/runs/${run.id}`}><div className="run-avatars">{run.characters.slice(0, 2).map(c => <Avatar key={c.id} className="size-8"><AvatarFallback>{c.name.slice(-2)}</AvatarFallback></Avatar>)}</div>{run.characters.map(c => c.name).join("、")}</a></TableCell><TableCell>{scenarioNames[run.scenario]}</TableCell><TableCell><Badge variant={run.status === "running" ? "default" : "secondary"}>{statusNames[run.status]}</Badge></TableCell><TableCell><Button variant="ghost" size="sm" asChild><a href={`#/runs/${run.id}`}>{["running", "paused"].includes(run.status) ? "进入对局" : "只读回放"}<ArrowUpRight data-icon="inline-end" /></a></Button></TableCell></TableRow>)}</TableBody></Table> : <Empty><EmptyHeader><EmptyTitle>还没有对局</EmptyTitle><EmptyDescription>从上方进入真人对局或设置实验。</EmptyDescription></EmptyHeader></Empty>}
    </section>
    {archives.length > 0 && <details><summary>早期归档 · {archives.length}</summary>{archives.map(a => <a className="block py-2" key={a.id} href={`#/archives/${a.id}`}>{a.title}</a>)}</details>}
  </div>;
}
