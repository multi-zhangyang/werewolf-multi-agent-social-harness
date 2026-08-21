import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import type { AgentRuntimeEvent, CinematicCue, SocialMessage, ThoughtBeatKind } from "@/society/contracts";
import type { SocietyRoomEventEnvelope, SocietyRoomSnapshot } from "@/society/room";

export type LiveAgentProcessStep =
  | {
      id: string;
      kind: "reasoning";
      text: string;
      elapsedMs: number;
      done: boolean;
      startedAt: string;
      updatedAt: string;
    }
  | {
      id: string;
      kind: "output";
      text: string;
      streaming: boolean;
      startedAt: string;
      updatedAt: string;
    }
  | {
      id: string;
      kind: "tool";
      toolCallId: string;
      toolName: string;
      label?: string;
      phase: "queued" | "started" | "streaming" | "succeeded" | "failed";
      safeInputSummary?: string;
      safeOutputSummary?: string;
      errorCode?: string;
      startedAt: string;
      updatedAt: string;
    };

export interface LiveAgentActivity {
  /** Streamed text deltas from the model while it speaks or decides. */
  text: string;
  /** Provider-returned reasoning channel for the current activation. */
  reasoningContent?: { text: string; elapsedMs: number; done: boolean; completedAt?: string };
  /** Provider-returned reasoning summary; never raw hidden reasoning. */
  reasoningSummary?: string;
  /** Latest structured ThoughtBeat produced by this agent's own cognition. */
  thought?: { kind: ThoughtBeatKind; text: string; title?: string };
  /** The SDK tool the agent is currently invoking. */
  tool?: string;
  /** Ordered, live-only model/reasoning/tool trace for the current activation. */
  processSteps?: LiveAgentProcessStep[];
  liveStatus?: "lobby" | "idle" | "thinking" | "acting" | "speaking" | "paused" | "error" | "finished";
  completedAt?: string;
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
  kind: "thought" | "tool" | "message" | "action" | "cue" | "memory" | "pressure" | "notice";
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

const DELTA_CAP = 8_000;
const REASONING_SUMMARY_CAP = 700;
const REASONING_CONTENT_CAP = 12_000;
const PROCESS_STEP_CAP = 16;
const LIVE_TRACE_RETENTION_MS = 20_000;

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
    const query = `?${viewerQuery}`;
    let cancelled = false;
    let source: EventSource | undefined;

    const connect = async (): Promise<void> => {
      // EventSource cannot attach an Authorization header. Authenticate one
      // ordinary snapshot request first; the server exchanges the accepted
      // header for an HttpOnly same-origin cookie used by the SSE connection.
      const response = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}${query}`, {
        headers: token ? { "x-player-token": token } : undefined
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(payload?.message ?? `HTTP ${response.status}`);
      }
      const initial = await response.json() as SocietyRoomSnapshot;
      if (cancelled) return;
      setRoom(initial);
      setFeed(initial.world.messages);
      if (staticMode) {
        setConnection("closed");
        return;
      }

      // Reconnect recovery: the server writes `id:` per envelope and replays
      // from Last-Event-ID. No credential is ever placed in the URL.
      source = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/events${query}`);
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
      let retries = 0;
      source.onerror = () => {
        retries += 1;
        setConnection("reconnecting");
        // A room that left process memory has no live stream. The bootstrap
        // cookie/header path remains valid for its viewer-safe archive.
        if (retries >= 3) {
          source?.close();
          if (sourceRef.current === source) sourceRef.current = null;
          apiFetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
            headers: token ? { "x-player-token": token } : undefined
          })
            .then(async (fallbackResponse) => {
              if (!fallbackResponse.ok) throw new Error(`HTTP ${fallbackResponse.status}`);
              const next = await fallbackResponse.json() as SocietyRoomSnapshot;
              setRoom(next);
              setFeed(next.world.messages);
              setConnection("closed");
            })
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        }
      };
    };
    void connect().catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      source?.close();
      if (sourceRef.current === source) sourceRef.current = null;
    };
  }, [roomId, token, viewer.mode, viewer.agentId]);

  const pause = useCallback(async (): Promise<void> => {
    if (!roomId) return;
    try {
      const response = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/pause`, {
        method: "POST",
        headers: token ? { "x-player-token": token } : undefined
      });
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
      const response = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/resume`, {
        method: "POST",
        headers: token ? { "x-player-token": token } : undefined
      });
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
      const action = paused ? "pause" : "resume";
      const response = await apiFetch(
        `/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(actorId)}/${action}`,
        { method: "POST", headers: token ? { "x-player-token": token } : undefined }
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
      const response = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/action`, {
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

function appendOutputStep(steps: LiveAgentProcessStep[], delta: string, at: string): LiveAgentProcessStep[] {
  const next = finishOpenSteps(steps, at, "output");
  const last = next.at(-1);
  if (last?.kind === "output" && last.streaming) {
    next[next.length - 1] = {
      ...last,
      text: (last.text + delta).slice(-DELTA_CAP),
      updatedAt: at
    };
    return next;
  }
  return trimProcessSteps([
    ...next,
    { id: `output:${at}`, kind: "output", text: delta.slice(-DELTA_CAP), streaming: true, startedAt: at, updatedAt: at }
  ]);
}

function appendReasoningStep(
  steps: LiveAgentProcessStep[],
  delta: string,
  elapsedMs: number,
  done: boolean,
  at: string
): LiveAgentProcessStep[] {
  const last = steps.at(-1);
  if (last?.kind === "reasoning" && !last.done) {
    const next = steps.slice();
    next[next.length - 1] = {
      ...last,
      text: (last.text + delta).slice(-REASONING_CONTENT_CAP),
      elapsedMs,
      done,
      updatedAt: at
    };
    return next;
  }
  if (!delta) return steps;
  return trimProcessSteps([
    ...finishOpenSteps(steps, at),
    { id: `reasoning:${at}`, kind: "reasoning", text: delta.slice(-REASONING_CONTENT_CAP), elapsedMs, done, startedAt: at, updatedAt: at }
  ]);
}

function upsertToolStep(
  steps: LiveAgentProcessStep[],
  event: Extract<AgentRuntimeEvent, { type: "agent.tool" }>
): LiveAgentProcessStep[] {
  const index = steps.findIndex((step) => step.kind === "tool" && step.toolCallId === event.toolCallId);
  if (index >= 0) {
    const current = steps[index];
    if (current.kind !== "tool") return steps;
    const next = steps.slice();
    next[index] = {
      ...current,
      toolName: event.toolName,
      phase: event.phase,
      ...(event.label ? { label: event.label } : {}),
      ...(event.safeInputSummary ? { safeInputSummary: event.safeInputSummary } : {}),
      ...(event.safeOutputSummary ? { safeOutputSummary: event.safeOutputSummary } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      updatedAt: event.at
    };
    return next;
  }
  return trimProcessSteps([
    ...finishOpenSteps(steps, event.at),
    {
      id: `tool:${event.toolCallId}`,
      kind: "tool",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      phase: event.phase,
      ...(event.label ? { label: event.label } : {}),
      ...(event.safeInputSummary ? { safeInputSummary: event.safeInputSummary } : {}),
      ...(event.safeOutputSummary ? { safeOutputSummary: event.safeOutputSummary } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      startedAt: event.at,
      updatedAt: event.at
    }
  ]);
}

function finishOpenSteps(steps: LiveAgentProcessStep[], at: string, except?: LiveAgentProcessStep["kind"]): LiveAgentProcessStep[] {
  return steps.map((step) => {
    if (step.kind === "reasoning" && !step.done && except !== "reasoning") return { ...step, done: true, updatedAt: at };
    if (step.kind === "output" && step.streaming && except !== "output") return { ...step, streaming: false, updatedAt: at };
    return step;
  });
}

function finishProcessSteps(steps: LiveAgentProcessStep[], at: string): LiveAgentProcessStep[] {
  return finishOpenSteps(steps, at);
}

function trimProcessSteps(steps: LiveAgentProcessStep[]): LiveAgentProcessStep[] {
  return steps.slice(-PROCESS_STEP_CAP);
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
      const state = current[event.actorId];
      const text = ((state?.text ?? "") + event.delta).slice(-DELTA_CAP);
      return {
        ...current,
        [event.actorId]: {
          ...state,
          text,
          at: event.at,
          processSteps: appendOutputStep(state?.processSteps ?? [], event.delta, event.at)
        }
      };
    });
    return;
  }
  if (event.type === "agent.reasoning-content") {
    setActivity((current) => {
      const state = current[event.actorId];
      const previous = state?.reasoningContent?.text ?? "";
      return {
        ...current,
        [event.actorId]: {
          ...state,
          text: state?.text ?? "",
          reasoningContent: {
            text: (previous + event.delta).slice(-REASONING_CONTENT_CAP),
            elapsedMs: event.elapsedMs,
            done: event.done,
            ...(event.done ? { completedAt: event.at } : {})
          },
          processSteps: appendReasoningStep(state?.processSteps ?? [], event.delta, event.elapsedMs, event.done, event.at),
          at: event.at
        }
      };
    });
    return;
  }
  if (event.type === "agent.reasoning-summary" || event.type === "agent.reasoning") {
    setActivity((current) => {
      const state = current[event.actorId];
      const previous = state?.reasoningSummary ?? "";
      const reasoningSummary = (previous + event.delta).slice(-REASONING_SUMMARY_CAP);
      return {
        ...current,
        [event.actorId]: {
          ...state,
          text: state?.text ?? "",
          reasoningSummary,
          processSteps: appendReasoningStep(state?.processSteps ?? [], event.delta, 0, false, event.at),
          at: event.at
        }
      };
    });
    return;
  }
  if (event.type === "runtime.notice") {
    const description = [event.modelId, event.code].filter(Boolean).join(" · ");
    if (event.severity === "error") toast.error(event.message, { description });
    else if (event.severity === "warning") toast.warning(event.message, { description });
    else toast.info(event.message, { description });
    pushTimeline({
      id: `${event.code}:${event.at}`,
      at: event.at,
      kind: "notice",
      actorId: event.actorId,
      label: event.category === "reasoning" ? "推理能力自动降级" : event.category === "persistence" ? "持久化状态" : "模型运行状态",
      detail: event.message
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
      const startsActivation = event.status === "thinking"
        && (!previous || !previous.liveStatus || previous.liveStatus === "lobby" || previous.liveStatus === "paused" || previous.liveStatus === "idle" || previous.liveStatus === "finished" || previous.liveStatus === "error");
      if (startsActivation) {
        return { ...current, [event.actorId]: { text: "", processSteps: [], liveStatus: event.status, at: event.at } };
      }
      if (event.status === "idle" || event.status === "finished" || event.status === "error") {
        return {
          ...current,
          [event.actorId]: {
            ...previous,
            text: "",
            at: event.at,
            tool: undefined,
            liveStatus: event.status,
            completedAt: event.at,
            processSteps: finishProcessSteps(previous?.processSteps ?? [], event.at)
          }
        };
      }
      return {
        ...current,
        [event.actorId]: {
          ...previous,
          text: previous?.text ?? "",
          at: event.at,
          liveStatus: event.status
        }
      };
    });
    if (event.status === "idle" || event.status === "finished" || event.status === "error") {
      const completedAt = event.at;
      window.setTimeout(() => {
        setActivity((current) => {
          if (current[event.actorId]?.completedAt !== completedAt) return current;
          const next = { ...current };
          delete next[event.actorId];
          return next;
        });
      }, LIVE_TRACE_RETENTION_MS);
    }
    return;
  }
  if (event.type === "agent.model.switched") {
    // The same person on a new engine: identity, session and memory survive.
    setRoom((current) => {
      if (!current) return current;
      return {
        ...current,
        participants: current.participants.map((participant) =>
          participant.profile.id === event.actorId
            ? { ...participant, profile: { ...participant.profile, model: event.model } }
            : participant
        )
      };
    });
    pushTimeline({
      id: `model-switch-${event.actorId}-${event.at}`,
      at: event.at,
      kind: "action",
      actorId: event.actorId,
      label: "切换模型",
      detail: `${event.previousModel} → ${event.model}`
    });
    return;
  }
  if (event.type === "agent.tool") {
    setActivity((current) => {
      const state = current[event.actorId];
      return {
        ...current,
        [event.actorId]: {
          ...state,
          text: state?.text ?? "",
          tool: event.phase === "queued" || event.phase === "started" || event.phase === "streaming" ? event.toolName : undefined,
          processSteps: upsertToolStep(state?.processSteps ?? [], event),
          at: event.at
        }
      };
    });
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
        ...current[event.actorId],
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
  if (event.type === "agent.memory.recalled") {
    pushTimeline({
      id: `recalled-${event.at}`,
      at: event.at,
      kind: "memory",
      actorId: event.actorId,
      label: "记忆检索",
      detail: `${event.count} 条相关经历被唤起`
    });
    return;
  }
  if (event.type === "agent.memory.consolidated") {
    pushTimeline({
      id: `consolidated-${event.memoryId}`,
      at: event.at,
      kind: "memory",
      actorId: event.actorId,
      label: "记忆巩固",
      detail: event.summary
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
