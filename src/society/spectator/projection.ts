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
    default:
      // Room-level events (snapshots, messages, tension, cues) stay visible.
      return event;
  }
}