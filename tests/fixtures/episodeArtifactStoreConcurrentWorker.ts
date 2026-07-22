import { readFile } from "node:fs/promises";
import {
  HarnessEpisodeArtifactStore,
  type HarnessEpisodeArtifactEnvelope
} from "../../src/harness/generic";
import { hashStableState } from "../../src/harness/hash";

type WorkerArtifact = HarnessEpisodeArtifactEnvelope<unknown, unknown, unknown, unknown, unknown>;

const [baseDirectory, artifactFile, expectedHashesText] = process.argv.slice(2);
if (!baseDirectory || !artifactFile || !expectedHashesText || !process.send) {
  throw new Error("Episode artifact store concurrency worker arguments are incomplete.");
}
const expectedHashes = new Set(expectedHashesText.split(","));

const artifact = JSON.parse(await readFile(artifactFile, "utf8")) as WorkerArtifact;
const store = await HarnessEpisodeArtifactStore.open<WorkerArtifact>({
  baseDirectory,
  verifyArtifact(candidate) {
    const actual = hashStableState(candidate);
    return {
      ok: expectedHashes.has(actual),
      mismatches: expectedHashes.has(actual) ? [] : ["worker artifact hash mismatch"]
    };
  }
});

await send({ type: "READY" });
process.once("message", async (message) => {
  if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== "GO") {
    try {
      await send({ type: "ERROR", message: "worker expected GO" });
    } finally {
      if (process.connected) process.disconnect?.();
    }
    return;
  }
  try {
    const entry = await store.put(artifact);
    await send({ type: "DONE", entry });
  } catch (error) {
    try {
      await send({ type: "ERROR", message: error instanceof Error ? error.message : "unknown worker failure" });
    } catch {
      process.exitCode = 1;
    }
  } finally {
    if (process.connected) process.disconnect?.();
  }
});

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send!(message, (error) => error ? reject(error) : resolve());
  });
}
