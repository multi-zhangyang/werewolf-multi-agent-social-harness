import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Globe, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { CenterColumn } from "./room-view";
import { ScenarioIcon } from "./shared";
import { useRoom } from "./use-room";

type CasterMode = "public" | "postgame";

/**
 * The caster's entire mode state machine: the public projection while the
 * game runs, the postgame reveal the moment it ends. There is no path back
 * and no path to omniscient — a broadcast surface must never be able to
 * spoil the game it is showing.
 */
export function casterModeFor(revealed: boolean): CasterMode {
  return revealed ? "postgame" : "public";
}

/**
 * The OBS/caster broadcast surface: one column, no rails, no controls, no
 * viewer switching — deliberately a dead-end page (no back button either:
 * from the operator's browser a "back" would open their privileged view on
 * stream). Point OBS's browser source at `#/caster/<roomId>`, or pop it out
 * from the room header.
 *
 * Spoiler safety is structural, not cosmetic: the connection requests only
 * `public`/`postgame`, and the server enforces those projections before
 * anything crosses the wire — even when this window rides the operator's
 * credentials (localStorage token / HttpOnly cookie), the granted mode is
 * what filters the stream.
 */
export function CasterRoomView({ roomId }: { roomId: string }): ReactNode {
  // Latched, not derived: flipping the mode resets the connection (room
  // briefly null → finished false), so a derived mode would oscillate
  // between public and postgame forever. Once seen finished, stays revealed.
  const [revealed, setRevealed] = useState(false);
  const viewerParam = useMemo(() => ({ mode: casterModeFor(revealed) }), [revealed]);
  const connection = useRoom(roomId, undefined, viewerParam, { silentNotices: true });
  const { room, viewer, connection: link, stream } = connection;

  const finished = room?.world.status === "finished" || room?.status === "finished";
  useEffect(() => {
    if (finished) setRevealed(true);
  }, [finished]);

  const avatarSeedFor = useMemo(() => {
    const seeds = new Map((room?.participants ?? []).map((participant) => [participant.profile.id, participant.profile.characterId]));
    return (actorId: string): string | undefined => seeds.get(actorId);
  }, [room?.participants]);

  const [endgameDismissed, setEndgameDismissed] = useState(false);

  if (!room) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background text-foreground">
        <Spinner className="size-7" />
        <p className={cn("text-sm text-muted-foreground", link === "reconnecting" && "animate-pulse")}>
          {connection.error ?? "连接直播流中…"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="rule-b flex h-10 shrink-0 items-center gap-2.5 bg-background px-4">
        <ScenarioIcon id={room.scenarioId} className="size-3.5 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate text-sm font-semibold leading-none tracking-tight">{room.title}</h1>
        <p className="hidden min-w-0 truncate text-xs leading-none text-muted-foreground lg:block">{room.world.summary}</p>
        <Badge variant="outline" className="ml-auto shrink-0 gap-1 text-xs font-normal text-muted-foreground">
          <Globe className="size-3" aria-hidden />
          {revealed ? "赛后揭晓" : "公开直播 · 无剧透"}
        </Badge>
      </header>

      {link !== "closed" && room.world.status !== "finished" && (link === "reconnecting" || connection.error) ? (
        <p className="flex shrink-0 items-center justify-center gap-1.5 bg-warn/10 px-4 py-1 text-center text-xs text-warn">
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          {connection.error ?? "连接中断，正在重连——快照会自愈。"}
        </p>
      ) : null}

      <main className="min-h-0 flex-1">
        <CenterColumn
          room={room}
          stream={stream}
          viewer={viewer}
          finished={Boolean(finished)}
          endgameDismissed={endgameDismissed}
          onDismissEndgame={() => setEndgameDismissed(true)}
          onRevealEndgame={() => setEndgameDismissed(false)}
          avatarSeedFor={avatarSeedFor}
        />
      </main>
    </div>
  );
}
