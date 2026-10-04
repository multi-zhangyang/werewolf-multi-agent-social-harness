import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isHybrid, psychologyFromEvent, strategyLabels } from "@/runtime/psychology";
import type { TrialResult, TrialSummary } from "@/runtime/studies";
import { json } from "./api";

const labels = { silence: "没有回应", apology: "只有道歉", compensation: "道歉 + 补偿" };
const order = ["silence", "apology", "compensation"] as const;
function stateAt(result: TrialResult | undefined, stage: string) {
  return psychologyFromEvent(result?.events.find(e => e.actorId === "self" && e.data.stageId === stage && psychologyFromEvent(e)));
}

export function StudyComparison({ studyId, trials }: { studyId: string; trials: TrialSummary[] }) {
  const [details, setDetails] = useState<TrialResult[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const readyKey = JSON.stringify(trials.filter(t => ["completed", "failed"].includes(t.status)).map(t => t.id));
  useEffect(() => {
    let active = true;
    setDetails([]); setErrors([]);
    const ids = JSON.parse(readyKey) as string[];
    void Promise.allSettled(ids.map(id => json<TrialResult>(`/api/v2/studies/${studyId}/trials/${id}`))).then(results => {
      if (!active) return;
      setDetails(results.flatMap(r => r.status === "fulfilled" ? [r.value] : []));
      setErrors(results.flatMap(r => r.status === "rejected" ? [String(r.reason)] : []));
    });
    return () => { active = false; };
  }, [studyId, readyKey]);
  if (!trials.some(t => t.mechanism !== "off")) return null;
  return <Card><CardHeader><CardTitle>判断怎样改变</CardTitle><CardDescription>按相同事件对齐；这里展示模拟主体的主观解释，金额来自实际结算。</CardDescription></CardHeader><CardContent>
    {errors.map((error, i) => <Alert key={i}><AlertDescription>{error}</AlertDescription></Alert>)}
    <Table><TableHeader><TableRow><TableHead>观察时点</TableHead>{order.map(c => <TableHead key={c}>{labels[c]}</TableHead>)}</TableRow></TableHeader><TableBody>
      {(["1:after-repair", "2:return", "3:invest"] as const).map(stage => <TableRow key={stage}>
        <TableCell className="align-top">{{ "1:after-repair": "面对修复条件", "2:return": "轮到自己返还", "3:invest": "再次决定投资" }[stage]}</TableCell>
        {order.map(condition => {
          const trial = trials.find(t => t.condition === condition);
          const detail = details.find(t => t.id === trial?.id);
          const state = stateAt(detail, stage); const baseline = stateAt(detail, "1:reflection");
          const relation = state?.relationships.find(r => r.targetId === "peer");
          const before = baseline?.relationships.find(r => r.targetId === "peer");
          return <TableCell key={condition} className="min-w-52 max-w-80 whitespace-normal align-top">
            {state ? <div className="flex flex-col gap-3"><Badge variant="outline">{strategyLabels[state.strategy.kind]}</Badge><p>{state.appraisal}</p>
              {relation && "willingness" in relation && <p className="text-xs text-muted-foreground">合作意愿 {before && "willingness" in before ? `${before.willingness.toFixed(2)} → ` : ""}{relation.willingness.toFixed(2)} · 能力 {relation.competence.toFixed(2)}</p>}
              {isHybrid(state) && <p className="text-xs text-muted-foreground">{{ reappraise: "重新理解", suppress: "克制表达", ruminate: "反复回想", repair: "主动修复", none: "暂不调节" }[state.regulation]}</p>}
            </div> : detail ? <span className="text-muted-foreground">{detail.status === "failed" ? "失败，未到达此时点" : "没有心理记录"}</span> : trial?.status === "completed" || trial?.status === "failed" ? <Skeleton className="h-20" /> : <span className="text-muted-foreground">等待该分支完成</span>}
          </TableCell>;
        })}
      </TableRow>)}
    </TableBody></Table>
  </CardContent></Card>;
}
