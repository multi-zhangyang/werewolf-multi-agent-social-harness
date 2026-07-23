import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SEALED_BID_AUCTION_EVALUATOR_ID,
  SEALED_BID_AUCTION_EXECUTION_MODE,
  buildSealedBidAuctionCheckpoint,
  createSealedBidAuctionArtifact,
  createSealedBidAuctionInitialState,
  evaluateSealedBidAuctionArtifact,
  forkSealedBidAuctionFromCheckpoint,
  replaySealedBidAuctionEpisode,
  runSealedBidAuctionEpisode,
  runSealedBidAuctionExperiment,
  verifySealedBidAuctionArtifact
} from "../src/domains/sealedBidAuction";
import { validateHarnessCheckpointEnvelope, validateSocialEpisodeArtifact } from "../src/harness/generic";
import { parseSealedBidAuctionCliArgs } from "../src/scripts/runSealedBidAuction";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sealed-bid auction second domain adapter", () => {
  it("runs two actor-scoped parallel rounds with policy-only actors and no provider-call evidence", async () => {
    const initialState = createSealedBidAuctionInitialState("focused-auction-seed");
    initialState.privateValues = {
      alpha: [8, 3],
      beta: [5, 9]
    };
    const result = await runSealedBidAuctionEpisode({
      id: "sealed-bid-auction-focused",
      initialState
    });
    const episode = result.socialEpisode;

    expect(episode.status).toBe("completed");
    expect(episode.schedulerMode).toBe("parallel");
    expect(episode.steps).toHaveLength(4);
    expect(episode.steps.every((step) => step.commitStatus === "committed")).toBe(true);
    expect(new Set(episode.steps.map((step) => step.batchId)).size).toBe(2);
    expect(episode.steps.every((step) => step.atomic && step.resolutionPolicy === "parallel-stepBatch")).toBe(true);
    expect(validateSocialEpisodeArtifact(episode)).toEqual([]);

    const alphaRoundOne = episode.steps.find(
      (step) => step.actorId === "alpha" && step.action.command.round === 0
    );
    const betaRoundOne = episode.steps.find(
      (step) => step.actorId === "beta" && step.action.command.round === 0
    );
    const alphaRoundTwo = episode.steps.find(
      (step) => step.actorId === "alpha" && step.action.command.round === 1
    );
    expect(alphaRoundOne?.observation).toMatchObject({ actorId: "alpha", privateValue: 8, visibleMessages: [] });
    expect(betaRoundOne?.observation).toMatchObject({ actorId: "beta", privateValue: 5, visibleMessages: [] });
    expect(alphaRoundOne?.observation).not.toHaveProperty("privateValues");
    expect(alphaRoundOne?.observation).not.toHaveProperty("opponentPrivateValue");
    expect(alphaRoundTwo?.observation.visibleMessages).toHaveLength(2);

    expect(episode.profiles.every((profile) => profile.model === SEALED_BID_AUCTION_EXECUTION_MODE)).toBe(true);
    expect(episode.steps.every((step) => !step.reasonerCalls?.length)).toBe(true);
    expect(result.agents).toEqual([
      expect.objectContaining({ actorId: "alpha", executionMode: "policy-only", committedRounds: 2 }),
      expect.objectContaining({ actorId: "beta", executionMode: "policy-only", committedRounds: 2 })
    ]);
    expect(episode.finalState.results).toMatchObject([
      { winnerId: "alpha", bids: { alpha: 8, beta: 4 }, utility: 0 },
      { winnerId: "beta", bids: { alpha: 3, beta: 8 }, utility: 1 }
    ]);

    const artifact = createSealedBidAuctionArtifact(result);
    const verification = verifySealedBidAuctionArtifact(artifact);
    expect(verification.ok, verification.mismatches.join("\n")).toBe(true);
    const replay = replaySealedBidAuctionEpisode(episode);
    expect(replay.ok, replay.mismatches.join("\n")).toBe(true);
    expect(replay.replayedBatches).toBe(2);
    expect(replay.finalState).toEqual(episode.finalState);

    const evaluation = evaluateSealedBidAuctionArtifact(artifact);
    expect(evaluation.status).toBe("completed");
    expect(evaluation.evaluatorIds).toEqual([SEALED_BID_AUCTION_EVALUATOR_ID]);
    expect(evaluation.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "auction.allocative_efficiency", evidenceRefs: [expect.objectContaining({ artifact: "state" })] }),
      expect.objectContaining({ id: "auction.policy_only_execution", value: true })
    ]));
  });

  it("builds only a complete joint-boundary checkpoint and performs a real model-free fork continuation", async () => {
    const result = await runSealedBidAuctionEpisode({
      id: "sealed-bid-auction-parent",
      initialState: createSealedBidAuctionInitialState("fork-auction-seed")
    });
    const artifact = createSealedBidAuctionArtifact(result);

    expect(() => buildSealedBidAuctionCheckpoint(artifact, 1)).toThrow(/middle of a native scheduler batch/i);
    const checkpoint = buildSealedBidAuctionCheckpoint(artifact, 2);
    expect(validateHarnessCheckpointEnvelope(checkpoint)).toEqual([]);
    expect(checkpoint.state).toMatchObject({ round: 1, done: false });
    expect(checkpoint.agents.every((agent) => agent.committedRounds === 1)).toBe(true);
    expect(checkpoint.executionPrefix.messages).toHaveLength(2);

    const fork = await forkSealedBidAuctionFromCheckpoint({
      checkpoint,
      childRunId: "sealed-bid-auction-child"
    });
    expect(fork.seed.forkOf).toMatchObject({
      checkpointId: checkpoint.checkpointId,
      parentRunId: artifact.runId,
      parentNativeStepCount: 2,
      parentMessageCount: 2
    });
    expect(fork.socialEpisode.initialState).toEqual(checkpoint.state);
    expect(fork.socialEpisode.status).toBe("completed");
    expect(fork.socialEpisode.steps).toHaveLength(2);
    expect(fork.socialEpisode.messages).toHaveLength(4);
    expect(fork.socialEpisode.steps.every((step) => !step.reasonerCalls?.length)).toBe(true);
    const replay = replaySealedBidAuctionEpisode(fork.socialEpisode);
    expect(replay.ok, replay.mismatches.join("\n")).toBe(true);
  });

  it("publishes a generic experiment artifact, evaluation, assignment evidence, and both safe checkpoints", async () => {
    const root = await temporaryRoot();
    const { execution, episodeStore } = await runSealedBidAuctionExperiment({
      baseDirectory: root,
      id: "sealed-bid-auction-persisted",
      seed: "persisted-auction-seed"
    });
    const episode = execution.runSet.episodes[0];
    expect(episode).toMatchObject({ status: "completed" });
    expect(episode?.artifact?.experiment?.spec.domainId).toBe("sealed-bid-auction");
    expect(episode?.artifact?.executionAttestation?.assignmentResolution?.actors).toEqual([
      expect.objectContaining({ actorId: "alpha", model: "policy-only" }),
      expect.objectContaining({ actorId: "beta", model: "policy-only" })
    ]);
    expect(episode?.evaluationReport).toMatchObject({
      status: "completed",
      evaluatorIds: [SEALED_BID_AUCTION_EVALUATOR_ID],
      metricCount: 4
    });
    expect(episode?.runId).toBeTruthy();
    const checkpoints = await episodeStore.listCheckpoints(episode!.runId!);
    expect(checkpoints.map((entry) => entry.nativeStepCount)).toEqual([2, 4]);
    expect((await episodeStore.list()).map((entry) => entry.runId)).toEqual([episode!.runId]);
  });

  it("exposes a no-env developer CLI and rejects unknown options", () => {
    expect(parseSealedBidAuctionCliArgs(["--output=./auction-proof", "--seed=cli-seed", "--id=cli-id"]))
      .toMatchObject({ seed: "cli-seed", id: "cli-id" });
    expect(parseSealedBidAuctionCliArgs(["--help"])).toEqual({ help: true });
    expect(() => parseSealedBidAuctionCliArgs(["--models=not-applicable"])).toThrow(/unknown/i);

    const domainSource = readFileSync(new URL("../src/domains/sealedBidAuction.ts", import.meta.url), "utf8");
    const cliSource = readFileSync(new URL("../src/scripts/runSealedBidAuction.ts", import.meta.url), "utf8");
    expect(`${domainSource}\n${cliSource}`).not.toMatch(/process\.env|--env-file|openaiClient|providerRegistry/);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sealed-bid-auction-domain-"));
  temporaryRoots.push(root);
  return root;
}
