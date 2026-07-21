import { describe, expect, it } from "vitest";
import { harnessFailureEvidenceFromEpisode } from "../src/harness/executionEvidence";
import type { SocialEpisodeArtifact } from "../src/harness/social";
import {
  WEREWOLF_HARNESS_TURN_METADATA_KIND,
  werewolfHarnessTurnEvidenceFromEpisode
} from "../src/harness/werewolfExecutionEvidence";

function episodeWithActionMetadata(metadata: Record<string, unknown>): SocialEpisodeArtifact {
  return {
    id: "evidence-contract",
    status: "completed",
    schedulerMode: "aec",
    profiles: [],
    channels: [],
    initialState: { phase: "initial" },
    finalState: { phase: "final" },
    messages: [],
    steps: [
      {
        traceId: "trace-1",
        turnIndex: 1,
        actorId: "actor-1",
        profileId: "profile-1",
        schedulerMode: "aec",
        pendingAction: { kind: "choose" },
        observation: { visible: true },
        action: {
          actorId: "actor-1",
          kind: "choose",
          command: { type: "choose" },
          metadata
        }
      }
    ]
  };
}

describe("Werewolf execution evidence boundary", () => {
  it("decodes only the explicit Werewolf trace envelope", () => {
    const foreignEpisode = episodeWithActionMetadata({
      kind: "other-domain-turn",
      turnTrace: {
        traceId: "trace-1",
        playerId: "actor-1",
        model: "model-a",
        actionKind: "choose",
        commandType: "choose"
      }
    });
    const werewolfEpisode = episodeWithActionMetadata({
      kind: WEREWOLF_HARNESS_TURN_METADATA_KIND,
      turnTrace: {
        traceId: "trace-1",
        playerId: "actor-1",
        model: "model-a",
        actionKind: "choose",
        commandType: "choose"
      }
    });

    expect(werewolfHarnessTurnEvidenceFromEpisode(foreignEpisode)).toEqual([]);
    expect(werewolfHarnessTurnEvidenceFromEpisode(werewolfEpisode)).toMatchObject([
      {
        traceId: "trace-1",
        actorId: "actor-1",
        trace: { model: "model-a" }
      }
    ]);
  });

  it("keeps generic failure extraction independent from action metadata markers", () => {
    const episode = episodeWithActionMetadata({ kind: "other-domain-turn" });
    episode.steps[0]!.failure = {
      stage: "environment_step",
      message: "foreign domain rejected its command"
    };

    expect(harnessFailureEvidenceFromEpisode(episode)).toMatchObject([
      {
        traceId: "trace-1",
        actorId: "actor-1",
        failure: { stage: "environment_step" }
      }
    ]);
  });

  it("counts a staged proposal once when an AEC batch-abort record preserves its native evidence", () => {
    const episode = episodeWithActionMetadata({
      kind: WEREWOLF_HARNESS_TURN_METADATA_KIND,
      turnTrace: {
        traceId: "reasoner-cognition-1",
        playerId: "actor-1",
        model: "model-a",
        actionKind: "kill",
        commandType: "werewolf.killVote"
      }
    });
    episode.steps.push({
      ...episode.steps[0]!,
      traceId: "trace-2",
      commitStatus: "rejected",
      failure: {
        stage: "batch_aborted",
        message: "peer decision failed before the staged proposal reached the environment"
      }
    });

    expect(episode.steps).toHaveLength(2);
    expect(werewolfHarnessTurnEvidenceFromEpisode(episode)).toMatchObject([
      {
        traceId: "trace-1",
        trace: { traceId: "reasoner-cognition-1" }
      }
    ]);
  });

  it("keeps derivative batch-aborted records in the artifact without counting them as root failures", () => {
    const episode = episodeWithActionMetadata({ kind: "other-domain-turn" });
    episode.steps[0]!.failure = {
      stage: "actor_decide",
      message: "provider decision failed"
    };
    episode.steps.push({
      ...episode.steps[0]!,
      traceId: "trace-2",
      actorId: "actor-2",
      failure: {
        stage: "batch_aborted",
        message: "peer proposal was not applied"
      }
    });

    expect(episode.steps).toHaveLength(2);
    expect(harnessFailureEvidenceFromEpisode(episode)).toMatchObject([
      {
        traceId: "trace-1",
        failure: { stage: "actor_decide" }
      }
    ]);
  });
});
