import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/api";
import type { AgentRuntimeEvent, CinematicCue } from "@/society/contracts";
import type { SpectatorModeLike } from "@/components/society/viewer-types";
import type {
  AgentTurnRecord,
  AgentTurnRecordStatus,
  AgentTurnToolRecord,
  SocietyRoomEventEnvelope,
  SocietyRoomSnapshot
} from "@/society/room";

/**
 * Live-stream data layer.
 *
 * Everything SSE-delivered flows through one pure reducer (`reduceRoomEvent`)
 * so the streaming semantics are unit-testable: reconnects cannot conjure
 * ghost text (deltas only ever apply to an OPEN turn), sequence cursors make
 * backlog replay idempotent, and the effective viewer boundary reported by
 * the server is what the UI displays.
 */

export type TurnStatus = AgentTurnRecordStatus;

export interface TurnReasoning {
  text: string;
  elapsedMs: number;
  done: boolean;
}

export type TurnToolStep = AgentTurnToolRecord;

/**
 * One activation of one agent, rendered as a single live card: thinking →
 * reasoning → tools → streamed speech → settled message.
 */
export interface LiveTurn {
  id: string;
  actorId: string;
  status: TurnStatus;
  /** Streamed model text (speech draft). Empty while sealed. */
  outputText: string;
  /** True while the phase seals public token streams; public viewers see only progress. */
  sealed: boolean;
  reasoning?: TurnReasoning;
  tools: TurnToolStep[];
  /** Message committed by this activation, once known. */
  messageId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** One notable event in the session timeline (used by highlights 前因后果). */
export interface StreamEventEntry {
  id: string;
  at: string;
  kind: "thought" | "tool" | "message" | "action" | "cue" | "memory" | "notice";
  actorId?: string;
  label: string;
  detail?: string;
}

export interface RoomTension {
  score: number;
  level: "calm" | "warm" | "tense" | "climax";
  reasons: string[];
  primaryAgentIds: string[];
}

export interface EffectiveViewer {
  mode: SpectatorModeLike;
  privileged: boolean;
  agentId?: string;
}

export interface RoomNotice {
  id: string;
  severity: "info" | "warning" | "error";
  message: string;
  description?: string;
}

export interface RoomStreamState {
  turns: LiveTurn[];
  timeline: StreamEventEntry[];
  tension: RoomTension | null;
  cue: CinematicCue | null;
  notices: RoomNotice[];
  /** Highest event sequence applied — replayed envelopes below it are ignored. */
  lastSeq: number;
}

export const EMPTY_STREAM_STATE: RoomStreamState = {
  turns: [],
  timeline: [],
  tension: null,
  cue: null,
  notices: [],
  lastSeq: 0
};

const TURN_OUTPUT_CAP = 8_000;
/** Generous bound only for pathological streams; normal reasoning never hits it. */
const TURN_REASONING_CAP = 120_000;
/** Retained completed turns — the in-page rewatch window for long games. */
const TURN_HISTORY_CAP = 1_000;
const TIMELINE_CAP = 400;

export const COMPLETED_STATUSES: ReadonlySet<string> = new Set(["idle", "finished", "error"]);

function pushTimeline(state: RoomStreamState, entry: StreamEventEntry): RoomStreamState {
  return { ...state, timeline: [entry, ...state.timeline].slice(0, TIMELINE_CAP) };
}

function openTurn(actorId: string, status: TurnStatus, at: string, turnId?: string): LiveTurn {
  return {
    id: turnId ?? `${actorId}:${at}`,
    actorId,
    status,
    outputText: "",
    sealed: false,
    tools: [],
    startedAt: at,
    updatedAt: at
  };
}

function openTurnIndex(turns: LiveTurn[], actorId: string, turnId?: string): number {
  if (turnId) {
    const exact = turns.findIndex((turn) => turn.id === turnId && !turn.completedAt);
    if (exact >= 0) return exact;
  }
  return turns.findIndex((turn) => turn.actorId === actorId && !turn.completedAt);
}

/** Deltas only apply to the actor's OPEN turn — closed turns never resurrect, so replayed backlogs cannot create ghosts. */
function applyDelta(turn: LiveTurn | undefined, delta: string, sealed: boolean | undefined, at: string): LiveTurn | undefined {
  if (!turn || turn.completedAt) return undefined;
  if (sealed) {
    return { ...turn, sealed: true, updatedAt: at };
  }
  return {
    ...turn,
    sealed: false,
    outputText: (turn.outputText + delta).slice(-TURN_OUTPUT_CAP),
    updatedAt: at
  };
}

/**
 * Pure SSE reducer. Unit-tested in tests/unit/room-stream-reducer.test.ts.
 */
export function reduceRoomEvent(state: RoomStreamState, event: AgentRuntimeEvent): RoomStreamState {
  switch (event.type) {
    case "world.updated":
      return state; // snapshot merge handled by the hook, not the reducer
    case "agent.delta": {
      const index = openTurnIndex(state.turns, event.actorId, event.turnId);
      if (index < 0) return state;
      const turns = state.turns.slice();
      const next = applyDelta(turns[index], event.delta, event.sealed === true, event.at);
      if (!next) return state;
      turns[index] = next;
      return { ...state, turns };
    }
    case "agent.reasoning-content": {
      const index = openTurnIndex(state.turns, event.actorId, event.turnId);
      if (index < 0) return state;
      const turns = state.turns.slice();
      const turn = turns[index];
      const previous = turn.reasoning && !turn.reasoning.done ? turn.reasoning.text : "";
      turns[index] = {
        ...turn,
        reasoning: {
          text: (previous + event.delta).slice(-TURN_REASONING_CAP),
          elapsedMs: event.elapsedMs,
          done: event.done
        },
        updatedAt: event.at
      };
      return { ...state, turns };
    }
    case "agent.status": {
      const closed = COMPLETED_STATUSES.has(event.status);
      const index = openTurnIndex(state.turns, event.actorId, event.turnId);
      if (!closed) {
        const turns = state.turns.slice();
        if (index >= 0) {
          const turn = turns[index];
          turns[index] = { ...turn, status: normalizeStatus(event.status, turn.status), updatedAt: event.at };
          return { ...state, turns };
        }
        if (event.status === "thinking" || event.status === "acting" || event.status === "speaking") {
          turns.push(openTurn(event.actorId, normalizeStatus(event.status, "thinking"), event.at, event.turnId));
          return { ...state, turns: trimTurns(turns) };
        }
        return state;
      }
      if (index < 0) return state;
      const turns = state.turns.slice();
      const turn = turns[index];
      turns[index] = {
        ...turn,
        status: event.status === "error" ? "error" : turn.status,
        outputText: event.status === "error" ? turn.outputText : "",
        completedAt: event.at,
        updatedAt: event.at
      };
      return { ...state, turns: trimTurns(turns) };
    }
    case "agent.tool": {
      // "failed" is terminal too: the SDK converts thrown tool executes into
      // an output whose text is its fixed error template, so the row must
      // settle as failed instead of spinning forever.
      if (event.phase !== "started" && event.phase !== "succeeded" && event.phase !== "failed") return state;
      const index = openTurnIndex(state.turns, event.actorId, event.turnId);
      if (index >= 0) {
        const turns = state.turns.slice();
        const turn = turns[index];
        const existing = turn.tools.findIndex((tool) => tool.toolCallId === event.toolCallId);
        const tools = turn.tools.slice();
        if (existing >= 0) {
          tools[existing] = { ...tools[existing], phase: event.phase, ...(event.safeOutputSummary ? { safeOutputSummary: event.safeOutputSummary } : {}) };
        } else {
          tools.push({
            kind: "tool",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(event.label ? { label: event.label } : {}),
            ...(event.safeInputSummary ? { safeInputSummary: event.safeInputSummary } : {}),
            ...(event.safeOutputSummary ? { safeOutputSummary: event.safeOutputSummary } : {}),
            phase: event.phase
          });
        }
        turns[index] = { ...turn, tools, updatedAt: event.at };
        const nextState = { ...state, turns: trimTurns(turns) };
        if (event.phase === "succeeded") {
          return pushTimeline(nextState, {
            id: event.toolCallId,
            at: event.at,
            kind: "tool",
            actorId: event.actorId,
            label: event.label ?? event.toolName,
            detail: event.safeOutputSummary?.slice(0, 140)
          });
        }
        return nextState;
      }
      if (event.phase !== "succeeded") return state;
      return pushTimeline(state, {
        id: event.toolCallId,
        at: event.at,
        kind: "tool",
        actorId: event.actorId,
        label: event.label ?? event.toolName,
        detail: event.safeOutputSummary?.slice(0, 140)
      });
    }
    case "agent.thought-beat": {
      const withBeat = pushTimeline(state, {
        id: event.beat.id,
        at: event.at,
        kind: "thought",
        actorId: event.actorId,
        label: event.beat.title ?? "思考",
        detail: event.beat.summary.slice(0, 160)
      });
      const index = withBeat.turns.findIndex((turn) => turn.actorId === event.actorId && !turn.completedAt);
      if (index < 0) return withBeat;
      const turns = withBeat.turns.slice();
      const turn = turns[index];
      turns[index] = { ...turn, reasoning: turn.reasoning ?? { text: "", elapsedMs: 0, done: true }, updatedAt: event.at };
      return { ...withBeat, turns };
    }
    case "runtime.notice": {
      const description = [event.modelId, event.code].filter(Boolean).join(" · ");
      const notice: RoomNotice = {
        id: `${event.code}:${event.at}`,
        severity: event.severity,
        message: event.message,
        ...(description ? { description } : {})
      };
      return pushTimeline(
        { ...state, notices: [...state.notices, notice].slice(-20) },
        {
          id: notice.id,
          at: event.at,
          kind: "notice",
          actorId: event.actorId,
          label: event.category === "reasoning" ? "推理能力自动降级" : event.category === "persistence" ? "持久化状态" : "模型运行状态",
          detail: event.message
        }
      );
    }
    case "world.action": {
      return pushTimeline(state, {
        id: `action:${event.action}:${event.at}`,
        at: event.at,
        kind: "action",
        actorId: event.actorId,
        label: event.action,
        detail: event.detail.slice(0, 140)
      });
    }
    case "tension.changed":
      return {
        ...state,
        tension: { score: event.score, level: event.level, reasons: event.reasons, primaryAgentIds: event.primaryAgentIds }
      };
    case "cinematic.cue":
      return pushTimeline({ ...state, cue: event.cue }, {
        id: event.cue.id,
        at: event.cue.createdAt,
        kind: "cue",
        label: event.cue.title ?? event.cue.camera,
        detail: event.cue.subtitle
      });
    case "agent.compacted": {
      const nextState = pushTimeline(state, {
        id: `compacted-${event.at}`,
        at: event.at,
        kind: "memory",
        actorId: event.actorId,
        label: "记忆压缩",
        detail: `压力降至 ${Math.round(event.pressureAfter * 100)}%`
      });
      const index = nextState.turns.findIndex((turn) => turn.actorId === event.actorId && !turn.completedAt);
      if (index < 0) return nextState;
      return nextState;
    }
    case "agent.memory.consolidated":
      return pushTimeline(state, {
        id: `consolidated-${event.memoryId}`,
        at: event.at,
        kind: "memory",
        actorId: event.actorId,
        label: "记忆巩固",
        detail: event.summary
      });
    default:
      return state;
  }
}

function trimTurns(turns: LiveTurn[]): LiveTurn[] {
  if (turns.length <= TURN_HISTORY_CAP) return turns;
  const open = turns.filter((turn) => !turn.completedAt);
  const closed = turns.filter((turn) => turn.completedAt).slice(-(TURN_HISTORY_CAP - Math.max(open.length, 1)));
  return [...open, ...closed];
}

function turnFromRecord(record: AgentTurnRecord): LiveTurn {
  return {
    id: record.id,
    actorId: record.actorId,
    status: record.status,
    outputText: "",
    sealed: record.sealed,
    tools: record.tools.map((tool) => ({ ...tool })),
    ...(record.messageId ? { messageId: record.messageId } : {}),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {})
  };
}

/** Snapshot transcript is durable truth; richer live deltas remain ephemeral. */
function mergeSnapshotTurns(state: RoomStreamState, snapshot: SocietyRoomSnapshot): RoomStreamState {
  if (!snapshot.agentTurns) return state;
  const currentById = new Map(state.turns.map((turn) => [turn.id, turn]));
  const durableIds = new Set(snapshot.agentTurns.map((turn) => turn.id));
  const merged = snapshot.agentTurns.map((record) => {
    const durable = turnFromRecord(record);
    const current = currentById.get(record.id);
    if (!current) return durable;
    return {
      ...durable,
      outputText: current.outputText,
      ...(current.reasoning ? { reasoning: current.reasoning } : {}),
      tools: durable.tools,
      updatedAt: record.updatedAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {})
    };
  });
  for (const turn of state.turns) {
    if (!durableIds.has(turn.id)) merged.push(turn);
  }
  return { ...state, turns: trimTurns(merged) };
}

function normalizeStatus(status: string, fallback: TurnStatus): TurnStatus {
  if (status === "thinking" || status === "acting" || status === "speaking" || status === "paused") return status;
  return fallback;
}

export interface RoomConnection {
  room: SocietyRoomSnapshot | null;
  /** The boundary the server actually granted — not the one requested. */
  viewer: EffectiveViewer | null;
  connection: "connected" | "reconnecting" | "closed";
  error?: string;
  stream: RoomStreamState;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  toggleAgentPause: (actorId: string, paused: boolean) => Promise<void>;
  /** Swap one agent's engine; identity, session and memory survive. */
  switchAgentModel: (actorId: string, modelProfileId: string) => Promise<void>;
  submitAction: (action: string, payload: unknown) => Promise<void>;
}

interface SnapshotWithViewer extends SocietyRoomSnapshot {
  viewer?: EffectiveViewer;
}

/** Optional connection behavior — the caster broadcast surface uses `silent`. */
export interface UseRoomOptions {
  /** Suppress runtime-notice toasts: privileged viewers' operational noise
   * (model degradations, persistence state) must never hit a broadcast page. */
  silentNotices?: boolean;
}

export function useRoom(
  roomId: string | undefined,
  token?: string,
  viewer: { mode: SpectatorModeLike; agentId?: string } = { mode: "public" },
  options: UseRoomOptions = {}
): RoomConnection {
  const { silentNotices = false } = options;
  const [room, setRoom] = useState<SocietyRoomSnapshot | null>(null);
  const [effectiveViewer, setEffectiveViewer] = useState<EffectiveViewer | null>(null);
  const [connection, setConnection] = useState<RoomConnection["connection"]>("closed");
  const [error, setError] = useState<string>();
  const [stream, setStream] = useState<RoomStreamState>(EMPTY_STREAM_STATE);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    sourceRef.current?.close();
    setRoom(null);
    setEffectiveViewer(null);
    setError(undefined);
    setConnection("closed");
    setStream(EMPTY_STREAM_STATE);
    if (!roomId) return;

    const staticMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("static");
    const viewerQuery = `mode=${encodeURIComponent(viewer.mode)}${viewer.mode === "agent-pov" && viewer.agentId ? `&agent=${encodeURIComponent(viewer.agentId)}` : ""}`;
    let cancelled = false;
    let source: EventSource | undefined;
    let malformedEvents = 0;

    const applySnapshot = (next: SnapshotWithViewer): void => {
      setRoom(next);
      if (next.viewer) setEffectiveViewer(next.viewer);
      // A fresh snapshot proves the transport works again, so transport-level
      // error banners clear here rather than lingering forever.
      setError(undefined);
      // Snapshots anchor truth: live turns whose activations already ended in
      // the snapshot's participant statuses are dropped so a reconnect starts
      // clean instead of resuming stale streams.
      setStream((current) => resetStaleTurns(mergeSnapshotTurns(current, next), next));
    };

    const connect = async (): Promise<void> => {
      // EventSource cannot attach an Authorization header. Authenticate one
      // ordinary snapshot request first; the server exchanges the accepted
      // header for an HttpOnly same-origin cookie used by the SSE connection.
      const response = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}?${viewerQuery}`, {
        headers: token ? { "x-player-token": token } : undefined
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(payload?.message ?? `HTTP ${response.status}`);
      }
      const initial = await response.json() as SnapshotWithViewer;
      if (cancelled) return;
      applySnapshot(initial);
      if (staticMode) {
        setConnection("closed");
        return;
      }

      source = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/events${viewerQuery ? `?${viewerQuery}` : ""}`);
      sourceRef.current = source;
      source.onopen = () => setConnection("connected");
      source.addEventListener("snapshot", (event) => {
        try {
          applySnapshot(JSON.parse((event as MessageEvent).data) as SnapshotWithViewer);
        } catch {
          setError("无法解析房间快照");
        }
      });
      source.addEventListener("event", (event) => {
        try {
          const envelope = JSON.parse((event as MessageEvent).data) as SocietyRoomEventEnvelope;
          malformedEvents = 0;
          setStream((current) => ingestEnvelope(current, envelope));
          if (envelope.event.type === "world.updated") {
            const snapshot = envelope.event.snapshot;
            setRoom((current) => (current ? { ...current, world: snapshot } : current));
          }
          if (envelope.event.type === "agent.model.switched") {
            // Same person on a new engine: identity/session/memory survive.
            const switched = envelope.event;
            setRoom((current) => current
              ? {
                  ...current,
                  participants: current.participants.map((participant) =>
                    participant.profile.id === switched.actorId
                      ? { ...participant, profile: { ...participant.profile, model: switched.model } }
                      : participant
                  )
                }
              : current);
          }
        } catch {
          // Malformed envelope: the next coalesced snapshot self-heals the view,
          // but a persistent stream of them must become visible instead of
          // leaving the page silently frozen on stale data.
          malformedEvents += 1;
          if (malformedEvents === 5) setError("事件流数据持续异常，画面可能滞后（快照每 5 秒兜底刷新）");
        }
      });
      // Never give up on the stream: EventSource retries natively, and while
      // it is down a 5s snapshot poll keeps the page alive (a permanently
      // frozen spectator page is worse than a degraded one).
      source.onerror = () => {
        setConnection("reconnecting");
        setError("直播连接中断，正在重连…");
      };
    };
    void connect().catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    // Self-heal poll: while the event stream is down (or before it opens),
    // a periodic snapshot keeps the page truthful. Cheap: one scoped GET.
    const poll = window.setInterval(() => {
      if (cancelled || staticMode) return;
      apiFetch(`/api/rooms/${encodeURIComponent(roomId)}?${viewerQuery}`, {
        headers: token ? { "x-player-token": token } : undefined
      })
        .then(async (response) => {
          if (!response.ok) return;
          applySnapshot(await response.json() as SnapshotWithViewer);
        })
        .catch(() => undefined);
    }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      source?.close();
      if (sourceRef.current === source) sourceRef.current = null;
    };
  }, [roomId, token, viewer.mode, viewer.agentId]);

  // Surface runtime notices as toasts exactly once each — unless the page is a
  // broadcast surface that must stay chrome-free.
  const lastNotifiedRef = useRef(0);
  useEffect(() => {
    if (silentNotices) return;
    const pending = stream.notices.slice(lastNotifiedRef.current);
    lastNotifiedRef.current = stream.notices.length;
    for (const notice of pending) {
      const payload = { description: notice.description } as const;
      if (notice.severity === "error") toast.error(notice.message, payload);
      else if (notice.severity === "warning") toast.warning(notice.message, payload);
      else toast.info(notice.message, payload);
    }
  }, [stream.notices, silentNotices]);

  const pause = useCallback(async (): Promise<void> => {
    await postControl(`/api/rooms/${encodeURIComponent(roomId ?? "")}/pause`, token, setError);
  }, [roomId, token]);

  const resume = useCallback(async (): Promise<void> => {
    await postControl(`/api/rooms/${encodeURIComponent(roomId ?? "")}/resume`, token, setError);
  }, [roomId, token]);

  const toggleAgentPause = useCallback(async (actorId: string, paused: boolean): Promise<void> => {
    const action = paused ? "pause" : "resume";
    await postControl(`/api/rooms/${encodeURIComponent(roomId ?? "")}/agents/${encodeURIComponent(actorId)}/${action}`, token, setError);
  }, [roomId, token]);

  const switchAgentModel = useCallback(async (actorId: string, modelProfileId: string): Promise<void> => {
    if (!roomId) return;
    try {
      const response = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(actorId)}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "x-player-token": token } : {}) },
        body: JSON.stringify({ modelProfileId })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new Error(body?.message ?? `HTTP ${response.status}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
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

  return useMemo(
    () => ({ room, viewer: effectiveViewer, connection, error, stream, pause, resume, toggleAgentPause, switchAgentModel, submitAction }),
    [room, effectiveViewer, connection, error, stream, pause, resume, toggleAgentPause, switchAgentModel, submitAction]
  );
}

function ingestEnvelope(state: RoomStreamState, envelope: SocietyRoomEventEnvelope): RoomStreamState {
  if (typeof envelope.seq === "number") {
    if (envelope.seq <= state.lastSeq) return state;
    return reduceRoomEvent({ ...state, lastSeq: envelope.seq }, envelope.event);
  }
  return reduceRoomEvent(state, envelope.event);
}

/** Drop open turns whose owner is no longer mid-activation per the snapshot. */
function resetStaleTurns(state: RoomStreamState, snapshot: SocietyRoomSnapshot): RoomStreamState {
  const activeStatuses = new Set(["thinking", "acting", "speaking"]);
  const alive = new Set(
    snapshot.world.agents.filter((agent) => activeStatuses.has(agent.status)).map((agent) => agent.id)
  );
  const durableOpen = new Set((snapshot.agentTurns ?? []).filter((turn) => !turn.completedAt).map((turn) => turn.id));
  return {
    ...state,
    turns: state.turns.map((turn) =>
      !turn.completedAt && !alive.has(turn.actorId) && !durableOpen.has(turn.id)
        ? { ...turn, completedAt: turn.updatedAt }
        : turn
    )
  };
}

/**
 * A finished, archived game as a read-only RoomConnection. The archive's
 * envelopes are reduced through the same pure reducer the live stream uses,
 * so the presentation layer (turns, tension, cues, timeline) is rebuilt
 * statically — no SSE, no server room, no writes.
 */
export function useArchiveRoom(archiveId: string | undefined): RoomConnection {
  const [room, setRoom] = useState<SocietyRoomSnapshot | null>(null);
  const [viewer, setViewer] = useState<EffectiveViewer | null>(null);
  const [error, setError] = useState<string>();
  const [stream, setStream] = useState<RoomStreamState>(EMPTY_STREAM_STATE);

  useEffect(() => {
    if (!archiveId) return;
    let cancelled = false;
    setRoom(null);
    setViewer(null);
    setError(undefined);
    setStream(EMPTY_STREAM_STATE);
    apiFetch(`/api/archives/${encodeURIComponent(archiveId)}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => undefined) as
          | { viewer?: { privileged?: boolean }; room?: SocietyRoomSnapshot; envelopes?: SocietyRoomEventEnvelope[]; message?: string }
          | undefined;
        if (!response.ok || !payload?.room) {
          throw new Error(payload?.message ?? `HTTP ${response.status}`);
        }
        if (cancelled) return;
        setRoom(payload.room);
        setViewer({ mode: "postgame", privileged: payload.viewer?.privileged === true });
        let state = mergeSnapshotTurns(EMPTY_STREAM_STATE, payload.room);
        for (const envelope of payload.envelopes ?? []) {
          state = ingestEnvelope(state, envelope);
        }
        setStream(state);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [archiveId]);

  const readonlyAction = useCallback(async (): Promise<void> => {
    toast.info("已归档的对局是只读的。");
  }, []);

  return useMemo(
    () => ({
      room,
      viewer,
      connection: room ? "closed" : "reconnecting",
      error,
      stream,
      pause: readonlyAction,
      resume: readonlyAction,
      toggleAgentPause: readonlyAction,
      switchAgentModel: readonlyAction,
      submitAction: readonlyAction
    }),
    [room, viewer, error, stream, readonlyAction]
  );
}

async function postControl(path: string, token: string | undefined, setError: React.Dispatch<React.SetStateAction<string | undefined>>): Promise<void> {
  try {
    const response = await apiFetch(path, {
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
}
