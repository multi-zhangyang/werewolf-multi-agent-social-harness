import { createGame } from "../src/core/engine";
import { buildMatchArtifact } from "../src/harness/artifacts";
import { describeResolvedAssignments, profilesFromModels, resolveAgentConfigs } from "../src/harness/profiles";
import { runHarnessMatch } from "../src/harness/runtime";
import type { HarnessReasoner } from "../src/harness/types";
import { createServerApp } from "../src/server/index";
import { clearServerStoreForTests, getMatch, saveMatch } from "../src/server/store";

const fixtureMatchId = "fixture-match-001";
const fixtureCandidateMatchId = "fixture-match-002";
const fixturePort = Number(process.env.E2E_FIXTURE_PORT ?? 4173);

const fixtureReasoner: HarnessReasoner = {
  async think(input) {
    const content =
      input.action.kind === "speech"
        ? `fixture public speech ${input.traceId}`
        : `fixture private memo ${input.agent.model}/${input.action.kind}`;
    return {
      content,
      completion: {
        content,
        latencyMs: 1,
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        providerRequestId: `fixture-${input.traceId}`,
        attempts: 1
      }
    };
  }
};

async function main(): Promise<void> {
  configureFixtureRuntime();
  clearServerStoreForTests();
  await seedFixtureMatch(fixtureMatchId, "fixture-seed-a");
  await seedFixtureMatch(fixtureCandidateMatchId, "fixture-seed-b");

  const app = createServerApp({
    createReasoner: () => fixtureReasoner,
    artifactAccessBindHost: "127.0.0.1"
  });
  const server = app.listen(fixturePort, "127.0.0.1", () => {
    console.log(`Cockpit fixture server listening on http://127.0.0.1:${fixturePort}`);
  });
  const shutdown = () => {
    server.close(() => {
      clearServerStoreForTests();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function configureFixtureRuntime(): void {
  // The fixture is deliberately isolated from configured live providers.
  for (const key of [
    "LLM_API_KEY",
    "ANTHROPIC_API_KEY",
    "LLM_CHAT_COMPLETIONS_URL",
    "LLM_BASE_URL",
    "LLM_RESPONSES_URL",
    "ANTHROPIC_MESSAGES_URL",
    "ANTHROPIC_MAX_TOKENS",
    "MATCH_ARTIFACT_BASE_DIR",
    "CHECKPOINT_ARTIFACT_BASE_DIR",
    "TOURNAMENT_ARTIFACT_BASE_DIR",
    "MATRIX_ARTIFACT_BASE_DIR",
    "COMPARISON_ARTIFACT_BASE_DIR"
  ]) {
    delete process.env[key];
  }
  process.env.LLM_PROVIDER_PROTOCOL = "openai-chat-completions";
  process.env.LLM_MODELS = "fixture-model";
}

async function seedFixtureMatch(id: string, seed: string): Promise<void> {
  const createdAt = "2026-07-20T00:00:00.000Z";
  const models = ["fixture-model"];
  const initialState = createGame({ id, seed });
  const profiles = profilesFromModels(models, 0.2);
  const agents = resolveAgentConfigs(initialState.players, profiles, 0, 0.2);
  const result = await runHarnessMatch({
    initialState,
    agents,
    reasoner: fixtureReasoner,
    // Four transitions cross the first resolved night boundary so the fixture
    // contains at least one server-owned public ledger event and replay link.
    maxTransitions: 4,
    recordAgentSnapshots: true
  });
  const artifact = buildMatchArtifact({
    runId: id,
    matchId: id,
    createdAt,
    seed: initialState.seed,
    models,
    profiles,
    resolvedAssignments: describeResolvedAssignments(initialState.players, agents),
    result
  });
  saveMatch({
    id,
    createdAt,
    state: initialState,
    models,
    status: "completed",
    artifact
  });
  if (!getMatch(id)?.artifact) {
    throw new Error(`Fixture match artifact was not stored: ${id}`);
  }
}

void main().catch((error: unknown) => {
  console.error("Cockpit fixture server failed to start.", error);
  process.exitCode = 1;
});
