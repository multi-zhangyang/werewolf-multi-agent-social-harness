/**
 * World serialization round-trip checks (recovery suite). Pins restart
 * recovery: every scenario's exported state must rehydrate an identical
 * world — same snapshot, same re-export. No model calls, no network.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { ALL_SCENARIOS, SCENARIO_METADATA, createWorld } from "../../src/society/scenarios";
import { createAgentProfiles } from "../../src/society/profiles";
import type { ScenarioId } from "../../src/society/contracts";

function check(name: string, fn: () => void): void {
  it(name, fn);
}

function seatsFor(scenarioId: ScenarioId): number {
  const meta = SCENARIO_METADATA[scenarioId];
  return meta.playerRange ? meta.playerRange.min : meta.players;
}

check("every scenario round-trips its serialized state", () => {
  for (const meta of ALL_SCENARIOS) {
    const seats = seatsFor(meta.id);
    const profiles = createAgentProfiles(["model-a"], seats);
    const first = createWorld({ roomId: "room-t", scenarioId: meta.id, profiles, rounds: meta.minRounds });
    first.start();
    // Exercise a little real state where the world allows it without models:
    // a start log and statuses exist in every world.
    const state = first.exportState();
    assert.equal(state.scenarioId, meta.id, `${meta.id} state is self-labeled`);
    const second = createWorld({ roomId: "room-t", scenarioId: meta.id, profiles, rounds: meta.minRounds, state });
    assert.equal(second.snapshot().status, "paused", `${meta.id} recovers held (paused)`);
    second.start();
    assert.equal(JSON.stringify(second.snapshot()), JSON.stringify(first.snapshot()), `${meta.id} snapshot survives restore`);
    assert.equal(JSON.stringify(second.exportState()), JSON.stringify(first.exportState()), `${meta.id} re-export is stable`);
  }
});

check("restored worlds are held paused and resume cleanly", () => {
  const profiles = createAgentProfiles(["model-a"], 2);
  const first = createWorld({ roomId: "room-t", scenarioId: "prisoners-dilemma", profiles, rounds: 3 });
  first.start();
  const state = first.exportState();
  const restored = createWorld({ roomId: "room-t", scenarioId: "prisoners-dilemma", profiles, rounds: 3, state });
  assert.equal(restored.snapshot().status, "paused", "recovered worlds come back held");
  restored.start();
  assert.equal(restored.snapshot().status, "running", "resume restarts the world");
});

check("state mismatch across scenarios is refused loudly", () => {
  const profiles = createAgentProfiles(["model-a"], 2);
  const pd = createWorld({ roomId: "r", scenarioId: "prisoners-dilemma", profiles, rounds: 3 });
  pd.start();
  const state = pd.exportState();
  assert.throws(
    () => createWorld({ roomId: "r", scenarioId: "ultimatum-game", profiles, rounds: 3, state }),
    /SCENARIO_STATE_MISMATCH/
  );
});