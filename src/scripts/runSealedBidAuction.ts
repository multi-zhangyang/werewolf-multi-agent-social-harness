import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  SEALED_BID_AUCTION_EXECUTION_MODE,
  replaySealedBidAuctionEpisode,
  runSealedBidAuctionExperiment
} from "../domains/sealedBidAuction";

interface AuctionCliOptions {
  output: string;
  seed?: string;
  id?: string;
}

export function parseSealedBidAuctionCliArgs(args: readonly string[]): AuctionCliOptions | { help: true } {
  const options: AuctionCliOptions = {
    output: path.resolve(process.cwd(), "artifacts", "sealed-bid-auction-example")
  };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length).trim();
      if (!value) throw new Error("--output requires a nonempty directory.");
      options.output = path.resolve(process.cwd(), value);
      continue;
    }
    if (arg.startsWith("--seed=")) {
      const value = arg.slice("--seed=".length).trim();
      if (!value) throw new Error("--seed requires a nonempty value.");
      options.seed = value;
      continue;
    }
    if (arg.startsWith("--id=")) {
      const value = arg.slice("--id=".length).trim();
      if (!value) throw new Error("--id requires a nonempty value.");
      options.id = value;
      continue;
    }
    throw new Error(`Unknown sealed-bid auction option: ${arg}`);
  }
  return options;
}

export async function runSealedBidAuctionCli(args: readonly string[]): Promise<number> {
  const options = parseSealedBidAuctionCliArgs(args);
  if ("help" in options) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const result = await runSealedBidAuctionExperiment({
    baseDirectory: options.output,
    id: options.id,
    seed: options.seed
  });
  const episode = result.execution.runSet.episodes[0];
  const artifact = episode?.artifact;
  if (!episode?.runId || !artifact) throw new Error("Sealed-bid auction experiment did not materialize its canonical artifact.");
  const replay = replaySealedBidAuctionEpisode(artifact.socialEpisode);
  if (!replay.ok) throw new Error(`Sealed-bid auction model-free replay failed: ${replay.mismatches.join(" ")}`);
  const checkpoints = await result.episodeStore.listCheckpoints(episode.runId);
  const reasonerCallCount = artifact.socialEpisode.steps.reduce(
    (total, step) => total + (step.reasonerCalls?.length ?? 0),
    0
  );
  const summary = {
    domainId: artifact.socialEpisode.domainId,
    executionMode: SEALED_BID_AUCTION_EXECUTION_MODE,
    providerCalls: reasonerCallCount,
    status: artifact.status,
    runId: artifact.runId,
    schedulerMode: artifact.socialEpisode.schedulerMode,
    nativeSteps: artifact.socialEpisode.steps.length,
    atomicBatches: replay.replayedBatches,
    replayOk: replay.ok,
    checkpointCount: checkpoints.length,
    evaluatorIds: episode.evaluationReport?.evaluatorIds ?? [],
    metricCount: episode.evaluationReport?.metricCount ?? 0,
    finalUtilities: artifact.finalState.utilities,
    artifactDirectories: result.directories
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

function usage(): string {
  return [
    "Policy-only non-Werewolf domain proof over the generic harness.",
    "",
    "Usage:",
    "  npm run arena:auction -- [--output=DIR] [--seed=VALUE] [--id=VALUE]",
    "",
    "This command performs no provider/model call and does not read .env files.",
    "It persists the canonical artifact, evaluation report, experiment run record,",
    "and safe native-boundary checkpoints, then verifies model-free replay."
  ].join("\n");
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  runSealedBidAuctionCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  );
}
