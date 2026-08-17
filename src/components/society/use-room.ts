import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRuntimeEvent, CinematicCue, SocialMessage, ThoughtBeatKind } from "@/society/contracts";
import type { SocietyRoomEventEnvelope, SocietyRoomSnapshot } from "@/society/room";

export interface LiveAgentActivity {
  /** Streamed text deltas from the model while it speaks or decides. */
  text: string;
  /** Streamed hidden reasoning from reasoning-capable providers. */
  reasoning?: string;
  /** Latest structured ThoughtBeat produced by this agent's own cognition. */
  thought?: { kind: ThoughtBeatKind; text: string; title?: string };
  /** The SDK tool the agent is currently invoking. */
  tool?: string;
  /** Latest context-compaction digest (the agent's long-term memory was compressed). */
  compacted?: string;
  /** Latest context pressure state (budget + level). */
  pressure?: { level: string; ratio: number; usable: number; current: number; window: number };
  /** Last event timestamp for this agent. */
  at: string;
}

/** One row of the unified spectator timeline (thought / tool / speech / world / cue). */
export interface TimelineEntry {
  id: string;
  at: string;
  kind: "thought" | "tool" | "message" | "action" | "cue" | "memory" | "pressure";
  actorId?: string;
  label: string;
  detail?: string;
  camera?: string;
  priority?: number;
}

export interface RoomTension {
  score: number;
  level: "calm" | "warm" | "tense" | "climax";
  reasons: string[];
  primaryAgentIds: string[];
}

export interface RoomConnection {
  room: SocietyRoomSnapshot | null;
  connection: "connected" | "reconnecting" | "closed";
  error?: string;
  /** Live per-participant model activity, reduced from SSE events. */
  activity: Record<string, LiveAgentActivity>;
  /** Tool calls seen in this connection, newest first. */
  toolCalls: Array<{ actorId: string; actorName: string; toolName: string; phase: "started" | "completed"; summary?: string; at: string }>;
  /** Messages sent through the live feed while connected. */
  feed: SocialMessage[];
  /** Current director tension (presentation-only). */
  tension: RoomTension | null;
  /** Latest cinematic cue (presentation-only). */
  cue: CinematicCue | null;
  /** Unified timeline of thought / tool / speech / action / cue events. */
  timeline: TimelineEntry[];
  pause: () => Promise<void>;
  /** Resume a room-level pause (repeated binding failures, observer pause). */
  resume: () => Promise<void>;
  /** Pause or resume one participant without touching the others. */
  toggleAgentPause: (actorId: string, paused: boolean) => Promise<void>;
  submitAction: (action: string, payload: unknown) => Promise<void>;
}

const DELTA_CAP = 480;
const REASONING_CAP = 700;

export function useRoom(roomId: string | undefined, token?: string, viewer: { mode: "public" | "omniscient" | "agent-pov" | "postgame"; agentId?: string } = { mode: "omniscient" }): RoomConnection {
  const [room, setRoom] = useState<SocietyRoomSnapshot | null>(null);
  const [connection, setConnection] = useState<RoomConnection["connection"]>("closed");
  const [error, setError] = useState<string>();
  const [activity, setActivity] = useState<Record<string, LiveAgentActivity>>({});
  const [toolCalls, setToolCalls] = useState<RoomConnection["toolCalls"]>([]);
  const [feed, setFeed] = useState<SocialMessage[]>([]);
  const [tension, setTension] = useState<RoomTension | null>(null);
  const [cue, setCue] = useState<CinematicCue | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const sourceRef = useRef<EventSource | null>(null);
  /** Last event sequence seen; EventSource re-sends it as Last-Event-ID. */
  const lastSeqRef = useRef(0);

  useEffect(() => {
    sourceRef.current?.close();
    setRoom(null);
    setError(undefined);
    setConnection("closed");
    setActivity({});
    setToolCalls([]);
    setFeed([]);
    setTension(null);
    setCue(null);
    setTimeline([]);
    lastSeqRef.current = 0;
    if (!roomId) return;

    const staticMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("static");
    const viewerQuery = `mode=${encodeURIComponent(viewer.mode)}${viewer.mode === "agent-pov" && viewer.agentId ? `&agent=${encodeURIComponent(viewer.agentId)}` : ""}`;
    if (staticMode) {
      const tokenPart = token ? `?token=${encodeURIComponent(token)}` : "";
      const query = tokenPart ? `${tokenPart}&${viewerQuery}` : `?${viewerQuery}`;
      fetch(`/api/rooms/${encodeURIComponent(roomId)}${query}`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.json() as SocietyRoomSnapshot;
        })
        .then((next) => {
          setRoom(next);
          setFeed(next.world.messages);
          setConnection("closed");
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
      return;
    }

    const tokenPart = token ? `?token=${encodeURIComponent(token)}` : "";
    const query = tokenPart ? `${tokenPart}&${viewerQuery}` : `?${viewerQuery}`;
    // Reconnect recovery: the server writes `id:` per envelope and replays the
    // backlog after the Last-Event-ID header this source re-sends on reconnect;
    // the reducer dedupes by seq, so replays are idempotent.
    const source = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/events${query}`);
    sourceRef.current = source;
    source.onopen = () => setConnection("connected");
    source.addEventListener("snapshot", (event) => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as SocietyRoomSnapshot;
        setRoom(next);
        setFeed(next.world.messages);
      } catch {
        setError("无法解析房间快照");
      }
    });
    source.addEventListener("event", (event) => {
      try {
        const envelope = JSON.parse((event as MessageEvent).data) as SocietyRoomEventEnvelope;
        if (typeof envelope.seq === "number") {
          if (envelope.seq <= lastSeqRef.current) return; // replayed backlog: idempotent
          lastSeqRef.current = envelope.seq;
        }
        reduceEvent(envelope.event, setRoom, setActivity, setToolCalls, setFeed, setTension, setCue, setTimeline);
      } catch {
        // Ignore malformed envelopes; the next snapshot self-heals the view.
      }
    });
    source.onerror = () => setConnection("reconnecting");
    return () => {
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
    };
  }, [roomId, token, viewer.mode, viewer.agentId]);

  const pause = useCallback(async (): Promise<void> => {
    if (!roomId) return;
    try {
      const query = token ? `?token=${encodeURIComponent(token)}` : "";
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/pause${query}`, { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(payload?.message ?? `HTTP ${response.status}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [roomId, token]);

  const resume = useCallback(async (): Promise<void> => {
    if (!roomId) return;
    try {
      const query = token ? `?token=${encodeURIComponent(token)}` : "";
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/resume${query}`, { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(payload?.message ?? `HTTP ${response.status}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [roomId, token]);

  const toggleAgentPause = useCallback(async (actorId: string, paused: boolean): Promise<void> => {
    if (!roomId) return;
    try {
      const query = token ? `?token=${encodeURIComponent(token)}` : "";
      const action = paused ? "pause" : "resume";
      const response = await fetch(
        `/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(actorId)}/${action}${query}`,
        { method: "POST" }
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(payload?.message ?? `HTTP ${response.status}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [roomId, token]);

  const submitAction = useCallback(async (action: string, payload: unknown): Promise<void> => {
    if (!roomId) return;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "x-player-token": token } : {}) },
        body: JSON.stringify({ action, payload })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new Error(body?.message ?? `HTTP ${response.status}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [roomId, token]);

  return { room, connection, error, activity, toolCalls, feed, tension, cue, timeline, pause, resume, toggleAgentPause, submitAction };
}

function reduceEvent(
  event: AgentRuntimeEvent,
  setRoom: React.Dispatch<React.SetStateAction<SocietyRoomSnapshot | null>>,
  setActivity: React.Dispatch<React.SetStateAction<Record<string, LiveAgentActivity>>>,
  setToolCalls: React.Dispatch<React.SetStateAction<RoomConnection["toolCalls"]>>,
  setFeed: React.Dispatch<React.SetStateAction<SocialMessage[]>>,
  setTension: React.Dispatch<React.SetStateAction<RoomTension | null>>,
  setCue: React.Dispatch<React.SetStateAction<CinematicCue | null>>,
  setTimeline: React.Dispatch<React.SetStateAction<TimelineEntry[]>>
): void {
  const pushTimeline = (entry: TimelineEntry): void => {
    setTimeline((current) => [entry, ...current].slice(0, 120));
  };
  if (event.type === "world.updated") {
    setRoom((current) => (current ? { ...current, world: event.snapshot } : current));
    return;
  }
  if (event.type === "agent.delta") {
    setActivity((current) => {
      const previous = current[event.actorId]?.text ?? "";
      const text = (previous + event.delta).slice(-DELTA_CAP);
      return { ...current, [event.actorId]: { text, at: event.at, tool: current[event.actorId]?.tool, reasoning: current[event.actorId]?.reasoning } };
    });
    return;
  }
  if (event.type === "agent.reasoning") {
    setActivity((current) => {
      const previous = current[event.actorId]?.reasoning ?? "";
      const reasoning = (previous + event.delta).slice(-REASONING_CAP);
      return { ...current, [event.actorId]: { ...current[event.actorId], reasoning, at: event.at } };
    });
    return;
  }
  if (event.type === "agent.thought-beat") {
    setActivity((current) => ({
      ...current,
      [event.actorId]: {
        ...current[event.actorId],
        thought: { kind: event.beat.kind, text: event.beat.summary, title: event.beat.title },
        at: event.at
      }
    }));
    pushTimeline({
      id: event.beat.id,
      at: event.at,
      kind: "thought",
      actorId: event.actorId,
      label: event.beat.title,
      detail: event.beat.summary.slice(0, 160)
    });
    return;
  }
  if (event.type === "agent.status") {
    setActivity((current) => {
      const previous = current[event.actorId];
      if (event.status === "thinking" && previous && !previous.tool) return { ...current, [event.actorId]: { text: "", at: event.at } };
      if (event.status === "idle" || event.status === "finished") return { ...current, [event.actorId]: { text: "", at: event.at, tool: previous?.tool } };
      return { ...current, [event.actorId]: { text: previous?.text ?? "", at: event.at, tool: previous?.tool } };
    });
    return;
  }
  if (event.type === "agent.tool") {
    setActivity((current) => ({
      ...current,
      [event.actorId]: {
        text: current[event.actorId]?.text ?? "",
        tool: event.phase === "started" ? event.toolName : undefined,
        at: event.at
      }
    }));
    setToolCalls((current) => [
      {
        actorId: event.actorId,
        actorName: "", // resolved by the view against the room snapshot
        toolName: event.toolName,
        phase: event.phase === "started" ? "started" as const : "completed" as const,
        ...(event.safeOutputSummary ? { summary: event.safeOutputSummary } : {}),
        at: event.at
      },
      ...current
    ].slice(0, 40));
    if (event.phase === "succeeded") {
      pushTimeline({
        id: event.toolCallId,
        at: event.at,
        kind: "tool",
        actorId: event.actorId,
        label: event.label ?? event.toolName,
        detail: event.safeOutputSummary?.slice(0, 140)
      });
    }
    return;
  }
  if (event.type === "agent.message") {
    setFeed((current) => [...current.slice(-99), event.message]);
    pushTimeline({
      id: event.message.id,
      at: event.message.createdAt,
      kind: "message",
      actorId: event.message.senderId,
      label: event.message.channel === "public" ? "公开发言" : event.message.channel === "private" ? "私聊" : "阵营频道",
      detail: event.message.text.slice(0, 140)
    });
    return;
  }
  if (event.type === "world.action") {
    pushTimeline({
      id: event.action,
      at: event.at,
      kind: "action",
      actorId: event.actorId,
      label: event.action,
      detail: event.detail.slice(0, 140)
    });
    return;
  }
  if (event.type === "tension.changed") {
    setTension({
      score: event.score,
      level: event.level,
      reasons: event.reasons,
      primaryAgentIds: event.primaryAgentIds
    });
    return;
  }
  if (event.type === "cinematic.cue") {
    setCue(event.cue);
    pushTimeline({
      id: event.cue.id,
      at: event.cue.createdAt,
      kind: "cue",
      label: event.cue.title ?? event.cue.camera,
      detail: event.cue.subtitle,
      camera: event.cue.camera,
      priority: event.cue.priority
    });
    return;
  }
  if (event.type === "agent.compacted") {
    setActivity((current) => ({
      ...current,
      [event.actorId]: {
        text: current[event.actorId]?.text ?? "",
        compacted: `上下文已压缩：${event.estimatedTokens.toLocaleString()} → 摘要（阈值 ${event.threshold.toLocaleString()}，压缩后压力 ${Math.round(event.pressureAfter * 100)}%）`,
        at: event.at
      }
    }));
    pushTimeline({
      id: `compacted-${event.at}`,
      at: event.at,
      kind: "memory",
      actorId: event.actorId,
      label: "记忆压缩",
      detail: `压力降至 ${Math.round(event.pressureAfter * 100)}%`
    });
    return;
  }
  if (event.type === "agent.context.pressure") {
    setActivity((current) => ({
      ...current,
      [event.actorId]: {
        ...current[event.actorId],
        pressure: {
          level: event.level,
          ratio: event.pressureRatio,
          usable: event.usableInputTokens,
          current: event.currentInputTokens,
          window: event.contextWindow
        },
        at: event.at
      }
    }));
    return;
  }
}
