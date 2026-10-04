import { expect, it } from "vitest";
import { reconcileRun } from "../../src/components/interaction/run-snapshot";
import { selectActivities } from "../../src/runtime/behavior";
import type { RunView } from "../../src/components/interaction/api";

it("keeps existing event identity and skips identical snapshots without retaining removed private records", () => {
  const previous = { id: "r", events: [{ id: "e", seq: 1 }, { id: "private", seq: 2 }], characters: [{ id: "a" }], memories: [], status: "running" } as unknown as RunView;
  expect(reconcileRun(previous, structuredClone(previous))).toBe(previous);
  const current = reconcileRun(previous, { ...structuredClone(previous), events: [{ id: "e", seq: 1 }, { id: "new", seq: 3 }] } as RunView);
  expect(current.events[0]).toBe(previous.events[0]);
  expect(current.characters).toBe(previous.characters);
  expect(current.events.some(e => e.id === "private")).toBe(false);
});

it("updates a tool card in place through start, end and rejection", () => {
  const event = (kind: string, n: number) => ({ id: `e${n}`, seq: n, runId: "r", at: "", text: "sdk-harness", type: "trace" as const, visibility: "research" as const, data: { harness: true, kind, opportunityId: "o", phase: "action", attempt: 1, step: 1, callId: "c", toolName: "invest" } });
  const first = selectActivities([event("tool_start", 1)])[0];
  const last = selectActivities([event("tool_start", 1), event("tool_rejected", 2), event("tool_error", 3)])[0];
  expect(last.id).toBe(first.id); expect(last.seq).toBe(first.seq); expect(last.data.kind).toBe("tool_error");
});
