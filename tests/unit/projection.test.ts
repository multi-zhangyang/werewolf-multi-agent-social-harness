/**
 * Spectator projection checks: the hard information boundary between
 * omniscient, public and agent-pov seats, plus the world-level role
 * visibility, must never leak private cognition or hidden identities.
 */
import { strict as assert } from "node:assert";
import { it } from "vitest";
import { createWorld } from "../../src/society/scenarios";
import { projectEventFor, type SpectatorViewer } from "../../src/society/spectator/projection";
import type { AgentRuntimeEvent, AgentProfile, SocialMessage } from "../../src/society/contracts";

function check(name: string, fn: () => void): void {
  it(name, fn);
}

function profiles(count: number): AgentProfile[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `agent-${String(index + 1).padStart(2, "0")}`,
    displayName: `P${index + 1}`,
    characterId: `char-test-${index + 1}`,
    persona: "test",
    traits: [],
    values: [],
    goals: [],
    temperament: undefined,
    decisionBiases: [],
    voice: "",
    model: "test",
    controller: "agent"
  }));
}

const at = new Date().toISOString();

function message(senderId: string, channel: "public" | "private" | "team", recipientIds: string[] = []): AgentRuntimeEvent {
  return {
    type: "agent.message",
    roomId: "r",
    message: {
      id: `m-${senderId}-${channel}`,
      roomId: "r",
      senderId,
      senderName: senderId,
      channel,
      text: "hello",
      turn: 1,
      phase: "discussion",
      createdAt: at,
      ...(recipientIds.length ? { recipientIds } : {})
    } satisfies SocialMessage
  } satisfies AgentRuntimeEvent;
}

const reasoning: AgentRuntimeEvent = { type: "agent.reasoning", roomId: "r", actorId: "agent-01", delta: "secret", at };
const thought: AgentRuntimeEvent = {
  type: "agent.thought-beat",
  roomId: "r",
  actorId: "agent-01",
  beat: { id: "b1", roomId: "r", agentId: "agent-01", activationId: "a", kind: "doubt", title: "t", summary: "s", visibility: "private", createdAt: at },
  at
};
const pressure: AgentRuntimeEvent = {
  type: "agent.context.pressure",
  roomId: "r",
  actorId: "agent-01",
  level: "soft-compact",
  pressureRatio: 0.8,
  usableInputTokens: 1000,
  currentInputTokens: 800,
  contextWindow: 2000,
  at
};
const tool: AgentRuntimeEvent = { type: "agent.tool", roomId: "r", actorId: "agent-01", toolCallId: "t1", toolName: "investigate_identity", phase: "succeeded", at };
const publicTool: AgentRuntimeEvent = { type: "agent.tool", roomId: "r", actorId: "agent-01", toolCallId: "t2", toolName: "communicate", phase: "succeeded", at };
const worldAction: AgentRuntimeEvent = { type: "world.action", roomId: "r", actorId: "agent-01", action: "cast_day_vote", detail: "x", at };
const publicAction: AgentRuntimeEvent = { type: "world.action", roomId: "r", actorId: "agent-01", action: "message", detail: "x", at };
const cue: AgentRuntimeEvent = { type: "cinematic.cue", roomId: "r", cue: { id: "c1", roomId: "r", camera: "wide-table", title: "t", priority: 5, focusAgentIds: [], minimumDurationMs: 1000, maximumDurationMs: 2000, skippable: true, sourceEventIds: [], createdAt: at }, at };

const omniscient: SpectatorViewer = { mode: "omniscient" };
const publicView: SpectatorViewer = { mode: "public" };
const pov01: SpectatorViewer = { mode: "agent-pov", agentId: "agent-01" };
const privilegedPublic: SpectatorViewer = { mode: "public", privileged: true };
const postgameView: SpectatorViewer = { mode: "postgame" };
const notice: AgentRuntimeEvent = { type: "runtime.notice", roomId: "r", actorId: "agent-01", category: "reasoning", severity: "warning", code: "TEST", message: "m", at };
const sealedDelta: AgentRuntimeEvent = { type: "agent.delta", roomId: "r", actorId: "agent-01", delta: "hidden choice draft", sealed: true, at };

check("omniscient passes everything through unchanged", () => {
  // Legacy raw provider reasoning is never viewer-facing (§12), even for the
  // omniscient seat; every other event type passes through unchanged.
  for (const event of [thought, pressure, tool, worldAction, cue]) {
    assert.equal(projectEventFor(event, omniscient), event, event.type);
  }
  assert.equal(projectEventFor(reasoning, omniscient), undefined, "raw reasoning never projects");
});

check("public seat never receives private cognition; tool pulses arrive redacted", () => {
  assert.equal(projectEventFor(reasoning, publicView), undefined);
  assert.equal(projectEventFor(thought, publicView), undefined);
  assert.equal(projectEventFor(pressure, publicView), undefined);
  // Open phases keep the "a binding action is running" pulse public, but the
  // tool identity and summaries are privileged (they hint at strategies).
  const pulse = projectEventFor(tool, publicView);
  assert.ok(pulse && pulse.type === "agent.tool", "unsealed tool becomes an activity pulse");
  assert.equal((pulse as { toolName: string }).toolName, "", "tool names stay private in public");
  assert.equal((pulse as { label?: string }).label, undefined);
  assert.equal((pulse as { safeInputSummary?: string }).safeInputSummary, undefined);
  assert.equal((pulse as { safeOutputSummary?: string }).safeOutputSummary, undefined);
  assert.equal(projectEventFor(publicTool, publicView)?.type, "agent.tool");
  assert.equal(
    projectEventFor({ ...tool, sealed: true }, publicView),
    undefined,
    "sealed-phase tools stay hidden entirely"
  );
  assert.equal(projectEventFor(worldAction, publicView), undefined, "hidden world actions stay hidden");
  assert.equal(projectEventFor(publicAction, publicView), publicAction, "public actions flow");
  assert.equal(projectEventFor(cue, publicView), cue, "cues stay visible");
});

check("agent-pov seat only sees the watched agent's private events", () => {
  // Raw provider reasoning stays unprojectable even in its own POV; the
  // bounded reasoning-summary/thought-beat paths are the private interface.
  assert.equal(projectEventFor(reasoning, pov01), undefined, "raw reasoning never projects");
  assert.equal(projectEventFor(thought, pov01), thought);
  assert.equal(projectEventFor(pressure, pov01), pressure);
  assert.equal(projectEventFor(tool, pov01), tool);
  assert.equal(projectEventFor(cue, pov01), cue);
});

check("agent-pov message boundary: public, own, addressed-to — nothing else", () => {
  assert.equal(projectEventFor(message("agent-02", "public"), pov01)?.type, "agent.message", "public speech visible");
  assert.equal(projectEventFor(message("agent-01", "private", ["agent-02"]), pov01)?.type, "agent.message", "own private mail visible");
  assert.equal(projectEventFor(message("agent-02", "private", ["agent-01"]), pov01)?.type, "agent.message", "mail addressed to the watched agent visible");
  assert.equal(projectEventFor(message("agent-02", "private", ["agent-03"]), pov01), undefined, "others' private exchanges hidden");
  assert.equal(projectEventFor(message("agent-02", "team", []), pov01), undefined, "team channel hidden from non-recipients");
});

check("caster broadcast seat: privileged credentials riding a public request never widen the boundary", () => {
  // The caster window is popped out from the operator's browser, so it rides
  // the stored owner token / cookie. The granted mode — not the credential —
  // is what filters the stream: everything the anonymous public seat cannot
  // see, the authenticated caster seat cannot see either.
  assert.equal(projectEventFor(thought, privilegedPublic), undefined, "thought-beats stay private");
  assert.equal(projectEventFor(pressure, privilegedPublic), undefined, "context pressure stays private");
  assert.equal(projectEventFor(sealedDelta, privilegedPublic), undefined, "sealed token streams never cross the public seat");
  assert.equal(projectEventFor({ ...tool, sealed: true }, privilegedPublic), undefined, "sealed-phase tools stay hidden");
  const pulse = projectEventFor(tool, privilegedPublic);
  assert.ok(pulse && pulse.type === "agent.tool", "open-phase tools remain an anonymous activity pulse");
  assert.equal((pulse as { toolName: string }).toolName, "");
  assert.equal(projectEventFor(worldAction, privilegedPublic), undefined, "hidden world actions stay hidden");
  // Runtime notices are the one privilege-visible family in public mode —
  // operational noise the caster view suppresses client-side (silentNotices).
  assert.equal(projectEventFor(notice, privilegedPublic)?.type, "runtime.notice");
  assert.equal(projectEventFor(notice, publicView), undefined, "anonymous public seat gets no notices");
});

check("caster reveal: postgame flows the full transcript but never private minds", () => {
  assert.equal(projectEventFor(thought, postgameView), undefined, "cognition stays hidden even postgame");
  assert.equal(projectEventFor(pressure, postgameView), undefined);
  assert.equal(projectEventFor(sealedDelta, postgameView), undefined, "sealed streams stay sealed in replay");
  assert.equal(projectEventFor(cue, postgameView), cue, "cues flow for the reveal");
});

check("werewolf world hides roles from the public projection and shows wolf teammates to wolves", () => {
  const world = createWorld({ roomId: "r-ww", scenarioId: "werewolf", profiles: profiles(6), rounds: 2 });
  world.start();
  const internal = world.snapshot();
  const roles = new Map<string, string>(Object.entries((internal.details.roles ?? {}) as Record<string, string>));
  const wolves = [...roles].filter(([, role]) => role === "wolf").map(([id]) => id);
  const publicSnap = world.snapshotFor();
  for (const agent of publicSnap.agents) {
    assert.equal((agent as { observerRole?: string }).observerRole, undefined, "public snapshot must not carry observer roles");
  }
  const wolfView = world.snapshotFor(wolves[0]);
  const wolfSeenRoles = wolfView.agents.filter((agent) => (agent as { observerRole?: string }).observerRole);
  assert.equal(wolfSeenRoles.length, wolves.length, "a wolf sees exactly the wolf team");
  const villagerId = [...roles].find(([, role]) => role === "villager")![0];
  const villagerView = world.snapshotFor(villagerId);
  const villagerSeen = villagerView.agents.filter((agent) => (agent as { observerRole?: string }).observerRole);
  assert.equal(villagerSeen.length, 1, "a villager sees only their own role");
  assert.equal(villagerSeen[0].id, villagerId, "and it is their own");
});