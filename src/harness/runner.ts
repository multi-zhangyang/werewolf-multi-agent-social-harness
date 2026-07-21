import { runSocialEpisode, type SocialEpisodeArtifact, type SocialEpisodeOptions } from "./social";

/**
 * Domain-neutral harness entry point. Domain adapters provide the environment,
 * actors, observations, commands, and optional scheduler hooks; this function
 * only delegates to the generic social execution contract.
 */
export async function runHarnessEpisode<
  TState,
  TObservation,
  TPending extends { actorId?: string },
  TCommand
>(
  options: SocialEpisodeOptions<TState, TObservation, TPending, TCommand>
): Promise<SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>> {
  return runSocialEpisode(options);
}
