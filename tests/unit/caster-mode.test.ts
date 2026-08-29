/**
 * The caster broadcast surface's mode state machine: the public projection
 * while the game runs, the postgame reveal once it ends — one-way, and with
 * no omniscient or agent-pov state anywhere in its state space.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { casterModeFor } from "@/components/society/caster-view";

describe("casterModeFor — the broadcast seat's only mode transition", () => {
  it("stays on the public projection while the game runs", () => {
    assert.equal(casterModeFor(false), "public");
  });

  it("switches to the postgame reveal once the game ends", () => {
    assert.equal(casterModeFor(true), "postgame");
  });

  it("never offers an omniscient or agent-pov state", () => {
    const reachable: Set<string> = new Set([casterModeFor(false), casterModeFor(true)]);
    assert.ok(reachable.has("public"));
    assert.ok(reachable.has("postgame"));
    assert.equal(reachable.size, 2);
    assert.equal(reachable.has("omniscient"), false);
    assert.equal(reachable.has("agent-pov"), false);
  });
});
