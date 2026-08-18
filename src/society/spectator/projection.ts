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
}

/** Tools whose execution is public knowledge in every world. */
const PUBLIC_TOOLS = new Set(["communicate"]);
/** World actions whose effect is public knowledge in every world. */
const PUBLIC_ACTIONS = new Set(["communicate", "message"]);

export function projectEventFor(event: AgentRuntimeEvent, viewer: SpectatorViewer): AgentRuntimeEvent | undefined {
  if (viewer.mode === "omniscient" || viewer.mode === "postgame") return event;
  if (viewer.mode === "public") return projectPublic(event);
  return projectPov(event, viewer.agentId);
}

function projectPublic(event: AgentRuntimeEvent): AgentRuntimeEvent | undefined {
  switch (event.type) {
    // Private cognition and state never leaves the public seat.
    case "agent.reasoning":
    case "agent.thought-beat":
    case "agent.context.pressure":
    case "agent.compacted":
    case "agent.updated":
      return undefined;
    case "agent.tool":
      return PUBLIC_TOOLS.has(event.toolName) ? event : undefined;
    case "world.action":
      return PUBLIC_ACTIONS.has(event.action) ? event : undefined;
    default:
      return event;
  }
}

function projectPov(event: AgentRuntimeEvent, selfId: string | undefined): AgentRuntimeEvent | undefined {
  switch (event.type) {
    case "agent.reasoning":
    case "agent.thought-beat":
    case "agent.context.pressure":
    case "agent.compacted":
    case "agent.updated":
    case "agent.tool":
    case "world.action":
    case "agent.status":
      return event.actorId === selfId ? event : undefined;
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