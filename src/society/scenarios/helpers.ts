import type { AgentProfile, MoodSignal, SocietyAgentContext } from "../contracts";

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
 * profile and — when the world's mood mirror carries a signal for the actor —
 * from the agent's ADAPTED temperament and current mood: an aroused, pleased
 * agent pressures harder and speaks up, a deflated one goes quiet, and
 * distress sharpens the sting of being targeted. Betrayal-hypervigilance is
 * applied measurably: a vigilant character feels more response pressure
 * when targeted, so accusations and challenges land harder and draw a
 * response sooner.
 */
export function discussionPersonality(profiles: Map<string, AgentProfile>, moodFor?: (actorId: string) => MoodSignal | undefined) {
  const profileFor = (id: string) => profiles.get(id);
  const signalFor = (id: string) => moodFor?.(id);
  return {
    talkativeness: (id: string) => {
      const signal = signalFor(id);
      const base = signal?.extraversion ?? profileFor(id)?.temperament?.extraversion ?? 0.5;
      if (!signal) return base;
      return clamp(base + (signal.pleasure - 0.5) * 0.16 + (signal.arousal - 0.5) * 0.12);
    },
    dominance: (id: string) => {
      const signal = signalFor(id);
      const t = signal
        ? { extraversion: signal.extraversion, conscientiousness: signal.conscientiousness }
        : profileFor(id)?.temperament;
      const base = t ? 0.5 + (t.extraversion - 0.5) * 0.6 + (t.conscientiousness - 0.5) * 0.3 : 0.5;
      if (!signal) return base;
      return clamp(base + (signal.dominance - 0.5) * 0.15);
    },
    sensitivity: (id: string) => {
      const signal = signalFor(id);
      const neuroticism = signal?.neuroticism ?? profileFor(id)?.temperament?.neuroticism ?? 0.5;
      const vigilant = profileFor(id)?.decisionBiases?.includes("betrayal-hypervigilance") ?? false;
      const base = Math.min(1, neuroticism + (vigilant ? 0.15 : 0));
      if (!signal) return base;
      return clamp(base + (0.5 - signal.pleasure) * 0.2);
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
