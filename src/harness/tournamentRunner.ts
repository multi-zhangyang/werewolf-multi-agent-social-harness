/**
 * Domain-neutral tournament control plane.
 *
 * It deliberately knows nothing about games, LLMs, roles, models, metrics, or
 * artifacts. A domain owns episode preparation and execution; this runner
 * owns seed scheduling, lifecycle accounting, ordered records, and the
 * policy that an execution failure may stop a tournament while a bounded
 * (truncated) episode remains an auditable scheduled result.
 */

export type TournamentEpisodeLifecycle = "completed" | "truncated" | "failed";

/**
 * Generic control-plane output must never become a carrier for an arbitrary
 * exception message. Domain adapters may record their own reviewed, closed
 * failure evidence, but this fallback is deliberately stable and content-free
 * so generic result/pack persistence cannot leak provider diagnostics.
 */
export const GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE = "Tournament episode failed before a result was recorded.";

export interface TournamentEpisodeContext {
  index: number;
  seed: string;
}

export interface GenericTournamentEpisode<TPrepared, TResult> extends TournamentEpisodeContext {
  status: TournamentEpisodeLifecycle;
  prepared?: TPrepared;
  result?: TResult;
  error?: string;
}

export interface GenericTournamentResult<TPrepared, TResult> {
  seed: string;
  gamesRequested: number;
  gamesCompleted: number;
  gamesTruncated: number;
  gamesFailed: number;
  /** Requested episodes that the control plane intentionally never started. */
  gamesUnstarted: number;
  episodes: Array<GenericTournamentEpisode<TPrepared, TResult>>;
}

export interface GenericTournamentRunnerOptions<TPrepared, TResult> {
  games: number;
  seed: string;
  /** Canonical terminal prefix restored by the control plane. Restored
   * episodes are included in lifecycle accounting but are never prepared or
   * executed again. Runtime preparation objects are forbidden in the prefix. */
  initialEpisodes?: ReadonlyArray<GenericTournamentEpisode<never, TResult>>;
  /** Stop scheduling new episodes after a shared control-plane deadline. The
   * already-started episode owns its own rejected-step evidence. */
  abortSignal?: AbortSignal;
  /** Continue after failed execution records. Truncated episodes always continue. */
  continueOnError?: boolean;
  prepareEpisode: (context: TournamentEpisodeContext) => TPrepared | Promise<TPrepared>;
  runEpisode: (prepared: TPrepared, context: TournamentEpisodeContext) => TResult | Promise<TResult>;
  statusOf: (result: TResult) => TournamentEpisodeLifecycle;
  seedForEpisode?: (context: TournamentEpisodeContext) => string;
  describeError?: (error: unknown) => string;
  /** Durable start boundary. It is awaited before domain preparation and
   * outside the domain error boundary; hook failures are fatal. */
  onEpisodeStarting?: (context: TournamentEpisodeContext) => void | Promise<void>;
  /** Durable control-plane hook. It runs after the terminal episode record is
   * appended and outside the domain error boundary; hook failures are fatal. */
  onEpisodeSettled?: (episode: GenericTournamentEpisode<TPrepared, TResult>) => void | Promise<void>;
}

/**
 * Run prepared episodes in deterministic index order. The result list is the
 * control-plane source of truth: it preserves completed, truncated, and
 * failed states without promoting partial runs into completed ones.
 */
export async function runTournamentEpisodes<TPrepared, TResult>(
  options: GenericTournamentRunnerOptions<TPrepared, TResult>
): Promise<GenericTournamentResult<TPrepared, TResult>> {
  if (!Number.isInteger(options.games) || options.games <= 0) {
    throw new Error("Tournament games must be a positive integer.");
  }
  const restored = validateInitialEpisodes(options);
  const episodes: Array<GenericTournamentEpisode<TPrepared, TResult>> = restored.map((episode) => ({ ...episode }));
  const errorText = options.describeError ?? defaultErrorText;
  const restoredStop = !options.continueOnError && episodes.at(-1)?.status === "failed";

  for (let index = restoredStop ? options.games : episodes.length; index < options.games; index += 1) {
    if (options.abortSignal?.aborted) break;
    const baseContext: TournamentEpisodeContext = {
      index,
      seed: ""
    };
    const context: TournamentEpisodeContext = {
      ...baseContext,
      seed: options.seedForEpisode?.(baseContext) ?? `${options.seed}:g${index + 1}`
    };
    await options.onEpisodeStarting?.(context);
    let prepared: TPrepared | undefined;
    let settled: GenericTournamentEpisode<TPrepared, TResult>;
    try {
      prepared = await options.prepareEpisode(context);
      // Preparation may be asynchronous. The episode itself has not started
      // until runEpisode() is invoked, so honor a deadline that fired while
      // preparing and leave this requested slot explicitly unstarted.
      if (options.abortSignal?.aborted) break;
      const result = await options.runEpisode(prepared, context);
      const status = options.statusOf(result);
      settled = { ...context, status, prepared, result };
    } catch (error) {
      settled = {
        ...context,
        status: "failed",
        ...(prepared === undefined ? {} : { prepared }),
        error: errorText(error)
      };
    }
    episodes.push(settled);
    await options.onEpisodeSettled?.(settled);
    if (settled.status === "failed" && !options.continueOnError) break;
  }

  return {
    seed: options.seed,
    gamesRequested: options.games,
    gamesCompleted: episodes.filter((episode) => episode.status === "completed").length,
    gamesTruncated: episodes.filter((episode) => episode.status === "truncated").length,
    gamesFailed: episodes.filter((episode) => episode.status === "failed").length,
    gamesUnstarted: options.games - episodes.length,
    episodes
  };
}

function validateInitialEpisodes<TPrepared, TResult>(
  options: GenericTournamentRunnerOptions<TPrepared, TResult>
): Array<GenericTournamentEpisode<never, TResult>> {
  const restored = options.initialEpisodes ?? [];
  if (restored.length > options.games) {
    throw new Error("Tournament restored episode prefix exceeds the requested schedule.");
  }
  return restored.map((episode, index) => {
    const baseContext: TournamentEpisodeContext = { index, seed: "" };
    const expectedSeed = options.seedForEpisode?.(baseContext) ?? `${options.seed}:g${index + 1}`;
    if (
      episode.index !== index ||
      episode.seed !== expectedSeed ||
      (episode.status !== "completed" && episode.status !== "truncated" && episode.status !== "failed")
    ) {
      throw new Error("Tournament restored episodes must be a valid contiguous terminal prefix.");
    }
    if ("prepared" in episode && episode.prepared !== undefined) {
      throw new Error("Tournament restored episodes cannot contain runtime preparation state.");
    }
    if (!options.continueOnError && episode.status === "failed" && index !== restored.length - 1) {
      throw new Error("Tournament restored prefix cannot continue beyond a stopping failure.");
    }
    return { ...episode };
  });
}

function defaultErrorText(_error: unknown): string {
  return GENERIC_TOURNAMENT_EPISODE_FAILURE_MESSAGE;
}
