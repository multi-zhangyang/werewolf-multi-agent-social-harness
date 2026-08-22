import { memo, type ReactNode } from "react";
import { ArrowRight, ChevronDown } from "lucide-react";
import type { SocietyRoomSnapshot } from "@/society/room";
import type {
  DeceptionEpisode,
  DirectedRelationshipState,
  OutcomeReconciliation,
  SocialCausalityProjection
} from "@/society/social/contracts";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { provenanceBadge } from "./shared";

/**
 * The right rail: one flat, scrollable causality column. No nested tabs —
 * every section is a one-click accordion answering one spectator question.
 */

interface CausalityPanelProps {
  room: SocietyRoomSnapshot;
  viewerMode: string | undefined;
  viewerPrivileged: boolean;
}

export const CausalityPanel = memo(function CausalityPanel({ room, viewerPrivileged }: CausalityPanelProps): ReactNode {
  const projection = room.world.details.socialCausality as SocialCausalityProjection | undefined;
  const names = new Map(room.world.agents.map((agent) => [agent.id, agent.displayName]));
  const characterNames = new Map(room.world.agents.map((agent) => [agent.characterId, agent.displayName]));
  const actorName = (id: string | undefined): string => (id ? names.get(id) ?? characterNames.get(id) ?? id : "—");
  const omniscient = viewerPrivileged;

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-1.5 p-3">
        <ScoreSection room={room} />
        <SuspicionSection room={room} />
        <BeliefSection projection={projection} characterNames={characterNames} />
        <CommitmentSection projection={projection} actorName={actorName} />
        <DeceptionSection projection={projection} actorName={actorName} propositions={new Map((projection?.propositions ?? []).map((entry) => [entry.propositionId, entry]))} />
        <RelationshipSection projection={projection} characterNames={characterNames} />
        {omniscient ? <OutcomeSection projection={projection} actorName={actorName} /> : null}
        {!projection || totalRecords(projection) === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">因果账本为空——记录出现后会在这里按来源分层展示。</p>
        ) : null}
      </div>
    </ScrollArea>
  );
});

function totalRecords(projection: SocialCausalityProjection): number {
  return projection.beliefUpdates.length + projection.commitments.length + projection.deceptions.length
    + projection.directedRelationships.length + projection.outcomeReconciliations.length;
}

/** One flat accordion section; first section defaults open. */
function Section({ title, count, children, defaultOpen = false }: { title: string; count?: number; children: ReactNode; defaultOpen?: boolean }): ReactNode {
  return (
    <Collapsible defaultOpen={defaultOpen} className="group/section rounded-lg border bg-card/40">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-muted/30">
        {title}
        {count !== undefined && count > 0 ? <Badge variant="secondary" className="ml-0.5 font-mono text-[10px]">{count}</Badge> : null}
        <ChevronDown className="ml-auto size-3.5 text-muted-foreground transition-transform group-data-[state=open]/section:rotate-180" aria-hidden />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 border-t border-border/60 px-3 py-2.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ScoreSection({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const ranked = [...room.world.agents].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  if (!ranked.some((agent) => (agent.score ?? 0) !== 0)) return null;
  return (
    <Section title="战况" defaultOpen>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {ranked.map((agent) => (
          <li key={agent.id} className="flex items-baseline justify-between gap-2">
            <span className="truncate">{agent.displayName}{agent.observerRole ? <span className="ml-1 text-muted-foreground">· {agent.observerRole}</span> : null}</span>
            <span className="font-mono">{agent.score ?? "-"}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function SuspicionSection({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const suspicion = room.world.details.suspicion as { entries?: Array<{ accuser: string; target: string; kind: string }> } | undefined;
  const entries = (suspicion?.entries ?? []).slice(-6).reverse();
  if (!entries.length) return null;
  const names = new Map(room.world.agents.map((agent) => [agent.id, agent.displayName]));
  return (
    <Section title="公开怀疑" count={entries.length}>
      <ul className="space-y-1 text-xs">
        {entries.map((entry, index) => (
          <li key={`${entry.accuser}-${entry.target}-${index}`} className="flex items-center gap-1.5">
            <span className="truncate">{names.get(entry.accuser) ?? entry.accuser}</span>
            <ArrowRight className="size-3 shrink-0 text-rose-400" aria-hidden />
            <span className="truncate font-medium">{names.get(entry.target) ?? entry.target}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function BeliefSection({ projection, characterNames }: {
  projection: SocialCausalityProjection | undefined;
  characterNames: Map<string, string>;
}): ReactNode {
  const updates = [...(projection?.beliefUpdates ?? [])].sort((left, right) => left.logicalTime - right.logicalTime);
  if (!updates.length) return null;
  const propositions = new Map((projection?.propositions ?? []).map((entry) => [entry.propositionId, entry]));
  const groups = new Map<string, typeof updates>();
  for (const update of updates) {
    const key = `${update.ownerCharacterId}:${update.propositionId}`;
    const list = groups.get(key) ?? [];
    list.push(update);
    groups.set(key, list);
  }
  return (
    <Section title="信念时间线" count={updates.length}>
      {[...groups.values()].slice(-8).reverse().map((group) => {
        const proposition = propositions.get(group[0].propositionId);
        return (
          <div key={group[0].beliefId} className="rounded-md border border-border/50 p-2">
            <p className="text-xs font-medium">{characterNames.get(group[0].ownerCharacterId) ?? group[0].ownerCharacterId}</p>
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{proposition?.predicate ?? group[0].propositionId}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {group.slice(-4).map((update) => (
                <Badge key={update.beliefUpdateId} variant="outline" className="font-mono text-[10px]">
                  {Math.round(update.beforeProbability * 100)}→{Math.round(update.afterProbability * 100)}%
                </Badge>
              ))}
              {provenanceBadge("agent-self-report")}
            </div>
          </div>
        );
      })}
    </Section>
  );
}

function CommitmentSection({ projection, actorName }: {
  projection: SocialCausalityProjection | undefined;
  actorName: (id: string | undefined) => string;
}): ReactNode {
  const commitments = [...(projection?.commitments ?? [])].reverse();
  if (!commitments.length) return null;
  return (
    <Section title="承诺账本" count={commitments.length}>
      {commitments.map((commitment) => (
        <div key={commitment.commitmentId} className="rounded-md border border-border/50 p-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">{actorName(commitment.promisorActorId)}</span>
            <Badge variant={commitment.state === "violated" ? "destructive" : commitment.state === "fulfilled" ? "secondary" : "outline"} className="text-[10px]">
              {commitmentStateLabel(commitment.state)}
            </Badge>
            {provenanceBadge("message-claim")}
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{commitment.proposition}</p>
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            对象 {commitment.audienceActorIds.map(actorName).join("、")}{promisedActionText(commitment)}
          </p>
        </div>
      ))}
    </Section>
  );
}

function promisedActionText(commitment: SocialCausalityProjection["commitments"][number]): string {
  const action = commitment.promisedAction as Record<string, unknown> | undefined;
  if (!action) return "";
  if (action.actionType === "return-ratio") return ` · 承诺返还 ≥ 投资额的 ${String(action.amount)}%`;
  if (action.actionType === "return-at-least") return ` · 承诺返还 ≥ ${String(action.amount)}`;
  if (action.actionType === "invest-at-least") return ` · 承诺投入 ≥ ${String(action.amount)}`;
  return "";
}

const DECEPTION_STAGES = ["计划", "实施", "接收", "相信", "改变行动", "识破", "修复"] as const;
const STAGE_OF: Record<string, number> = {
  planned: 0, attempted: 1, received: 2, believed: 3,
  "behaviorally-effective": 4, detected: 5, "repair-attempted": 5, repaired: 6
};

function DeceptionSection({ projection, actorName, propositions }: {
  projection: SocialCausalityProjection | undefined;
  actorName: (id: string | undefined) => string;
  propositions: Map<string, SocialCausalityProjection["propositions"][number]>;
}): ReactNode {
  const episodes = [...(projection?.deceptions ?? [])].reverse();
  if (!episodes.length) return null;
  return (
    <Section title="欺骗生命周期" count={episodes.length}>
      {episodes.map((episode) => (
        <DeceptionCard key={episode.deceptionId} episode={episode} actorName={actorName} propositions={propositions} />
      ))}
    </Section>
  );
}

function DeceptionCard({ episode, actorName, propositions }: {
  episode: DeceptionEpisode;
  actorName: (id: string | undefined) => string;
  propositions: Map<string, SocialCausalityProjection["propositions"][number]>;
}): ReactNode {
  const reached = STAGE_OF[episode.status] ?? -1;
  return (
    <div className="rounded-md border border-border/50 p-2">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">{actorName(episode.deceiverActorId)}</span>
        <Badge variant={episode.status === "detected" ? "destructive" : "outline"} className="text-[10px]">{deceptionStatusLabel(episode.status)}</Badge>
        {provenanceBadge("agent-self-report")}
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
        {episode.intendedFalseBeliefIds.map((id) => propositions.get(id)?.predicate).filter(Boolean).join("；") || "目标命题未引用"}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[10px]">
        {DECEPTION_STAGES.map((stage, index) => (
          <span key={stage} className={cn(index <= reached ? "font-medium text-foreground" : "text-muted-foreground/45")}>
            {index <= reached ? stage : `${stage}?`}{index < DECEPTION_STAGES.length - 1 ? <span className="mx-0.5 opacity-40">→</span> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function RelationshipSection({ projection, characterNames }: {
  projection: SocialCausalityProjection | undefined;
  characterNames: Map<string, string>;
}): ReactNode {
  const relationships = [...(projection?.directedRelationships ?? [])];
  if (!relationships.length) return null;
  return (
    <Section title="有向关系" count={relationships.length}>
      {relationships.map((relationship) => (
        <DirectedEdge key={relationship.relationshipId} relationship={relationship} nameFor={(id) => characterNames.get(id) ?? id} />
      ))}
    </Section>
  );
}

function DirectedEdge({ relationship, nameFor }: { relationship: DirectedRelationshipState; nameFor: (id: string) => string }): ReactNode {
  return (
    <div className="rounded-md border border-border/50 p-2 text-xs">
      <p className="flex items-center gap-1.5 font-medium">
        {nameFor(relationship.ownerCharacterId)}
        <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
        {nameFor(relationship.targetCharacterId)}
        {provenanceBadge(relationship.provenance.sourceKind)}
      </p>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        <Metric label="信任" value={relationship.trust} />
        <Metric label="好感" value={relationship.affinity} />
        <Metric label="尊重" value={relationship.respect} />
        <Metric label="张力" value={relationship.tension} />
      </dl>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="font-mono">{value.toFixed(2)}</dd>
    </div>
  );
}

function OutcomeSection({ projection, actorName }: {
  projection: SocialCausalityProjection | undefined;
  actorName: (id: string | undefined) => string;
}): ReactNode {
  const reconciliations = [...(projection?.outcomeReconciliations ?? [])].reverse().slice(0, 6);
  const links = (projection?.influenceLinks ?? []).slice(-6).reverse();
  if (!reconciliations.length && !links.length) return null;
  return (
    <Section title="结果对账（全知）" count={reconciliations.length + links.length}>
      {reconciliations.map((reconciliation) => (
        <OutcomeRow key={reconciliation.reconciliationId} reconciliation={reconciliation} actorName={actorName} />
      ))}
      {links.map((link) => (
        <p key={link.influenceId} className="text-[11px] leading-4 text-muted-foreground">
          可能影响 {actorName(link.targetCharacterId)} · {influenceBasisLabel(link.basis)} · 置信 {Math.round(link.confidence * 100)}%
        </p>
      ))}
    </Section>
  );
}

function OutcomeRow({ reconciliation, actorName }: { reconciliation: OutcomeReconciliation; actorName: (id: string | undefined) => string }): ReactNode {
  return (
    <div className="rounded-md border border-border/50 p-2 text-[11px] leading-4">
      <p className="font-medium">{actorName(reconciliation.actorId)}</p>
      <p className="text-muted-foreground">{reconciliation.actualOutcome.summary}</p>
      {reconciliation.predictionAssessments.length ? (
        <p className="mt-0.5 text-[10px] text-muted-foreground/70">
          预测结算 {reconciliation.predictionAssessments.length} 项 · 命中 {reconciliation.predictionAssessments.filter((assessment) => assessment.actual).length}
        </p>
      ) : null}
    </div>
  );
}

function influenceBasisLabel(basis: string): string {
  const labels: Record<string, string> = {
    "agent-cited": "Agent 明确引用",
    "direct-commitment-reference": "直接引用承诺",
    "temporal-association": "时间关联",
    "counterfactual-replay": "反事实重放",
    "observer-inferred": "系统推断"
  };
  return labels[basis] ?? basis;
}

function deceptionStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planned: "计划中", attempted: "已执行", received: "已接收", believed: "已相信",
    "behaviorally-effective": "已影响行动", failed: "未奏效", abandoned: "已放弃",
    detected: "已识破", "repair-attempted": "修复中", repaired: "已修复"
  };
  return labels[status] ?? status;
}

function commitmentStateLabel(state: string): string {
  return state === "proposed" ? "待接受" : state === "accepted" ? "已接受" : state === "fulfilled" ? "已履约" : state === "violated" ? "已违约" : "已作废";
}

