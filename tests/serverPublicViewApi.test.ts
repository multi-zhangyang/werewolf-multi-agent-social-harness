import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelCallError } from "../src/agents/schema";
import { appendHarnessTurn, applyCommand, computeMetrics, getPendingActions } from "../src/core/engine";
import type { GameEvent, GameState, MatchMetrics, PendingAction, PlayerState, Role } from "../src/core/types";
import type { MatchArtifact } from "../src/harness/artifacts";
import type { HarnessReasoner } from "../src/harness/types";
import { createServerApp } from "../src/server/index";
import { clearServerStoreForTests, createMatchRecord, saveMatch } from "../src/server/store";

const fakeReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? `public redaction speech ${input.traceId}`
        : `public redaction memo ${input.agent.model}/${input.action.kind}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        providerRequestId: `public-redaction-${input.traceId}`,
        attempts: 1
      }
    };
  }
};

describe("public match API redaction", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    clearServerStoreForTests();
    const app = createServerApp({ createReasoner: () => fakeReasoner });
    server = await listen(app);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await close(server);
    clearServerStoreForTests();
  });

  it("redacts hidden night state, private events, postgame traces, and source ids from match detail and list views", async () => {
    const record = createSensitiveStoredMatch("server-public-redaction-detail");

    const detail = await requestJson(baseUrl, "GET", `/api/matches/${record.id}`);
    expect(detail.status).toBe(200);
    assertPublicMatchResponse(detail.body);
    expect(detail.body.state).not.toHaveProperty("night");
    expect(detail.body.state).not.toHaveProperty("pendingHunterId");
    expect(detail.body.state).not.toHaveProperty("hunterResume");
    expect(detail.body).not.toHaveProperty("metrics");
    expect(detail.body.state.pendingActionCount).toEqual(expect.any(Number));
    expect(detail.body.state.harnessTurnCount).toBeGreaterThan(0);
    expect(detail.body.state.publicEventCount).toBe(detail.body.state.events.length);

    const listed = await requestJson(baseUrl, "GET", "/api/matches");
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    assertPublicMatchResponse(listed.body[0]);
  });

  it("keeps full postgame truth behind the artifact route", async () => {
    const record = createSensitiveStoredMatch("server-public-redaction-artifact");

    const detail = await requestJson(baseUrl, "GET", `/api/matches/${record.id}`);
    expect(detail.status).toBe(200);
    assertPublicMatchResponse(detail.body);

    const artifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact`);
    expect(artifact.status).toBe(200);
    expect(artifact.body.finalState.night.seerInspection).toMatchObject({
      resultTeam: expect.any(String)
    });
    expect(artifact.body.finalState.night.wolfVotes).not.toEqual({});
    expect(artifact.body.finalState.events.some((event: GameEvent) => event.type === "harness.turn")).toBe(true);
    expect(JSON.stringify(artifact.body)).toContain("privateMemo");
    expect(JSON.stringify(artifact.body)).toContain("sourceId");
  });

  it("serves a server-side postgame artifact projection with private evidence redacted", async () => {
    const record = createSensitiveStoredMatch("server-postgame-artifact-projection");
    addProjectionSentinels(record);

    const fullArtifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact`);
    expect(fullArtifact.status).toBe(200);
    expect(JSON.stringify(fullArtifact.body)).toContain("projection secret reasoner output");
    expect(JSON.stringify(fullArtifact.body)).toContain("projection private social message");
    expect(JSON.stringify(fullArtifact.body)).toContain("projection memory secret");

    const projected = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=postgame-redacted`);
    expect(projected.status).toBe(200);
    expect(projected.body.projection).toMatchObject({
      view: "postgame-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: false
    });
    expect(projected.body.finalState.night.seerInspection).toMatchObject({
      resultTeam: expect.any(String)
    });
    expect(projected.body.trajectory).toHaveLength(1);
    expect(projected.body.trajectory[0]).not.toHaveProperty("agentSnapshotsAfterStep");
    expect(projected.body.trajectory[0].reasonerOutput.content).toBe("[REDACTED model reasoning output]");
    expect(projected.body.socialEpisode.messages[0].content).toBe("[REDACTED private social message]");
    expect(projected.body.socialEpisode.steps[0].observation).toBe("[REDACTED private social observation]");
    expect(projected.body.socialEpisode.exposureSummary).toMatchObject({
      schemaVersion: "server.social-exposure-summary.v1",
      source: "scoped_observation",
      privateEvidenceRedacted: true,
      recordCount: 1,
      messageCount: 1,
      sourceCount: 1,
      observerCount: 1,
      byVisibility: expect.objectContaining({ private: 1 })
    });
    expect(projected.body.socialEpisode.exposureRecords).toHaveLength(1);
    expect(projected.body.socialEpisode.exposureRecords[0]).toMatchObject({
      messageId: "projection-private-message",
      messageSeq: 1,
      sourceId: record.artifact!.socialEpisode.messages[0].senderId,
      observerId: record.artifact!.socialEpisode.steps[0].actorId,
      observedAtTraceId: "projection-social-step",
      observedAtTurnIndex: 0,
      observedAtActionKind: "speech",
      channelId: "wolf-chat",
      visibility: "private",
      kind: "private-strategy",
      evidenceRefs: expect.arrayContaining([
        expect.objectContaining({ artifact: "message", id: "projection-private-message", seq: 1 }),
        expect.objectContaining({ artifact: "delivery_receipt", id: "projection-private-message-receipt", seq: 1 }),
        expect.objectContaining({ artifact: "trace", traceId: "projection-social-step", seq: 0 }),
        expect.objectContaining({ artifact: "observation", traceId: "projection-social-step", seq: 0 })
      ])
    });
    expect(projected.body.socialEpisode.exposureRecords[0]).not.toHaveProperty("deliveryReceipt");
    expect(projected.body.socialEpisode.exposureRecords[0].evidenceRefs.some((ref: { description?: string }) => ref.description)).toBe(false);
    expect(projected.body.agents[0].social.memory.entries[0].content).toBe("[REDACTED private memory]");
    expect(projected.body.agents[0].social.goals.goals[0].description).toBe("[REDACTED private goal]");
    expect(projected.body.agents[0].social.beliefs.claims.claim1.value).toBe("[REDACTED private belief value]");
    const projectedJson = JSON.stringify(projected.body);
    expect(projectedJson).not.toContain("projection secret reasoner output");
    expect(projectedJson).not.toContain("projection private turn memo");
    expect(projectedJson).not.toContain("projection private social message");
    expect(projectedJson).not.toContain("projection social observation secret");
    expect(projectedJson).not.toContain("projection receipt redaction policy secret");
    expect(projectedJson).not.toContain("projection memory secret");
    expect(projectedJson).not.toContain("projection goal secret");
    expect(projectedJson).not.toContain("projection belief value");

    const unsupported = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=private-chat`);
    expect(unsupported.status).toBe(400);
  });

  it("serves a server-side postgame-redacted match comparison without private projection sentinels", async () => {
    const baseline = createSensitiveStoredMatch("server-compare-baseline");
    const candidate = createSensitiveStoredMatch("server-compare-candidate");
    addProjectionSentinels(baseline);
    addProjectionSentinels(candidate);

    const compared = await requestJson(baseUrl, "GET", `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted`);
    expect(compared.status).toBe(200);
    expect(compared.body).toMatchObject({
      artifactVersion: "harness.match-comparison.v1",
      kind: "match-comparison",
      view: "postgame-redacted",
      projection: {
        view: "postgame-redacted",
        privateEvidenceRedacted: true,
        postgameTruthRedacted: false
      },
      baseline: {
        matchId: baseline.id,
        runId: baseline.id,
        seed: "server-compare-baseline",
        projection: {
          view: "postgame-redacted",
          privateEvidenceRedacted: true,
          postgameTruthRedacted: false
        },
        trajectorySteps: 1,
        socialMessages: 1
      },
      candidate: {
        matchId: candidate.id,
        runId: candidate.id,
        seed: "server-compare-candidate",
        projection: {
          view: "postgame-redacted",
          privateEvidenceRedacted: true,
          postgameTruthRedacted: false
        },
        trajectorySteps: 1,
        socialMessages: 1
      },
      summary: {
        rowCount: expect.any(Number),
        changedRowCount: expect.any(Number),
        numericDeltaCount: expect.any(Number),
        baselineHash: expect.any(String),
        candidateHash: expect.any(String)
      }
    });
    expect(compared.body.comparisonId).toEqual(expect.stringContaining("match-comparison:"));
    expect(compared.body.createdAt).toBe(new Date(0).toISOString());
    expect(compared.body.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "trajectory_steps",
          baseline: 1,
          candidate: 1,
          delta: 0,
          changed: false
        }),
        expect.objectContaining({
          id: "social_messages",
          baseline: 1,
          candidate: 1,
          delta: 0,
          changed: false
        }),
        expect.objectContaining({
          id: "social_exposures",
          baseline: 1,
          candidate: 1,
          delta: 0,
          changed: false
        })
      ])
    );
    expect(compared.body.summary.rowCount).toBe(compared.body.rows.length);
    expect(compared.body.baseline.artifactHash).toBe(compared.body.summary.baselineHash);
    expect(compared.body.candidate.artifactHash).toBe(compared.body.summary.candidateHash);

    const comparedJson = JSON.stringify(compared.body);
    expect(comparedJson).not.toContain("projection secret reasoner output");
    expect(comparedJson).not.toContain("projection private turn memo");
    expect(comparedJson).not.toContain("projection private social message");
    expect(comparedJson).not.toContain("projection social action message secret");
    expect(comparedJson).not.toContain("projection social observation secret");
    expect(comparedJson).not.toContain("projection receipt redaction policy secret");
    expect(comparedJson).not.toContain("projection memory secret");
    expect(comparedJson).not.toContain("projection goal secret");
    expect(comparedJson).not.toContain("projection belief value");

    const unsupported = await requestJson(baseUrl, "GET", `/api/matches/${baseline.id}/compare/${candidate.id}?view=private-chat`);
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error).toContain("Unsupported artifact view");

    const missingCandidate = await requestJson(baseUrl, "GET", `/api/matches/${baseline.id}/compare/missing-candidate?view=postgame-redacted`);
    expect(missingCandidate.status).toBe(404);
    expect(missingCandidate.body).toMatchObject({ error: "match not found" });
  });

  it("redacts provider failure strings from explicit artifact and trajectory routes", async () => {
    const record = createSensitiveStoredMatch("server-public-redaction-provider-artifact");
    const rawToken = "Bearer artifact-route-token-should-not-appear";
    if (!record.artifact) throw new Error("Expected stored artifact.");
    record.artifact.failureReason = `provider failed with ${rawToken}`;
    record.artifact.events.push({
      id: `${record.id}:provider-secret`,
      seq: record.artifact.events.length + 1,
      day: record.state.day,
      phase: record.state.phase,
      type: "harness.error",
      actorId: "p1",
      visibility: "postgame",
      payload: {
        model: "alpha",
        actionKind: "speech",
        message: `provider payload leaked ${rawToken}`,
        traceId: "provider-secret-trace",
        providerFailure: {
          failureKind: "http",
          providerStage: "http_response",
          status: 502,
          providerRequestId: rawToken,
          retryCause: `retry leaked ${rawToken}`,
          abortReason: `abort leaked ${rawToken}`,
          causeName: `Error ${rawToken}`
        }
      },
      createdAt: record.createdAt
    });
    saveMatch(record);

    const artifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact`);
    expect(artifact.status).toBe(200);
    const artifactJson = JSON.stringify(artifact.body);
    expect(artifactJson).not.toContain("artifact-route-token-should-not-appear");
    expect(artifactJson).toContain("Bearer [REDACTED]");
    expect(artifactJson).toContain("privateMemo");
    expect(artifactJson).toContain("sourceId");

    const trajectory = await requestText(baseUrl, "GET", `/api/matches/${record.id}/trajectory.jsonl`);
    expect(trajectory.status).toBe(200);
    expect(trajectory.text).not.toContain("artifact-route-token-should-not-appear");
    expect(trajectory.text).toContain("Bearer [REDACTED]");
  });

  it("redacts command responses and post-run public summaries while preserving safe counts", async () => {
    const created = createMatchRecord({ seed: "server-public-command", models: ["alpha", "beta"] });
    const commanded = await requestJson(baseUrl, "POST", `/api/matches/${created.id}/command`, {
      type: "system.advance",
      actorId: "system"
    });
    expect(commanded.status).toBe(200);
    assertPublicMatchResponse(commanded.body);
    expect(commanded.body.state).not.toHaveProperty("night");
    expect(commanded.body).not.toHaveProperty("metrics");

    const run = await requestJson(baseUrl, "POST", "/api/matches/run", {
      models: ["alpha", "beta"],
      profiles: [
        { id: "wolf-profile", model: "alpha", temperature: 0.3 },
        { id: "seer-profile", model: "beta", temperature: 0.3 },
        { id: "fallback-profile", model: "alpha", temperature: 0.3 }
      ],
      assignment: {
        strategy: "role",
        roles: {
          werewolf: "wolf-profile",
          seer: "seer-profile"
        },
        fallback: "profile-rotation"
      },
      seed: "server-public-run",
      maxTransitions: 1
    });
	    expect([200, 207]).toContain(run.status);
	    assertPublicMatchResponse(run.body);
	    expect(run.body).toMatchObject({
	      status: "completed",
	      harnessStatus: "truncated",
	      truncationReason: expect.stringContaining("maxTransitions")
	    });
	    expect(run.body.summary).toMatchObject({
	      status: "truncated",
	      truncationReason: expect.stringContaining("maxTransitions"),
	      profileCount: 3,
	      modelCount: 2
	    });
	    expect(run.body.summary).not.toHaveProperty("profiles");
	    const publicRunSummary = JSON.stringify(run.body.summary);
	    expect(publicRunSummary).not.toContain("wolf-profile");
	    expect(publicRunSummary).not.toContain("seer-profile");
	    expect(publicRunSummary).not.toContain("wolf-deceiver");
	    expect(publicRunSummary).not.toContain("seer-information");
	    expect(run.body.summary.resolvedAssignments).toHaveLength(run.body.state.players.length);
    expect(run.body.summary.assignment).toMatchObject({
      strategy: "role",
      fallback: "profile-rotation",
      roleAssignmentCount: 2,
      teamAssignmentCount: 0
    });
    expect(run.body.summary.assignment).not.toHaveProperty("roles");
    expect(run.body.summary.evaluationReport).toMatchObject({
      warningCount: expect.any(Number),
      warningCodes: expect.any(Array),
      warningSeverityCounts: {
        info: expect.any(Number),
        warning: expect.any(Number)
      }
    });
	    expect(run.body.summary.evaluationReport).not.toHaveProperty("warnings");
	    expect(run.body.summary.evaluationReport).not.toHaveProperty("evidenceRefs");
	    expect(run.body.summary.evaluationReport).not.toHaveProperty("metadata");
	    expect(run.body.summary.evaluationReport).not.toHaveProperty("summary");
	    expect(run.body.summary.evaluationReport).not.toHaveProperty("topMetrics");
	    expect(JSON.stringify(run.body.summary.evaluationReport)).not.toContain("subjectId");
	    expect(JSON.stringify(run.body.summary.evaluationReport)).not.toContain("agentScores");
	    expect(JSON.stringify(run.body.summary.evaluationReport)).not.toContain("profileScores");
    expect(run.body.summary.assignment).not.toHaveProperty("teams");
    expect(JSON.stringify(run.body.summary.assignment)).not.toContain("wolf-profile");
    expect(JSON.stringify(run.body.summary.assignment)).not.toContain("seer-profile");
    const publicResolvedAssignments = JSON.stringify(run.body.summary.resolvedAssignments);
    expect(publicResolvedAssignments).not.toContain("wolf-profile");
    expect(publicResolvedAssignments).not.toContain("seer-profile");
    expect(publicResolvedAssignments).not.toContain("wolf-deceiver");
    expect(publicResolvedAssignments).not.toContain("seer-information");
    expect(publicResolvedAssignments).not.toContain("werewolf");
    expect(publicResolvedAssignments).not.toContain("seer");
    for (const assignment of run.body.summary.resolvedAssignments) {
      expect(Object.keys(assignment).sort()).toEqual(["playerId", "seat"]);
      expect(assignment).not.toHaveProperty("role");
      expect(assignment).not.toHaveProperty("team");
      expect(assignment).not.toHaveProperty("profileId");
      expect(assignment).not.toHaveProperty("model");
      expect(assignment).not.toHaveProperty("temperature");
      expect(assignment).not.toHaveProperty("policyName");
    }
    expect(run.body.summary).not.toHaveProperty("lastHarnessTurns");
    expect(run.body.summary).not.toHaveProperty("harnessFailures");
    expect(run.body.summary.evaluation).not.toHaveProperty("lastTrajectorySteps");
    expect(run.body.summary.evaluation).toMatchObject({
      agentRewardCount: expect.any(Number),
      voteAccuracyAgentCount: expect.any(Number),
      influenceAgentCount: expect.any(Number),
      deceptionAgentCount: expect.any(Number)
    });
    expect(run.body.summary.evaluation).not.toHaveProperty("agentRewards");
    expect(run.body.summary.evaluation).not.toHaveProperty("voteAccuracyByAgent");
    expect(run.body.summary.evaluation).not.toHaveProperty("influenceByAgent");
    expect(run.body.summary.evaluation).not.toHaveProperty("deceptionByAgent");
    expect(JSON.stringify(run.body.summary.evaluation)).not.toContain("wolf-profile");
    expect(JSON.stringify(run.body.summary.evaluation)).not.toContain("seer-profile");
    expect(JSON.stringify(run.body.summary.evaluation)).not.toContain("wolf-deceiver");
    expect(JSON.stringify(run.body.summary.evaluation)).not.toContain("seer-information");
  });

  it("uses explicit profiles as the public and stored model source for match runs", async () => {
    const run = await requestJson(baseUrl, "POST", "/api/matches/run", {
      models: ["stale-model"],
      profiles: [
        { id: "profile-a", model: "profile-model-a", temperature: 0.3 },
        { id: "profile-b", model: "profile-model-b", temperature: 0.4 },
        { id: "profile-c", model: "profile-model-a", temperature: 0.5 }
      ],
      assignment: { strategy: "profile-rotation" },
      seed: "server-public-profile-model-source",
      maxTransitions: 1
    });

    expect([200, 207]).toContain(run.status);
    assertPublicMatchResponse(run.body);
    expect(run.body.models).toEqual(["profile-model-a", "profile-model-b"]);
    expect(run.body.models).not.toContain("stale-model");
    expect(run.body.summary).toMatchObject({
      models: ["profile-model-a", "profile-model-b"],
      profileCount: 3,
      modelCount: 2
    });
    expect(run.body.summary.models).not.toContain("stale-model");

    const listed = await requestJson(baseUrl, "GET", "/api/matches");
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].models).toEqual(["profile-model-a", "profile-model-b"]);
    expect(listed.body[0].models).not.toContain("stale-model");
  });

  it("rejects invalid match run assignment before persisting a match record", async () => {
    const rejected = await requestJson(baseUrl, "POST", "/api/matches/run", {
      models: ["alpha"],
      profiles: [{ id: "alpha-profile", model: "alpha", temperature: 0.3 }],
      assignment: {
        strategy: "seat",
        seats: {
          "99": "missing-unused-profile"
        },
        fallback: "profile-rotation"
      },
      seed: "server-run-invalid-assignment",
      maxTransitions: 0
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({
      summary: {
        kind: "match",
        ok: false,
        seed: "server-run-invalid-assignment",
        resolvedAssignments: [],
        failureReason: expect.stringContaining("missing-unused-profile")
      },
      error: expect.stringContaining("missing-unused-profile")
    });
    expect(rejected.body).not.toHaveProperty("state");

    const matches = await requestJson(baseUrl, "GET", "/api/matches");
    expect(matches.status).toBe(200);
    expect(matches.body).toHaveLength(0);
  });

  it("keeps harness probe diagnostic results out of persisted public matches", async () => {
    const before = await requestJson(baseUrl, "GET", "/api/matches");
    expect(before.status).toBe(200);
    expect(before.body).toHaveLength(0);

    const probe = await requestJson(baseUrl, "POST", "/api/harness/probe", {
      model: "alpha"
    });

    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({
      source: "diagnostic-probe",
      applied: false,
      summary: {
        kind: "probe",
        ok: true,
        source: "diagnostic-probe",
        applied: false,
        model: "alpha"
      }
    });
    expect(probe.body).not.toHaveProperty("trace");
    expect(probe.body).not.toHaveProperty("command");
    expect(probe.body).not.toHaveProperty("action");
	    expect(probe.body.summary.harnessTurn).toMatchObject({
	      traceRef: expect.any(String),
	      day: expect.any(Number),
	      actionRecorded: expect.any(Boolean),
	      policyRecorded: expect.any(Boolean),
	      commandRecorded: expect.any(Boolean),
	      confidence: expect.any(Number)
	    });
	    expect(probe.body.summary.harnessTurn).not.toHaveProperty("actorId");
	    expect(probe.body.summary.harnessTurn).not.toHaveProperty("phase");
	    expect(probe.body.summary.harnessTurn).not.toHaveProperty("actionKind");
	    expect(probe.body.summary.harnessTurn).not.toHaveProperty("policy");
	    expect(probe.body.summary.harnessTurn).not.toHaveProperty("commandType");
	    expect(probe.body.summary.harnessTurn).not.toHaveProperty("intent");
    expect(probe.body.summary.harnessTurn).not.toHaveProperty("targetId");
    expect(probe.body.summary.harnessTurn).not.toHaveProperty("traceId");
    expect(probe.body.summary).not.toHaveProperty("providerRequestId");
    expect(probe.body.diagnostic).toMatchObject({
      schema: "probe-public-diagnostic.v1",
      redaction: {
        rawActionRedacted: true,
        rawCommandRedacted: true,
        rawTraceRedacted: true,
        privateReasoningRedacted: true,
        privateStateRedacted: true,
        providerTelemetryRedacted: true
      }
    });

    const after = await requestJson(baseUrl, "GET", "/api/matches");
    expect(after.status).toBe(200);
    expect(after.body).toHaveLength(0);
  });

  it("redacts private reasoning and raw probe internals from successful probe responses", async () => {
    await close(server);
    clearServerStoreForTests();
    const rawToken = "Bearer raw-success-probe-token-should-not-appear";
    const sensitiveReasoner: HarnessReasoner = {
      async think() {
        const content = `PRIVATE_PROBE_MEMO_SENTINEL ${rawToken}`;
        return {
          content,
          completion: {
            content,
            latencyMs: 1,
            usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            providerRequestId: `success-provider-id ${rawToken}`,
            attempts: 2,
            retryHistory: [
              {
                attempt: 1,
                providerStage: "during_stream",
                retryable: true,
                delayMs: 1,
                message: `success retry leaked ${rawToken}`
              }
            ],
            stream: {
              enabled: true,
              completed: true,
              completedBy: "done_sentinel"
            }
          }
        };
      }
    };
    const app = createServerApp({ createReasoner: () => sensitiveReasoner });
    server = await listen(app);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const probe = await requestJson(baseUrl, "POST", "/api/harness/probe", {
      model: "alpha"
    });
    const json = JSON.stringify(probe.body);

    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({
      source: "diagnostic-probe",
      applied: false,
      summary: {
        kind: "probe",
        ok: true,
        source: "diagnostic-probe",
        applied: false,
        model: "alpha",
        stream: {
          enabled: true,
          completed: true,
          completedBy: "done_sentinel"
        },
        redaction: {
          privateReasoningRedacted: true,
          privateStateRedacted: true,
          providerTelemetryRedacted: true
        }
      }
    });
    expect(json).not.toContain("PRIVATE_PROBE_MEMO_SENTINEL");
    expect(json).not.toContain("raw-success-probe-token-should-not-appear");
    expect(json).not.toContain("success-provider-id");
    expect(json).not.toContain("success retry leaked");
    expect(json).not.toContain("privateMemo");
    expect(json).not.toContain("beliefs");
    expect(json).not.toContain("legalTargetIds");
    expect(json).not.toContain("teamActorIds");
    expect(json).not.toContain("nightVictimId");
    expect(json).not.toContain("saveTargetId");
    expect(json).not.toContain("poisonTargetId");
    expect(json).not.toContain("retryHistory");
    expect(json).not.toContain("providerRequestId");
    expect(json).not.toContain(":harness:");
    expect(json).not.toContain("\"trace\":");
    expect(json).not.toContain("\"command\":");
    expect(json).not.toContain("\"action\":");
  });

  it("redacts provider failure body and header details from failed probe responses", async () => {
    await close(server);
    clearServerStoreForTests();
    const rawToken = "Bearer raw-provider-token-should-not-appear";
    const failingReasoner: HarnessReasoner = {
      async think() {
        throw new ModelCallError(`upstream body leaked ${rawToken}`, {
          failureKind: "http",
          providerStage: "http_response",
          status: 502,
          retryable: true,
          attempts: 2,
          maxAttempts: 3,
          providerRequestId: "failed-public-probe-request",
          retryCause: `retry body leaked ${rawToken}`,
          body: `body leaked ${rawToken}`,
          headers: {
            authorization: rawToken
          }
        });
      }
    };
    const app = createServerApp({ createReasoner: () => failingReasoner });
    server = await listen(app);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const probe = await requestJson(baseUrl, "POST", "/api/harness/probe", {
      model: "alpha"
    });
    const json = JSON.stringify(probe.body);

    expect(probe.status).toBe(500);
    expect(probe.body.error).toBe(probe.body.summary.failureReason);
    expect(probe.body.summary.failureReason).toContain("Model provider failure");
    expect(probe.body.summary.failureReason).toContain("kind=http");
    expect(probe.body.summary.providerFailure).toMatchObject({
      failureKind: "http",
      providerStage: "http_response",
      status: 502,
      retryable: true,
      attempts: 2,
      maxAttempts: 3,
      providerRequestId: "failed-public-probe-request"
    });
    expect(json).not.toContain("raw-provider-token-should-not-appear");
    expect(json).not.toContain("upstream body leaked");
    expect(json).not.toContain("retry body leaked");
    expect(json).not.toContain("authorization");
    expect(json).not.toContain("retryCause");

    const matches = await requestJson(baseUrl, "GET", "/api/matches");
    expect(matches.status).toBe(200);
    expect(matches.body).toHaveLength(0);
  });
});

function createSensitiveStoredMatch(seed: string) {
  const record = createMatchRecord({ seed, models: ["alpha", "beta"] });
  const initialState = record.state;
  let state = initialState;
  state = applyCommand(state, { type: "system.advance", actorId: "system" });

  const inspect = pendingByKind(state, "inspect")[0];
  state = applyCommand(state, { type: "seer.inspect", actorId: inspect.actorId, targetId: inspect.legalTargetIds[0] });

  const kill = pendingByKind(state, "kill")[0];
  state = applyCommand(state, { type: "werewolf.killVote", actorId: kill.actorId, targetId: kill.legalTargetIds[0] });

  const witch = playerByRole(state, "witch");
  const poisonTarget = state.players.find((player) => player.id !== witch.id && player.alive);
  if (!poisonTarget) throw new Error("Expected poison target.");
  state = addPublicDeathWithHiddenSource(state, witch, poisonTarget);

  state = appendHarnessTurn(state, {
    traceId: "redaction-trace",
    playerId: inspect.actorId,
    model: "alpha",
    actionKind: "inspect",
    confidence: 1,
    intent: "private inspection trace",
    beliefs: {},
    policyName: "seer-information",
    privateMemo: "privateMemo should stay out of public match summaries",
    commandType: "seer.inspect",
    latencyMs: 1
  });

  record.state = state;
  record.metrics = buildMetrics(state);
  record.status = "completed";
  record.artifact = {
    artifactVersion: "harness.match.v1",
    kind: "match",
    runId: record.id,
    matchId: record.id,
    createdAt: record.createdAt,
    seed,
    config: initialState.config,
    models: record.models,
    profiles: [],
    resolvedAssignments: [
      {
        playerId: inspect.actorId,
        seat: state.players.find((player) => player.id === inspect.actorId)?.seat ?? 0,
        role: "seer",
        team: "village",
        profileId: "alpha-1",
        model: "alpha",
        temperature: 0.3,
        policyName: "seer-information"
      }
    ],
    status: "completed",
    initialState,
    finalState: state,
    trajectory: [],
    socialEpisode: {
      id: "redaction-social",
      status: "completed",
      schedulerMode: "aec",
      profiles: [],
      channels: [],
      initialState,
      finalState: state,
      steps: [],
      messages: []
    },
    events: state.events,
    metrics: record.metrics,
    evaluation: {
      teamRewards: { village: 0, werewolves: 0 },
      agentRewards: [],
      voteAccuracyByAgent: {},
      influenceByAgent: {},
      deceptionByAgent: {},
      trajectory: []
    },
    evaluationReport: {
      id: "redaction-report",
      createdAt: record.createdAt,
      evaluatorIds: [],
      evaluatorRegistry: [],
      outputs: {},
      metrics: [],
      metricCount: 0,
      summary: {
        teamScores: {},
        agentScores: {},
        profileScores: {},
        modelScores: {}
      }
    },
    agents: []
  } satisfies MatchArtifact;
  saveMatch(record);
  return record;
}

function addProjectionSentinels(record: ReturnType<typeof createSensitiveStoredMatch>): void {
  if (!record.artifact) throw new Error("Expected stored artifact.");
  const actorId = record.artifact.resolvedAssignments[0]?.playerId ?? "p1";
  const observerId = record.artifact.finalState.players.find((player) => player.id !== actorId)?.id ?? "p2";
  record.artifact.trajectory = [
    {
      traceId: "projection-trace",
      turnIndex: 0,
      actorId,
      profileId: "projection-profile",
      model: "alpha",
      pendingAction: {
        kind: "speech",
        phase: "day_speech",
        actorId,
        legalPressureTargetIds: ["p2"]
      },
      observation: {
        playerId: actorId,
        phase: "day_speech",
        day: record.state.day,
        self: { id: actorId },
        players: [],
        events: [],
        speeches: [],
        votes: [],
        deaths: []
      },
      decisionStateHash: "projection-decision-hash",
      preStateHash: "projection-pre-hash",
      policyPlan: {
        policyName: "seer-information",
        command: { type: "speech.submit", actorId, text: "projection secret command speech" },
        intent: "projection secret policy intent",
        confidence: 0.8,
        strategyTags: ["projection-secret-tag"],
        targetId: "p2"
      },
      reasonerOutput: {
        content: "projection secret reasoner output",
        latencyMs: 1,
        promptTokens: 2,
        completionTokens: 3,
        providerRequestId: "projection-provider-request"
      },
      command: { type: "speech.submit", actorId, text: "projection secret command speech" },
      turnTrace: {
        traceId: "projection-trace",
        playerId: actorId,
        profileId: "projection-profile",
        model: "alpha",
        actionKind: "speech",
        policyName: "seer-information",
        commandType: "speech.submit",
        intent: "projection secret turn intent",
        targetId: "p2",
        confidence: 0.8,
        strategyTags: ["projection-secret-tag"],
        beliefs: {
          p2: {
            wolfProb: 0.7,
            rationaleTags: ["projection secret belief rationale"]
          }
        },
        privateMemo: "projection private turn memo",
        publicSpeech: "projection generated public speech",
        latencyMs: 1,
        promptTokens: 2,
        completionTokens: 3,
        providerRequestId: "projection-provider-request"
      },
      agentSnapshotsAfterStep: [
        {
          playerId: actorId,
          model: "alpha",
          temperature: 0.3,
          policyName: "seer-information",
          turns: 1,
          observations: 1,
          beliefs: {},
          privateMemos: ["projection private snapshot memo"],
          lastIntent: "projection secret snapshot intent"
        }
      ],
      postStateHash: "projection-post-hash",
      eventSeqRange: [1, 1],
      messageSeqRange: [1, 1]
    } as any
  ];
  record.artifact.socialEpisode.messages = [
    {
      id: "projection-private-message",
      seq: 1,
      channelId: "wolf-chat",
      senderId: actorId,
      recipientIds: [observerId],
      visibility: "private",
      content: "projection private social message",
      createdAt: record.createdAt,
      deliveryReceipts: [
        {
          id: "projection-private-message-receipt",
          messageId: "projection-private-message",
          messageSeq: 1,
          channelId: "wolf-chat",
          senderId: actorId,
          observerId,
          visibility: "private",
          deliveredAtTurn: 0,
          observationTraceId: "projection-social-step",
          redactionPolicy: "projection receipt redaction policy secret"
        }
      ],
      metadata: { kind: "private-strategy" }
    }
  ];
  record.artifact.socialEpisode.channels = [
    {
      id: "wolf-chat",
      kind: "private",
      participantIds: [actorId, observerId],
      readableBy: "participants"
    }
  ];
  record.artifact.socialEpisode.steps = [
    {
      traceId: "projection-social-step",
      turnIndex: 0,
      actorId: observerId,
      schedulerMode: "aec",
      batchId: "projection-batch",
      batchIndex: 0,
      batchSize: 1,
      pendingAction: { kind: "speech", actorId: observerId },
      observation: {
        agentId: observerId,
        visibleMessages: [record.artifact.socialEpisode.messages[0]],
        secret: "projection social observation secret"
      },
      action: {
        actorId: observerId,
        kind: "speech",
        command: { type: "speech.submit", actorId: observerId, text: "projection social command secret" },
        messages: [
          {
            channelId: "wolf-chat",
            senderId: observerId,
            recipientIds: [actorId],
            visibility: "private",
            content: "projection social action message secret"
          }
        ]
      },
      preStateHash: "projection-social-pre",
      postStateHash: "projection-social-post"
    } as any
  ];
  record.artifact.agents = [
    {
      playerId: actorId,
      profileId: "projection-profile",
      model: "alpha",
      temperature: 0.3,
      policyName: "seer-information",
      turns: 1,
      observations: 1,
      beliefs: {},
      privateMemos: ["projection private agent memo"],
      lastIntent: "projection secret last intent",
      socialStateHash: "projection-social-state-hash",
      social: {
        agentId: actorId,
        profile: { id: "projection-profile", model: "alpha", temperature: 0.3 },
        memory: {
          nextSeq: 2,
          maxEntries: 10,
          entries: [
            {
              seq: 1,
              kind: "memo",
              source: "projection-test",
              visibility: "private",
              content: "projection memory secret",
              salience: 0.9,
              importance: 0.8,
              evidenceRefs: [{ artifact: "trace", traceId: "projection-trace" }],
              tags: ["projection-secret-memory-tag"],
              createdAt: record.createdAt
            }
          ]
        },
        beliefs: {
          claims: {
            claim1: {
              id: "claim1",
              subject: "p2",
              predicate: "projection secret predicate",
              value: "projection belief value",
              confidence: 0.9,
              evidenceRefs: [{ artifact: "trace", traceId: "projection-trace" }],
              contradictions: [],
              updatedAt: record.createdAt
            }
          }
        },
        relationships: { edges: {} },
        norms: { norms: {} },
        reputation: { records: {} },
        goals: {
          goals: [
            {
              id: "projection-goal",
              kind: "tactical",
              description: "projection goal secret",
              priority: 0.9,
              status: "active",
              evidenceRefs: [{ artifact: "trace", traceId: "projection-trace" }],
              createdAt: record.createdAt,
              updatedAt: record.createdAt
            }
          ]
        },
        lastPlan: { secret: "projection plan secret" },
        journal: {
          schemaVersion: "harness.social-state-journal.v1",
          nextSeq: 2,
          maxEntries: 10,
          entries: [
            {
              journalSeq: 1,
              agentId: actorId,
              traceId: "projection-trace",
              turnIndex: 0,
              store: "memory",
              mutationKind: "memory.appended",
              beforeSummary: { secret: "projection journal before secret" },
              afterSummary: { secret: "projection journal after secret" },
              deltaSummary: { secret: "projection journal delta secret" },
              evidenceRefs: [{ artifact: "trace", traceId: "projection-trace" }],
              redactionClass: "agent_private_summary",
              hiddenTruthUsed: false,
              createdAt: record.createdAt
            }
          ]
        }
      }
    } as any
  ];
  saveMatch(record);
}

function buildMetrics(state: GameState): MatchMetrics {
  const coreMetrics = computeMetrics(state);
  return {
    winner: state.winner,
    days: state.day,
    totalDeaths: state.deaths.length,
    totalSpeeches: state.speeches.length,
    totalVotes: state.votes.length,
    harnessTurnCount: state.events.filter((event) => event.type === "harness.turn").length,
    harnessErrorCount: state.events.filter((event) => event.type === "harness.error").length,
    averageLatencyMs: 0,
    wolfVoteAccuracy: coreMetrics.wolfVoteAccuracy,
    villageVoteAccuracy: coreMetrics.villageVoteAccuracy,
    deceptionSurvivalScore: coreMetrics.deceptionSurvivalScore,
    modelUsage: {}
  };
}

function addPublicDeathWithHiddenSource(state: GameState, source: PlayerState, target: PlayerState): GameState {
  const next: GameState = JSON.parse(JSON.stringify(state)) as GameState;
  const nextTarget = next.players.find((player) => player.id === target.id);
  if (!nextTarget) throw new Error("Missing target after clone.");
  nextTarget.alive = false;
  nextTarget.eliminatedAt = { day: next.day, phase: next.phase, reason: "poison" };
  next.deaths.push({ day: next.day, playerId: target.id, reason: "poison", sourceId: source.id });
  next.events.push({
    id: `${next.id}:manual-death`,
    seq: next.events.length + 1,
    day: next.day,
    phase: next.phase,
    type: "player.died",
    actorId: source.id,
    visibility: "public",
    payload: {
      playerId: target.id,
      reason: "poison",
      sourceId: source.id
    },
    createdAt: new Date().toISOString()
  });
  return next;
}

function assertPublicMatchResponse(body: any): void {
  const json = JSON.stringify(body);
  expect(body).toHaveProperty("harnessStatus");
  expect(body).toHaveProperty("truncationReason");
  expect(body.state.events.every((event: GameEvent) => event.visibility === "public")).toBe(true);
  expect(json).not.toContain("seerInspection");
  expect(json).not.toContain("wolfVotes");
  expect(json).not.toContain("resultTeam");
  expect(json).not.toContain("saveTargetId");
  expect(json).not.toContain("poisonTargetId");
  expect(json).not.toContain("privateMemo");
  expect(json).not.toContain("harness.turn");
  expect(json).not.toContain("harness.error");
  expect(json).not.toContain("sourceId");
  for (const player of body.state.players) {
    expect(player).not.toHaveProperty("role");
    expect(player).not.toHaveProperty("team");
    expect(player).not.toHaveProperty("ability");
  }
  for (const death of body.state.deaths) {
    expect(death).not.toHaveProperty("sourceId");
  }
  for (const event of body.state.events) {
    if (typeof event.payload === "object" && event.payload !== null) {
      expect(event.payload).not.toHaveProperty("sourceId");
    }
  }
}

function playerByRole(state: GameState, role: Role): PlayerState {
  const player = state.players.find((candidate) => candidate.role === role);
  if (!player) throw new Error(`Missing role ${role}.`);
  return player;
}

function pendingByKind<K extends PendingAction["kind"]>(state: GameState, kind: K): Extract<PendingAction, { kind: K }>[] {
  return getPendingActions(state).filter((action): action is Extract<PendingAction, { kind: K }> => action.kind === kind);
}

async function listen(app: ReturnType<typeof createServerApp>): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function requestJson(baseUrl: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

async function requestText(baseUrl: string, method: string, path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${baseUrl}${path}`, { method });
  return {
    status: response.status,
    text: await response.text()
  };
}
