/**
 * Byte-budgeted rolling windows (§31): `world.*-frame` envelopes embed full
 * snapshots, so the SSE backlog and the replay anchors are capped by count
 * AND serialized bytes. A count-only cap let single checkpoints exceed
 * 300MB; these tests pin the trimming contract.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { EnvelopeWindow } from "../../src/society/envelope-window";

function windowOf(maxCount: number, maxBytes: number, minKeep: number): EnvelopeWindow<number> {
  return new EnvelopeWindow<number>({ maxCount, maxBytes, minKeep }, (value) => value);
}

describe("envelope window budgets", () => {
  it("trims by count, keeping the newest entries", () => {
    const win = windowOf(3, Number.POSITIVE_INFINITY, 1);
    for (let i = 1; i <= 10; i += 1) win.push(i);
    assert.deepEqual(win.toArray(), [8, 9, 10]);
    assert.equal(win.length, 3);
    assert.equal(win.last(), 10);
  });

  it("trims by bytes once minKeep is covered", () => {
    const win = windowOf(100, 10, 2);
    // Entries of size 4: two fit the budget, older ones fall off the front.
    for (let i = 1; i <= 8; i += 1) win.push(4);
    assert.deepEqual(win.toArray(), [4, 4]);
    // A burst of large entries still leaves the newest two, never fewer.
    win.push(1000);
    win.push(1000);
    assert.deepEqual(win.toArray(), [1000, 1000]);
  });

  it("never trims below minKeep even when every entry exceeds the byte budget", () => {
    const win = windowOf(10, 1, 3);
    for (let i = 1; i <= 6; i += 1) win.push(50);
    assert.deepEqual(win.toArray(), [50, 50, 50]);
  });

  it("pushAll applies the same budget as push", () => {
    const win = windowOf(4, Number.POSITIVE_INFINITY, 1);
    win.pushAll([1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(win.toArray(), [4, 5, 6, 7]);
  });

  it("survives head compaction after many trims (no stale entries leak back)", () => {
    const win = windowOf(2, Number.POSITIVE_INFINITY, 1);
    for (let i = 1; i <= 2000; i += 1) win.push(i);
    assert.deepEqual(win.toArray(), [1999, 2000]);
    win.push(2001);
    assert.deepEqual(win.toArray(), [2000, 2001]);
  });

  it("an empty window reports undefined last and an empty array", () => {
    const win = windowOf(3, 100, 1);
    assert.equal(win.last(), undefined);
    assert.deepEqual(win.toArray(), []);
    assert.equal(win.length, 0);
  });
});
