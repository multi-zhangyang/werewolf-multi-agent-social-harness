import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { apiFetch, storeOwnerToken } from "@/lib/api";
import type { ScenarioSummary } from "@/society/contracts";
import type { SocietyRoomSnapshot } from "@/society/room";
import { Landing } from "@/components/society/landing";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import type { ArchiveOption, CreateRoomInput, CreateRoomResult, ModelOption } from "@/components/society/types";

const About = lazy(() => import("@/components/society/about").then((module) => ({ default: module.About })));
const CharactersPage = lazy(() => import("@/components/society/characters-dialog").then((module) => ({ default: module.CharactersPage })));
const CreateRoomPage = lazy(() => import("@/components/society/create-room").then((module) => ({ default: module.CreateRoomPage })));
const RoomView = lazy(() => import("@/components/society/room-view").then((module) => ({ default: module.RoomView })));
const ArchiveRoomView = lazy(() => import("@/components/society/room-view").then((module) => ({ default: module.ArchiveRoomView })));
const CasterRoomView = lazy(() => import("@/components/society/caster-view").then((module) => ({ default: module.CasterRoomView })));
const SettingsPage = lazy(() => import("@/components/society/settings-dialog").then((module) => ({ default: module.SettingsPage })));

interface CatalogResponse {
  scenarios: ScenarioSummary[];
  models: ModelOption[];
  randomPoolProfileIds?: string[];
}
interface RoomListResponse { rooms: SocietyRoomSnapshot[] }
interface ArchiveListResponse { archives: ArchiveOption[] }

export interface HealthResponse {
  ok: boolean;
  rooms: number;
  models: { enabled: number; ready: number; failed: number; stale: number };
  storage: {
    status: "ok" | "degraded";
    issues: Array<{
      store: "models" | "characters" | "templates" | "archives";
      code: "CORRUPT_FILE_QUARANTINED" | "READ_FAILED" | "WRITE_FAILED";
    }>;
  };
}

type Route =
  | { name: "landing" }
  | { name: "create"; scenarioId?: string }
  | { name: "settings" }
  | { name: "characters" }
  | { name: "room"; id: string }
  | { name: "caster"; id: string }
  | { name: "archive"; id: string }
  | { name: "about" };

export function App(): ReactNode {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultPoolProfileIds, setDefaultPoolProfileIds] = useState<string[]>([]);
  const [rooms, setRooms] = useState<SocietyRoomSnapshot[]>([]);
  const [archives, setArchives] = useState<ArchiveOption[]>([]);
  const [health, setHealth] = useState<HealthResponse>();
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [booting, setBooting] = useState(true);
  const [roomPendingRemoval, setRoomPendingRemoval] = useState<string>();

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const detail = route.name === "room" || route.name === "archive" || route.name === "caster" ? route.id.slice(0, 8) : undefined;
    const titles: Record<Route["name"], string> = {
      landing: "Society — 多智能体社会博弈竞技场",
      create: "创建世界 · Society",
      settings: "模型设置 · Society",
      characters: "人物库 · Society",
      room: `${detail ?? "房间"} · Society`,
      caster: `${detail ?? "房间"} 直播 · Society`,
      archive: `${detail ?? "归档"} 复盘 · Society`,
      about: "关于 · Society"
    };
    document.title = titles[route.name];
  }, [route]);

  const loadCatalog = useCallback(async (): Promise<void> => {
    const [catalog, list, archiveList, healthResult] = await Promise.all([
      getJson<CatalogResponse>("/api/scenarios"),
      getJson<RoomListResponse>("/api/rooms"),
      getJson<ArchiveListResponse>("/api/archives").catch(() => ({ archives: [] as ArchiveOption[] })),
      getJson<HealthResponse>("/api/health")
    ]);
    setScenarios(catalog.scenarios);
    setModels(catalog.models);
    setDefaultPoolProfileIds(Array.isArray(catalog.randomPoolProfileIds) ? catalog.randomPoolProfileIds : []);
    setRooms(list.rooms);
    setArchives(archiveList.archives);
    setHealth(healthResult);
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
      void Promise.all([getJson<RoomListResponse>("/api/rooms"), getJson<HealthResponse>("/api/health")])
        .then(([list, currentHealth]) => { setRooms(list.rooms); setHealth(currentHealth); })
        .catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(poll);
  }, []);

  const createRoom = useCallback(async (input: CreateRoomInput): Promise<CreateRoomResult> => {
    const response = await apiFetch("/api/rooms", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input)
    });
    const payload = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
    const result = payload as { room: SocietyRoomSnapshot } & Partial<CreateRoomResult>;
    if (result.ownerToken) storeOwnerToken(result.ownerToken);
    if (result.playerToken) sessionStorage.setItem(`society:player-token:${result.room.id}`, result.playerToken);
    setRooms((current) => [result.room, ...current.filter((room) => room.id !== result.room.id)]);
    location.hash = `#/rooms/${encodeURIComponent(result.room.id)}`;
    return { roomId: result.room.id, playerToken: result.playerToken };
  }, []);

  const removeRoom = useCallback(async (roomId: string): Promise<void> => {
    try {
      const response = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${response.status}`);
      setRooms((current) => current.filter((room) => room.id !== roomId));
      setRoomPendingRemoval(undefined);
    } catch (cause) { toast.error(errorMessage(cause)); }
  }, []);

  const scenario = useMemo(() => {
    if (route.name !== "create") return undefined;
    return scenarios.find((candidate) => candidate.id === route.scenarioId) ?? scenarios[0];
  }, [route, scenarios]);
  const token = route.name === "room" ? sessionStorage.getItem(`society:player-token:${route.id}`) ?? undefined : undefined;

  if (booting) return <RouteFallback label="正在检查本机环境…" />;
  if (route.name === "room") return <Suspense fallback={<RouteFallback />}><RoomView key={route.id} roomId={route.id} token={token} onBack={goHome} /></Suspense>;
  if (route.name === "caster") return <Suspense fallback={<RouteFallback />}><CasterRoomView key={route.id} roomId={route.id} /></Suspense>;
  if (route.name === "archive") return <Suspense fallback={<RouteFallback />}><ArchiveRoomView key={`archive:${route.id}`} archiveId={route.id} onBack={goHome} /></Suspense>;
  if (route.name === "about") return <Suspense fallback={<RouteFallback />}><About onBack={goHome} /></Suspense>;
  if (route.name === "settings") return <Suspense fallback={<RouteFallback />}><SettingsPage onBack={goHome} onSaved={() => void loadCatalog().catch((cause) => toast.error(errorMessage(cause)))} /></Suspense>;
  if (route.name === "characters") return <Suspense fallback={<RouteFallback />}><CharactersPage onBack={goHome} onChanged={() => undefined} /></Suspense>;
  if (route.name === "create") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <CreateRoomPage
          scenario={scenario}
          scenarios={scenarios}
          models={models}
          defaultPoolProfileIds={defaultPoolProfileIds}
          onScenarioChange={(scenarioId) => { location.hash = `#/create/${encodeURIComponent(scenarioId)}`; }}
          onBack={goHome}
          onOpenSettings={() => { location.hash = "#/settings"; }}
          onCreated={createRoom}
        />
      </Suspense>
    );
  }

  return (
    <>
      <Landing
        scenarios={scenarios} models={models} rooms={rooms} archives={archives} health={health}
        onStart={(scenarioId) => { location.hash = `#/create/${encodeURIComponent(scenarioId)}`; }}
        onOpenRoom={(roomId) => { location.hash = `#/rooms/${encodeURIComponent(roomId)}`; }}
        onOpenArchive={(archiveId) => { location.hash = `#/archives/${encodeURIComponent(archiveId)}`; }}
        onOpenSettings={() => { location.hash = "#/settings"; }}
        onOpenCharacters={() => { location.hash = "#/characters"; }}
        onOpenAbout={() => { location.hash = "#/about"; }}
        onRemoveRoom={setRoomPendingRemoval}
      />
      <AlertDialog open={roomPendingRemoval !== undefined} onOpenChange={(open) => { if (!open) setRoomPendingRemoval(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>停止并移除这个房间？</AlertDialogTitle><AlertDialogDescription>对局会立即结束，当前进程中的房间状态无法恢复。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => { if (roomPendingRemoval) void removeRoom(roomPendingRemoval); }}>移除房间</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function goHome(): void { location.hash = "#/"; }
function RouteFallback({ label = "正在加载页面…" }: { label?: string }): ReactNode {
  return <div className="flex min-h-screen flex-col items-center justify-center gap-3"><Spinner className="size-8" /><p className="text-sm text-muted-foreground">{label}</p></div>;
}

export function parseHash(hash: string): Route {
  const roomMatch = /^#\/rooms\/([^/?#]+)/.exec(hash);
  if (roomMatch) return { name: "room", id: decodeURIComponent(roomMatch[1]) };
  const casterMatch = /^#\/caster\/([^/?#]+)/.exec(hash);
  if (casterMatch) return { name: "caster", id: decodeURIComponent(casterMatch[1]) };
  const archiveMatch = /^#\/archives\/([^/?#]+)/.exec(hash);
  if (archiveMatch) return { name: "archive", id: decodeURIComponent(archiveMatch[1]) };
  const createMatch = /^#\/create(?:\/([^/?#]+))?/.exec(hash);
  if (createMatch) return { name: "create", ...(createMatch[1] ? { scenarioId: decodeURIComponent(createMatch[1]) } : {}) };
  if (/^#\/settings/.test(hash)) return { name: "settings" };
  if (/^#\/characters/.test(hash)) return { name: "characters" };
  if (/^#\/about/.test(hash)) return { name: "about" };
  return { name: "landing" };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return await response.json() as T;
}
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
