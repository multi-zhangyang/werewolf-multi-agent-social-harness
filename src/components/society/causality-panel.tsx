import { memo, useMemo, type ReactNode } from "react";
import { ArrowRight, Crown, Waypoints } from "lucide-react";
import type { SocietyRoomSnapshot } from "@/society/room";
import type {
  DeceptionEpisode,
  DirectedRelationshipState,
  OutcomeReconciliation,
  SocialActRecord,
  SocialCausalityProjection
} from "@/society/social/contracts";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { CollapsibleSection, ProvenanceDot } from "./shared";

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
  // Ledger prose (predicates, summaries) is model-written and can cite raw
  // ids like "agent-01"; rewrite every known id back into a display name.
  const hydrateText = useMemo(() => {
    const replacements = [...names.entries(), ...characterNames.entries()]
      .map(([id, name]) => [id, name] as const)
      .sort((left, right) => right[0].length - left[0].length);
    return (text: string): string => {
      let result = text;
      for (const [id, name] of replacements) {
        if (result.includes(id)) result = result.split(id).join(name);
      }
      return result;
    };
  }, [names, characterNames]);
  const omniscient = viewerPrivileged;
  const records = projection ? totalRecords(projection) : 0;

  return (
    <div className="panel flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <Waypoints className="size-3 text-muted-foreground" aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground/70">因果账本</span>
        {records > 0 ? <span className="nums ml-auto font-mono text-[10px] text-muted-foreground/50">{records}</span> : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-4">
          <ScoreSection room={room} />
          <SuspicionSection room={room} />
          <SocialActsSection projection={projection} actorName={actorName} hydrateText={hydrateText} propositions={new Map((projection?.propositions ?? []).map((entry) => [entry.propositionId, entry]))} />
          <BeliefSection projection={projection} characterNames={characterNames} hydrateText={hydrateText} />
          <CommitmentSection projection={projection} actorName={actorName} hydrateText={hydrateText} />
          <DeceptionSection projection={projection} actorName={actorName} hydrateText={hydrateText} propositions={new Map((projection?.propositions ?? []).map((entry) => [entry.propositionId, entry]))} />
          <RelationshipSection projection={projection} characterNames={characterNames} />
          {omniscient ? <OutcomeSection projection={projection} actorName={actorName} hydrateText={hydrateText} /> : null}
          {!projection || records === 0 ? (
            <Empty className="py-14">
              <EmptyHeader>
                <EmptyMedia variant="icon" className="text-muted-foreground">
                  <Waypoints className="size-4" />
                </EmptyMedia>
                <EmptyTitle className="text-sm">因果账本还是空的</EmptyTitle>
                <EmptyDescription className="text-xs">
                  承诺、信念、怀疑与欺骗的记录出现后，会在这里按来源分层展开——谁主张了什么、谁信了、世界如何对账。
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

function totalRecords(projection: SocialCausalityProjection): number {
  return spectatorActs(projection).length + projection.beliefUpdates.length + projection.commitments.length
    + projection.deceptions.length + projection.directedRelationships.length + projection.outcomeReconciliations.length;
}

/** High-signal acts worth a timeline row; assertions/questions stay in the ledger only. */
const SPECTATOR_ACT_KINDS: ReadonlySet<string> = new Set([
  "promise", "offer", "acceptance", "rejection", "accusation", "threat",
  "alliance-proposal", "warning", "denial", "apology"
]);

const ACT_KIND_LABELS: Record<string, string> = {
  assertion: "断言", denial: "否认", question: "提问", answer: "回答",
  promise: "承诺", offer: "报价", acceptance: "接受", rejection: "拒绝",
  request: "请求", threat: "威胁", accusation: "指控", defense: "辩护",
  apology: "道歉", "alliance-proposal": "结盟提议", disclosure: "披露",
  endorsement: "背书", warning: "警告"
};

function spectatorActs(projection: SocialCausalityProjection | undefined): SocialActRecord[] {
  return (projection?.socialActs ?? [])
    .filter((act) => SPECTATOR_ACT_KINDS.has(act.kind))
    .sort((left, right) => left.logicalTime - right.logicalTime);
}

function SocialActsSection({ projection, actorName, hydrateText, propositions }: {
  projection: SocialCausalityProjection | undefined;
  actorName: (id: string | undefined) => string;
  hydrateText: (text: string) => string;
  propositions: Map<string, SocialCausalityProjection["propositions"][number]>;
}): ReactNode {
  const acts = spectatorActs(projection).slice(-12).reverse();
  if (!acts.length) return null;
  return (
    <CollapsibleSection title="社会行为" count={acts.length} defaultOpen contentClassName="space-y-0">
      <ul>
        {acts.map((act) => (
          <li key={act.socialActId} className="border-b border-border/40 py-2.5 first:pt-0 last:border-b-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-5">
              <ProvenanceDot source="message-claim" note={act.extractionMethod === "model-extracted" ? `自动提取${act.confidence < 0.75 ? ` ${Math.round(act.confidence * 100)}%` : ""}` : undefined} />
              <span className={cn("font-medium",
                act.kind === "accusation" || act.kind === "threat" || act.kind === "rejection" ? "text-suspect"
                  : act.kind === "promise" || act.kind === "alliance-proposal" || act.kind === "acceptance" ? "text-live"
                    : act.kind === "warning" ? "text-warn" : undefined)}
              >
                {ACT_KIND_LABELS[act.kind] ?? act.kind}
              </span>
              <span className="truncate">{actorName(act.actorId)}</span>
              {act.targetActorIds.length ? (
                <>
                  <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate">{act.targetActorIds.map((id) => actorName(id)).join("、")}</span>
                </>
              ) : null}
            </div>
            {act.propositionIds.length ? (
              <p className="mt-1 line-clamp-2 pl-3 text-[11px] leading-5 text-muted-foreground">
                {hydrateText(act.propositionIds.map((id) => propositions.get(id)?.predicate).filter(Boolean).join("；"))}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}

function ScoreSection({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const ranked = [...room.world.agents].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  if (!ranked.some((agent) => (agent.score ?? 0) !== 0)) return null;
  // Ties lead together: everyone at the top score wears the crown.
  const topScore = ranked[0]?.score ?? 0;
  const leaders = new Set(ranked.filter((agent) => (agent.score ?? 0) > 0 && (agent.score ?? 0) === topScore).map((agent) => agent.id));
  return (
    <CollapsibleSection title="战况" defaultOpen>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {ranked.map((agent) => (
          <li key={agent.id} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">{agent.displayName}{agent.observerRole ? <span className="ml-1 text-muted-foreground">· {agent.observerRole}</span> : null}</span>
              {leaders.has(agent.id) ? <Crown className="size-3 shrink-0 text-warn" aria-label="暂时领先" /> : null}
            </span>
            <span className="nums shrink-0 font-mono tabular-nums">{agent.score ?? "-"}</span>
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}

function SuspicionSection({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const suspicion = room.world.details.suspicion as { entries?: Array<{ accuser: string; target: string; kind: string }> } | undefined;
  const entries = (suspicion?.entries ?? []).slice(-6).reverse();
  if (!entries.length) return null;
  const names = new Map(room.world.agents.map((agent) => [agent.id, agent.displayName]));
  return (
    <CollapsibleSection title="公开怀疑" count={entries.length}>
      <ul className="space-y-1 text-xs">
        {entries.map((entry, index) => (
          <li key={`${entry.accuser}-${entry.target}-${index}`} className="flex items-center gap-1.5">
            <span className="truncate">{names.get(entry.accuser) ?? entry.accuser}</span>
            <ArrowRight className="size-3 shrink-0 text-suspect" aria-hidden />
            <span className="truncate font-medium">{names.get(entry.target) ?? entry.target}</span>
          </li>
        ))}
      </ul>
    </CollapsibleSection>
  );
}

function BeliefSection({ projection, characterNames, hydrateText }: {
  projection: SocialCausalityProjection | undefined;
  characterNames: Map<string, string>;
  hydrateText: (text: string) => string;
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
    <CollapsibleSection title="信念时间线" count={updates.length} contentClassName="space-y-0">
      {[...groups.values()].slice(-8).reverse().map((group) => {
        const proposition = propositions.get(group[0].propositionId);
        return (
          <div key={group[0].beliefId} className="border-b border-border/40 py-2.5 first:pt-0 last:border-b-0 last:pb-0">
            <p className="text-xs font-medium">{characterNames.get(group[0].ownerCharacterId) ?? group[0].ownerCharacterId}</p>
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{hydrateText(proposition?.predicate ?? group[0].propositionId)}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {group.slice(-4).map((update) => (
                <Badge key={update.beliefUpdateId} variant="outline" className="rounded-full border-border/70 bg-muted/50 font-mono text-[10px]">
                  {Math.round(update.beforeProbability * 100)}→{Math.round(update.afterProbability * 100)}%
                </Badge>
              ))}
              <ProvenanceDot source="agent-self-report" />
            </div>
          </div>
        );
      })}
    </CollapsibleSection>
  );
}

function CommitmentSection({ projection, actorName, hydrateText }: {
  projection: SocialCausalityProjection | undefined;
  actorName: (id: string | undefined) => string;
  hydrateText: (text: string) => string;
}): ReactNode {
  const commitments = [...(projection?.commitments ?? [])].reverse();
  if (!commitments.length) return null;
  return (
    <CollapsibleSection title="承诺账本" count={commitments.length} contentClassName="space-y-0">
      {commitments.map((commitment) => (
        <div key={commitment.commitmentId} className="border-b border-border/40 py-2.5 first:pt-0 last:border-b-0 last:pb-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium">{actorName(commitment.promisorActorId)}</span>
            <Badge variant={commitment.state === "violated" ? "destructive" : commitment.state === "fulfilled" ? "secondary" : "outline"} className="text-[10px]">
              {commitmentStateLabel(commitment.state)}
            </Badge>
            <ProvenanceDot source="message-claim" />
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-foreground/85">{hydrateText(commitment.proposition)}</p>
          <p className="mt-1 text-[10px] text-muted-foreground/70">
            对象 {commitment.audienceActorIds.map(actorName).join("、")}{promisedActionText(commitment)}
          </p>
        </div>
      ))}
    </CollapsibleSection>
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

function DeceptionSection({ projection, actorName, hydrateText, propositions }: {
  projection: SocialCausalityProjection | undefined;
  actorName: (id: string | undefined) => string;
  hydrateText: (text: string) => string;
  propositions: Map<string, SocialCausalityProjection["propositions"][number]>;
}): ReactNode {
  const episodes = [...(projection?.deceptions ?? [])].reverse();
  if (!episodes.length) return null;
  return (
    <CollapsibleSection title="欺骗生命周期" count={episodes.length} contentClassName="space-y-0">
      {episodes.map((episode) => (
        <DeceptionCard key={episode.deceptionId} episode={episode} actorName={actorName} hydrateText={hydrateText} propositions={propositions} />
      ))}
    </CollapsibleSection>
  );
}

function DeceptionCard({ episode, actorName, hydrateText, propositions }: {
  episode: DeceptionEpisode;
  actorName: (id: string | undefined) => string;
  hydrateText: (text: string) => string;
  propositions: Map<string, SocialCausalityProjection["propositions"][number]>;
}): ReactNode {
  const reached = STAGE_OF[episode.status] ?? -1;
  return (
    <div className="border-b border-border/40 py-2.5 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium">{actorName(episode.deceiverActorId)}</span>
        <Badge variant={episode.status === "detected" ? "destructive" : "outline"} className="text-[10px]">{deceptionStatusLabel(episode.status)}</Badge>
        <ProvenanceDot source="agent-self-report" />
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
        {hydrateText(episode.intendedFalseBeliefIds.map((id) => propositions.get(id)?.predicate).filter(Boolean).join("；")) || "目标命题未引用"}
      </p>
      {/* Lifecycle as chips: solid = reached, dashed + "?" = still unknown. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {DECEPTION_STAGES.map((stage, index) => (
          <span
            key={stage}
            className={cn(
              "rounded-full border px-1.5 py-px text-[9px] leading-3.5",
              index <= reached
                ? "border-foreground/20 bg-muted/60 font-medium text-foreground"
                : "border-dashed border-border/80 text-muted-foreground/45"
            )}
          >
            {stage}{index <= reached ? "" : "?"}
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
    <CollapsibleSection title="有向关系" count={relationships.length} contentClassName="space-y-0">
      {relationships.map((relationship) => (
        <DirectedEdge key={relationship.relationshipId} relationship={relationship} nameFor={(id) => characterNames.get(id) ?? id} />
      ))}
    </CollapsibleSection>
  );
}

function DirectedEdge({ relationship, nameFor }: { relationship: DirectedRelationshipState; nameFor: (id: string) => string }): ReactNode {
  return (
    <div className="border-b border-border/40 py-2.5 text-xs first:pt-0 last:border-b-0 last:pb-0">
      <p className="flex items-center gap-1.5 font-medium">
        <ProvenanceDot source={relationship.provenance.sourceKind} />
        {nameFor(relationship.ownerCharacterId)}
        <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
        {nameFor(relationship.targetCharacterId)}
      </p>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
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
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0">{label}</dt>
      <dd className="nums font-mono tabular-nums text-foreground/80">{value.toFixed(2)}</dd>
    </div>
  );
}

function OutcomeSection({ projection, actorName, hydrateText }: {
  projection: SocialCausalityProjection | undefined;
  actorName: (id: string | undefined) => string;
  hydrateText: (text: string) => string;
}): ReactNode {
  const reconciliations = [...(projection?.outcomeReconciliations ?? [])].reverse().slice(0, 6);
  if (!reconciliations.length) return null;
  return (
    <CollapsibleSection title="结果对账（全知）" count={reconciliations.length} contentClassName="space-y-0">
      {reconciliations.map((reconciliation) => (
        <OutcomeRow key={reconciliation.reconciliationId} reconciliation={reconciliation} actorName={actorName} hydrateText={hydrateText} />
      ))}
    </CollapsibleSection>
  );
}

function OutcomeRow({ reconciliation, actorName, hydrateText }: { reconciliation: OutcomeReconciliation; actorName: (id: string | undefined) => string; hydrateText: (text: string) => string }): ReactNode {
  return (
    <div className="border-b border-border/40 py-2.5 text-[11px] leading-4 first:pt-0 last:border-b-0 last:pb-0">
      <p className="font-medium">{actorName(reconciliation.actorId)}</p>
      <p className="mt-0.5 text-muted-foreground">{hydrateText(reconciliation.actualOutcome.summary)}</p>
    </div>
  );
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

