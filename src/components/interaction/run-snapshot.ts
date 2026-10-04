import type { RunView } from "./api";

/** Events are immutable. Keep their identity when a live snapshot adds a new event. */
export function reconcileRun(previous: RunView | undefined, incoming: RunView): RunView {
  if (!previous || previous.id !== incoming.id) return incoming;
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (equal(previous, incoming)) return previous;
  const oldEvents = new Map(previous.events.map(event => [event.id, event]));
  return { ...incoming,
    characters: equal(previous.characters, incoming.characters) ? previous.characters : incoming.characters,
    memories: equal(previous.memories, incoming.memories) ? previous.memories : incoming.memories,
    events: incoming.events.map(event => oldEvents.get(event.id) ?? event),
  };
}
