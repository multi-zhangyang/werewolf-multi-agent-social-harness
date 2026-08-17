import type { ReactNode } from "react";
import { Network } from "lucide-react";
import type { SocietyParticipantCard } from "@/society/room";
import { cn } from "@/lib/utils";

interface PairEdge {
  a: string;
  b: string;
  trust: number;
  tension: number;
  affinity: number;
}

/**
 * The relationship web — how the characters actually feel about each other,
 * aggregated from every participant's private relationship ledger. Green edges
 * are trust, rose edges are unresolved tension; width carries intensity. It is
 * derived from private minds, so it only renders what the observer is allowed
 * to see: the observer seat sees everyone's minds, a player seat sees none.
 */
export function RelationshipNetwork({ participants }: { participants: SocietyParticipantCard[] }): ReactNode {
  const ids = participants.map((participant) => participant.profile.id);
  const names = new Map(participants.map((participant) => [participant.profile.id, participant.profile.displayName]));
  const edges = buildEdges(participants);
  const n = Math.max(2, ids.length);
  const cx = 100;
  const cy = 78;
  const radius = 56;
  const position = (id: string): { x: number; y: number } => {
    const index = ids.indexOf(id);
    if (index === -1) return { x: cx, y: cy };
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / n;
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  };

  if (!edges.length) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-10">
        <Network className="size-5 text-muted-foreground/50" />
        <p className="mt-2 text-xs text-muted-foreground">关系还没有成形</p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">等角色们交锋几个回合，这里会长出信任与嫌隙。</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3.5">
      <svg viewBox="0 0 200 164" className="w-full" role="img" aria-label="角色关系网络">
        {edges.map((edge) => {
          const from = position(edge.a);
          const to = position(edge.b);
          const bond = Math.max(edge.trust, edge.affinity);
          const hostile = edge.tension > 0.6 && edge.tension > bond;
          const strength = hostile ? edge.tension : bond;
          const color = hostile ? "#fb7185" : bond > 0.6 ? "#34d399" : "#71717a";
          const width = 0.8 + Math.min(2.2, (strength - 0.5) * 5);
          return (
            <g key={`${edge.a}-${edge.b}`}>
              <title>
                {`${names.get(edge.a)} ↔ ${names.get(edge.b)} · 信任 ${Math.round(bond * 100)}% · 张力 ${Math.round(edge.tension * 100)}%`}
              </title>
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={color}
                strokeWidth={width}
                strokeOpacity={hostile ? 0.75 : 0.55}
              />
            </g>
          );
        })}
        {ids.map((id) => {
          const point = position(id);
          const participant = participants.find((entry) => entry.profile.id === id);
          const live = participant && (participant.status === "thinking" || participant.status === "acting" || participant.status === "speaking");
          return (
            <g key={id}>
              <circle
                cx={point.x}
                cy={point.y}
                r={11}
                fill="#0a0a0a"
                stroke={live ? "#34d399" : participant?.alive === false ? "#3f3f46" : "#52525b"}
                strokeWidth={live ? 2 : 1.2}
              />
              <circle cx={point.x} cy={point.y} r={3.2} fill={participant?.alive === false ? "#52525b" : "#e4e4e7"} />
              <text
                x={point.x}
                y={point.y + 24}
                textAnchor="middle"
                fontSize="8.5"
                className={cn("fill-white/70", participant?.alive === false && "fill-white/30")}
              >
                {names.get(id) ?? id}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-emerald-400" />信任</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-rose-400" />张力</span>
        <span className="flex items-center gap-1"><span className="size-1.5 rounded-full bg-zinc-500" />观望</span>
      </div>
    </div>
  );
}

function buildEdges(participants: SocietyParticipantCard[]): PairEdge[] {
  const ids = participants.map((participant) => participant.profile.id);
  const edges: PairEdge[] = [];
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const a = ids[left];
      const b = ids[right];
      const mindA = participants.find((entry) => entry.profile.id === a)?.mind;
      const mindB = participants.find((entry) => entry.profile.id === b)?.mind;
      const relA = mindA?.relationships.find((relationship) => relationship.agentId === b);
      const relB = mindB?.relationships.find((relationship) => relationship.agentId === a);
      const trust = Math.max(relA?.trust ?? 0.5, relB?.trust ?? 0.5);
      const tension = Math.max(relA?.tension ?? 0, relB?.tension ?? 0);
      const affinity = Math.max(relA?.affinity ?? 0.5, relB?.affinity ?? 0.5);
      edges.push({ a, b, trust, tension, affinity });
    }
  }
  return edges;
}