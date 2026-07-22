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
  const episodes: Array<GenericTournamentEpisode<TPrepared, TResult>> = [];
  const errorText = options.describeError ?? defaultErrorText;

  for (let index = 0; index < options.games; index += 1) {
    if (options.abortSignal?.aborted) break;
    const baseContext: TournamentEpisodeContext = {
      index,
      seed: ""
    };
    const context: TournamentEpisodeContext = {
      ...baseContext,
      seed: options.seedForEpisode?.(baseContext) ?? `${options.seed}:g${index + 1}`
    };
    let prepared: TPrepared | undefined;
    try {
      prepared = await options.prepareEpisode(context);
      // Preparation may be asynchronous. The episode itself has not started
      // until runEpisode() is invoked, so honor a deadline that fired while
      // preparing and leave this requested slot explicitly unstarted.
      if (options.abortSignal?.aborted) break;
      const result = await options.runEpisode(prepared, context);
      const status = options.statusOf(result);
      episodes.push({ ...context, status, prepared, result });
      if (status === "failed" && !options.continueOnError) break;
    } catch (error) {
      episodes.push({ ...context, status: "failed", ...(prepared === undefined ? {} : { prepared }), error: errorText(error) });
      if (!options.continueOnError) break;
    }
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

function defaultErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
