/**
 * Evidence-weighted belief fusion (Phase 3): a self-reported belief is
 * Jeffrey-conditioned on partially trusted evidence — `b' = r·p + (1−r)·b` —
 * with trust from stated confidence, saturating backing from freshly cited
 * evidence, geometric damping of stale repeats, and Cromwell clamping off
 * the 0/1 endpoints. These tests pin the mechanical contract:
 *
 *  - a confident report with fresh evidence moves the belief most of the way;
 *  - a repeat citing nothing new compounds geometrically, never to certainty;
 *  - low confidence barely moves the belief (no whiplash from single pushes);
 *  - only world resolution writes exact 0/1, and it bypasses the fusion.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { SocialCausalityLedger } from "../../src/society/social/ledger";
import { fuseSelfReport } from "../../src/society/social/ledger";
import type { BeliefUpdateRecord } from "../../src/society/social/contracts";

const ROOM = "room-test";

function ledgerWithTwoActors(): SocialCausalityLedger {
  return new SocialCausalityLedger(ROOM);
}

function historyOf(...evidenceIdGroups: string[][]): BeliefUpdateRecord[] {
  return evidenceIdGroups.map((evidenceIds) => ({
    beliefUpdateId: `update-${Math.random().toString(36).slice(2, 8)}`,
    beliefId: "belief-test",
    ownerCharacterId: "builtin-02",
    propositionId: "prop-test",
    beforeProbability: 0.5,
    afterProbability: 0.6,
    confidence: 0.5,
    addedEvidenceIds: evidenceIds,
    removedEvidenceIds: [],
    reasonCode: "new-observation",
    logicalTime: 1,
    provenance: { sourceKind: "agent-self-report", sourceIds: [], confidence: 0.5, createdAtLogical: 1, schemaVersion: 1 }
  }));
}

it("a confident report with fresh evidence moves most of the way toward the claim", () => {
  const after = fuseSelfReport({
    prior: 0.5,
    reported: 0.9,
    confidence: 0.9,
    evidenceIds: ["ev-1", "ev-2"],
    history: historyOf(["ev-0"])
  });
  assert.ok(after > 0.7, `fresh confident evidence should move substantially (after=${after})`);
  assert.ok(after < 0.9, "but never verbatim-overwrite the claim");
});

it("a repeat citing nothing new compounds geometrically and never reaches certainty", () => {
  // First push, then two stale repeats of the same claim at max confidence.
  const first = fuseSelfReport({ prior: 0.5, reported: 1, confidence: 1, evidenceIds: [], history: historyOf() });
  const second = fuseSelfReport({ prior: first, reported: 1, confidence: 1, evidenceIds: [], history: historyOf([]) });
  const third = fuseSelfReport({ prior: second, reported: 1, confidence: 1, evidenceIds: [], history: historyOf([], []) });
  assert.ok(second > first, "stale repeats still move the belief");
  assert.ok(third - second < second - first, "each stale repeat moves less than the one before (geometric damping)");
  assert.ok(third < 0.98, "no amount of stale repetition can pin a belief at certainty (Cromwell)");
});

it("new evidence after stale repeats lands at full weight again", () => {
  const stale = fuseSelfReport({ prior: 0.5, reported: 0.9, confidence: 0.9, evidenceIds: [], history: historyOf([]) });
  const recovered = fuseSelfReport({ prior: stale, reported: 0.9, confidence: 0.9, evidenceIds: ["ev-new"], history: historyOf([]) });
  assert.ok(recovered - stale > 0.05, `genuinely new evidence must not inherit the repeat damping (delta=${recovered - stale})`);
});

it("a low-confidence report barely moves the belief", () => {
  const after = fuseSelfReport({ prior: 0.5, reported: 1, confidence: 0.2, evidenceIds: ["ev-1", "ev-2"], history: historyOf() });
  assert.ok(after < 0.6, `low certainty cannot whiplash the belief (after=${after})`);
});

it("recordBeliefUpdate fuses instead of overwriting and keeps the chain intact", () => {
  const ledger = ledgerWithTwoActors();
  const first = ledger.recordBeliefUpdate("agent-02", "builtin-02", {
    subjectId: "builtin-01",
    proposition: "他是狼人",
    probability: 0.9,
    confidence: 0.9,
    source: "查验"
  });
  assert.ok(first.afterProbability < 0.9, "the engine tempers the self-report");
  assert.ok(first.afterProbability > 0.5, "but a confident first report still moves the belief up");
  const second = ledger.recordBeliefUpdate("agent-02", "builtin-02", {
    subjectId: "builtin-01",
    proposition: "他是狼人",
    probability: 0.95,
    confidence: 0.9,
    source: "复查"
  });
  assert.equal(second.beforeProbability, first.afterProbability, "chains link before to previous after");
  assert.ok(second.afterProbability >= first.afterProbability, "consistent direction keeps accumulating");
  assert.ok(second.afterProbability <= 0.98, "the belief stays off the absorbing endpoint");
});
