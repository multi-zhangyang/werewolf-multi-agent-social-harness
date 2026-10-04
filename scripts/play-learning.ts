import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { activeMemories, memoryOriginEpisode } from "../src/agents/cognition";
import { snapshotAgentSource } from "../src/agents/provenance";
import { nativeError } from "../src/agents/sdk";
import { RunService } from "../src/runtime/run";
import { SocietyStore } from "../src/runtime/store";
import { modelParticipantFactory } from "../src/runtime/participant";
import { runSpecSchema } from "../src/runtime/types";
import { builtinCharacters } from "../src/society/profiles";
import { loadRegistry } from "../src/society/models/registry";
import { runtimeCharacter } from "../src/server/routes/runs";
import { importGeneralResults } from "./import-general-results";

const source = path.resolve(process.argv[2] ?? "data/episode-review-validation-1791070192853");
const directory = path.resolve(process.argv[3] ?? `data/learning-play-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2));
const sourceHash = snapshotAgentSource(path.join(directory, "source"));
const databaseFile = path.join(directory, "results.sqlite");
const store = new SocietyStore(databaseFile);
importGeneralResults(path.join(source, "results.sqlite"), databaseFile);
const registry = loadRegistry();
const service = new RunService(store, modelParticipantFactory(registry));
const schedule = [
  { scenario: "trust-game" as const, seed: 23, sourceRunId: "acf1025e-49e4-4844-8667-8902b4a0c3a4", ids: ["builtin-01", "builtin-03"] },
  { scenario: "public-goods" as const, seed: 41, sourceRunId: "93496278-4838-46bb-aab0-a0cbd4423d14", ids: ["builtin-03", "builtin-01", "builtin-02"] },
];
write("manifest.json", { sourceHash, source, schedule, rounds: 2, discussionTurns: 2,
  purpose: "Two short production runs with fixed inherited experience. Practical behavior check, separate from earlier research gates.", createdAt: new Date().toISOString() });
const results: unknown[] = [];
try {
  for (const condition of schedule) {
    const characters = condition.ids.map(id => runtimeCharacter(builtinCharacters().find(character => character.id === id)!));
    const initialSnapshots = Object.fromEntries(condition.ids.flatMap(id => {
      const snapshot = store.snapshots(id).find(item => item.runId === condition.sourceRunId);
      return snapshot ? [[id, snapshot.id]] : [];
    }));
    const spec = runSpecSchema.parse({ scenario: condition.scenario, mode: "experiment", worldId: "learning-play", initialSnapshots,
      roster: characters.map(character => ({ characterId: character.id, modelProfileId: "gpt-6-luna" })), seed: condition.seed, rounds: 2,
      budgets: { discussionTurns: 2, maxTurns: 8 }, cognition: { requestTimeoutMs: 60000 } });
    const { run } = service.create(spec, characters);
    console.log(JSON.stringify({ started: condition.scenario, runId: run.id }));
    await run.settled();
    const cases = store.cases(run.id);
    const minds = characters.flatMap(character => store.cognition(run.id, character.id) ?? []);
    const result = { scenario: condition.scenario, runId: run.id, status: run.status, calls: cases.length,
      failedCalls: cases.filter(record => record.error).length,
      toolErrors: store.events(run.id).filter(event => event.data.kind === "tool_error").length,
      scores: run.world.publicState().scores,
      actors: minds.map(mind => ({ actorId: mind.actorId,
        inheritedStrategies: activeMemories(mind).filter(memory => memory.kind === "procedural" && memoryOriginEpisode(memory) !== run.id).length,
        assessments: mind.strategyAssessments?.filter(item => item.episode === run.id).map(item => ({ verdict: item.verdict,
          matching: item.matching, differences: item.differences, adaptation: item.adaptation, actions: item.decisionIds.length, feedback: item.feedback })),
        review: mind.episodeReviews?.find(item => item.episode === run.id) })) };
    results.push(result); write("results.json", { sourceHash, results }); console.log(JSON.stringify(result));
  }
} catch (error) { write("error.json", { message: nativeError(error) }); process.exitCode = 1; }
finally { service.stopAll(); await Promise.allSettled([...service.live.values()].map(run => run.settled())); store.close(); }
write("results.json", { sourceHash, results, finishedAt: new Date().toISOString() });
