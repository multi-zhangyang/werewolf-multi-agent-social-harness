import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, ArrowRight, BarChart3, BrainCircuit, ChevronDown, Clapperboard, Crosshair, Flame, GitBranch, ListOrdered, MessageSquare, Network, Radio, Sparkles, Wrench } from "lucide-react";
import type { ScenarioId, WorldSnapshot } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import type { InfluenceLink, OutcomeReconciliation, SocialCausalityProjection } from "@/society/social/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { RoomConnection, TimelineEntry } from "./use-room";
import { AgentAvatar, StatusDot, StatusLabel, eventLabel, roleLabelZh } from "./shared";
import { RelationshipNetwork } from "./network";
import { timelineContextAround } from "@/society/spectator/projection";
import { toast } from "sonner";

interface DiscussionState {
  wave: number;
  open: boolean;
  messageCount: number;
  urgency: Record<string, number>;
  spokeCounts: Record<string, number>;
}

interface SuspicionState {
  scores: Record<string, number>;
  entries: Array<{ turn: number; accuser: string; target: string; kind: "speech" | "vote" | "outcome" }>;
}

export function WorldPanel({ room, toolCalls = [], timeline = [], onJumpToAt }: { room: SocietyRoomSnapshot; toolCalls?: RoomConnection["toolCalls"]; timeline?: TimelineEntry[]; onJumpToAt?: (at: string) => void }): ReactNode {
  const world = room.world;
  const names = new Map(world.agents.map((agent) => [agent.id, agent.displayName]));
  const avatarSeeds = new Map(room.participants.map((participant) => [participant.profile.id, participant.profile.characterId]));

  return (
    <div className="flex flex-col gap-3">
      <section>
        <div className="px-1 pb-3">
          <div className="flex items-center justify-between">
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
              <Radio className="size-3.5" />
              实时局势
            </p>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
              <StatusDot status={world.status} />
              <StatusLabel status={world.status} />
            </span>
          </div>
          <div className="mt-2 flex items-end justify-between">
            <div>
              <p className="text-lg font-semibold tracking-tight">{world.phase}</p>
              <p className="nums mt-1 font-mono text-xs text-muted-foreground/80">第 {world.turn} / {world.totalTurns} 轮</p>
            </div>
            <ActBar turn={world.turn} total={world.totalTurns} finished={world.status === "finished"} />
          </div>
        </div>

        <DiscussionHeat world={world} names={names} />
        <SuspicionGraph world={world} names={names} />
        <SuspicionPanel world={world} names={names} />

        <Tabs defaultValue="causality">
          <TabsList className="grid h-auto w-full grid-cols-4 gap-1 bg-transparent p-0">
            <TabsTrigger value="causality">
              <GitBranch />
              社会
            </TabsTrigger>
            <TabsTrigger value="network">
              <Network />
              关系
            </TabsTrigger>
            <TabsTrigger value="scores">
              <BarChart3 />
              战况
            </TabsTrigger>
            <TabsTrigger value="records">
              <ListOrdered />
              记录
            </TabsTrigger>
          </TabsList>
          <TabsContent value="causality" className="pt-3">
            <CausalityCard room={room} />
          </TabsContent>
          <TabsContent value="network" className="pt-3">
            <RelationshipNetwork room={room} />
          </TabsContent>
          <TabsContent value="scores" className="pt-3">
            <div className="flex flex-col gap-3">
              <ScoreCard world={world} />
              <HistoryCard world={world} names={names} scenarioId={room.scenarioId} />
            </div>
          </TabsContent>
          <TabsContent value="records" className="pt-3">
            <Tabs defaultValue="timeline">
              <TabsList variant="line" className="grid w-full grid-cols-3">
                <TabsTrigger value="timeline"><ListOrdered />时间线</TabsTrigger>
                <TabsTrigger value="activity"><Radio />工具</TabsTrigger>
                <TabsTrigger value="highlights"><Sparkles />高光</TabsTrigger>
              </TabsList>
              <TabsContent value="timeline" className="pt-3">
                <TimelineCard timeline={timeline} names={names} />
              </TabsContent>
              <TabsContent value="activity" className="pt-3">
                <ActivityCard toolCalls={toolCalls} names={names} avatarSeeds={avatarSeeds} />
              </TabsContent>
              <TabsContent value="highlights" className="pt-3">
                <HighlightsCard highlights={room.highlights ?? []} timeline={timeline} names={names} onJumpToAt={onJumpToAt} />
              </TabsContent>
            </Tabs>
          </TabsContent>
        </Tabs>
      </section>
      <BeatOverlay world={world} names={names} scenarioId={room.scenarioId} />
    </div>
  );
}

/**
 * Live social temperature of the room: the discussion director's response
 * pressure per participant. Reads who is being challenged, who is under
 * suspicion, and whether the conversation is still open — at a glance.
 */
function DiscussionHeat({ world, names }: { world: WorldSnapshot; names: Map<string, string> }): ReactNode {
  const discussion = world.details.discussion as DiscussionState | undefined;
  if (!discussion) return null;
  const entries = Object.entries(discussion.urgency)
    .sort((left, right) => right[1] - left[1])
    .filter(([, value]) => value > 0);
  return (
    <Card className="mb-3 gap-3 py-3 shadow-none">
      <CardHeader className="px-3">
        <CardTitle className="flex items-center gap-1.5 text-xs"><Flame />讨论热度</CardTitle>
        <CardAction><Badge variant="outline">{discussion.open ? `第 ${discussion.wave} 轮 · ${discussion.messageCount} 条` : "已收场"}</Badge></CardAction>
      </CardHeader>
      {entries.length ? (
        <CardContent className="flex flex-col gap-2 px-3">
          {entries.map(([id, value]) => (
            <div key={id} className="flex items-center gap-2">
              <span className="w-14 truncate text-[11px] text-muted-foreground">{names.get(id) ?? id}</span>
              <Progress value={Math.max(6, value * 100)} className="h-1 flex-1" aria-label={`${names.get(id) ?? id} 讨论热度 ${Math.round(value * 100)}%`} />
            </div>
          ))}
        </CardContent>
      ) : (
        <CardContent className="px-3 text-xs text-muted-foreground">没有人被点名，对话趋于平静</CardContent>
      )}
    </Card>
  );
}

/**
 * The accusation web: a directed graph of who pointed at whom. Nodes are the
 * characters arranged in a circle; edges are the latest public accusations,
 * votes and outcomes, colored by kind and faded by age — the room's argument
 * structure at a glance.
 */
function SuspicionGraph({ world, names }: { world: WorldSnapshot; names: Map<string, string> }): ReactNode {
  const suspicion = world.details.suspicion as SuspicionState | undefined;
  if (!suspicion) return null;
  const entries = suspicion.entries.slice(-8).reverse();
  return (
    <Card className="mb-3 gap-3 py-3 shadow-none">
      <CardHeader className="px-3">
        <CardTitle className="flex items-center gap-1.5 text-xs"><Network />公开指向</CardTitle>
        <CardDescription>最近的指控、投票与结果，不与私有关系混合。</CardDescription>
        <CardAction><Badge variant="outline">{entries.length} 条</Badge></CardAction>
      </CardHeader>
      <CardContent className="px-3">
        {entries.length ? (
          <ItemGroup>
            {entries.map((entry, index) => (
              <Item key={`${entry.turn}:${entry.accuser}:${entry.target}:${index}`} size="sm" variant="muted">
                <ItemContent>
                  <ItemTitle>
                    <span className="truncate">{names.get(entry.accuser) ?? entry.accuser}</span>
                    <ArrowRight />
                    <span className="truncate">{names.get(entry.target) ?? entry.target}</span>
                  </ItemTitle>
                  <ItemDescription>第 {entry.turn} 轮公开记录</ItemDescription>
                </ItemContent>
                <ItemActions><Badge variant={entry.kind === "vote" ? "secondary" : "outline"}>{entry.kind === "vote" ? "投票" : entry.kind === "outcome" ? "结果" : "指控"}</Badge></ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <Empty className="min-h-28">
            <EmptyHeader><EmptyMedia variant="icon"><Network /></EmptyMedia><EmptyTitle>暂无公开指向</EmptyTitle></EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The room's suspicion climate: who the group is currently leaning against,
 * derived from public accusations, votes and outcomes. The accusation feed
 * shows the live chains ("who pointed at whom") for observers.
 */
function SuspicionPanel({ world, names }: { world: WorldSnapshot; names: Map<string, string> }): ReactNode {
  const suspicion = world.details.suspicion as SuspicionState | undefined;
  if (!suspicion) return null;
  const ranked = Object.entries(suspicion.scores)
    .sort((left, right) => right[1] - left[1])
    .filter(([, value]) => value > 0);
  const feed = suspicion.entries.slice(-6).reverse();
  return (
    <Card className="mb-3 gap-3 py-3 shadow-none">
      <CardHeader className="px-3">
        <CardTitle className="flex items-center gap-1.5 text-xs"><Crosshair />怀疑氛围</CardTitle>
        <CardAction><Badge variant="outline">{ranked.length ? `${ranked.length} 人被点名` : "风平浪静"}</Badge></CardAction>
      </CardHeader>
      {ranked.length ? (
        <CardContent className="flex flex-col gap-2 px-3">
          {ranked.slice(0, 5).map(([id, value]) => (
            <div key={id} className="flex items-center gap-2">
              <span className="w-14 truncate text-[11px] text-muted-foreground">{names.get(id) ?? id}</span>
              <Progress value={Math.max(6, value * 100)} className="h-1 flex-1" aria-label={`${names.get(id) ?? id} 被怀疑程度 ${Math.round(value * 100)}%`} />
            </div>
          ))}
        </CardContent>
      ) : (
        <CardContent className="px-3 text-xs text-muted-foreground">还没有公开指控或异常票型</CardContent>
      )}
      {feed.length ? (
        <CardContent className="px-3">
          <ItemGroup>
          {feed.map((entry, index) => {
            const accuser = names.get(entry.accuser) ?? entry.accuser;
            const target = names.get(entry.target) ?? entry.target;
            const kindLabel = entry.kind === "vote" ? "投票" : entry.kind === "outcome" ? "结果" : "指控";
            return (
              <Item key={`${entry.turn}:${entry.accuser}:${entry.target}:${index}`} size="sm">
                <ItemContent><ItemTitle>{accuser}<ArrowRight />{target}</ItemTitle></ItemContent>
                <ItemActions><Badge variant="outline">{kindLabel}</Badge></ItemActions>
              </Item>
            );
          })}
          </ItemGroup>
        </CardContent>
      ) : null}
    </Card>
  );
}

function ActBar({ turn, total, finished }: { turn: number; total: number; finished: boolean }): ReactNode {
  const progress = finished ? 100 : Math.round((Math.max(0, turn) / Math.max(1, total)) * 100);
  return <Progress value={progress} className="h-1 w-20" aria-label={`第 ${turn} / ${total} 轮`} />;
}

function ScoreCard({ world }: { world: WorldSnapshot }): ReactNode {
  const scored = world.agents.filter((agent) => agent.score !== undefined);
  if (!scored.length) {
    return (
      <Empty className="min-h-32">
        <EmptyHeader><EmptyMedia variant="icon"><Activity /></EmptyMedia><EmptyTitle>本场景暂无公开分数</EmptyTitle></EmptyHeader>
      </Empty>
    );
  }
  const sorted = [...scored].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const max = sorted[0]?.score ?? 0;
  return (
    <Card className="gap-2 py-3 shadow-none">
      <CardHeader className="px-3"><CardTitle className="text-xs">公开排名</CardTitle></CardHeader>
      <CardContent className="px-3">
        <ItemGroup>
          {sorted.map((agent, index) => (
            <Item key={agent.id} size="sm" variant={index === 0 ? "muted" : "default"}>
              <Badge variant={index === 0 ? "secondary" : "outline"}>{index + 1}</Badge>
              <ItemContent>
                <ItemTitle>{agent.displayName}</ItemTitle>
                <Progress value={max > 0 ? ((agent.score ?? 0) / max) * 100 : 0} className="h-1" aria-label={`${agent.displayName} 得分 ${agent.score ?? 0}`} />
              </ItemContent>
              <ItemActions><Badge variant="outline">{agent.score}</Badge></ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
    </Card>
  );
}

interface ProjectedCommitment {
  commitmentId: string;
  promisorActorId: string;
  proposition: string;
  state: "proposed" | "accepted" | "fulfilled" | "violated" | "void";
}

function CausalityCard({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const projection = room.world.details.socialCausality as SocialCausalityProjection | undefined;
  const legacyCommitments = Array.isArray(room.world.details.commitments)
    ? room.world.details.commitments.filter((entry): entry is ProjectedCommitment => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        const value = entry as Record<string, unknown>;
        return typeof value.commitmentId === "string"
          && typeof value.promisorActorId === "string"
          && typeof value.proposition === "string"
          && ["proposed", "accepted", "fulfilled", "violated", "void"].includes(String(value.state));
      })
    : [];
  const commitments: ProjectedCommitment[] = projection?.commitments.length ? projection.commitments : legacyCommitments;
  const actorNames = new Map(room.participants.map((participant) => [participant.profile.id, participant.profile.displayName]));
  const characterNames = new Map(room.participants.map((participant) => [participant.profile.characterId, participant.profile.displayName]));
  const propositions = new Map((projection?.propositions ?? []).map((proposition) => [proposition.propositionId, proposition]));
  const socialActs = (projection?.socialActs ?? []).slice(-5).reverse();
  const beliefUpdates = (projection?.beliefUpdates ?? []).slice(-4).reverse();
  const actorModels = (projection?.actorModels ?? []).slice(-4).reverse();
  const deceptions = (projection?.deceptions ?? []).slice(-3).reverse();
  const decisions = (projection?.decisions ?? []).slice(-3).reverse();
  const reconciliations = (projection?.outcomeReconciliations ?? []).slice(-4).reverse();
  const influenceLinks = (projection?.influenceLinks ?? []).slice(-4).reverse();
  // Thread 决策 → 影响 → 结果 by the same decisionId: influence links may
  // arrive without an explicit decisionId, in which case the resulting action
  // receipt resolves back to the owning decision.
  const decisionById = new Map((projection?.decisions ?? []).map((decision) => [decision.decisionId, decision]));
  const decisionByReceipt = new Map((projection?.decisions ?? []).map((decision) => [decision.actionReceiptId, decision]));
  const influencesByDecision = new Map<string, InfluenceLink[]>();
  for (const link of projection?.influenceLinks ?? []) {
    const owner = link.decisionId
      ?? (link.resultingActionReceiptId ? decisionByReceipt.get(link.resultingActionReceiptId)?.decisionId : undefined);
    if (!owner) continue;
    const list = influencesByDecision.get(owner) ?? [];
    list.push(link);
    influencesByDecision.set(owner, list);
  }
  const reconciliationByDecision = new Map<string, OutcomeReconciliation>(
    (projection?.outcomeReconciliations ?? []).map((reconciliation) => [reconciliation.decisionId, reconciliation])
  );
  const hasRecords = commitments.length + socialActs.length + beliefUpdates.length + actorModels.length + deceptions.length + decisions.length + reconciliations.length + influenceLinks.length > 0;

  if (!hasRecords) {
    return (
      <Empty className="min-h-48">
        <EmptyHeader>
          <EmptyMedia variant="icon"><GitBranch /></EmptyMedia>
          <EmptyTitle>等待第一条因果记录</EmptyTitle>
          <EmptyDescription>消息、信念和绑定行动发生后，这里会显示来源与后果。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-1.5">
        <CausalityMetric label="行为" value={projection?.socialActs.length ?? 0} />
        <CausalityMetric label="信念" value={projection?.beliefUpdates.length ?? 0} />
        <CausalityMetric label="决定" value={projection?.decisions.length ?? 0} />
        <CausalityMetric label="结果" value={projection?.outcomeReconciliations.length ?? 0} />
      </div>
      <Tabs defaultValue="beliefs">
        <TabsList variant="line" className="grid w-full grid-cols-5">
          <TabsTrigger value="beliefs">信念</TabsTrigger>
          <TabsTrigger value="commitments">承诺</TabsTrigger>
          <TabsTrigger value="deceptions">欺骗</TabsTrigger>
          <TabsTrigger value="decisions">决策</TabsTrigger>
          <TabsTrigger value="outcomes">结果</TabsTrigger>
        </TabsList>

        <TabsContent value="beliefs" className="pt-3">
          <div className="flex flex-col gap-2">
            {beliefUpdates.map((belief) => (
              <Card key={belief.beliefUpdateId} className="gap-2 py-3 shadow-none">
                <CardHeader className="px-3">
                  <CardTitle className="text-xs">{characterNames.get(belief.ownerCharacterId) ?? belief.ownerCharacterId}</CardTitle>
                  <CardDescription className="line-clamp-2 text-xs">{propositions.get(belief.propositionId)?.predicate ?? belief.propositionId}</CardDescription>
                  <CardAction><Badge variant="outline">{Math.round(belief.beforeProbability * 100)} → {Math.round(belief.afterProbability * 100)}%</Badge></CardAction>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-1.5 px-3">
                  <Badge variant="secondary">置信 {Math.round(belief.confidence * 100)}%</Badge>
                  <Badge variant="outline">{belief.addedEvidenceIds.length} 证据</Badge>
                </CardContent>
              </Card>
            ))}
            {actorModels.map((model) => (
              <Card key={model.modelId} className="gap-2 py-3 shadow-none">
                <CardHeader className="px-3">
                  <CardTitle className="text-xs">{characterNames.get(model.ownerCharacterId) ?? model.ownerCharacterId} 对 {characterNames.get(model.targetCharacterId) ?? model.targetCharacterId} 的判断</CardTitle>
                  <CardDescription className="line-clamp-2 text-xs">{model.perceivedStrategy.join(" · ") || "尚未归纳策略"}</CardDescription>
                  <CardAction><Badge variant="outline">诚实 {Math.round(model.perceivedHonesty * 100)}%</Badge></CardAction>
                </CardHeader>
              </Card>
            ))}
            {!beliefUpdates.length && !actorModels.length ? <CausalityEmpty title="暂无可见信念" /> : null}
          </div>
        </TabsContent>

        <TabsContent value="commitments" className="pt-3">
          <div className="flex flex-col gap-2">
            {commitments.slice(-4).reverse().map((commitment) => (
              <Card key={commitment.commitmentId} className="gap-2 py-3 shadow-none">
                <CardHeader className="px-3">
                  <CardTitle className="text-xs">{actorNames.get(commitment.promisorActorId) ?? commitment.promisorActorId}</CardTitle>
                  <CardDescription className="line-clamp-3 text-xs">{commitment.proposition}</CardDescription>
                  <CardAction><Badge variant={commitment.state === "violated" ? "destructive" : "outline"}>{commitmentStateLabel(commitment.state)}</Badge></CardAction>
                </CardHeader>
              </Card>
            ))}
            {!commitments.length ? <CausalityEmpty title="暂无可见承诺" /> : null}
          </div>
        </TabsContent>

        <TabsContent value="deceptions" className="pt-3">
          <div className="flex flex-col gap-2">
            {deceptions.map((episode) => (
              <Card key={episode.deceptionId} className="gap-2 py-3 shadow-none">
                <CardHeader className="px-3">
                  <CardTitle className="text-xs">{actorNames.get(episode.deceiverActorId) ?? episode.deceiverActorId}</CardTitle>
                  <CardDescription className="line-clamp-3 text-xs">{episode.intendedFalseBeliefIds.map((id) => propositions.get(id)?.predicate).filter(Boolean).join("；") || episode.mode}</CardDescription>
                  <CardAction><Badge variant="outline">{deceptionStatusLabel(episode.status)}</Badge></CardAction>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-1.5 px-3">
                  <Badge variant="secondary">{episode.executionMessageIds.length} 消息</Badge>
                  <Badge variant="outline">{episode.believedByCharacterIds.length} 相信</Badge>
                  <Badge variant="outline">{episode.detectionEventIds.length} 识破事件</Badge>
                </CardContent>
              </Card>
            ))}
            {!deceptions.length ? <CausalityEmpty title="暂无可见欺骗" /> : null}
          </div>
        </TabsContent>

        <TabsContent value="decisions" className="pt-3">
          <div className="flex flex-col gap-2">
            {decisions.map((decision) => {
              const links = influencesByDecision.get(decision.decisionId) ?? [];
              const reconciliation = reconciliationByDecision.get(decision.decisionId);
              return (
                <Card key={decision.decisionId} className="gap-2 py-3 shadow-none">
                  <CardHeader className="px-3">
                    <CardTitle className="text-xs">{actorNames.get(decision.actorId) ?? decision.actorId}</CardTitle>
                    <CardDescription className="line-clamp-3 text-xs">{decision.selectedIntent.summary}</CardDescription>
                    <CardAction><Badge variant="outline">{eventLabel(decision.action)}</Badge></CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-1.5 px-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary">{decision.candidateIntentIds.length} 候选意图</Badge>
                      <Badge variant="outline">{decision.evidenceRefs.length} 证据</Badge>
                      <Badge variant="outline">{decision.predictedConsequences.length} 预测</Badge>
                    </div>
                    {links.length || reconciliation ? (
                      <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/30 p-2.5">
                        {links.map((link) => (
                          <p key={link.influenceId} className="text-[11px] leading-4 text-muted-foreground">
                            影响 {characterNames.get(link.targetCharacterId) ?? link.targetCharacterId} · {influenceBasisLabel(link.basis)} · 置信 {Math.round(link.confidence * 100)}%
                          </p>
                        ))}
                        {reconciliation ? (
                          <p className="text-[11px] leading-4 text-muted-foreground">结果:{reconciliation.actualOutcome.summary}</p>
                        ) : (
                          <p className="text-[11px] leading-4 text-muted-foreground/60">结果尚未对账</p>
                        )}
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
            {socialActs.map((act) => (
              <Card key={act.socialActId} className="gap-2 py-3 shadow-none">
                <CardHeader className="px-3">
                  <CardTitle className="text-xs">{actorNames.get(act.actorId) ?? act.actorId}</CardTitle>
                  <CardDescription className="line-clamp-2 text-xs">{act.propositionIds.map((id) => propositions.get(id)?.predicate).filter(Boolean).join("；") || `面向 ${act.audienceActorIds.length} 人`}</CardDescription>
                  <CardAction><Badge variant="secondary">{socialActLabel(act.kind)}</Badge></CardAction>
                </CardHeader>
              </Card>
            ))}
            {!decisions.length && !socialActs.length ? <CausalityEmpty title="暂无可见决策" /> : null}
          </div>
        </TabsContent>

        <TabsContent value="outcomes" className="pt-3">
          <div className="flex flex-col gap-2">
            {reconciliations.map((reconciliation) => {
              const decision = decisionById.get(reconciliation.decisionId);
              return (
                <Card key={reconciliation.reconciliationId} className="gap-2 py-3 shadow-none">
                  <CardHeader className="px-3">
                    <CardTitle className="text-xs">{actorNames.get(reconciliation.actorId) ?? reconciliation.actorId}</CardTitle>
                    <CardDescription className="line-clamp-3 text-xs">
                      {decision ? `${eventLabel(decision.action)} · ${decision.selectedIntent.summary}` : reconciliation.actualOutcome.summary}
                    </CardDescription>
                    <CardAction><Badge variant="outline">{reconciliation.calibrationError === undefined ? "已对账" : `误差 ${reconciliation.calibrationError.toFixed(2)}`}</Badge></CardAction>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-1.5 px-3">
                    <p className="text-[11px] leading-4 text-muted-foreground">结果:{reconciliation.actualOutcome.summary}</p>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="secondary">{reconciliation.predictionAssessments.length} 预测结算</Badge>
                      <Badge variant="outline">{reconciliation.influenceIds.length} 影响链</Badge>
                      <Badge variant="outline">{reconciliation.memoryWriteSuggestions.length} 记忆候选</Badge>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            {influenceLinks.map((link) => {
              const sourceDecision = link.decisionId ? decisionById.get(link.decisionId) : undefined;
              return (
                <Card key={link.influenceId} className="gap-2 py-3 shadow-none">
                  <CardHeader className="px-3">
                    <CardTitle className="text-xs">可能影响了 {characterNames.get(link.targetCharacterId) ?? link.targetCharacterId}</CardTitle>
                    <CardDescription className="text-xs">
                      {influenceBasisLabel(link.basis)}
                      {sourceDecision ? ` · 源自 ${characterNames.get(sourceDecision.actorId) ?? sourceDecision.actorId} 的${eventLabel(sourceDecision.action)}` : ""}
                    </CardDescription>
                    <CardAction><Badge variant="outline">{Math.round(link.confidence * 100)}%</Badge></CardAction>
                  </CardHeader>
                </Card>
              );
            })}
            {!reconciliations.length && !influenceLinks.length ? <CausalityEmpty title="暂无结果对账" /> : null}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CausalityMetric({ label, value }: { label: string; value: number }): ReactNode {
  return (
    <Card className="gap-1 py-2 shadow-none">
      <CardHeader className="gap-1 px-2.5">
        <CardTitle className="font-mono text-base">{String(value).padStart(2, "0")}</CardTitle>
        <CardDescription className="text-[10px]">{label}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function CausalityEmpty({ title }: { title: string }): ReactNode {
  return (
    <Empty className="min-h-36">
      <EmptyHeader>
        <EmptyMedia variant="icon"><GitBranch /></EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
    </Empty>
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

function socialActLabel(kind: string): string {
  const labels: Record<string, string> = {
    assertion: "主张", denial: "否认", question: "提问", answer: "回应", promise: "承诺",
    offer: "提议", acceptance: "接受", rejection: "拒绝", request: "请求", threat: "威胁",
    accusation: "指控", defense: "辩护", apology: "道歉", "alliance-proposal": "结盟",
    disclosure: "披露", endorsement: "背书", warning: "警告", silence: "沉默"
  };
  return labels[kind] ?? kind;
}

function deceptionStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    planned: "计划中", attempted: "已执行", received: "已接收", believed: "已相信",
    "behaviorally-effective": "已影响行动", failed: "未奏效", abandoned: "已放弃",
    detected: "已识破", repaired: "已修复"
  };
  return labels[status] ?? status;
}

function commitmentStateLabel(state: ProjectedCommitment["state"]): string {
  return state === "proposed" ? "待接受" : state === "accepted" ? "已接受" : state === "fulfilled" ? "已履约" : state === "violated" ? "已违约" : "已作废";
}

function ActivityCard({ toolCalls, names, avatarSeeds }: { toolCalls: RoomConnection["toolCalls"]; names: Map<string, string>; avatarSeeds: Map<string, string> }): ReactNode {
  if (!toolCalls.length) {
    return (
      <Empty className="min-h-32">
        <EmptyHeader><EmptyMedia variant="icon"><Radio /></EmptyMedia><EmptyTitle>等待 Agent 活动</EmptyTitle></EmptyHeader>
      </Empty>
    );
  }
  return (
    <ItemGroup>
      {toolCalls.slice(0, 20).map((call, index) => (
        <Item key={`${call.at}-${index}`} size="sm" variant="muted">
          <ItemMedia><AgentAvatar name={call.actorName || names.get(call.actorId) || call.actorId} index={indexOf(call.actorId)} seed={avatarSeeds.get(call.actorId)} size="sm" /></ItemMedia>
          <ItemContent>
            <ItemTitle>{names.get(call.actorId) ?? call.actorId}</ItemTitle>
            <ItemDescription>{eventLabel(call.toolName)}</ItemDescription>
          </ItemContent>
          <ItemActions><Badge variant={call.phase === "started" ? "secondary" : "outline"}>{call.phase === "started" ? "执行中" : "已完成"}</Badge></ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}

function TimelineCard({ timeline, names }: { timeline: TimelineEntry[]; names: Map<string, string> }): ReactNode {
  if (!timeline.length) {
    return (
      <Empty className="min-h-32">
        <EmptyHeader><EmptyMedia variant="icon"><ListOrdered /></EmptyMedia><EmptyTitle>等待时间线事件</EmptyTitle><EmptyDescription>思考、记忆、工具与行动会按顺序出现。</EmptyDescription></EmptyHeader>
      </Empty>
    );
  }
  const ICONS: Record<TimelineEntry["kind"], ReactNode> = {
    thought: <BrainCircuit />,
    tool: <Wrench />,
    message: <MessageSquare />,
    action: <Crosshair />,
    cue: <Clapperboard />,
    memory: <BrainCircuit />,
    pressure: <Flame />,
    notice: <Activity />
  };
  return (
    <ItemGroup>
      {timeline.slice(0, 40).map((entry) => (
        <Item key={entry.id} size="sm">
          <ItemMedia variant="icon">{ICONS[entry.kind]}</ItemMedia>
          <ItemContent>
            <ItemTitle>{entry.actorId ? `${names.get(entry.actorId) ?? entry.actorId} · ` : ""}{entry.label}</ItemTitle>
            {entry.detail ? <ItemDescription>{entry.detail}</ItemDescription> : null}
          </ItemContent>
          <ItemActions><Badge variant="outline">{formatTime(entry.at)}</Badge></ItemActions>
        </Item>
      ))}
    </ItemGroup>
  );
}

/**
 * Endgame/high-tension moments, derived from real cues. Each highlight can be
 * expanded to show the surrounding timeline entries — the cause before it and
 * what followed — so the drama is clickable rather than just listed (§8.7).
 */
function HighlightsCard({ highlights, timeline, names, onJumpToAt }: { highlights: SocietyRoomSnapshot["highlights"]; timeline: TimelineEntry[]; names: Map<string, string>; onJumpToAt?: (at: string) => void }): ReactNode {
  const [expandedId, setExpandedId] = useState<string>();
  if (!highlights?.length) {
    return (
      <Empty className="min-h-32">
        <EmptyHeader><EmptyMedia variant="icon"><Sparkles /></EmptyMedia><EmptyTitle>等待高光事件</EmptyTitle><EmptyDescription>高优先级镜头出现后会汇聚到这里。</EmptyDescription></EmptyHeader>
      </Empty>
    );
  }
  const contextAround = (at: string): TimelineEntry[] => timelineContextAround(timeline, at);
  return (
    <div className="flex flex-col gap-2">
      {[...highlights].reverse().map((highlight) => {
        const open = expandedId === highlight.id;
        const context = open ? contextAround(highlight.at) : [];
        return (
          <Collapsible key={highlight.id} open={open} onOpenChange={(next) => setExpandedId(next ? highlight.id : undefined)}>
            <Card className="gap-3 py-3 shadow-none">
              <CardHeader className="px-3">
                <CardTitle className="flex items-center gap-2 text-xs"><Clapperboard />{highlight.title}</CardTitle>
                <CardDescription className="line-clamp-2">{highlight.subtitle ?? `发生于 ${formatTime(highlight.at)}`}</CardDescription>
                <CardAction className="flex items-center gap-1">
                  {onJumpToAt ? <Button variant="ghost" size="xs" onClick={() => onJumpToAt(highlight.at)}>定位</Button> : null}
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="icon-xs" aria-label={open ? "收起前因后果" : "展开前因后果"}>
                      <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
                    </Button>
                  </CollapsibleTrigger>
                </CardAction>
              </CardHeader>
              <CollapsibleContent>
                <CardContent className="flex flex-col gap-2 px-3">
                  {highlight.focusAgentIds.length ? <Badge variant="outline">焦点：{highlight.focusAgentIds.map((id) => names.get(id) ?? id).join("、")}</Badge> : null}
                  {context.length ? (
                    <ItemGroup>
                      {context.map((entry) => (
                        <Item key={`${entry.id}-${entry.at}`} size="sm" variant="muted">
                          <ItemContent><ItemTitle>{entry.actorId && names.get(entry.actorId) ? `${names.get(entry.actorId)} · ` : ""}{entry.label}</ItemTitle>{entry.detail ? <ItemDescription>{entry.detail}</ItemDescription> : null}</ItemContent>
                          <ItemActions><Badge variant="outline">{formatTime(entry.at)}</Badge></ItemActions>
                        </Item>
                      ))}
                    </ItemGroup>
                  ) : (
                    <p className="text-xs text-muted-foreground">时间线窗口中没有更早条目。</p>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        );
      })}
    </div>
  );
}

function formatTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function HistoryCard({ world, names, scenarioId }: { world: WorldSnapshot; names: Map<string, string>; scenarioId: ScenarioId }): ReactNode {
  const history = (world.details.history ?? []) as Array<Record<string, unknown>>;
  if (!history.length) {
    return (
      <Empty className="min-h-32">
        <EmptyHeader><EmptyMedia variant="icon"><Activity /></EmptyMedia><EmptyTitle>还没有历史回合</EmptyTitle></EmptyHeader>
      </Empty>
    );
  }
  return (
    <Card className="gap-2 py-3 shadow-none">
      <CardHeader className="px-3"><CardTitle className="text-xs">回合历史</CardTitle></CardHeader>
      <CardContent className="px-3">
        <ItemGroup>
          {history.map((entry, index) => (
            <HistoryRow key={index} entry={entry} names={names} scenarioId={scenarioId} />
          ))}
        </ItemGroup>
      </CardContent>
    </Card>
  );
}

function HistoryRow({ entry, names, scenarioId }: { entry: Record<string, unknown>; names: Map<string, string>; scenarioId: ScenarioId }): ReactNode {
  let title: string | undefined;
  let description: string | undefined;
  if (scenarioId === "werewolf") {
    const eliminated = entry.eliminatedId as string | undefined;
    const night = entry.nightTargetId as string | undefined;
    title = eliminated ? `${names.get(eliminated) ?? eliminated} 被投票淘汰（${roleLabelZh(String(entry.eliminatedRole))}）` : "投票平局，无人淘汰";
    description = night ? `夜晚：${names.get(night) ?? night} 被淘汰（${roleLabelZh(String(entry.nightTargetRole))}）` : undefined;
  } else if (scenarioId === "sealed-bid-auction") {
    const winnerId = entry.winnerId as string | undefined;
    const price = entry.price as number | undefined;
    const bids = entry.bids as Record<string, number> | undefined;
    title = `${winnerId ? names.get(winnerId) ?? winnerId : "无人"} 以 ${price ?? "—"} 点拍得`;
    description = bids ? Object.entries(bids).map(([id, value]) => `${names.get(id) ?? id} ${value}`).join(" · ") : undefined;
  } else if (scenarioId === "prisoners-dilemma" || scenarioId === "trust-game" || scenarioId === "ultimatum-game" || scenarioId === "chicken-game" || scenarioId === "stag-hunt") {
    const payoffs = entry.payoffs as Record<string, number> | undefined;
    const detail = entry.text as string | undefined;
    title = detail ?? "本轮已结算";
    description = payoffs ? Object.entries(payoffs).map(([id, value]) => `${names.get(id) ?? id} ${value}`).join(" · ") : undefined;
  } else if (scenarioId === "public-goods") {
    const contributions = entry.contributions as Record<string, number> | undefined;
    title = `公共池 ${String(entry.pool)} · 每人返还 ${String(entry.share)}`;
    description = contributions ? Object.entries(contributions).map(([id, value]) => `${names.get(id) ?? id} ${value}`).join(" · ") : undefined;
  } else if (typeof entry.text === "string") {
    title = entry.text;
  }
  if (!title) return null;
  return (
    <Item size="sm">
      <Badge variant="outline">{scenarioId === "werewolf" ? `D${String(entry.day)}` : `R${roundLabel(entry)}`}</Badge>
      <ItemContent><ItemTitle>{title}</ItemTitle>{description ? <ItemDescription>{description}</ItemDescription> : null}</ItemContent>
    </Item>
  );
}

function roundLabel(entry: Record<string, unknown>): string {
  const round = entry.round ?? entry.move ?? entry.quest ?? entry.day;
  return round === undefined ? "·" : String(round);
}

/** Cinematic beat: dim the stage for a second and announce the latest outcome. */
function BeatOverlay({ world, names, scenarioId }: { world: WorldSnapshot; names: Map<string, string>; scenarioId: ScenarioId }): ReactNode {
  const history = (world.details.history ?? []) as Array<Record<string, unknown>>;
  const seenRef = useRef<number>(0);

  useEffect(() => {
    if (world.status === "finished") return; // the finale belongs to the result card
    if (history.length <= seenRef.current) return;
    seenRef.current = history.length;
    const latest = history.at(-1);
    if (!latest) return;
    const text = beatText(latest, names, scenarioId);
    if (!text) return;
    toast(text, { id: `world-beat-${scenarioId}-${history.length}`, duration: 3_200 });
  }, [history, names, scenarioId, world]);

  return null;
}

function beatText(entry: Record<string, unknown>, names: Map<string, string>, scenarioId: ScenarioId): string | null {
  if (scenarioId === "werewolf") {
    const eliminated = entry.eliminatedId as string | undefined;
    if (entry.idiotSurvived) return `${names.get(eliminated ?? "") ?? eliminated} 亮出白痴身份，免死并失去投票权`;
    if (eliminated) return `${names.get(eliminated) ?? eliminated} 被投票淘汰，身份揭晓：${roleLabelZh(String(entry.eliminatedRole))}`;
    const night = entry.nightTargetId as string | undefined;
    if (night) return `夜晚降临，${names.get(night) ?? night} 遇害，身份：${roleLabelZh(String(entry.nightTargetRole))}`;
    return null;
  }
  if (scenarioId === "avalon") {
    const outcome = entry.outcome as string | undefined;
    if (!outcome) return null;
    return outcome === "fail"
      ? `任务失败 —— ${String(entry.failCount)} 张黑票悄然出现`
      : `任务成功 —— 但胜负仍要等刺客的最后一剑`;
  }
  if (typeof entry.text === "string" && entry.text) return entry.text;
  return null;
}

function indexOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}
