import type { AgentProfile, SocietyAgentContext } from "../contracts";

export function emitAction(context: SocietyAgentContext, action: string, detail: string): void {
  context.emit({
    type: "world.action",
    roomId: context.roomId,
    actorId: context.actorId,
    action,
    detail,
    at: new Date().toISOString()
  });
}

/**
 * Personality signals for the DiscussionDirector, derived from the character
 * profile. Betrayal-hypervigilance (§4.2.7) is applied measurably: a vigilant
 * character feels more response pressure when targeted, so accusations and
 * challenges land harder and draw a response sooner.
 */
export function discussionPersonality(profiles: Map<string, AgentProfile>) {
  const profileFor = (id: string) => profiles.get(id);
  return {
    talkativeness: (id: string) => profileFor(id)?.temperament?.extraversion ?? 0.5,
    dominance: (id: string) => {
      const t = profileFor(id)?.temperament;
      return t ? 0.5 + (t.extraversion - 0.5) * 0.6 + (t.conscientiousness - 0.5) * 0.3 : 0.5;
    },
    sensitivity: (id: string) => {
      const profile = profileFor(id);
      const neuroticism = profile?.temperament?.neuroticism ?? 0.5;
      const vigilant = profile?.decisionBiases?.includes("betrayal-hypervigilance") ?? false;
      return Math.min(1, neuroticism + (vigilant ? 0.15 : 0));
    }
  };
}

export function boundedRounds(value: number | undefined, fallback: number, max: number, min = 1): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
