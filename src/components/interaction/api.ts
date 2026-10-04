import { apiFetch } from "@/lib/api";
import type { ActionSpec, Character, CharacterSnapshot, Memory, Opportunity, RunSpec, RunStatus, WorldEvent } from "@/runtime/types";
import type { SignalingResult } from "@/runtime/scenarios/signaling";

export interface Catalog {
  scenarios: Array<{ id: RunSpec["scenario"]; name: string; players: number; playerRange?: { min: number; max: number }; defaultRounds: number; maxRounds: number }>;
  characters: Character[]; customCharacterIds?: string[]; models: Array<{ id: string; name: string }>; defaultModel: string;
}
export interface RunSummary { id: string; scenario: RunSpec["scenario"]; status: RunStatus; createdAt: string; characters: Character[]; mode: string; worldId: string; }
export interface RunView extends RunSummary {
  modelConfigs?: Record<string, Record<string, unknown>>;
  events: WorldEvent[]; spec?: RunSpec; world: { phase?: string; phaseId?: string; protocol?: string; investorId?: string; trusteeId?: string; investment?: number; returned?: number; pledge?: number; repair?: number; round?: number; scores?: Record<string, number>; alive?: string[]; revealed?: Record<string, string>; winners?: string[];
    incentives?: RunSpec["signalingIncentives"]; payoffProfile?: RunSpec["signalingPayoffProfile"]; senderId?: string; receiverId?: string; highQuality?: boolean; reportedHighQuality?: boolean; accepted?: boolean; reportAccurate?: boolean; history?: SignalingResult[] };
  active: Array<{ actorId: string }>;
  opportunities: Array<Omit<Opportunity, "actions"> & { actions: Omit<ActionSpec, "parameters">[] }>;
  memories: Memory[];
}
export const scenarioNames: Record<RunSpec["scenario"], string> = { "trust-game": "信任博弈", "public-goods": "公共品博弈", werewolf: "狼人杀", "signaling-game": "信息交易" };
export const statusNames: Record<RunStatus, string> = { running: "进行中", paused: "已暂停", completed: "已结束", incomplete: "未完成", stopped: "已停止", interrupted: "已中断" };
export function runToken(id: string) { return localStorage.getItem(`society:run:${id}:owner`); }
export function playerTokens(id: string): Record<string, string> { return JSON.parse(sessionStorage.getItem(`society:run:${id}:players`) ?? "{}"); }
export function headersFor(id?: string, token?: string): HeadersInit {
  const bearer = token ?? (id ? runToken(id) : undefined);
  return { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) };
}
export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? "请求失败");
  return data;
}
export function snapshots(id: string) { return json<{ snapshots: CharacterSnapshot[] }>(`/api/v2/characters/${id}/snapshots`); }
export async function createRun(spec: Partial<RunSpec>) {
  const result = await json<{ run: RunView; ownerToken: string; playerTokens: Record<string, string> }>("/api/v2/runs", { method: "POST", headers: headersFor(), body: JSON.stringify(spec) });
  return enterCreatedRun(result);
}
export async function restartRun(id: string, play: boolean) {
  const result = await json<{ run: RunView; ownerToken: string; playerTokens: Record<string, string> }>(`/api/v2/runs/${id}/restart`, { method: "POST", headers: headersFor(), body: JSON.stringify({ play }) });
  return enterCreatedRun(result);
}
function enterCreatedRun(result: { run: RunView; ownerToken: string; playerTokens: Record<string, string> }) {
  localStorage.setItem(`society:run:${result.run.id}:owner`, result.ownerToken);
  sessionStorage.setItem(`society:run:${result.run.id}:players`, JSON.stringify(result.playerTokens));
  location.hash = `#/runs/${result.run.id}`;
  return result;
}
