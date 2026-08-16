import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRuntimeEvent, SocialMessage } from "@/society/contracts";
import type { SocietyRoomEventEnvelope, SocietyRoomSnapshot } from "@/society/room";

export interface LiveAgentActivity {
  /** Streamed text deltas from the model while it speaks or decides. */
  text: string;
  /** The SDK tool the agent is currently invoking. */
  tool?: string;
  /** Last event timestamp for this agent. */
  at: string;
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
  pause: () => Promise<void>;
  submitAction: (action: string, payload: unknown) => Promise<void>;
}

const DELTA_CAP = 480;

export function useRoom(roomId: string | undefined, token?: string): RoomConnection {
  const [room, setRoom] = useState<SocietyRoomSnapshot | null>(null);
  const [connection, setConnection] = useState<RoomConnection["connection"]>("closed");
  const [error, setError] = useState<string>();
  const [activity, setActivity] = useState<Record<string, LiveAgentActivity>>({});
  const [toolCalls, setToolCalls] = useState<RoomConnection["toolCalls"]>([]);
  const [feed, setFeed] = useState<SocialMessage[]>([]);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    sourceRef.current?.close();
    setRoom(null);
    setError(undefined);
    setConnection("closed");
    setActivity({});
    setToolCalls([]);
    setFeed([]);
    if (!roomId) return;

    const staticMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("static");
    if (staticMode) {
      const query = token ? `?token=${encodeURIComponent(token)}` : "";
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

    const query = token ? `?token=${encodeURIComponent(token)}` : "";
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
        reduceEvent(envelope.event, setActivity, setToolCalls, setFeed);
      } catch {
        // Ignore malformed envelopes; the next snapshot self-heals the view.
      }
    });
    source.onerror = () => setConnection("reconnecting");
    return () => {
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
    };
  }, [roomId, token]);

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

  return { room, connection, error, activity, toolCalls, feed, pause, submitAction };
}

function reduceEvent(
  event: AgentRuntimeEvent,
  setActivity: React.Dispatch<React.SetStateAction<Record<string, LiveAgentActivity>>>,
  setToolCalls: React.Dispatch<React.SetStateAction<RoomConnection["toolCalls"]>>,
  setFeed: React.Dispatch<React.SetStateAction<SocialMessage[]>>
): void {
  if (event.type === "agent.delta") {
    setActivity((current) => {
      const previous = current[event.actorId]?.text ?? "";
      const text = (previous + event.delta).slice(-DELTA_CAP);
      return { ...current, [event.actorId]: { text, at: event.at, tool: current[event.actorId]?.tool } };
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
        phase: event.phase,
        ...(event.summary ? { summary: event.summary } : {}),
        at: event.at
      },
      ...current
    ].slice(0, 40));
    return;
  }
  if (event.type === "agent.message") {
    setFeed((current) => [...current.slice(-99), event.message]);
  }
}
