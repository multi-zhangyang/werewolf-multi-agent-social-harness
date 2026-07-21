import { readFile } from "node:fs/promises";
import { replayWerewolfSocialEpisode } from "../harness/replay";
import { assertValidMatchArtifactIntegrity, type MatchArtifact } from "../harness/artifacts";
import { countSocialStepCommits } from "../harness/social";

interface ReplayCliOptions {
  artifact: string;
  stopOnMismatch: boolean;
  json: "summary" | "full";
}

if (hasFlag("help")) {
  printUsage();
} else {
  await main().catch((error) => {
    console.log(
      JSON.stringify(
        {
          summary: {
            kind: "replay",
            ok: false,
            failureReason: error instanceof Error ? error.message : String(error)
          }
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const options = parseOptions();
  const artifact = JSON.parse(await readFile(options.artifact, "utf8")) as MatchArtifact;
  assertValidMatchArtifactIntegrity(artifact);
  const replay = replayWerewolfSocialEpisode(artifact.socialEpisode, {
    stopOnMismatch: options.stopOnMismatch,
    agentSnapshotFrames: artifact.agentSnapshotFrames
  });
  const finalHashMatchesArtifact = replay.finalHash === replay.expectedFinalHash;
  const summary = {
    kind: "replay",
    ok: replay.ok && finalHashMatchesArtifact,
    artifact: options.artifact,
    runId: artifact.runId,
    seed: artifact.seed,
    status: artifact.status,
    authority: "native-social-episode",
    ...countSocialStepCommits(artifact.socialEpisode.steps),
    replayedSteps: replay.replayedSteps,
    replayedBatches: replay.replayedBatches,
    finalHash: replay.finalHash,
    expectedFinalHash: replay.expectedFinalHash,
    finalHashMatchesArtifact,
    messagesHash: replay.messagesHash,
    expectedMessagesHash: replay.expectedMessagesHash,
    mismatchCount: replay.mismatches.length,
    mismatches: replay.mismatches.slice(0, 12)
  };

  console.log(JSON.stringify(options.json === "full" ? { summary, replay } : { summary }, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

function parseOptions(): ReplayCliOptions {
  const artifact = readArg("artifact");
  if (!artifact) throw new Error("--artifact is required.");
  const json = readArg("json") ?? "summary";
  if (json !== "summary" && json !== "full") throw new Error("--json must be summary or full.");
  return {
    artifact,
    stopOnMismatch: readArg("stopOnMismatch") !== "false",
    json
  };
}

function readArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = argv.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`) || process.argv.slice(2).includes(`-${name[0]}`);
}

function printUsage(): void {
  console.log(
    [
      "Usage: npm run arena:replay -- --artifact=artifacts/match.json [--json=summary|full]",
      "",
      "Replays a harness artifact from its native social execution. It does not call actors, reasoners, or model APIs."
    ].join("\n")
  );
}
