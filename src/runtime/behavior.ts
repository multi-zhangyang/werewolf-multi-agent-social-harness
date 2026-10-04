import type { Character, WorldEvent } from "./types";

export function isActivityEvent(event: WorldEvent) {
  return event.type === "action" || event.type === "note" || event.type === "trace" && (event.data.harness ? !["agent_start", "agent_end"].includes(String(event.data.kind)) : "input" in event.data || Boolean(event.data.toolError) || event.text === "action-response" || Boolean(event.data.error) || event.text === "missing-action");
}

/** Show one tool card when an authorized trace already contains its action receipt. */
export function selectActivities(events: WorldEvent[]) {
  const receipts = new Set(events.filter(e => e.type === "trace" && Array.isArray(e.data.result)).flatMap(e => (e.data.result as Array<{ id?: string }>).flatMap(r => r?.id ? [r.id] : [])));
  const sdkTools = new Set(events.filter(e => e.data.harness && e.data.toolName).map(e => `${e.data.opportunityId}:${e.data.toolName}`));
  const grouped = new Map<string, WorldEvent>();
  for (const event of events) {
    if (!isActivityEvent(event) || event.type === "action" && receipts.has(event.id)) continue;
    if (!event.data.harness) {
      if (event.type === "trace" && sdkTools.has(`${event.data.opportunityId}:${event.text}`)) continue;
      grouped.set(event.id, event); continue;
    }
    const d = event.data;
    const key = `${d.opportunityId}:${d.phase}:${d.attempt}:${d.callId ? `tool:${d.callId}` : String(d.kind).startsWith("model_") ? `model:${d.step}` : event.id}`;
    const previous = grouped.get(key);
    // A lifecycle update must not remove/reinsert the card or reset an open panel.
    grouped.set(key, { ...event, id: previous?.id ?? event.id, seq: previous?.seq ?? event.seq, data: { ...previous?.data, ...d } });
  }
  return [...grouped.values()].sort((a, b) => a.seq - b.seq);
}

/** Summarizes supplied events only; callers remain responsible for viewer authorization. */
export function summarizeBehavior(characters: Character[], events: WorldEvent[]) {
  return characters.map(character => {
    const own = events.filter(e => e.actorId === character.id);
    const messages = own.filter(e => e.type === "message");
    const publicMessages = messages.filter(e => e.visibility === "public");
    const actions = own.filter(e => e.type === "action");
    return {
      character, messages: messages.length, publicMessages: publicMessages.length,
      privateMessages: messages.length - publicMessages.length,
      averageCharacters: messages.length ? Math.round(messages.reduce((n, e) => n + [...e.text].length, 0) / messages.length) : null,
      exactRepeats: messages.length - new Set(messages.map(e => e.text.trim())).size,
      actions, latestMessage: messages.at(-1),
    };
  });
}
