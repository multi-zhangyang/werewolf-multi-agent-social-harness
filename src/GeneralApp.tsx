import { lazy, Suspense, useCallback, useEffect, useState, type CSSProperties } from "react";
import { FlaskConical, MessageCircle, Settings, Users } from "lucide-react";
import { toast } from "sonner";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { InteractionHome } from "@/components/interaction/home";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { json, type Catalog, type RunSummary } from "@/components/interaction/api";
import type { Character, WorldEvent } from "@/runtime/types";

const SettingsPage = lazy(() => import("@/components/society/settings-dialog").then(m => ({ default: m.SettingsPage })));
const CreateInteraction = lazy(() => import("@/components/interaction/create").then(m => ({ default: m.CreateInteraction })));
const RunRoom = lazy(() => import("@/components/interaction/room").then(m => ({ default: m.RunRoom })));
const Conversation = lazy(() => import("@/components/interaction/room").then(m => ({ default: m.Conversation })));
const Research = lazy(() => import("@/components/interaction/research").then(m => ({ default: m.Research })));
const Studies = lazy(() => import("@/components/interaction/studies").then(m => ({ default: m.Studies })));
const Characters = lazy(() => import("@/components/interaction/characters").then(m => ({ default: m.Characters })));
type ArchiveMeta = { id: string; title: string; finishedAt: string };

export function App() {
  const [hash, setHash] = useState(location.hash);
  const [catalog, setCatalog] = useState<Catalog>(); const [runs, setRuns] = useState<RunSummary[]>([]); const [archives, setArchives] = useState<ArchiveMeta[]>([]); const [error, setError] = useState("");
  const refresh = useCallback(() => { void Promise.all([json<Catalog>("/api/v2/catalog"), json<{ runs: RunSummary[] }>("/api/v2/runs"), json<{ archives: ArchiveMeta[] }>("/api/archives")]).then(([c, r, a]) => { setCatalog(c); setRuns(r.runs); setArchives(a.archives); setError(""); }).catch(e => setError(e.message)); }, []);
  useEffect(() => { const change = () => { setHash(location.hash); refresh(); }; window.addEventListener("hashchange", change); refresh(); return () => window.removeEventListener("hashchange", change); }, [refresh]);
  const route = hash.split("?")[0].replace(/^#\/?/, "").split("/"); const page = route[0] || "interaction";
  let content;
  if (!catalog) content = <div className="page-content">{error ? <Empty><EmptyHeader><EmptyTitle>{error}</EmptyTitle></EmptyHeader><EmptyContent><Button onClick={refresh}>重试</Button></EmptyContent></Empty> : <Skeleton className="h-72 w-full" />}</div>;
  else if (page === "runs") content = <RunRoom key={route[1]} id={route[1]} />;
  else if (page === "create") content = <CreateInteraction key={hash} catalog={catalog} />;
  else if (page === "characters") content = <Characters catalog={catalog} refresh={refresh} />;
  else if (page === "research") content = <Research id={route[1]} runs={runs} />;
  else if (page === "studies") content = <Studies id={route[1]} />;
  else if (page === "settings") content = <Suspense fallback={<Skeleton className="h-72 w-full" />}><SettingsPage onBack={() => { location.hash = "#/"; }} onSaved={refresh} /></Suspense>;
  else if (page === "archives") content = <LegacyArchive id={route[1]} />;
  else content = <InteractionHome catalog={catalog} runs={runs} archives={archives} />;
  return <SidebarProvider style={{ "--sidebar-width": "13.5rem" } as CSSProperties}><Navigation page={page} /><SidebarInset className="min-w-0"><div className="mobile-navigation"><SidebarTrigger /><span>Society</span><div className="ml-auto"><ThemeToggle /></div></div><Suspense fallback={<Skeleton className="m-8 h-72" />}>{content}</Suspense></SidebarInset></SidebarProvider>;
}
function Navigation({ page }: { page: string }) {
  const { setOpenMobile } = useSidebar();
  return <Sidebar collapsible="icon"><SidebarHeader><a className="society-brand" href="#/" onClick={() => setOpenMobile(false)}><span className="brand-symbol">s</span><span>Society</span></a></SidebarHeader><SidebarContent><SidebarGroup><SidebarGroupContent><SidebarMenu>{[{ id: "interaction", label: "互动", icon: MessageCircle, href: "#/" }, { id: "characters", label: "人物", icon: Users, href: "#/characters" }, { id: "studies", label: "实验", icon: FlaskConical, href: "#/studies" }, { id: "research", label: "回看", icon: FlaskConical, href: "#/research" }].map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton asChild isActive={item.id === page || item.id === "interaction" && ["runs", "create", "archives"].includes(page)}><a href={item.href} onClick={() => setOpenMobile(false)}><item.icon /><span>{item.label}</span></a></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent><SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton asChild isActive={page === "settings"}><a href="#/settings" onClick={() => setOpenMobile(false)}><Settings /><span>设置</span></a></SidebarMenuButton></SidebarMenuItem></SidebarMenu><div className="flex items-center justify-between px-2 py-2"><span className="text-xs text-muted-foreground">外观</span><ThemeToggle /></div></SidebarFooter></Sidebar>;
}
function LegacyArchive({ id }: { id: string }) {
  const [data, setData] = useState<{ characters: Character[]; events: WorldEvent[]; title: string }>();
  useEffect(() => { void json<{ room: { title: string; participants: Array<{ profile: { id: string; displayName: string } }>; world: { messages: Array<{ id: string; senderId: string; text: string; channel: string }> } } }>(`/api/archives/${id}`).then(({ room }) => setData({ title: room.title, characters: room.participants.map(p => ({ id: p.profile.id, name: p.profile.displayName, persona: "", goals: [], values: [], voice: "" })), events: room.world.messages.map((m, i) => ({ id: m.id, seq: i, runId: id, at: "", type: "message", actorId: m.senderId, text: m.text, visibility: "public", data: { channel: m.channel } })) })).catch(e => toast.error(e.message)); }, [id]);
  return <section className="room-shell"><header className="room-heading"><h1>{data?.title ?? "历史归档"}</h1><Badge variant="secondary">只读</Badge></header>{data ? <Conversation events={data.events} characters={data.characters} /> : <Skeleton className="h-72 w-full" />}</section>;
}
