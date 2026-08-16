import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { CreateRoomDialog } from "@/components/society/create-room";
import { Landing } from "@/components/society/landing";
import { RoomView } from "@/components/society/room-view";
import { SettingsDialog } from "@/components/society/settings-dialog";
import type { CreateRoomInput, CreateRoomResult, ModelOption } from "@/components/society/types";

interface CatalogResponse {
  scenarios: ScenarioSummary[];
  models: ModelOption[];
}

interface RoomListResponse {
  rooms: SocietyRoomSnapshot[];
}

type Route = { name: "landing" } | { name: "room"; id: string };

export function App(): ReactNode {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [rooms, setRooms] = useState<SocietyRoomSnapshot[]>([]);
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [createScenarioId, setCreateScenarioId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const loadCatalog = useCallback(async (): Promise<void> => {
    const [catalog, list] = await Promise.all([getJson<CatalogResponse>("/api/scenarios"), getJson<RoomListResponse>("/api/rooms")]);
    setScenarios(catalog.scenarios);
    setModels(catalog.models);
    setRooms(list.rooms);
  }, []);

  useEffect(() => {
    let active = true;
    void loadCatalog()
      .catch((cause) => { if (active) setError(errorMessage(cause)); })
      .finally(() => { if (active) setBooting(false); });
    return () => { active = false; };
  }, [loadCatalog]);

  useEffect(() => {
    const poll = window.setInterval(() => {
      void getJson<RoomListResponse>("/api/rooms").then((list) => setRooms(list.rooms)).catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(poll);
  }, []);

  const createRoom = useCallback(async (input: CreateRoomInput): Promise<CreateRoomResult> => {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
    const result = payload as { room: SocietyRoomSnapshot } & Partial<CreateRoomResult>;
    if (result.playerToken) {
      sessionStorage.setItem(`society:player-token:${result.room.id}`, result.playerToken);
    }
    setRooms((current) => [result.room, ...current.filter((room) => room.id !== result.room.id)]);
    setCreateScenarioId(undefined);
    location.hash = `#/rooms/${encodeURIComponent(result.room.id)}`;
    return { roomId: result.room.id, playerToken: result.playerToken };
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

  return (
    <>
      {booting ? (
        <div className="flex min-h-screen items-center justify-center">
          <span className="size-8 animate-spin rounded-full border-2 border-white/10 border-t-zinc-300" />
        </div>
      ) : (
        <Landing
          scenarios={scenarios}
          models={models}
          rooms={rooms}
          onStart={(scenarioId) => setCreateScenarioId(scenarioId)}
          onOpenRoom={(roomId) => { location.hash = `#/rooms/${encodeURIComponent(roomId)}`; }}
          onOpenSettings={() => setSettingsOpen(true)}
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
        onSaved={() => { void loadCatalog().catch((cause) => setError(errorMessage(cause))); }}
      />
      {error ? (
        <div className="fixed inset-x-0 bottom-4 z-30 mx-auto w-fit rounded-lg border border-red-400/20 bg-[#140a0a] px-4 py-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}
    </>
  );
}

function parseHash(hash: string): Route {
  const match = /^#\/rooms\/([^/?#]+)/.exec(hash);
  if (match) return { name: "room", id: decodeURIComponent(match[1]) };
  return { name: "landing" };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return await response.json() as T;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
