import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { SocietyStore } from "../../src/runtime/store";
import { RunService, replayView } from "../../src/runtime/run";
import { runSpecSchema } from "../../src/runtime/types";

it("replays committed events after restart without creating agents or recovering in-flight calls", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "society-v2-replay-")); const file = path.join(directory, "runs.sqlite");
  const store = new SocietyStore(file);
  const service = new RunService(store, () => { throw new Error("No agent should be needed for human sessions"); });
  const characters = ["a", "b"].map(id => ({ id, name: id, persona: "人物", values: [], goals: [], voice: "" }));
  const spec = runSpecSchema.parse({ scenario: "trust-game", roster: characters.map(c => ({ characterId: c.id, human: true })) });
  const { run } = service.create(spec, characters);
  const before = store.events(run.id);
  run.control("stop"); await run.settled();
  store.setStatus(run.id, "running"); store.close();
  const reopened = new SocietyStore(file); expect(reopened.get(run.id)?.status).toBe("running");
  reopened.recoverInterrupted(); const record = reopened.get(run.id)!;
  expect(record.status).toBe("interrupted");
  expect(replayView(record, reopened, { research: true }).events.slice(0, before.length)).toEqual(before);
  expect(reopened.head("society", "a")).toBeUndefined(); reopened.close(); rmSync(directory, { recursive: true });
});
