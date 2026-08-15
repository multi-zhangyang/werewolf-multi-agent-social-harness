import type { SocietyAgentContext } from "../contracts";

export function emitAction(context: SocietyAgentContext, action: string, detail: string): void {
  context.emit({
    type: "world.action",
    roomId: context.roomId,
    actorId: context.actorId,
    action,
    detail: detail.slice(0, 260),
    at: new Date().toISOString()
  });
}

export function boundedRounds(value: number | undefined, fallback: number, max: number, min = 1): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
