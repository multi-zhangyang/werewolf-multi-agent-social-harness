import express from "express";
import {
  assertValidHarnessCheckpoint,
  buildFinalHarnessCheckpoint,
  buildHarnessCheckpointAtPrefix,
  toTrajectoryJsonl
} from "../../harness/artifacts";
import { buildReplayableSocialPrefix } from "../../harness/episodeArtifacts";
import { redactSecrets } from "../../harness/redaction";
import { replayWerewolfSocialEpisode } from "../../harness/replay";
import { countSocialStepCommits } from "../../harness/social";
import { publicApiFailureFromError } from "../apiFailure";
import {
  artifactViewFromQuery,
  assertLocalOperatorRegistryAccess,
  assertLocalPostgameReplayAccess,
  setArtifactProjectionResponseHeaders
} from "../artifactAccess";
import { projectMatchArtifactForView, projectPostgameReplayFrame } from "../artifactViews";
import { persistCheckpointArtifact, writeCheckpointArtifactIndex } from "../checkpointArtifactStore";
import { buildCheckpointForkAttemptLineageSummary, buildForkLineageSummary, serializeCheckpointPublicResponse } from "../checkpointDto";
import type { ServerContext } from "../context";
import { serializeSocialReplayResult } from "../dto";
import {
  FORBIDDEN_CHECKPOINT_BODY_FIELDS,
  HttpError,
  assertAllowedBodyFields,
  assertForbiddenBodyFields,
  assertStoredMatchArtifactIntegrity,
  checkpointPrefixSelectorFromBody,
  httpErrorFromCheckpointSelectionError,
  httpErrorFromReplayFrameError,
  parseOptionalString,
  requestBodyObject,
  requiredReplayFrameNativeStepCount
} from "../httpValidation";
import { type StoredMatch, getCheckpoint, getMatch, getMatchForRead, listCheckpointForkAttempts, saveCheckpoint } from "../store";
import { randomUUID } from "node:crypto";

export function registerMatchLifecycleRoutes(app: express.Express, context: ServerContext): void {
const { artifactAccessBindHost, checkpointArtifactBaseDir, matchArtifactBaseDir, loadServerArtifactStores, loadMatchArtifactIndex } = context;

app.get("/api/matches/:id/trajectory.jsonl", async (req, res, next) => {
  try {
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    const match = getMatchForRead(req.params.id);
    if (!match) {
      res.status(404).send("match not found");
      return;
    }
    if (!match.artifact) {
      res.status(404).send("match artifact not available");
      return;
    }
    const view = artifactViewFromQuery(req.query, req, artifactAccessBindHost);
    const artifact = projectMatchArtifactForView(match.artifact, view);
    const shortId = match.id.slice(0, 8);
    // trajectory.jsonl is always a downloadable export surface.
    setArtifactProjectionResponseHeaders(res, view);
    res.setHeader("Content-Disposition", `attachment; filename="${shortId}-trajectory-${view}.jsonl"`);
    res.type("application/x-ndjson").send(toTrajectoryJsonl(artifact));
  } catch (error) {
    next(error);
  }
});

/**
 * Return one server-authoritative, postgame-redacted state frame after a
 * complete native scheduler boundary. This is intentionally separate from
 * full-episode replay verification: a valid prefix must never be reported as
 * proof that later canonical steps also verify.
 */
app.post("/api/matches/:id/replay/frame", async (req, res, next) => {
  try {
    // Native cursor positions and a postgame-redacted prefix state disclose
    // more than a public observation. This is a local research-review API,
    // not an alternate way to bypass the truth-redacted projection.
    assertLocalPostgameReplayAccess(req, artifactAccessBindHost);
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    const match = getMatch(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!match.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    const body = requestBodyObject(req.body);
    assertAllowedBodyFields(body, ["nativeStepCount"], "server-owned replay frame");
    const nativeStepCount = requiredReplayFrameNativeStepCount(body);
    assertStoredMatchArtifactIntegrity(match.artifact);
    const prefix = buildReplayableSocialPrefix({
      episode: match.artifact.socialEpisode,
      selector: { nativeStepCount },
      replayPrefix: (episode) =>
        replayWerewolfSocialEpisode(episode, {
          // A prefix does not claim that it equals the parent final state. Its
          // state is derived solely from the recorded command prefix below.
          validateExpectedFinalState: false,
          stopOnMismatch: false,
          // Full canonical integrity was verified above. A view frame has no
          // actor restore semantics, so it deliberately does not audit or
          // expose durable actor snapshots again.
          auditAgentSnapshots: false
        })
    });
    const frame = projectPostgameReplayFrame(prefix);
    setArtifactProjectionResponseHeaders(res, "postgame-redacted");
    res.json({ frame: redactSecrets(frame) });
  } catch (error) {
    next(httpErrorFromReplayFrameError(error));
  }
});

app.post("/api/matches/:id/replay", async (req, res, next) => {
  let match: StoredMatch | undefined;
  try {
    // Full replay summaries contain native step/batch counts and deterministic
    // hashes. They are audit evidence for local postgame research only; a
    // truth-redacted client must not use them as a scheduler side channel.
    assertLocalPostgameReplayAccess(req, artifactAccessBindHost);
    await loadMatchArtifactIndex(matchArtifactBaseDir);
    match = getMatch(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!match.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    const body = requestBodyObject(req.body);
    assertAllowedBodyFields(body, ["stopOnMismatch"], "server-owned replay");
    assertStoredMatchArtifactIntegrity(match.artifact);
    const replay = replayWerewolfSocialEpisode(match.artifact.socialEpisode, {
      stopOnMismatch: body.stopOnMismatch !== false,
      agentSnapshotFrames: match.artifact.agentSnapshotFrames
    });
    res.status(replay.ok ? 200 : 409).json(
      serializeSocialReplayResult(replay, {
        source: "server-owned-match-artifact",
        matchId: match.id,
        runId: match.artifact.runId,
        ...countSocialStepCommits(match.artifact.socialEpisode.steps),
        finalHashMatchesArtifact: replay.finalHash === replay.expectedFinalHash
      })
    );
  } catch (error) {
    if (error instanceof HttpError) {
      next(error);
      return;
    }
    if (!match?.artifact) {
      next(error);
      return;
    }
    const failure = publicApiFailureFromError(error);
    res.status(500).json({
      summary: {
        kind: "replay",
        ok: false,
        source: "server-owned-match-artifact",
        matchId: match.id,
        runId: match.artifact.runId,
        failureReason: failure.message,
        providerFailure: failure.providerFailure ?? null
      },
      error: failure.message
    });
  }
});

app.post("/api/matches/:id/checkpoints", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    const body = requestBodyObject(req.body);
    assertForbiddenBodyFields(body, FORBIDDEN_CHECKPOINT_BODY_FIELDS, "checkpoint creation");
    assertAllowedBodyFields(body, ["reason", "nativeStepCount", "traceId", "nativeTurnIndex"], "checkpoint creation");
    await loadServerArtifactStores();
    const match = getMatch(req.params.id);
    if (!match) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!match.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    const reason = parseOptionalString(body.reason, "reason");
    const selector = checkpointPrefixSelectorFromBody(body);
    const checkpoint = selector
      ? buildHarnessCheckpointAtPrefix({
          artifact: match.artifact,
          selector,
          checkpointId: randomUUID(),
          reason
        })
      : buildFinalHarnessCheckpoint({
          artifact: match.artifact,
          checkpointId: randomUUID(),
          reason
        });
    assertValidHarnessCheckpoint(checkpoint);
    await persistCheckpointArtifact(checkpoint, checkpointArtifactBaseDir);
    saveCheckpoint(checkpoint);
    await writeCheckpointArtifactIndex(checkpointArtifactBaseDir);
    res.status(201).json(serializeCheckpointPublicResponse(checkpoint));
  } catch (error) {
    next(httpErrorFromCheckpointSelectionError(error));
  }
});

app.get("/api/matches/:id/fork-lineage", async (req, res, next) => {
  try {
    assertLocalOperatorRegistryAccess(req, artifactAccessBindHost);
    await loadServerArtifactStores();
    const match = getMatch(req.params.id);
    const attempt = listCheckpointForkAttempts().find((candidate) => candidate.childRunId === req.params.id);
    if (!match && !attempt) {
      res.status(404).json({ error: "match not found" });
      return;
    }
    if (!match?.artifact && attempt) {
      const checkpoint = getCheckpoint(attempt.forkOf.checkpointId);
      res.json({ summary: buildCheckpointForkAttemptLineageSummary(attempt, checkpoint) });
      return;
    }
    if (!match?.artifact) {
      res.status(404).json({ error: "match artifact not available" });
      return;
    }
    const checkpoint = match.artifact.forkOf ? getCheckpoint(match.artifact.forkOf.checkpointId) : undefined;
    res.json({
      summary: buildForkLineageSummary(match.artifact, checkpoint)
    });
  } catch (error) {
    next(error);
  }
});
}
