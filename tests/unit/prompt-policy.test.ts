/**
 * Prompt-policy checks (AGENTS.md §5.5 / §14.10 / §26.4): the shared protocol
 * floor must stay strategy-neutral. Suspicion, defection and deception may
 * never be demanded globally — they must arise from persona, temperament,
 * relationships and history. Pure text assertions on the exported protocol
 * block; no model calls.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { protocolInstructions } from "../../src/society/participant";

const text = protocolInstructions().join("\n");

it("drops the global cheap-talk presumption (§14.10)", () => {
  assert.ok(!/cheap talk/i.test(text), "no promise is globally framed as cheap talk");
  assert.ok(!/every promise/i.test(text), "no blanket rule over every promise");
  assert.ok(!/trust is earned slowly and destroyed quickly/i.test(text), "no asymmetric-trust directive");
});

it("drops the global defection tilt (§14.10)", () => {
  assert.ok(!/weigh defection actively/i.test(text), "no directive to weigh defection actively");
  assert.ok(!/defaulting to cooperation/i.test(text), "cooperation is not framed as the fallback");
});

it("drops the must-log-your-lies framing (§14.10)", () => {
  assert.ok(!/sloppy/i.test(text), "no shaming for unlogged deceptions");
  assert.ok(!/unlogged/i.test(text), "logging is optional, not a demand");
});

it("keeps the §5.5 protocol floor", () => {
  assert.ok(/Maintain your own goals, memory, beliefs about others, emotion, and relationships across turns/.test(text), "identity continuity stays");
  assert.ok(/All speech and all actions that change the world must use tools/.test(text), "the tool protocol stays");
  assert.ok(/Never claim an action happened unless its tool completed/.test(text), "no fabricated observations");
  assert.ok(/Do not reveal private role information unless doing so serves your strategy/.test(text), "the information boundary stays");
  assert.ok(/You may stay silent when there is nothing worth saying/.test(text), "silence stays a real choice");
  assert.ok(/Do not output hidden chain-of-thought/.test(text), "no hidden reasoning exposure");
});

it("keeps bookkeeping guidance without strategy conclusions", () => {
  assert.ok(/role inferences as probabilities/.test(text), "probability bookkeeping stays");
  assert.ok(/log_deception_plan/.test(text), "deception logging stays available as a consistency tool");
  assert.ok(!/you must (lie|deceive|betray|defect)/i.test(text), "no demanded deception or defection");
});