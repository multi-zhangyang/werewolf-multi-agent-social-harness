#!/usr/bin/env node
/**
 * Isolation verification — one character, one agent, one context.
 *
 * Builds two real participant runtimes against a real world (no model calls
 * needed: construction only) and proves, with actual SDK objects, that every
 * agent owns a private session, private mind, private memory store and private
 * context — and that a tool bound to one agent refuses to execute with
 * another agent's context.
 *
 * Usage: npx tsx scripts/verify-isolation.mts
 */
import { createSocietyAgent } from "../src/society/participant.ts";
import { scopedContext } from "../src/society/world.ts";
import { createWorld } from "../src/society/scenarios/index.ts";
import type { AgentProfile } from "../src/society/contracts.ts";

const profile = (id: string, name: string): AgentProfile => ({
  id,
  displayName: name,
  model: "isolation-check-model",
  persona: "verification",
  traits: [],
  values: [],
  goals: ["verify isolation"],
  temperament: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 }
});

const world = createWorld({
  roomId: "room-isolation",
  scenarioId: "prisoners-dilemma",
  profiles: [profile("agent-01", "林默"), profile("agent-02", "苏遥")]
});

const emit = () => undefined;
const base = { apiKey: "verify-only", baseURL: "http://127.0.0.1:9" };
const lin = createSocietyAgent({ profile: profile("agent-01", "林默"), roomId: "room-isolation", world, emit, ...base });
const su = createSocietyAgent({ profile: profile("agent-02", "苏遥"), roomId: "room-isolation", world, emit, ...base });

const checks: Array<[string, boolean]> = [];
const check = (label: string, ok: boolean): void => { checks.push([label, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); };

// 1. One character = one agent: distinct Agent instances.
check("agent instances are distinct", lin.agent !== su.agent);

// 2. Private sessions with distinct ids.
check("sessions are distinct instances", lin.session !== su.session);
check("session ids are distinct", (await lin.session.getSessionId()) !== (await su.session.getSessionId()));

// 3. Private minds: mutating one never touches the other.
check("mind objects are distinct", lin.mind !== su.mind);
lin.mind.mood.pad.pleasure = 0.99;
lin.mind.beliefs.push({ subjectId: "agent-02", proposition: "苏遥是狼", confidence: 0.8, updatedAtTurn: 1, source: "verify" });
check("mind mutation stays private", su.mind.mood.pad.pleasure === 0.08 && su.mind.beliefs.length === 0);

// 4. Private memory stores.
await lin.context.memory.remember({ text: "林默的私密记忆", tags: ["verify"], salience: 1, valence: 0, pad: lin.mind.mood.pad, turn: 1 });
const linMemories = await lin.context.memory.list(10);
const suMemories = await su.context.memory.list(10);
check("memory stores are distinct", linMemories.length === 1 && suMemories.length === 0);

// 5. Private relationship ledgers start from each agent's own view.
check("relationship ledgers are per-agent", lin.mind.relationships.length === 1 && su.mind.relationships.length === 1);

// 6. Tool context binding: a tool owned by 林默 refuses 苏遥's context.
let refused = false;
try {
  scopedContext({ context: { ...su.context, actorId: "agent-02" } }, "agent-01");
} catch (error) {
  refused = error instanceof Error && error.message.includes("CROSS_AGENT_CONTEXT_DETECTED");
}
check("cross-agent tool invocation is refused", refused);

const failures = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failures.length}/${checks.length} isolation checks passed.`);
process.exit(failures.length ? 1 : 0);
