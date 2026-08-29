import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { apiFetch, storeOwnerToken } from "@/lib/api";
import type { ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { About } from "@/components/society/about";
import { CharactersDialog } from "@/components/society/characters-dialog";
import { CreateRoomDialog } from "@/components/society/create-room";
import { Landing } from "@/components/society/landing";
import { ArchiveRoomView, RoomView } from "@/components/society/room-view";
import { CasterRoomView } from "@/components/society/caster-view";
import { SettingsDialog } from "@/components/society/settings-dialog";
import type { ArchiveOption, CreateRoomInput, CreateRoomResult, ModelOption } from "@/components/society/types";

interface CatalogResponse {
  scenarios: ScenarioSummary[];
  models: ModelOption[];
}

interface RoomListResponse {
  rooms: SocietyRoomSnapshot[];
}

interface ArchiveListResponse {
  archives: ArchiveOption[];
}

interface LeaderboardResponse {
  models: Array<{ model: string; seats: number; wins: number; avgScore: number | null }>;
}

type Route = { name: "landing" } | { name: "room"; id: string } | { name: "caster"; id: string } | { name: "archive"; id: string } | { name: "about" };

export function App(): ReactNode {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [rooms, setRooms] = useState<SocietyRoomSnapshot[]>([]);
  const [archives, setArchives] = useState<ArchiveOption[]>([]);
  const [standings, setStandings] = useState<LeaderboardResponse["models"]>([]);
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [createScenarioId, setCreateScenarioId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [charactersOpen, setCharactersOpen] = useState(false);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (route.name === "room" || route.name === "archive") {
      document.title = `${route.id.slice(0, 8)} · Society — 多智能体社会博弈竞技场`;
    } else if (route.name === "caster") {
      document.title = `${route.id.slice(0, 8)} 直播 · Society`;
    } else if (route.name === "about") {
      document.title = "关于 · Society — 多智能体社会博弈竞技场";
    } else {
      document.title = "Society — 多智能体社会博弈竞技场";
    }
  }, [route]);

  const loadCatalog = useCallback(async (): Promise<void> => {
    const [catalog, list, archiveList, leaderboard] = await Promise.all([
      getJson<CatalogResponse>("/api/scenarios"),
      getJson<RoomListResponse>("/api/rooms"),
      getJson<ArchiveListResponse>("/api/archives").catch(() => ({ archives: [] as ArchiveOption[] })),
      getJson<LeaderboardResponse>("/api/leaderboard").catch(() => ({ models: [] as LeaderboardResponse["models"] }))
    ]);
    setScenarios(catalog.scenarios);
    setModels(catalog.models);
    setRooms(list.rooms);
    setArchives(archiveList.archives);
    setStandings(leaderboard.models);
  }, []);

  useEffect(() => {
    let active = true;
    void loadCatalog()
      .catch((cause) => { if (active) toast.error(errorMessage(cause)); })
      .finally(() => { if (active) setBooting(false); });
    return () => { active = false; };
  }, [loadCatalog]);

  useEffect(() => {
    const poll = window.setInterval(() => {
      void getJson<RoomListResponse>("/api/rooms").then((list) => {
        setRooms(list.rooms);
      }).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(poll);
  }, []);

  const createRoom = useCallback(async (input: CreateRoomInput): Promise<CreateRoomResult> => {
    const response = await apiFetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
    const result = payload as { room: SocietyRoomSnapshot } & Partial<CreateRoomResult>;
    if (result.ownerToken) storeOwnerToken(result.ownerToken);
    if (result.playerToken) {
      sessionStorage.setItem(`society:player-token:${result.room.id}`, result.playerToken);
    }
    setRooms((current) => [result.room, ...current.filter((room) => room.id !== result.room.id)]);
    setCreateScenarioId(undefined);
    location.hash = `#/rooms/${encodeURIComponent(result.room.id)}`;
    return { roomId: result.room.id, playerToken: result.playerToken };
  }, []);

  const removeRoom = useCallback(async (roomId: string): Promise<void> => {
    if (!window.confirm("停止并移除这个房间？对局将立即结束且不可恢复。")) return;
    try {
      const response = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
      setRooms((current) => current.filter((room) => room.id !== roomId));
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  }, []);

  const scenario = useMemo(
    () => scenarios.find((candidate) => candidate.id === createScenarioId),
    [scenarios, createScenarioId]
  );

  const token = route.name === "room"
    ? sessionStorage.getItem(`society:player-token:${route.id}`) ?? undefined
    : undefined;

  if (route.name === "room") {
    return (
      <RoomView
        key={route.id}
        roomId={route.id}
        token={token}
        onBack={() => { location.hash = "#/"; }}
      />
    );
  }

  if (route.name === "caster") {
    return <CasterRoomView key={route.id} roomId={route.id} />;
  }

  if (route.name === "archive") {
    return (
      <ArchiveRoomView
        key={`archive:${route.id}`}
        archiveId={route.id}
        onBack={() => { location.hash = "#/"; }}
      />
    );
  }

  if (route.name === "about") {
    return <About onBack={() => { location.hash = "#/"; }} />;
  }

  return (
    <>
      {booting ? (
        <div className="flex min-h-screen items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <span className="size-8 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-foreground" />
            <p className="animate-pulse text-xs tracking-[0.18em] text-muted-foreground">正在唤醒世界…</p>
          </div>
        </div>
      ) : (
        <Landing
          scenarios={scenarios}
          models={models}
          rooms={rooms}
          archives={archives}
          standings={standings}
          onStart={(scenarioId) => setCreateScenarioId(scenarioId)}
          onOpenRoom={(roomId) => { location.hash = `#/rooms/${encodeURIComponent(roomId)}`; }}
          onOpenArchive={(archiveId) => { location.hash = `#/archives/${encodeURIComponent(archiveId)}`; }}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenCharacters={() => setCharactersOpen(true)}
          onOpenAbout={() => { location.hash = "#/about"; }}
          onRemoveRoom={(roomId) => { void removeRoom(roomId); }}
        />
      )}
      <CreateRoomDialog
        open={createScenarioId !== undefined}
        scenario={scenario}
        models={models}
        onOpenChange={(open) => { if (!open) setCreateScenarioId(undefined); }}
        onCreated={createRoom}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => { void loadCatalog().catch((cause) => toast.error(errorMessage(cause))); }}
      />
      <CharactersDialog
        open={charactersOpen}
        onOpenChange={setCharactersOpen}
        onChanged={() => undefined}
      />
    </>
  );
}

function parseHash(hash: string): Route {
  const roomMatch = /^#\/rooms\/([^/?#]+)/.exec(hash);
  if (roomMatch) return { name: "room", id: decodeURIComponent(roomMatch[1]) };
  const casterMatch = /^#\/caster\/([^/?#]+)/.exec(hash);
  if (casterMatch) return { name: "caster", id: decodeURIComponent(casterMatch[1]) };
  const archiveMatch = /^#\/archives\/([^/?#]+)/.exec(hash);
  if (archiveMatch) return { name: "archive", id: decodeURIComponent(archiveMatch[1]) };
  if (/^#\/about/.test(hash)) return { name: "about" };
  return { name: "landing" };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return await response.json() as T;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
