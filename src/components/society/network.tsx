import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Network } from "lucide-react";
import type { SocietyRoomSnapshot } from "@/society/room";
import type { DirectedRelationshipState, SocialCausalityProjection } from "@/society/social/contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AgentAvatar } from "./shared";

type CharacterProfileMap = Map<string, {
  participant: SocietyRoomSnapshot["participants"][number];
  index: number;
}>;

export function RelationshipNetwork({ room }: { room: SocietyRoomSnapshot }): ReactNode {
  const projection = room.world.details.socialCausality as SocialCausalityProjection | undefined;
  const relationships = projection?.directedRelationships ?? [];
  const profilesByCharacter = useMemo<CharacterProfileMap>(
    () => new Map(room.participants.map((participant, index) => [participant.profile.characterId, { participant, index }])),
    [room.participants]
  );
  const ownerCharacterIds = useMemo(
    () => [...new Set(relationships.map((relationship) => relationship.ownerCharacterId))],
    [relationships]
  );
  const [ownerCharacterId, setOwnerCharacterId] = useState(ownerCharacterIds[0] ?? "");

  useEffect(() => {
    if (!ownerCharacterIds.includes(ownerCharacterId)) setOwnerCharacterId(ownerCharacterIds[0] ?? "");
  }, [ownerCharacterId, ownerCharacterIds]);

  if (!relationships.length) {
    return (
      <Empty className="min-h-52">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Network /></EmptyMedia>
          <EmptyTitle>暂无可见关系</EmptyTitle>
          <EmptyDescription>关系是私有且有方向的；这里只显示当前视角有权看到的记录。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const visible = relationships
    .filter((relationship) => relationship.ownerCharacterId === ownerCharacterId)
    .sort((left, right) => right.lastUpdatedLogicalTime - left.lastUpdatedLogicalTime);

  return (
    <div className="flex flex-col gap-3">
      <Select value={ownerCharacterId} onValueChange={setOwnerCharacterId}>
        <SelectTrigger aria-label="选择关系主体">
          <SelectValue placeholder="选择人物视角" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {ownerCharacterIds.map((characterId) => (
              <SelectItem key={characterId} value={characterId}>{characterName(characterId, profilesByCharacter)}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      {visible.map((relationship) => (
        <DirectedRelationshipCard
          key={relationship.relationshipId}
          relationship={relationship}
          profilesByCharacter={profilesByCharacter}
        />
      ))}
    </div>
  );
}

function DirectedRelationshipCard({
  relationship,
  profilesByCharacter
}: {
  relationship: DirectedRelationshipState;
  profilesByCharacter: CharacterProfileMap;
}): ReactNode {
  const owner = profilesByCharacter.get(relationship.ownerCharacterId);
  const target = profilesByCharacter.get(relationship.targetCharacterId);
  return (
    <Card className="gap-3 py-3 shadow-none">
      <CardHeader className="px-3">
        <div className="flex min-w-0 items-center gap-2">
          <AgentAvatar
            name={owner?.participant.profile.displayName ?? relationship.ownerActorId}
            index={owner?.index ?? 0}
            seed={relationship.ownerCharacterId}
            size="sm"
          />
          <CardTitle className="truncate text-xs">{owner?.participant.profile.displayName ?? relationship.ownerActorId}</CardTitle>
          <ArrowRight />
          <AgentAvatar
            name={target?.participant.profile.displayName ?? relationship.targetActorId}
            index={target?.index ?? 0}
            seed={relationship.targetCharacterId}
            size="sm"
          />
          <CardTitle className="truncate text-xs">{target?.participant.profile.displayName ?? relationship.targetActorId}</CardTitle>
        </div>
        <CardDescription className="line-clamp-2 text-xs">{relationship.note || "暂无关系备注"}</CardDescription>
        <CardAction>
          <Badge variant="outline">L{relationship.lastUpdatedLogicalTime}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 px-3">
        <RelationshipMetric label="信任" value={relationship.trust} />
        <RelationshipMetric label="亲近" value={relationship.affinity} />
        <RelationshipMetric label="尊重" value={relationship.respect} />
        <RelationshipMetric label="张力" value={relationship.tension} />
        <RelationshipMetric label="熟悉" value={relationship.familiarity} />
      </CardContent>
      <CardContent className="flex flex-wrap gap-1.5 px-3">
        <Badge variant="secondary">{provenanceLabel(relationship.provenance.sourceKind)}</Badge>
        <Badge variant="outline">{relationship.sourceEventIds.length} 事件</Badge>
        <Badge variant="outline">{relationship.evidenceIds.length} 证据</Badge>
      </CardContent>
    </Card>
  );
}

function RelationshipMetric({ label, value }: { label: string; value: number }): ReactNode {
  const percentage = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="font-mono">{percentage}%</span>
      </div>
      <Progress value={percentage} aria-label={`${label} ${percentage}%`} />
    </div>
  );
}

function characterName(characterId: string, profiles: CharacterProfileMap): string {
  return profiles.get(characterId)?.participant.profile.displayName ?? characterId;
}

function provenanceLabel(source: DirectedRelationshipState["provenance"]["sourceKind"]): string {
  const labels: Record<DirectedRelationshipState["provenance"]["sourceKind"], string> = {
    "world-fact": "世界事实",
    "authorized-observation": "合法观察",
    "message-claim": "消息主张",
    "agent-self-report": "Agent 自述",
    "system-inference": "系统推断",
    presentation: "展示标签"
  };
  return labels[source];
}
