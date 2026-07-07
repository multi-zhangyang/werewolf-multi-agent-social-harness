import { describe, expect, it } from "vitest";
import { applyCommand, createGame, getPendingActions, livingPlayers } from "../src/core/engine";
import { isAgentPendingAction } from "../src/core/pending";
import type { GameState, PendingAction, PlayerState, Role } from "../src/core/types";

function advanceSystem(state: GameState): GameState {
  let next = state;
  let guard = 0;
  while (guard < 20) {
    const pending = getPendingActions(next);
    if (pending.length !== 1 || pending[0].kind !== "advance") return next;
    next = applyCommand(next, { type: "system.advance", actorId: "system" });
    guard += 1;
  }
  throw new Error("advanceSystem guard exceeded");
}

function playerByRole(state: GameState, role: Role): PlayerState {
  const player = state.players.find((candidate) => candidate.role === role);
  if (!player) throw new Error(`Missing role ${role}`);
  return player;
}

function pendingByKind<K extends PendingAction["kind"]>(state: GameState, kind: K): Extract<PendingAction, { kind: K }>[] {
  return getPendingActions(state).filter((action): action is Extract<PendingAction, { kind: K }> => action.kind === kind);
}

describe("game-core state machine", () => {
  it("runs a night cycle, resolves hunter shot, and resumes day speech", () => {
    let state = createGame({ id: "test-night-hunter", seed: "night-hunter" });
    state = advanceSystem(state);
    expect(state.phase).toBe("night_seer");

    const seerAction = pendingByKind(state, "inspect")[0];
    const firstLegalInspect = seerAction.legalTargetIds[0];
    state = applyCommand(state, { type: "seer.inspect", actorId: seerAction.actorId, targetId: firstLegalInspect });
    expect(state.phase).toBe("night_wolves");

    const hunter = playerByRole(state, "hunter");
    for (const action of pendingByKind(state, "kill")) {
      state = applyCommand(state, { type: "werewolf.killVote", actorId: action.actorId, targetId: hunter.id });
    }
    expect(state.phase).toBe("night_witch");

    const witchAction = pendingByKind(state, "witch")[0];
    state = applyCommand(state, { type: "witch.act", actorId: witchAction.actorId });
    expect(state.phase).toBe("hunter_shot");
    expect(state.pendingHunterId).toBe(hunter.id);

    const wolf = livingPlayers(state).find((player) => player.role === "werewolf");
    expect(wolf).toBeDefined();
    state = applyCommand(state, { type: "hunter.shoot", actorId: hunter.id, targetId: wolf!.id });
    expect(state.phase).toBe("day_speech");
    expect(state.players.find((player) => player.id === hunter.id)?.alive).toBe(false);
    expect(state.players.find((player) => player.id === wolf!.id)?.alive).toBe(false);
  });

  it("requires legal targets and rejects self voting", () => {
    let state = createGame({ id: "test-self-vote", seed: "self-vote" });
    state = advanceSystem(state);
    if (state.phase === "night_seer") {
      const inspect = pendingByKind(state, "inspect")[0];
      state = applyCommand(state, { type: "seer.inspect", actorId: inspect.actorId, targetId: inspect.legalTargetIds[0] });
    }
    for (const kill of pendingByKind(state, "kill")) {
      state = applyCommand(state, { type: "werewolf.killVote", actorId: kill.actorId, targetId: kill.legalTargetIds[0] });
    }
    if (state.phase === "night_witch") {
      const witch = pendingByKind(state, "witch")[0];
      state = applyCommand(state, { type: "witch.act", actorId: witch.actorId, saveTargetId: witch.nightVictimId });
    }
    expect(state.phase).toBe("day_speech");

    while (state.phase === "day_speech") {
      const speech = pendingByKind(state, "speech")[0];
      state = applyCommand(state, {
        type: "speech.submit",
        actorId: speech.actorId,
        text: "我先按公开信息站边，重点看夜晚死亡、发言压力和之后票型，不做无依据身份认定。",
        strategyTags: ["公开信息", "票型"]
      });
    }
    expect(state.phase).toBe("day_vote");
    const vote = pendingByKind(state, "vote")[0];
    expect(() => applyCommand(state, { type: "vote.cast", actorId: vote.actorId, targetId: vote.actorId })).toThrow(
      /cannot vote self/i
    );
  });

  it("exiles the unique top vote target and records public events", () => {
    let state = createGame({ id: "test-exile", seed: "exile" });
    state = advanceSystem(state);
    const seerAction = pendingByKind(state, "inspect")[0];
    state = applyCommand(state, { type: "seer.inspect", actorId: seerAction.actorId, targetId: seerAction.legalTargetIds[0] });

    const villagerTarget = livingPlayers(state).find((player) => player.role === "villager");
    expect(villagerTarget).toBeDefined();
    for (const kill of pendingByKind(state, "kill")) {
      state = applyCommand(state, { type: "werewolf.killVote", actorId: kill.actorId, targetId: villagerTarget!.id });
    }
    const witch = pendingByKind(state, "witch")[0];
    state = applyCommand(state, { type: "witch.act", actorId: witch.actorId, saveTargetId: witch.nightVictimId });

    while (state.phase === "day_speech") {
      const speech = pendingByKind(state, "speech")[0];
      state = applyCommand(state, {
        type: "speech.submit",
        actorId: speech.actorId,
        text: `我是 ${speech.actorId}，先保留身份，建议集中票型验证狼坑，不分票。`,
        strategyTags: ["集中票型"]
      });
    }
    expect(state.phase).toBe("day_vote");

    const wolfTarget = livingPlayers(state).find((player) => player.role === "werewolf");
    expect(wolfTarget).toBeDefined();
    while (state.phase === "day_vote") {
      const vote = pendingByKind(state, "vote")[0];
      if (!vote) break;
      const targetId = vote.legalTargetIds.includes(wolfTarget!.id) ? wolfTarget!.id : vote.legalTargetIds[0];
      state = applyCommand(state, { type: "vote.cast", actorId: vote.actorId, targetId });
    }

    expect(state.phase).not.toBe("day_vote");
    expect(state.deaths.some((death) => death.playerId === wolfTarget!.id && death.reason === "exile")).toBe(true);
    expect(state.events.some((event) => event.type === "vote.cast" && event.visibility === "public")).toBe(true);
  });

  it("does not expose advance actions as agent actions", () => {
    const state = createGame({ id: "test-guard", seed: "guard" });
    const pending = getPendingActions(state);
    expect(pending).toHaveLength(1);
    expect(isAgentPendingAction(pending[0])).toBe(false);
  });
});
