import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentSourceHash } from "../src/agents/provenance";
import { nativeError } from "../src/agents/sdk";
import { loadRegistry } from "../src/society/models";
import { builtinCharacter } from "../src/society/profiles";
import { runtimeCharacter } from "../src/server/routes/runs";
import { modelParticipantFactory } from "../src/runtime/participant";
import { RunService } from "../src/runtime/run";
import { SocietyStore } from "../src/runtime/store";
import { runSpecSchema } from "../src/runtime/types";

// A small autonomous smoke probe, not an effectiveness benchmark or a scripted deception test.
const directory = path.resolve(`data/decision-support-probe-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const sourceHash = agentSourceHash();
const store = new SocietyStore(path.join(directory, "results.sqlite"));
const service = new RunService(store, modelParticipantFactory(loadRegistry("data/model-settings.json")));
const characters = ["builtin-03", "builtin-01"].map(id => runtimeCharacter(builtinCharacter(id)!));
const spec = runSpecSchema.parse({ scenario: "signaling-game", signalingIncentives: "conflicting", rounds: 2, seed: 23, mode: "experiment",
  roster: characters.map(character => ({ characterId: character.id, modelProfileId: "gpt-6-luna" })),
  budgets: { discussionTurns: 2, maxTurns: 8 }, cognition: { requestTimeoutMs: 60000 },
  experiment: { psychology: "hybrid", speaking: "round-robin", relationshipMemory: true } });
const write = (value: unknown) => writeFileSync(path.join(directory, "summary.json"), JSON.stringify(value, null, 2));
write({ sourceHash, spec, status: "starting" });
console.log(JSON.stringify({ directory, sourceHash }));
try {
  const { run } = service.create(spec, characters);
  const progress = setInterval(() => console.log(JSON.stringify({ status: run.status, stage: run.world.stage()?.id, calls: store.cases(run.id).length })), 20000);
  try { await run.settled(); } finally { clearInterval(progress); }
  const cases = store.cases(run.id);
  const minds = characters.map(character => store.cognition(run.id, character.id));
  const toolCounts: Record<string, number> = {};
  for (const record of cases) for (const item of (record.sdkOutput ?? []) as Array<{ type: string; name?: string }>) {
    if (item.type === "function_call" && item.name) toolCounts[item.name] = (toolCounts[item.name] ?? 0) + 1;
  }
  const result = { sourceHash, sourceChanged: agentSourceHash() !== sourceHash, spec, runId: run.id, status: run.status,
    calls: cases.length, toolCounts, failedCalls: cases.filter(record => record.error).map(record => ({ id: record.id, error: record.error })),
    world: run.world.publicState(),
    agents: minds.map(mind => ({ actorId: mind?.actorId, decisions: mind?.decisions.filter(decision => decision.parameters),
      feedback: mind?.memories.flatMap(memory => memory.observation?.comparisons ?? []), reviews: mind?.episodeReviews })),
    interpretation: "One two-round autonomous game. Reports and payoffs are observations, not evidence of reliable deception, optimal play, causal improvement or transfer." };
  write(result);
  console.log(JSON.stringify({ directory, status: result.status, calls: result.calls, toolCounts, failedCalls: result.failedCalls, world: result.world }));
  if (result.status !== "completed" || result.sourceChanged || result.failedCalls.length) process.exitCode = 1;
} catch (error) {
  write({ sourceHash, status: "failed", error: nativeError(error) }); process.exitCode = 1;
  console.error(JSON.stringify({ directory, error: nativeError(error) }));
} finally {
  service.stopAll();
  for (const run of service.live.values()) await run.settled();
  store.close();
}
