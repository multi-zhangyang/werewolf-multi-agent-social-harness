/**
 * Server-side spectator event projection (AGENTS.md §8.3).
 *
 * Each spectator mode has a hard information boundary enforced here, before
 * any envelope reaches the wire:
 *
 *  - omniscient / postgame: the full observer stream;
 *  - public: no private cognition (reasoning, thought-beats, context
 *    pressure, compactions, mind updates), and only world-visible tools;
 *  - agent-pov: only the watched agent's private events; everyone's public
 *    speech and world events still flow.
 *
 * Projection never fabricates: it only filters and (for nothing else) passes
 * events through unchanged.
 */
import type { AgentRuntimeEvent, SpectatorMode } from "../contracts";

export interface SpectatorViewer {
  mode: SpectatorMode;
  /** Watched agent for `agent-pov`. */
  agentId?: string;
  /** Authenticated owner/operator; used only for sanitized runtime notices. */
  privileged?: boolean;
}

/** World actions whose effect is public knowledge in every world. */
const PUBLIC_ACTIONS = new Set(["communicate", "message"]);

export function projectEventFor(event: AgentRuntimeEvent, viewer: SpectatorViewer): AgentRuntimeEvent | undefined {
  // Legacy raw provider reasoning is never a viewer-facing interface, even
  // for operators. Only the bounded reasoning-summary/ThoughtBeat paths are
  // eligible for projection.
  if (event.type === "agent.reasoning") return undefined;
  if (viewer.mode === "omniscient") return event;
  if (viewer.mode === "public" || viewer.mode === "postgame") return projectPublic(event, viewer.privileged === true);
  return projectPov(event, viewer.agentId, viewer.privileged === true);
}

function projectPublic(event: AgentRuntimeEvent, privileged: boolean): AgentRuntimeEvent | undefined {
  switch (event.type) {
    // Private cognition and state never leaves the public seat. Token streams
    // are public during open phases (watching the speech being written is the
    // product) but sealed while a hidden choice is being made (§8.3).
    case "agent.delta":
      return event.sealed ? undefined : event;
    case "agent.reasoning-content":
    case "agent.reasoning-summary":
    case "agent.pov-frame":
    case "world.operator-frame":
    case "agent.thought-beat":
    case "agent.context.pressure":
    case "agent.compacted":
    case "agent.updated":
      return undefined;
    case "runtime.notice":
      return privileged ? event : undefined;
    case "agent.tool":
      // Open phases: the pulse of "a binding action is running" is public,
      // but tool names/summaries stay privileged (they can hint at private
      // strategies, e.g. a logged deception plan). Sealed phases hide it all.
      return event.sealed
        ? undefined
        : { ...event, toolName: "", label: undefined, safeInputSummary: undefined, safeOutputSummary: undefined };
    case "world.action":
      return PUBLIC_ACTIONS.has(event.action) ? event : undefined;
    default:
      return event;
  }
}

function projectPov(event: AgentRuntimeEvent, selfId: string | undefined, privileged: boolean): AgentRuntimeEvent | undefined {
  switch (event.type) {
    case "agent.delta":
    case "agent.reasoning-content":
    case "agent.reasoning-summary":
    case "agent.thought-beat":
    case "agent.context.pressure":
    case "agent.compacted":
    case "agent.updated":
    case "agent.tool":
    case "world.action":
    case "agent.status":
      return event.actorId === selfId ? event : undefined;
    case "agent.pov-frame":
      return event.actorId === selfId ? event : undefined;
    case "world.operator-frame":
    case "world.public-frame":
      return undefined;
    case "runtime.notice":
      return privileged || event.actorId === selfId ? event : undefined;
    case "agent.message": {
      // A POV seat may only see what the watched agent could see: public
      // channel, its own sent messages, or private/team messages addressed
      // to it. Other agents' private exchanges never cross this boundary.
      const message = event.message;
      if (message.channel === "public") return event;
      if (message.senderId === selfId) return event;
      if (message.recipientIds?.includes(selfId ?? "")) return event;
      return undefined;
    }
    default:
      // Room-level events (snapshots, tension, cues) stay visible.
      return event;
  }
}

/**
 * Timeline window around a highlight moment (§8.7): a few entries before it
 * (the cause) and a couple after (what followed), from an ascending-sorted,
 * time-parseable timeline. Used by the highlights card to expand 前因后果.
 */
export function timelineContextAround<T extends { at: string }>(timeline: T[], at: string): T[] {
  const ordered = timeline
    .slice()
    .filter((entry) => Number.isFinite(Date.parse(entry.at)))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  if (!ordered.length) return [];
  const target = Date.parse(at);
  if (!Number.isFinite(target)) return ordered.slice(-6);
  const index = ordered.findIndex((entry) => Date.parse(entry.at) >= target);
  if (index < 0) return ordered.slice(-6);
  return ordered.slice(Math.max(0, index - 4), Math.min(ordered.length, index + 2));
}
