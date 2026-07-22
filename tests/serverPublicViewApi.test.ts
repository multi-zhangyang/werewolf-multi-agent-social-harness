import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelCallError } from "../src/agents/schema";
import type { GameEvent } from "../src/core/types";
import { buildMatchArtifact } from "../src/harness/artifacts";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { runHarnessMatch } from "../src/harness/runtime";
import type { HarnessReasoner } from "../src/harness/types";
import { createServerApp } from "../src/server/index";
import { clearServerStoreForTests, createMatchRecord, getMatch, saveMatch } from "../src/server/store";

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
  const tempDirs: string[] = [];

  beforeEach(async () => {
    clearServerStoreForTests();
    const app = createServerApp({ createReasoner: () => fakeReasoner });
    server = await listen(app);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await close(server);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    clearServerStoreForTests();
  });

  it("redacts hidden night state, private events, postgame traces, and source ids from match detail and list views", async () => {
    const record = await createSensitiveStoredMatch("server-public-redaction-detail");

    const detail = await requestJson(baseUrl, "GET", `/api/matches/${record.id}`);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("x-powered-by")).toBeNull();
    assertPublicMatchResponse(detail.body);
    expect(detail.body.state).not.toHaveProperty("night");
    expect(detail.body.state).not.toHaveProperty("pendingHunterId");
    expect(detail.body.state).not.toHaveProperty("hunterResume");
    expect(detail.body).not.toHaveProperty("metrics");
    expect(detail.body.state.pendingActionCount).toEqual(expect.any(Number));
    expect(detail.body.state).not.toHaveProperty("harnessTurnCount");
    expect(detail.body.state).not.toHaveProperty("harnessErrorCount");
    expect(detail.body.state.publicEventCount).toBe(detail.body.state.events.length);

    const listed = await requestJson(baseUrl, "GET", "/api/matches");
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    assertPublicMatchResponse(listed.body[0]);
  });

  it("exposes only safe provider diagnostics from health and cockpit configuration routes", async () => {
    const [health, config] = await Promise.all([
      requestJson(baseUrl, "GET", "/api/health"),
      requestJson(baseUrl, "GET", "/api/config")
    ]);

    for (const response of [health, config]) {
      expect(response.status).toBe(200);
      expect(response.body.provider).toMatchObject({
        protocol: expect.any(String),
        configured: expect.any(Boolean)
      });
      expect(response.body.provider).not.toHaveProperty("endpoint");
      expect(response.body).not.toHaveProperty("chatCompletionsUrl");
      expect(JSON.stringify(response.body)).not.toContain('"endpoint"');
      expect(JSON.stringify(response.body)).not.toContain('"chatCompletionsUrl"');
    }
  });

  it("defaults artifact reads to a private-evidence-redacted projection and keeps full postgame truth explicit", async () => {
    const record = await createSensitiveStoredMatch("server-public-redaction-artifact");

    const detail = await requestJson(baseUrl, "GET", `/api/matches/${record.id}`);
    expect(detail.status).toBe(200);
    assertPublicMatchResponse(detail.body);

    const defaultArtifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact`);
    expect(defaultArtifact.status).toBe(200);
    expect(defaultArtifact.headers.get("cache-control")).toContain("no-store");
    expect(defaultArtifact.headers.get("x-content-type-options")).toBe("nosniff");
    expect(defaultArtifact.body.projection).toMatchObject({
      view: "postgame-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: false
    });
    const defaultArtifactJson = JSON.stringify(defaultArtifact.body);
    for (const agent of record.artifact!.agents) {
      for (const memo of agent.privateMemos) expect(defaultArtifactJson).not.toContain(memo);
    }

    const artifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=full`);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("cache-control")).toContain("no-store");
    expect(artifact.headers.get("x-robots-tag")).toContain("noindex");
    expect(artifact.body.finalState.night.seerInspection).toMatchObject({
      resultTeam: expect.any(String)
    });
    expect(artifact.body.finalState.night.wolfVotes).not.toEqual({});
  });

  it("rejects full artifact views on every artifact-bearing route when the embedded server is not loopback-bound", async () => {
    await close(server);
    const restrictedApp = createServerApp({
      createReasoner: () => fakeReasoner,
      artifactAccessBindHost: "0.0.0.0"
    });
    server = await listen(restrictedApp);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    const record = await createSensitiveStoredMatch("server-public-full-view-local-only");
    const candidate = await createSensitiveStoredMatch("server-public-full-view-local-only-candidate");
    const [operatorList, operatorDetail, strictLive] = await Promise.all([
      requestJson(baseUrl, "GET", "/api/matches"),
      requestJson(baseUrl, "GET", `/api/matches/${record.id}`),
      requestJson(baseUrl, "GET", `/api/matches/${record.id}/live`)
    ]);
    for (const response of [operatorList, operatorDetail]) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "operator_match_registry_local_only" });
      expect(JSON.stringify(response.body)).not.toContain("seerInspection");
    }
    expect(strictLive.status).toBe(200);
    expect(strictLive.body).toEqual({
      artifactVersion: "server.match-live-projection.v1",
      kind: "match-live-projection",
      matchId: record.id,
      lifecycle: expect.stringMatching(/^(completed|truncated|failed)$/),
      artifactAvailable: true
    });
    const safeComparison = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${record.id}/compare/${candidate.id}?view=truth-redacted`
    );
    expect(safeComparison.status).toBe(200);
    const checkpoint = await requestJson(baseUrl, "POST", `/api/matches/${record.id}/checkpoints`, {
      reason: "restricted full-view regression"
    });
    expect(checkpoint.status).toBe(201);

    const fullViewPaths = [
      `/api/matches/${record.id}/artifact?view=full`,
      `/api/matches/${record.id}/compare/${candidate.id}?view=full`,
      "/api/comparisons?view=full",
      `/api/comparisons/${encodeURIComponent(safeComparison.body.comparisonId)}?view=full`,
      `/api/matches/${record.id}/trajectory.jsonl?view=full`,
      `/api/checkpoints/${checkpoint.body.summary.checkpointId}/artifact?view=full`
    ];

    for (const path of fullViewPaths) {
      const response = await requestJson(baseUrl, "GET", path);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "full_artifact_view_local_only" });
      expect(JSON.stringify(response.body)).not.toContain("seerInspection");
    }

    const [nativeReplay, replayFrame] = await Promise.all([
      requestJson(baseUrl, "POST", `/api/matches/${record.id}/replay`, {}),
      requestJson(baseUrl, "POST", `/api/matches/${record.id}/replay/frame`, { nativeStepCount: 1 })
    ]);
    for (const response of [nativeReplay, replayFrame]) {
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "postgame_replay_local_only" });
      const responseJson = JSON.stringify(response.body);
      expect(responseJson).not.toContain("nativeStepCount");
      expect(responseJson).not.toContain("stateHash");
      expect(responseJson).not.toContain("seerInspection");
    }

    const defaultProjection = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact`);
    expect(defaultProjection.status).toBe(200);
    expect(defaultProjection.body.projection).toMatchObject({ view: "truth-redacted", postgameTruthRedacted: true });
    expect(defaultProjection.body.finalState).not.toHaveProperty("night");

    const explicitPostgameProjection = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${record.id}/artifact?view=postgame-redacted`
    );
    expect(explicitPostgameProjection.status).toBe(403);
    expect(explicitPostgameProjection.body).toMatchObject({ code: "postgame_artifact_view_local_only" });
  });

  it("serves a server-side postgame artifact projection with private evidence redacted", async () => {
    const record = await createSensitiveStoredMatch("server-postgame-artifact-projection");

    const fullArtifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=full`);
    expect(fullArtifact.status).toBe(200);
    expect(fullArtifact.body.trajectory.length).toBeGreaterThan(0);
    expect(fullArtifact.body.socialEpisode.messages.some((message: any) => message.visibility !== "public")).toBe(true);
    expect(fullArtifact.body.agents.some((agent: any) => agent.privateMemos.length > 0)).toBe(true);

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
    expect(projected.body.trajectory).toHaveLength(record.artifact!.trajectory.length);
    expect(projected.body.trajectory.every((step: any) => !("agentSnapshotsAfterStep" in step))).toBe(true);
    expect(projected.body.trajectory.every((step: any) => step.reasonerOutput.content === "[REDACTED model reasoning output]")).toBe(true);
    expect(
      projected.body.socialEpisode.messages
        .filter((message: any) => message.visibility !== "public")
        .every((message: any) => message.content === "[REDACTED private social message]")
    ).toBe(true);
    expect(projected.body.socialEpisode.steps.every((step: any) => step.observation === "[REDACTED private social observation]")).toBe(true);
    expect(projected.body.socialEpisode.exposureSummary).toMatchObject({
      schemaVersion: "server.social-exposure-summary.v1",
      source: "scoped_observation",
      privateEvidenceRedacted: true,
      recordCount: projected.body.socialEpisode.exposureRecords.length,
      messageCount: expect.any(Number),
      sourceCount: expect.any(Number),
      observerCount: expect.any(Number),
      byVisibility: expect.any(Object)
    });
    expect(projected.body.socialEpisode.exposureRecords.every((exposure: any) => exposure.deliveryReceipt === undefined)).toBe(true);
    expect(projected.body.werewolfReviewLedger).toMatchObject({
      artifactVersion: "server.werewolf-postgame-event-ledger.v1",
      kind: "werewolf-postgame-event-ledger",
      authority: "server-owned-match-artifact",
      projection: {
        view: "postgame-redacted",
        privateEvidenceRedacted: true,
        postgameTruthRedacted: false
      },
      entries: expect.any(Array)
    });
    const postgameLedger = projected.body.werewolfReviewLedger;
    expect(postgameLedger.entries.every((entry: any) => entry.visibility === "public")).toBe(true);
    expect(postgameLedger.entries.every((entry: any) => typeof entry.safeLabel === "string")).toBe(true);
    expect(postgameLedger.entries.map((entry: any) => entry.eventType)).not.toEqual(
      expect.arrayContaining(["seer.inspected", "werewolves.voted", "werewolves.whispered", "witch.acted"])
    );
    const postgameLedgerJson = JSON.stringify(postgameLedger);
    for (const forbidden of ["payload", "actorId", "targetId", "sourceId", "traceId", "batchId", "eventSeqRange", "command", "postStateHash"]) {
      expect(postgameLedgerJson).not.toContain(forbidden);
    }
    expect(
      projected.body.socialEpisode.exposureRecords.every((exposure: any) =>
        exposure.evidenceRefs.every((ref: { description?: string }) => ref.description === undefined)
      )
    ).toBe(true);
    expect(projected.body.agents.every((agent: any) => agent.privateMemos.every((memo: string) => memo === "[REDACTED private memo]"))).toBe(true);
    expect(projected.body.agents.every((agent: any) => agent.social.messageIngestion.seenMessageIds.length === 0)).toBe(true);
    expect(projected.body.agents.every((agent: any) => !("theoryOfMind" in agent.social))).toBe(true);
    expect(
      projected.body.agents.every((agent: any) =>
        agent.social.memory.entries.every((entry: any) => !entry.content || entry.content === "[REDACTED private memory]")
      )
    ).toBe(true);
    for (const step of projected.body.trajectory) {
      expect(Object.keys(step.pendingAction).sort()).toEqual(
        expect.arrayContaining(["actorId", "kind", "phase", "redacted"])
      );
      expect(step.pendingAction).not.toHaveProperty("legalTargetIds");
      expect(step.pendingAction).not.toHaveProperty("legalPoisonTargetIds");
      expect(step.pendingAction).not.toHaveProperty("legalPressureTargetIds");
      expect(step.pendingAction).not.toHaveProperty("teamActorIds");
      expect(step.pendingAction).not.toHaveProperty("nightVictimId");
      expect(step.command).not.toHaveProperty("targetId");
      expect(step.command).not.toHaveProperty("saveTargetId");
      expect(step.command).not.toHaveProperty("poisonTargetId");
      expect(step.policyPlan).not.toHaveProperty("targetId");
      expect(step.policyPlan).not.toHaveProperty("pressureTargetId");
      expect(step.policyPlan).not.toHaveProperty("arbitration");
      expect(step.policyPlan).not.toHaveProperty("memoryRetrieval");
      expect(step.reasonerOutput).not.toHaveProperty("providerRequestId");
      expect(step.reasonerOutput).not.toHaveProperty("retryHistory");
      expect(step.reasonerOutput).not.toHaveProperty("stream");
      expect(step.turnTrace).not.toHaveProperty("providerRequestId");
      expect(step.turnTrace).not.toHaveProperty("retryHistory");
      expect(step.turnTrace).not.toHaveProperty("stream");
      expect(step.turnTrace).not.toHaveProperty("memoryRetrieval");
    }
    expect(JSON.stringify(projected.body)).not.toContain("memoryRetrieval");
    for (const step of projected.body.socialEpisode.steps) {
      expect(step.pendingAction).not.toHaveProperty("legalTargetIds");
      expect(step.pendingAction).not.toHaveProperty("legalPoisonTargetIds");
      expect(step.pendingAction).not.toHaveProperty("legalPressureTargetIds");
      expect(step.pendingAction).not.toHaveProperty("teamActorIds");
      expect(step.pendingAction).not.toHaveProperty("nightVictimId");
      expect(step.action.command).not.toHaveProperty("targetId");
      expect(step.action.command).not.toHaveProperty("saveTargetId");
      expect(step.action.command).not.toHaveProperty("poisonTargetId");
      expect(step).not.toHaveProperty("infosByAgent");
    }
    for (const message of projected.body.socialEpisode.messages.filter((candidate: any) => candidate.visibility !== "public")) {
      expect(Object.keys(message.metadata ?? {}).sort()).toEqual(
        expect.arrayContaining(["redacted"])
      );
      expect(message.metadata).not.toHaveProperty("targetId");
      expect(message.metadata).not.toHaveProperty("saveTargetId");
      expect(message.metadata).not.toHaveProperty("poisonTargetId");
      expect(message.metadata).not.toHaveProperty("providerRequestId");
      for (const speechAct of message.speechActs ?? []) {
        expect(speechAct).not.toHaveProperty("targetId");
        expect(speechAct).not.toHaveProperty("value");
        expect(speechAct).not.toHaveProperty("metadata");
        expect(
          (speechAct.evidenceRefs ?? []).every((ref: { description?: string }) => ref.description === undefined)
        ).toBe(true);
      }
      for (const receipt of message.deliveryReceipts ?? []) {
        expect(receipt.redactionPolicy).toBe("[REDACTED delivery redaction policy]");
      }
    }
    for (const agent of projected.body.agents) {
      for (const entry of agent.social.memory.entries) {
        const metadata = entry.metadata ?? {};
        expect(metadata).not.toHaveProperty("intent");
        expect(metadata).not.toHaveProperty("targetId");
        expect(metadata).not.toHaveProperty("pressureTargetId");
        expect(metadata).not.toHaveProperty("providerRequestId");
        expect(metadata).not.toHaveProperty("retryHistory");
        expect(metadata).not.toHaveProperty("stream");
        expect((entry.evidenceRefs ?? []).every((ref: { description?: string }) => ref.description === undefined)).toBe(true);
      }
      for (const entry of agent.social.journal?.entries ?? []) {
        const metadata = entry.metadata ?? {};
        expect(metadata).not.toHaveProperty("providerRequestId");
        expect(metadata).not.toHaveProperty("retryHistory");
        expect(metadata).not.toHaveProperty("stream");
        if (metadata.visibility === "private" || metadata.visibility === "team") {
          expect(metadata).not.toHaveProperty("targetId");
        }
        expect((entry.evidenceRefs ?? []).every((ref: { description?: string }) => ref.description === undefined)).toBe(true);
      }
      assertNoEvidenceRefDescriptions(agent.social);
    }
    const projectedJson = JSON.stringify(projected.body);
    expect(projectedJson).not.toContain('"privateInfo"');
    expect(projectedJson).not.toContain('"legalTargetIds"');
    expect(projectedJson).not.toContain('"legalPoisonTargetIds"');
    expect(projectedJson).not.toContain('"legalPressureTargetIds"');
    expect(projectedJson).not.toContain('"providerRequestId"');
    expect(projectedJson).not.toContain('"retryHistory"');
    expect(projectedJson).not.toContain('"stream"');
    expect(projectedJson).not.toContain('"theoryOfMind"');
    for (const step of record.artifact!.trajectory) expect(projectedJson).not.toContain(step.reasonerOutput.content);
    for (const message of record.artifact!.socialEpisode.messages.filter((message) => message.visibility !== "public")) {
      expect(projectedJson).not.toContain(message.content);
    }
    for (const agent of record.artifact!.agents) {
      for (const memo of agent.privateMemos) expect(projectedJson).not.toContain(memo);
    }

    const projectedTrajectory = await requestText(
      baseUrl,
      "GET",
      `/api/matches/${record.id}/trajectory.jsonl?view=postgame-redacted`
    );
    expect(projectedTrajectory.status).toBe(200);
    expect(projectedTrajectory.text).not.toContain('"privateInfo"');
    expect(projectedTrajectory.text).not.toContain('"legalTargetIds"');
    expect(projectedTrajectory.text).not.toContain('"legalPoisonTargetIds"');
    expect(projectedTrajectory.text).not.toContain('"legalPressureTargetIds"');
    expect(projectedTrajectory.text).not.toContain('"providerRequestId"');
    expect(projectedTrajectory.text).not.toContain('"retryHistory"');
    expect(projectedTrajectory.text).not.toContain('"stream"');
    const projectedTrajectoryLines = projectedTrajectory.text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      projectedTrajectoryLines
        .filter((line: any) => line.type === "social_step")
        .every((line: any) => !("infosByAgent" in line))
    ).toBe(true);
    expect(
      projectedTrajectoryLines
        .filter((line: any) => line.type === "social_speech_act")
        .filter((line: any) => line.visibility !== "public")
        .every(
          (line: any) =>
            line.targetId === null &&
            line.value === null &&
            line.metadata === null &&
            line.evidenceRefs.every((ref: { description?: string }) => ref.description === undefined)
        )
    ).toBe(true);
    expect(
      projectedTrajectoryLines
        .filter((line: any) => line.type === "social_delivery_receipt")
        .every((line: any) => line.redactionPolicy === "[REDACTED delivery redaction policy]")
    ).toBe(true);

    const unsupported = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=private-chat`);
    expect(unsupported.status).toBe(400);
  });

  it("preserves closed policy-only provenance without exposing or inventing model telemetry", async () => {
    const record = await createSensitiveStoredMatch("server-postgame-policy-only-provenance", null);
    const projected = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=postgame-redacted`);

    expect(projected.status).toBe(200);
    expect(projected.body.trajectory.length).toBeGreaterThan(0);
    expect(projected.body.trajectory.every((step: any) => step.reasonerOutput.cognitionSource === "policy")).toBe(true);
    expect(projected.body.trajectory.every((step: any) => step.turnTrace.cognitionSource === "policy")).toBe(true);
    expect(projected.body.trajectory.every((step: any) => step.reasonerOutput.content === "[REDACTED deterministic policy memo]")).toBe(true);
    expect(JSON.stringify(projected.body.trajectory)).not.toContain("[REDACTED model reasoning output]");
  });

  it("serves a truth-redacted artifact projection without postgame role team night or winner truth", async () => {
    const record = await createSensitiveStoredMatch("server-truth-redacted-artifact-projection");

    const fullArtifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=full`);
    expect(fullArtifact.status).toBe(200);
    expect(fullArtifact.body.finalState.players.some((player: { role?: string }) => Boolean(player.role))).toBe(true);
    expect(fullArtifact.body.finalState.night).toBeTruthy();

    const projected = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=truth-redacted`);
    expect(projected.status).toBe(200);
    expect(projected.body.projection).toMatchObject({
      view: "truth-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: true
    });
    expect(projected.body).not.toHaveProperty("seed");
    expect(projected.body.initialState).not.toHaveProperty("id");
    expect(projected.body.initialState).not.toHaveProperty("seed");
    expect(projected.body.initialState).not.toHaveProperty("night");
    expect(projected.body.finalState).not.toHaveProperty("id");
    expect(projected.body.finalState).not.toHaveProperty("seed");
    expect(projected.body.finalState).not.toHaveProperty("night");
    expect(projected.body.finalState.winner).toBeUndefined();
    expect(projected.body.metrics).toEqual({});
    expect(projected.body.evaluation).toEqual({});
    for (const player of projected.body.finalState.players) {
      expect(player).not.toHaveProperty("role");
      expect(player).not.toHaveProperty("team");
      expect(player).not.toHaveProperty("ability");
    }
    expect(projected.body.models).toEqual([]);
    expect(projected.body.profiles).toEqual([]);
    expect(projected.body).not.toHaveProperty("assignment");
    expect(projected.body.trajectory).toEqual([]);
    expect(projected.body.agents).toEqual([]);
    expect(projected.body).not.toHaveProperty("agentSnapshotFrames");
    for (const assignment of projected.body.resolvedAssignments) expect(Object.keys(assignment).sort()).toEqual(["playerId", "seat"]);
    expect(projected.body.socialEpisode.profiles).toEqual([]);
    expect(projected.body.socialEpisode.steps).toEqual([]);
    expect(projected.body.socialEpisode.exposureRecords).toEqual([]);
    expect(projected.body.evaluationReport).toEqual({});
    const projectedJson = JSON.stringify(projected.body);
    expect(projectedJson).not.toContain("resultTeam");
    expect(projectedJson).not.toContain("seerInspection");
    expect(projectedJson).not.toContain(record.artifact!.seed);
    expect(projectedJson).not.toContain("wolf-deceiver");
    expect(projectedJson).not.toContain("seer-information");
    expect(projectedJson).not.toContain("werewolf.killVote");
    expect(projectedJson).not.toContain("seer.inspect");
    expect(projectedJson).not.toContain("witch.act");
    expect(projectedJson).not.toContain("hunter.shoot");
    expect(projectedJson).not.toContain("\"policyName\"");
    // config.roles is public roster composition, not seat-level postgame truth.
    expect(projected.body.config.roles).toEqual(expect.arrayContaining(["werewolf", "villager", "seer"]));
    expect(projected.body.socialEpisode.exposureSummary.privateEvidenceRedacted).toBe(true);
    assertTruthRedactedSocialTopology(projected.body.socialEpisode);
    expect(projected.body.werewolfReviewLedger).toMatchObject({
      artifactVersion: "server.werewolf-postgame-event-ledger.v1",
      kind: "werewolf-postgame-event-ledger",
      authority: "server-owned-match-artifact",
      projection: {
        view: "truth-redacted",
        privateEvidenceRedacted: true,
        postgameTruthRedacted: true
      },
      entries: expect.any(Array)
    });
    const truthLedgerJson = JSON.stringify(projected.body.werewolfReviewLedger);
    for (const forbidden of [
      "nativeBoundary",
      "nativeStepCount",
      "traceId",
      "batchId",
      "eventSeqRange",
      "command",
      "postStateHash",
      "seer.inspected",
      "werewolves.voted",
      "werewolves.whispered",
      "witch.acted",
      "winner",
      "resultTeam",
      "sourceId"
    ]) {
      expect(truthLedgerJson).not.toContain(forbidden);
    }

    const second = await createSensitiveStoredMatch("server-truth-redacted-compare-candidate");
    const truthCompared = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${record.id}/compare/${second.id}?view=truth-redacted`
    );
    if (truthCompared.status !== 200) throw new Error(`truth comparison response: ${JSON.stringify(truthCompared.body)}`);
    expect(truthCompared.status).toBe(200);
    expect(truthCompared.body.projection).toMatchObject({
      view: "truth-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: true
    });
    const compareJson = JSON.stringify(truthCompared.body);
    expect(compareJson).not.toContain("resultTeam");
    expect(compareJson).not.toContain("seerInspection");
    expect(compareJson).not.toContain(record.id);
    expect(compareJson).not.toContain(second.id);
    expect(compareJson).not.toContain(record.artifact!.seed);
    expect(compareJson).not.toContain("evaluation_metrics");
    expect(truthCompared.body.baseline).not.toHaveProperty("runId");
    expect(truthCompared.body.baseline).not.toHaveProperty("seed");
    expect(truthCompared.body.candidate).not.toHaveProperty("runId");
    expect(truthCompared.body.candidate).not.toHaveProperty("seed");
  });

  it("serves a server-side postgame-redacted match comparison without private projection sentinels", async () => {
    const baseline = await createSensitiveStoredMatch("server-compare-baseline");
    const candidate = await createSensitiveStoredMatch("server-compare-candidate");

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
        trajectorySteps: baseline.artifact!.trajectory.length,
        socialMessages: baseline.artifact!.socialEpisode.messages.length
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
        trajectorySteps: candidate.artifact!.trajectory.length,
        socialMessages: candidate.artifact!.socialEpisode.messages.length
      },
      summary: {
        rowCount: expect.any(Number),
        changedRowCount: expect.any(Number),
        numericDeltaCount: expect.any(Number),
        promotionChangedMetricCount: expect.any(Number),
        scorecardMetricDelta: expect.any(Number),
        diagnosticMetricDelta: expect.any(Number),
        benchmarkOnlyMetricDelta: expect.any(Number),
        metricKeysCompared: expect.any(Number),
        metricKeysEmitted: expect.any(Number),
        metricKeysTruncated: expect.any(Number),
        scorecardMetricKeysCompared: expect.any(Number),
        scorecardMetricKeysEmitted: expect.any(Number),
        scorecardMetricKeysTruncated: expect.any(Number),
        diagnosticMetricKeysCompared: expect.any(Number),
        diagnosticMetricKeysEmitted: expect.any(Number),
        diagnosticMetricKeysTruncated: expect.any(Number),
        benchmarkOnlyMetricKeysCompared: expect.any(Number),
        benchmarkOnlyMetricKeysEmitted: expect.any(Number),
        benchmarkOnlyMetricKeysTruncated: expect.any(Number),
        evidenceIdentityChangedMetricCount: expect.any(Number),
        evidenceIdentityOnlyBaselineRefCount: expect.any(Number),
        evidenceIdentityOnlyCandidateRefCount: expect.any(Number),
        metricRowsMax: expect.any(Number),
        baselineSocialSteps: expect.any(Number),
        candidateSocialSteps: expect.any(Number),
        baselineCommittedSteps: expect.any(Number),
        candidateCommittedSteps: expect.any(Number),
        baselineRejectedSteps: expect.any(Number),
        candidateRejectedSteps: expect.any(Number),
        socialStepsDelta: expect.any(Number),
        committedStepsDelta: expect.any(Number),
        rejectedStepsDelta: expect.any(Number),
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
          baseline: baseline.artifact!.trajectory.length,
          candidate: candidate.artifact!.trajectory.length,
          delta: 0,
          changed: false
        }),
        expect.objectContaining({
          id: "social_messages",
          baseline: baseline.artifact!.socialEpisode.messages.length,
          candidate: candidate.artifact!.socialEpisode.messages.length,
          delta: 0,
          changed: false
        }),
        expect.objectContaining({
          id: "social_exposures",
          baseline: expect.any(Number),
          candidate: expect.any(Number)
        })
      ])
    );
    expect(compared.body.summary.rowCount).toBe(compared.body.rows.length);
    expect(compared.body.baseline.artifactHash).toBe(compared.body.summary.baselineHash);
    expect(compared.body.candidate.artifactHash).toBe(compared.body.summary.candidateHash);

    const comparedJson = JSON.stringify(compared.body);
    expect(comparedJson).not.toContain('"privateInfo"');
    expect(comparedJson).not.toContain('"legalTargetIds"');
    expect(comparedJson).not.toContain('"providerRequestId"');
    expect(comparedJson).not.toContain('"retryHistory"');
    expect(comparedJson).not.toContain('"stream"');
    for (const artifact of [baseline.artifact!, candidate.artifact!]) {
      for (const step of artifact.trajectory) expect(comparedJson).not.toContain(step.reasonerOutput.content);
      for (const message of artifact.socialEpisode.messages.filter((message) => message.visibility !== "public")) {
        expect(comparedJson).not.toContain(message.content);
      }
    }

    const markdown = await requestText(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted&format=markdown`
    );
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("content-type") ?? "").toContain("text/markdown");
    expect(markdown.text).toContain("# Match Comparison");
    expect(markdown.text).toContain(compared.body.comparisonId);
    expect(markdown.text).not.toContain('"privateInfo"');
    for (const artifact of [baseline.artifact!, candidate.artifact!]) {
      for (const step of artifact.trajectory) expect(markdown.text).not.toContain(step.reasonerOutput.content);
      for (const message of artifact.socialEpisode.messages.filter((message) => message.visibility !== "public")) {
        expect(markdown.text).not.toContain(message.content);
      }
    }

    const markdownDownload = await requestText(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted&format=markdown&download=1`
    );
    expect(markdownDownload.status).toBe(200);
    expect(markdownDownload.headers.get("content-disposition") ?? "").toContain("attachment");
    expect(markdownDownload.headers.get("content-disposition") ?? "").toContain("-comparison.md");
    expect(markdownDownload.text).toContain("# Match Comparison");

    const jsonDownload = await requestText(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted&format=json&download=1`
    );
    expect(jsonDownload.status).toBe(200);
    expect(jsonDownload.headers.get("content-disposition") ?? "").toContain("attachment");
    expect(jsonDownload.headers.get("content-disposition") ?? "").toContain("-comparison.json");
    expect(JSON.parse(jsonDownload.text)).toMatchObject({
      artifactVersion: "harness.match-comparison.v1",
      kind: "match-comparison",
      comparisonId: compared.body.comparisonId
    });

    const registry = await requestJson(baseUrl, "GET", "/api/comparisons");
    expect(registry.status).toBe(200);
    expect(registry.body.comparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          comparisonId: compared.body.comparisonId,
          view: "postgame-redacted",
          baseline: expect.objectContaining({
            matchId: baseline.id,
            runId: baseline.id
          }),
          candidate: expect.objectContaining({
            matchId: candidate.id,
            runId: candidate.id
          }),
          summary: expect.objectContaining({
            rowCount: compared.body.summary.rowCount,
            changedRowCount: compared.body.summary.changedRowCount,
            numericDeltaCount: compared.body.summary.numericDeltaCount,
            promotionChangedMetricCount: compared.body.summary.promotionChangedMetricCount,
            scorecardMetricDelta: compared.body.summary.scorecardMetricDelta,
            diagnosticMetricDelta: compared.body.summary.diagnosticMetricDelta,
            benchmarkOnlyMetricDelta: compared.body.summary.benchmarkOnlyMetricDelta,
            evidenceIdentityChangedMetricCount: compared.body.summary.evidenceIdentityChangedMetricCount,
            evidenceIdentityOnlyBaselineRefCount: compared.body.summary.evidenceIdentityOnlyBaselineRefCount,
            evidenceIdentityOnlyCandidateRefCount: compared.body.summary.evidenceIdentityOnlyCandidateRefCount,
            metricKeysCompared: compared.body.summary.metricKeysCompared,
            metricKeysEmitted: compared.body.summary.metricKeysEmitted,
            metricKeysTruncated: compared.body.summary.metricKeysTruncated,
            scorecardMetricKeysCompared: compared.body.summary.scorecardMetricKeysCompared,
            scorecardMetricKeysEmitted: compared.body.summary.scorecardMetricKeysEmitted,
            scorecardMetricKeysTruncated: compared.body.summary.scorecardMetricKeysTruncated,
            diagnosticMetricKeysCompared: compared.body.summary.diagnosticMetricKeysCompared,
            diagnosticMetricKeysEmitted: compared.body.summary.diagnosticMetricKeysEmitted,
            diagnosticMetricKeysTruncated: compared.body.summary.diagnosticMetricKeysTruncated,
            benchmarkOnlyMetricKeysCompared: compared.body.summary.benchmarkOnlyMetricKeysCompared,
            benchmarkOnlyMetricKeysEmitted: compared.body.summary.benchmarkOnlyMetricKeysEmitted,
            benchmarkOnlyMetricKeysTruncated: compared.body.summary.benchmarkOnlyMetricKeysTruncated,
            metricRowsMax: compared.body.summary.metricRowsMax,
            baselineSocialSteps: compared.body.summary.baselineSocialSteps,
            candidateSocialSteps: compared.body.summary.candidateSocialSteps,
            baselineCommittedSteps: compared.body.summary.baselineCommittedSteps,
            candidateCommittedSteps: compared.body.summary.candidateCommittedSteps,
            baselineRejectedSteps: compared.body.summary.baselineRejectedSteps,
            candidateRejectedSteps: compared.body.summary.candidateRejectedSteps,
            socialStepsDelta: compared.body.summary.socialStepsDelta,
            committedStepsDelta: compared.body.summary.committedStepsDelta,
            rejectedStepsDelta: compared.body.summary.rejectedStepsDelta,
            baselineHash: compared.body.summary.baselineHash,
            candidateHash: compared.body.summary.candidateHash
          })
        })
      ])
    );

    const filteredByBaseline = await requestJson(
      baseUrl,
      "GET",
      `/api/comparisons?baselineId=${encodeURIComponent(baseline.id)}`
    );
    expect(filteredByBaseline.status).toBe(200);
    expect(filteredByBaseline.body.comparisons.every((entry: { baseline: { matchId?: string; runId: string } }) => entry.baseline.matchId === baseline.id || entry.baseline.runId === baseline.id)).toBe(true);

    const filteredByPackMatchIds = await requestJson(
      baseUrl,
      "GET",
      `/api/comparisons?matchIds=${encodeURIComponent(`${baseline.id},${candidate.id}`)}`
    );
    expect(filteredByPackMatchIds.status).toBe(200);
    expect(filteredByPackMatchIds.body.comparisons.length).toBeGreaterThanOrEqual(1);
    expect(
      filteredByPackMatchIds.body.comparisons.every(
        (entry: {
          baseline: { matchId?: string; runId: string };
          candidate: { matchId?: string; runId: string };
        }) => {
          const baselineIds = [entry.baseline.matchId, entry.baseline.runId].filter(
            (value): value is string => typeof value === "string" && value.length > 0
          );
          const candidateIds = [entry.candidate.matchId, entry.candidate.runId].filter(
            (value): value is string => typeof value === "string" && value.length > 0
          );
          return (
            baselineIds.some((id) => id === baseline.id) &&
            candidateIds.some((id) => id === candidate.id)
          );
        }
      )
    ).toBe(true);

    const filteredBySingleMatchId = await requestJson(
      baseUrl,
      "GET",
      `/api/comparisons?matchIds=${encodeURIComponent(baseline.id)}`
    );
    expect(filteredBySingleMatchId.status).toBe(200);
    // Fewer than two pack ids leaves the pack filter inactive; baseline-only
    // filtering still requires the explicit baselineId query.
    expect(Array.isArray(filteredBySingleMatchId.body.comparisons)).toBe(true);


    const loaded = await requestJson(baseUrl, "GET", `/api/comparisons/${encodeURIComponent(compared.body.comparisonId)}`);
    expect(loaded.status).toBe(200);
    expect(loaded.body).toMatchObject({
      artifactVersion: "harness.match-comparison.v1",
      kind: "match-comparison",
      comparisonId: compared.body.comparisonId,
      view: "postgame-redacted",
      summary: {
        baselineHash: compared.body.summary.baselineHash,
        candidateHash: compared.body.summary.candidateHash
      }
    });
    expect(JSON.stringify(loaded.body)).not.toContain('"privateInfo"');

    const missing = await requestJson(baseUrl, "GET", "/api/comparisons/missing-comparison-id");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain("comparison not found");



    const filtered = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted&filtered=1&group=metric_evidence&evidenceIdentity=changed`
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body).toMatchObject({
      artifactVersion: "harness.match-comparison.filtered.v1",
      kind: "match-comparison-filtered",
      sourceComparisonId: compared.body.comparisonId,
      view: "postgame-redacted",
      filter: {
        group: "metric_evidence",
        changedOnly: false,
        promotion: "all",
        evidenceIdentity: "changed",
        numericDelta: "all"
      },
      source: {
        comparisonId: compared.body.comparisonId
      }
    });
    expect(Array.isArray(filtered.body.rows)).toBe(true);
    expect(
      filtered.body.rows.every(
        (row: { evidence?: { onlyBaselineIds?: string[]; onlyCandidateIds?: string[] } }) => {
          const onlyBaseline = row.evidence?.onlyBaselineIds?.length ?? 0;
          const onlyCandidate = row.evidence?.onlyCandidateIds?.length ?? 0;
          return onlyBaseline > 0 || onlyCandidate > 0;
        }
      )
    ).toBe(true);
    expect(JSON.stringify(filtered.body)).not.toContain('"privateInfo"');

    const filteredMarkdown = await requestText(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted&format=markdown&filtered=1&group=metric_evidence&evidenceIdentity=changed`
    );
    expect(filteredMarkdown.status).toBe(200);
    expect(filteredMarkdown.headers.get("content-type") ?? "").toContain("text/markdown");
    expect(filteredMarkdown.text).toContain("# Match Comparison Filtered View");
    expect(filteredMarkdown.text).toContain(compared.body.comparisonId);
    expect(filteredMarkdown.text).toContain("evidenceIdentity=changed");

    const filteredDownload = await requestText(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted&format=json&download=1&filtered=1&group=metric_evidence&evidenceIdentity=changed`
    );
    expect(filteredDownload.status).toBe(200);
    expect(filteredDownload.headers.get("content-disposition") ?? "").toContain("attachment");
    expect(filteredDownload.headers.get("content-disposition") ?? "").toContain("-comparison-filtered.json");
    expect(JSON.parse(filteredDownload.text)).toMatchObject({
      artifactVersion: "harness.match-comparison.filtered.v1",
      kind: "match-comparison-filtered",
      sourceComparisonId: compared.body.comparisonId
    });

    const badGroup = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted&group=private`
    );
    expect(badGroup.status).toBe(400);

    const badNumericDelta = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted&numericDelta=private`
    );
    expect(badNumericDelta.status).toBe(400);
    expect(badNumericDelta.body.error).toContain('numericDelta must be "all" or "changed"');
    expect(badGroup.body.error).toContain('group must be "all", "summary", "metric", or "metric_evidence"');

    const badFormat = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted&format=csv`
    );
    expect(badFormat.status).toBe(400);
    expect(badFormat.body.error).toContain('format must be "json" or "markdown"');

    const unsupported = await requestJson(baseUrl, "GET", `/api/matches/${baseline.id}/compare/${candidate.id}?view=private-chat`);
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error).toContain("Unsupported artifact view");

    const missingCandidate = await requestJson(baseUrl, "GET", `/api/matches/${baseline.id}/compare/missing-candidate?view=postgame-redacted`);
    expect(missingCandidate.status).toBe(404);
    expect(missingCandidate.body).toMatchObject({ error: "match not found" });
  }, 20_000);

  it("keeps explicit full comparisons request-local and gates the comparison registry", async () => {
    const baseline = await createSensitiveStoredMatch("server-full-comparison-local-baseline");
    const candidate = await createSensitiveStoredMatch("server-full-comparison-local-candidate");
    const full = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=full`
    );
    expect(full.status).toBe(200);
    expect(full.body).toMatchObject({
      artifactVersion: "harness.match-comparison.v1",
      kind: "match-comparison",
      view: "full",
      projection: {
        view: "full"
      }
    });
    expect(full.headers.get("cache-control")).toContain("no-store");
    expect(full.headers.get("x-robots-tag")).toContain("noindex");

    const registry = await requestJson(baseUrl, "GET", "/api/comparisons");
    expect(registry.status).toBe(200);
    expect(registry.body.comparisons).toEqual([]);
    expect(JSON.stringify(registry.body)).not.toContain(full.body.comparisonId);

    const fullRegistry = await requestJson(baseUrl, "GET", "/api/comparisons?view=full");
    expect(fullRegistry.status).toBe(200);
    expect(fullRegistry.body.comparisons).toEqual([]);

    const missingSaved = await requestJson(
      baseUrl,
      "GET",
      `/api/comparisons/${encodeURIComponent(full.body.comparisonId)}`
    );
    expect(missingSaved.status).toBe(404);
    expect(missingSaved.body).toEqual({ error: "comparison not found" });
  });

  it("persists safe comparisons to disk and rehydrates the registry after store clear", async () => {
    await close(server);
    clearServerStoreForTests();
    const comparisonArtifactBaseDir = await mkdtemp(path.join(tmpdir(), "werewolf-comparisons-"));
    tempDirs.push(comparisonArtifactBaseDir);
    const app = createServerApp({
      createReasoner: () => fakeReasoner,
      comparisonArtifactBaseDir
    });
    server = await listen(app);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    const baseline = await createSensitiveStoredMatch("server-compare-persist-baseline");
    const candidate = await createSensitiveStoredMatch("server-compare-persist-candidate");
    const compared = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${baseline.id}/compare/${candidate.id}?view=postgame-redacted`
    );
    expect(compared.status).toBe(200);
    expect(compared.body.comparisonId).toEqual(expect.stringMatching(/^match-comparison:[a-f0-9]{24}$/i));

    const stem = String(compared.body.comparisonId).slice("match-comparison:".length);
    const relativeFile = path.join("comparisons", `${stem}.json`);
    const disk = JSON.parse(await readFile(path.join(comparisonArtifactBaseDir, relativeFile), "utf8"));
    expect(disk).toMatchObject({
      artifactVersion: "harness.match-comparison.v1",
      kind: "match-comparison",
      comparisonId: compared.body.comparisonId,
      view: "postgame-redacted"
    });
    const index = JSON.parse(await readFile(path.join(comparisonArtifactBaseDir, "comparisons.index.json"), "utf8"));
    expect(index).toMatchObject({
      artifactVersion: "harness.comparison-artifact-index.v1",
      kind: "comparison-artifact-index",
      comparisons: [
        expect.objectContaining({
          comparisonId: compared.body.comparisonId,
          relativeFile: `comparisons/${stem}.json`,
          rowCount: compared.body.summary.rowCount
        })
      ]
    });
    expect(JSON.stringify(index)).not.toContain(comparisonArtifactBaseDir);

    clearServerStoreForTests();
    const listed = await requestJson(baseUrl, "GET", "/api/comparisons");
    expect(listed.status).toBe(200);
    expect(listed.body.comparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          comparisonId: compared.body.comparisonId,
          view: "postgame-redacted",
          baseline: expect.objectContaining({ matchId: baseline.id, runId: baseline.id }),
          candidate: expect.objectContaining({ matchId: candidate.id, runId: candidate.id })
        })
      ])
    );

    const loaded = await requestJson(
      baseUrl,
      "GET",
      `/api/comparisons/${encodeURIComponent(compared.body.comparisonId)}`
    );
    expect(loaded.status).toBe(200);
    expect(loaded.body).toMatchObject({
      comparisonId: compared.body.comparisonId,
      summary: {
        baselineHash: compared.body.summary.baselineHash,
        candidateHash: compared.body.summary.candidateHash
      }
    });
    expect(JSON.stringify(loaded.body)).not.toContain(comparisonArtifactBaseDir);
  });


  it("redacts provider failure strings from explicit artifact and trajectory routes", async () => {
    const record = await createSensitiveStoredMatch("server-public-redaction-provider-artifact");
    const rawToken = "Bearer artifact-route-token-should-not-appear";
    if (!record.artifact) throw new Error("Expected stored artifact.");
    record.artifact.failureReason = `provider failed with ${rawToken}`;
    const firstStep = record.artifact.trajectory[0];
    if (!firstStep) throw new Error("Expected a committed player step in the real artifact fixture.");
    // Legacy persisted artifacts can contain fields which the current durable
    // schema forbids. Inject them through an unsafe seam to prove that every
    // read/export view strips them rather than relying on current TypeScript
    // shapes to hide a historical leak.
    const unsafeReasonerOutput = firstStep.reasonerOutput as unknown as Record<string, unknown>;
    unsafeReasonerOutput.providerRequestId = "req-opaque-nonsecret-12345";
    unsafeReasonerOutput.retryHistory = [
      {
        attempt: 1,
        retryable: false,
        message: "provider diagnostic: internal routing cluster x17"
      }
    ];
    unsafeReasonerOutput.stream = { enabled: true, completed: true, completedBy: "reader_done" };
    const unsafeTurnTrace = firstStep.turnTrace as unknown as Record<string, unknown>;
    unsafeTurnTrace.providerRequestId = "req-opaque-nonsecret-12345";
    unsafeTurnTrace.retryHistory = [
      {
        attempt: 1,
        retryable: false,
        message: "provider diagnostic: internal routing cluster x17"
      }
    ];
    unsafeTurnTrace.stream = { enabled: true, completed: true, completedBy: "reader_done" };
    saveMatch(record);

    const artifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=full`);
    expect(artifact.status).toBe(200);
    const artifactJson = JSON.stringify(artifact.body);
    expect(artifactJson).not.toContain("artifact-route-token-should-not-appear");
    expect(artifactJson).toContain("Bearer [REDACTED]");
    expect(artifactJson).toContain("privateMemo");
    expect(artifactJson).not.toContain("req-opaque-nonsecret-12345");
    expect(artifactJson).not.toContain("provider diagnostic: internal routing cluster x17");
    expect(artifactJson).not.toContain('"providerRequestId"');
    expect(artifactJson).toContain('"retryHistory"');

    const trajectory = await requestText(baseUrl, "GET", `/api/matches/${record.id}/trajectory.jsonl?view=full`);
    expect(trajectory.status).toBe(200);
    expect(trajectory.text).not.toContain("artifact-route-token-should-not-appear");
    expect(trajectory.text).toContain("Bearer [REDACTED]");
    expect(trajectory.text).not.toContain("req-opaque-nonsecret-12345");
    expect(trajectory.text).not.toContain("provider diagnostic: internal routing cluster x17");
    expect(trajectory.text).not.toContain('"providerRequestId"');
    expect(trajectory.text).toContain('"retryHistory"');

    const projectedArtifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=postgame-redacted`);
    expect(projectedArtifact.status).toBe(200);
    const projectedArtifactJson = JSON.stringify(projectedArtifact.body);
    expect(projectedArtifactJson).not.toContain("req-opaque-nonsecret-12345");
    expect(projectedArtifactJson).not.toContain("provider diagnostic: internal routing cluster x17");
    expect(projectedArtifactJson).not.toContain('"providerRequestId"');
    expect(projectedArtifactJson).not.toContain('"retryHistory"');
    expect(projectedArtifactJson).not.toContain('"stream"');

    const projectedTrajectory = await requestText(
      baseUrl,
      "GET",
      `/api/matches/${record.id}/trajectory.jsonl?view=postgame-redacted`
    );
    expect(projectedTrajectory.status).toBe(200);
    expect(projectedTrajectory.text).not.toContain("req-opaque-nonsecret-12345");
    expect(projectedTrajectory.text).not.toContain("provider diagnostic: internal routing cluster x17");
    expect(projectedTrajectory.text).not.toContain('"providerRequestId"');
    expect(projectedTrajectory.text).not.toContain('"retryHistory"');
    expect(projectedTrajectory.text).not.toContain('"stream"');
  });

  it("sets download disposition for trajectory and optional match artifact downloads", async () => {
    const record = await createSensitiveStoredMatch("server-download-disposition");

    const normalArtifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact?view=truth-redacted`);
    expect(normalArtifact.status).toBe(200);
    expect(normalArtifact.headers.get("content-disposition")).toBeNull();
    expect(normalArtifact.body.projection).toMatchObject({
      view: "truth-redacted",
      privateEvidenceRedacted: true,
      postgameTruthRedacted: true
    });

    const downloadArtifact = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${record.id}/artifact?view=truth-redacted&download=1`
    );
    expect(downloadArtifact.status).toBe(200);
    expect(downloadArtifact.headers.get("content-disposition")).toContain(
      `attachment; filename="${record.id.slice(0, 8)}-match-truth-redacted.json"`
    );

    const trajectory = await requestText(
      baseUrl,
      "GET",
      `/api/matches/${record.id}/trajectory.jsonl?view=truth-redacted`
    );
    expect(trajectory.status).toBe(200);
    expect(trajectory.headers.get("content-disposition")).toContain(
      `attachment; filename="${record.id.slice(0, 8)}-trajectory-truth-redacted.jsonl"`
    );
    expect(trajectory.text).toContain('"artifactVersion"');
    const trajectoryRecords = trajectory.text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const trajectoryJson = JSON.stringify(trajectoryRecords);
    const header = trajectoryRecords.find((line) => line.type === "header");
    const evaluation = trajectoryRecords.find((line) => line.type === "evaluation_report");
    expect(header).not.toHaveProperty("seed");
    expect(header).not.toHaveProperty("runId");
    expect(header).not.toHaveProperty("matchId");
    expect(header).not.toHaveProperty("forkOf");
    expect(evaluation).toMatchObject({ evaluatorIds: [], evaluatorRegistry: [], warnings: [], summary: null });
    expect(trajectoryRecords.some((line) => line.type === "metric")).toBe(false);
    expect(trajectoryJson).not.toContain("werewolf-team");
    expect(trajectoryJson).not.toContain("providerRequestId");
    expect(trajectoryJson).not.toContain("deliveryReceipts");
  });

  it("redacts post-run public summaries while preserving safe counts", async () => {
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
	      provider: {
	        protocol: expect.any(String),
	        configured: expect.any(Boolean)
	      },
	      profileCount: 3,
	      modelCount: 2,
	      nativeSteps: expect.any(Number),
	      committedSteps: expect.any(Number),
	      rejectedSteps: expect.any(Number),
	      evaluation: expect.objectContaining({
	        nativeSteps: expect.any(Number),
	        committedSteps: expect.any(Number),
	        rejectedSteps: expect.any(Number)
	      })
	    });
	    expect(run.body.summary).not.toHaveProperty("profiles");
	    expect(run.body.summary.provider).not.toHaveProperty("endpoint");
	    const publicRunSummary = JSON.stringify(run.body.summary);
	    expect(publicRunSummary).not.toContain("wolf-profile");
	    expect(publicRunSummary).not.toContain('"endpoint"');
	    expect(publicRunSummary).not.toContain('"chatCompletionsUrl"');
	    expect(publicRunSummary).not.toContain('"providerRequestId"');
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
      metricCount: expect.any(Number),
      scorecardEligibleMetricCount: expect.any(Number),
      metricPromotionClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      }),
      scorecardEligibleMetricClassCounts: expect.objectContaining({
        scorecard: expect.any(Number),
        diagnostic: expect.any(Number),
        benchmark_only: expect.any(Number)
      }),
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

  it("serves an ephemeral strict live-public projection before the terminal artifact exists", async () => {
    await close(server);
    let reasonerCalls = 0;
    let enteredSecondDecision!: () => void;
    let releaseSecondDecision!: () => void;
    const secondDecisionEntered = new Promise<void>((resolve) => {
      enteredSecondDecision = resolve;
    });
    const releaseGate = new Promise<void>((resolve) => {
      releaseSecondDecision = resolve;
    });
    const app = createServerApp({
      createReasoner: () => ({
        async think(input) {
          reasonerCalls += 1;
          if (reasonerCalls === 2) {
            enteredSecondDecision();
            await releaseGate;
          }
          return fakeReasoner.think(input);
        }
      })
    });
    server = await listen(app);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await requestJson(baseUrl, "POST", "/api/matches/run", {
        models: ["alpha", "beta"],
        seed: "server-live-public-projection",
        maxTransitions: 4,
        live: true
      });
      expect(started.status).toBe(202);
      expect(started.body).toEqual({
        artifactVersion: "server.match-live-start.v1",
        kind: "match-live-start",
        matchId: expect.any(String),
        lifecycle: "running",
        artifactAvailable: false,
        projection: { view: "live-public", privateEvidenceRedacted: true, postgameTruthRedacted: true }
      });
      const startJson = JSON.stringify(started.body);
      for (const forbidden of [
        "id\":",
        "state",
        "models",
        "role_reveal",
        "nativeSteps",
        "committedSteps",
        "rejectedSteps",
        "trajectorySteps",
        "checkpointCount",
        "profileCount",
        "alpha",
        "beta"
      ]) {
        expect(startJson).not.toContain(forbidden);
      }

      await secondDecisionEntered;
      const live = await requestJson(baseUrl, "GET", `/api/matches/${started.body.matchId}/live`);
      expect(live.status).toBe(200);
      expect(live.headers.get("cache-control")).toContain("no-store");
      expect(live.headers.get("x-content-type-options")).toBe("nosniff");
      expect(live.body).toMatchObject({
        artifactVersion: "server.match-live-projection.v1",
        kind: "match-live-projection",
        matchId: started.body.matchId,
        lifecycle: "running",
        artifactAvailable: false,
        projection: { view: "live-public", privateEvidenceRedacted: true, postgameTruthRedacted: true },
        publicState: { phase: "night" }
      });
      const liveJson = JSON.stringify(live.body);
      for (const forbidden of [
        "role",
        "team",
        "ability",
        "night_wolves",
        "seerInspection",
        "wolfVotes",
        "pendingAction",
        "traceId",
        "batchId",
        "postStateHash",
        "providerRequestId",
        "retryHistory",
        "alpha",
        "beta"
      ]) {
        expect(liveJson).not.toContain(forbidden);
      }
      const unavailableArtifact = await requestJson(baseUrl, "GET", `/api/matches/${started.body.matchId}/artifact?view=truth-redacted`);
      expect(unavailableArtifact.status).toBe(404);

      releaseSecondDecision();
      await waitFor(async () => {
        const terminal = await requestJson(baseUrl, "GET", `/api/matches/${started.body.matchId}/live`);
        return terminal.body.artifactAvailable === true ? terminal : undefined;
      });
      const artifact = await requestJson(baseUrl, "GET", `/api/matches/${started.body.matchId}/artifact?view=postgame-redacted`);
      expect(artifact.status).toBe(200);
    } finally {
      releaseSecondDecision?.();
    }
  });

  it("reports a missing ephemeral frame as running instead of fabricating a failure", async () => {
    const record = createMatchRecord({ seed: "server-live-frame-restart", models: ["alpha"] });
    record.status = "running";
    saveMatch(record);

    const live = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/live`);
    expect(live.status).toBe(200);
    expect(live.body).toEqual({
      artifactVersion: "server.match-live-projection.v1",
      kind: "match-live-projection",
      matchId: record.id,
      lifecycle: "running",
      artifactAvailable: false
    });
    expect(live.body).not.toHaveProperty("publicState");
    expect(live.body).not.toHaveProperty("projection");
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

  it("rejects a withdrawn runtime model before a probe or match can invoke the reasoner or persist state", async () => {
    const rejectedMatch = await requestJson(baseUrl, "POST", "/api/matches/run", {
      models: ["grok-4.5"],
      profiles: [{ id: "withdrawn-profile", model: "grok-4.5", temperature: 0.3 }],
      assignment: { strategy: "profile-rotation" },
      seed: "server-run-withdrawn-model",
      maxTransitions: 1
    });

    expect(rejectedMatch.status).toBe(400);
    expect(rejectedMatch.body).toMatchObject({
      summary: {
        kind: "match",
        ok: false,
        models: ["grok-4.5"],
        failureReason: expect.stringMatching(/unavailable for runtime use/i)
      },
      error: expect.stringMatching(/unavailable for runtime use/i)
    });

    const rejectedProbe = await requestJson(baseUrl, "POST", "/api/harness/probe", { model: "grok-4.5" });
    expect(rejectedProbe.status).toBe(400);
    expect(rejectedProbe.body).toMatchObject({
      summary: {
        kind: "probe",
        ok: false,
        model: "grok-4.5",
        failureReason: expect.stringMatching(/unavailable for runtime use/i)
      },
      error: expect.stringMatching(/unavailable for runtime use/i)
    });

    const matches = await requestJson(baseUrl, "GET", "/api/matches");
    expect(matches.status).toBe(200);
    expect(matches.body).toHaveLength(0);
  });

  it("accepts jointPhaseScheduler parallel and rejects invalid scheduler values", async () => {
    const rejected = await requestJson(baseUrl, "POST", "/api/matches/run", {
      models: ["alpha"],
      profiles: [{ id: "alpha-profile", model: "alpha", temperature: 0.3 }],
      assignment: { strategy: "profile-rotation" },
      seed: "server-run-invalid-joint",
      maxTransitions: 1,
      jointPhaseScheduler: "simultaneous-batch"
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain("jointPhaseScheduler");
    expect(rejected.body.summary.limits.jointPhaseScheduler).toBe("aec-batched-decision");

    const tooLow = await requestJson(baseUrl, "POST", "/api/matches/run", {
      models: ["alpha"],
      profiles: [{ id: "alpha-profile", model: "alpha", temperature: 0.3 }],
      assignment: { strategy: "profile-rotation" },
      seed: "server-run-parallel-too-low",
      maxTransitions: 3,
      jointPhaseScheduler: "parallel"
    });
    expect(tooLow.status).toBe(400);
    expect(tooLow.body.error).toContain("maxTransitions >= 4");
    expect(tooLow.body.summary.limits).toMatchObject({
      maxTransitions: 3,
      jointPhaseScheduler: "parallel"
    });

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
      seed: "server-run-joint-parallel",
      maxTransitions: 4,
      jointPhaseScheduler: "parallel"
    });
    expect([200, 207]).toContain(run.status);
    expect(run.body.summary.limits).toMatchObject({
      maxTransitions: 4,
      jointPhaseScheduler: "parallel"
    });

    const artifact = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${run.body.id}/artifact?view=postgame-redacted`
    );
    expect(artifact.status).toBe(200);
    const killSteps = (artifact.body.socialEpisode?.steps ?? []).filter(
      (step: { action?: { kind?: string }; schedulerMode?: string }) => step.action?.kind === "kill"
    );
    if (killSteps.length > 0) {
      expect(killSteps.every((step: { schedulerMode?: string }) => step.schedulerMode === "parallel")).toBe(true);
    }
  });

  it("defaults jointPhaseScheduler to aec-batched-decision when omitted", async () => {
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
      seed: "server-run-joint-default",
      maxTransitions: 4
    });
    expect([200, 207]).toContain(run.status);
    expect(run.body.summary.limits.jointPhaseScheduler).toBe("aec-batched-decision");

    const artifact = await requestJson(
      baseUrl,
      "GET",
      `/api/matches/${run.body.id}/artifact?view=postgame-redacted`
    );
    expect(artifact.status).toBe(200);
    const killSteps = (artifact.body.socialEpisode?.steps ?? []).filter(
      (step: { action?: { kind?: string }; schedulerMode?: string }) => step.action?.kind === "kill"
    );
    if (killSteps.length > 0) {
      expect(killSteps.every((step: { schedulerMode?: string }) => step.schedulerMode === "aec-batched-decision")).toBe(true);
      expect(killSteps.some((step: { schedulerMode?: string }) => step.schedulerMode === "parallel")).toBe(false);
    }
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
	      environmentValidated: true,
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

  it("keeps persisted failed-match summaries structured without relaying raw provider failure text", async () => {
    const rawToken = "Bearer raw-failed-match-token-should-not-appear";
    const record = await createSensitiveStoredMatch("server-public-failed-match");
    if (!record.artifact) throw new Error("Expected stored artifact.");
    const firstStep = record.artifact.socialEpisode.steps[0];
    if (!firstStep) throw new Error("Expected a native social step.");
    const rawFailure = `upstream failed-match body leaked ${rawToken}`;
    record.artifact.status = "failed";
    record.artifact.socialEpisode.status = "failed";
    record.artifact.failureReason = rawFailure;
    record.artifact.socialEpisode.failureReason = rawFailure;
    record.artifact.socialEpisode.error = rawFailure;
    firstStep.failure = {
      stage: "actor_decide",
      message: rawFailure,
      metadata: {
        model: "alpha",
        actionKind: firstStep.action.kind,
        message: rawFailure,
        traceId: firstStep.traceId,
        providerFailure: {
          failureKind: "http",
          providerStage: "http_response",
          status: 503,
          retryable: true,
          attempts: 1,
          maxAttempts: 2,
          providerRequestId: "failed-public-match-request",
          retryCause: `failed-match retry body leaked ${rawToken}`
        }
      }
    };
    record.error = rawFailure;
    saveMatch(record);

    const detail = await requestJson(baseUrl, "GET", `/api/matches/${record.id}`);
    const detailJson = JSON.stringify(detail.body);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: record.id,
      status: "failed",
      harnessStatus: "failed",
      hasArtifact: true,
      error: expect.stringContaining("Model provider failure"),
      providerFailure: {
        failureKind: "http",
        providerStage: "http_response",
        status: 503,
        attempts: 1,
        maxAttempts: 2
      }
    });
    expect(detailJson).not.toContain("raw-failed-match-token-should-not-appear");
    expect(detailJson).not.toContain("upstream failed-match body leaked");
    expect(detailJson).not.toContain("failed-match retry body leaked");
    expect(detailJson).not.toContain("failed-public-match-request");
    expect(detailJson).not.toContain("retryCause");

    const listed = await requestJson(baseUrl, "GET", "/api/matches");
    const listedJson = JSON.stringify(listed.body);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({
      id: record.id,
      status: "failed",
      harnessStatus: "failed",
      hasArtifact: true,
      error: expect.stringContaining("Model provider failure"),
      providerFailure: expect.objectContaining({
        failureKind: "http",
        status: 503
      })
    });
    expect(listedJson).not.toContain("raw-failed-match-token-should-not-appear");
    expect(listedJson).not.toContain("upstream failed-match body leaked");
    expect(listedJson).not.toContain("failed-match retry body leaked");

    const defaultArtifact = await requestJson(baseUrl, "GET", `/api/matches/${record.id}/artifact`);
    expect(defaultArtifact.status).toBe(200);
    expect(defaultArtifact.body.projection).toMatchObject({ view: "postgame-redacted" });
    expect(JSON.stringify(defaultArtifact.body)).not.toContain("upstream failed-match body leaked");
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
      maxAttempts: 3
    });
    expect(json).not.toContain("raw-provider-token-should-not-appear");
    expect(json).not.toContain("upstream body leaked");
    expect(json).not.toContain("retry body leaked");
    expect(json).not.toContain("failed-public-probe-request");
    expect(json).not.toContain("authorization");
    expect(json).not.toContain("retryCause");

    const matches = await requestJson(baseUrl, "GET", "/api/matches");
    expect(matches.status).toBe(200);
    expect(matches.body).toHaveLength(0);
  });
});

async function createSensitiveStoredMatch(seed: string, reasoner: HarnessReasoner | null = fakeReasoner) {
  const record = createMatchRecord({ seed, models: ["alpha", "beta"] });
  const profiles = profilesFromModels(record.models, 0.3);
  const agents = resolveAgentConfigs(record.state.players, profiles, 0, 0.3);
  const result = await runHarnessMatch({
    initialState: record.state,
    agents,
    reasoner: reasoner ?? undefined,
    maxTransitions: 3,
    recordAgentSnapshots: true
  });
  const artifact = buildMatchArtifact({
    runId: record.id,
    matchId: record.id,
    createdAt: record.createdAt,
    seed: record.state.seed,
    models: record.models,
    profiles,
    resolvedAssignments: describeResolvedAssignments(record.state.players, agents),
    result
  });
  saveMatch({ ...record, artifact });
  const stored = getMatch(record.id);
  if (!stored?.artifact) throw new Error("Expected a validated artifact-backed match.");
  return stored;
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

function assertNoEvidenceRefDescriptions(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoEvidenceRefDescriptions(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "evidenceRefs" && Array.isArray(item)) {
      expect(item.every((ref) => !ref || typeof ref !== "object" || !("description" in ref))).toBe(true);
    }
    assertNoEvidenceRefDescriptions(item);
  }
}

function assertTruthRedactedSocialTopology(episode: any): void {
  expect(episode.channels.length).toBeGreaterThan(0);
  expect(episode.channels.every((channel: any) => channel.kind === "public" && channel.readableBy === "all")).toBe(true);
  expect(episode.profiles).toEqual([]);
  expect(episode.steps).toEqual([]);
  expect(episode.exposureRecords).toEqual([]);
  expect(episode.messages.every((message: any) => message.visibility === "public")).toBe(true);
  expect(
    episode.messages.every((message: any) => episode.channels.some((channel: any) => channel.id === message.channelId))
  ).toBe(true);
  for (const message of episode.messages) {
    expect(message.recipientIds).toEqual([]);
    expect(message).not.toHaveProperty("metadata");
    expect(message).not.toHaveProperty("deliveryReceipts");
    expect(message.speechActs?.every((act: any) => Array.isArray(act.evidenceRefs) && act.evidenceRefs.length === 0)).toBe(true);
  }
  expect(JSON.stringify(episode)).not.toContain("werewolf-team");
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

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for server-owned live projection terminal state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function requestJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    headers: response.headers
  };
}

async function requestText(
  baseUrl: string,
  method: string,
  path: string
): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, { method });
  return {
    status: response.status,
    text: await response.text(),
    headers: response.headers
  };
}
