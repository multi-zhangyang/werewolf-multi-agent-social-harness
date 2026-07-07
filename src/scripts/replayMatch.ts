import { readFile } from "node:fs/promises";
import { replayHarnessTrajectory } from "../harness/replay";
import { hashStableState } from "../harness/hash";
import type { MatchArtifact } from "../harness/artifacts";

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
  const replay = replayHarnessTrajectory({
    initialState: artifact.initialState,
    trajectory: artifact.trajectory,
    stopOnMismatch: options.stopOnMismatch
  });
  const expectedFinalHash = hashStableState(artifact.finalState);
  const finalHashMatchesArtifact = replay.finalHash === expectedFinalHash;
  const summary = {
    kind: "replay",
    ok: replay.ok && finalHashMatchesArtifact,
    artifact: options.artifact,
    runId: artifact.runId,
    seed: artifact.seed,
    status: artifact.status,
    replayedCommands: replay.replayedCommands,
    trajectorySteps: artifact.trajectory.length,
    finalHash: replay.finalHash,
    expectedFinalHash,
    finalHashMatchesArtifact,
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
      "Replays a harness artifact from initialState + recorded trajectory. It does not call any model API."
    ].join("\n")
  );
}
