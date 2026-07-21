import { describe, expect, it } from "vitest";
import { applyCommand, createGame, getPendingActions, livingPlayers } from "../src/core/engine";
import { isAgentPendingAction } from "../src/core/pending";
import { createPlayerView, serializePublicState } from "../src/core/view";
import { hashStableState } from "../src/harness/hash";
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
    let state = createGame({ id: "test-night-hunter", seed: "night-hunter", config: { lastWords: "none" } });
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

  it("runs a public day-one sheriff election and makes the elected vote weight effective", () => {
    let state = createGame({
      id: "test-sheriff-election",
      seed: "sheriff-election",
      config: { sheriff: "day1", sheriffVoteWeight: 1.5, lastWords: "none" }
    });
    state = advanceSystem(state);
    const inspect = pendingByKind(state, "inspect")[0];
    state = applyCommand(state, { type: "seer.inspect", actorId: inspect.actorId, targetId: inspect.legalTargetIds[0] });
    const nightTarget = pendingByKind(state, "kill")[0].legalTargetIds[0];
    for (const kill of pendingByKind(state, "kill")) {
      state = applyCommand(state, { type: "werewolf.killVote", actorId: kill.actorId, targetId: nightTarget });
    }
    const witch = pendingByKind(state, "witch")[0];
    state = applyCommand(state, { type: "witch.act", actorId: witch.actorId, saveTargetId: witch.nightVictimId });

    expect(state.phase).toBe("sheriff_vote");
    const sheriff = pendingByKind(state, "sheriff_vote")[0].legalTargetIds[0];
    while (state.phase === "sheriff_vote") {
      const ballot = pendingByKind(state, "sheriff_vote")[0];
      state = applyCommand(state, { type: "sheriff.vote", actorId: ballot.actorId, targetId: sheriff });
    }

    expect(state.phase).toBe("day_speech");
    expect(state.players.find((player) => player.id === sheriff)?.isSheriff).toBe(true);
    expect(state.events.some((event) => event.type === "sheriff.elected" && (event.payload as { winnerId?: string }).winnerId === sheriff)).toBe(true);

    while (state.phase === "day_speech") {
      const speech = pendingByKind(state, "speech")[0];
      state = applyCommand(state, { type: "speech.submit", actorId: speech.actorId, text: "按公开信息完成发言，等待投票检验。" });
    }
    const sheriffVote = pendingByKind(state, "vote").find((vote) => vote.actorId === sheriff);
    expect(sheriffVote).toBeDefined();
    state = applyCommand(state, { type: "vote.cast", actorId: sheriffVote!.actorId, targetId: sheriffVote!.legalTargetIds[0] });
    expect(state.votes.at(-1)?.weight).toBe(1.5);
    expect(state.votes.at(-1)?.kind).toBe("exile");
  });

  it("queues exactly one public last-words turn after an eligible night death", () => {
    let state = createGame({ id: "test-last-words", seed: "last-words", config: { sheriff: "off", lastWords: "all" } });
    state = advanceSystem(state);
    const inspect = pendingByKind(state, "inspect")[0];
    state = applyCommand(state, { type: "seer.inspect", actorId: inspect.actorId, targetId: inspect.legalTargetIds[0] });
    const victim = livingPlayers(state).find((player) => player.role === "villager");
    expect(victim).toBeDefined();
    for (const kill of pendingByKind(state, "kill")) {
      state = applyCommand(state, { type: "werewolf.killVote", actorId: kill.actorId, targetId: victim!.id });
    }
    const witch = pendingByKind(state, "witch")[0];
    state = applyCommand(state, { type: "witch.act", actorId: witch.actorId });

    expect(state.phase).toBe("last_words");
    const lastWords = pendingByKind(state, "last_words")[0];
    expect(lastWords.actorId).toBe(victim!.id);
    state = applyCommand(state, { type: "lastWords.submit", actorId: lastWords.actorId, text: "请重点复盘昨夜刀口和白天的票型，不要轻易放过矛盾发言。" });

    expect(state.phase).toBe("day_speech");
    expect(state.speeches.at(-1)).toMatchObject({ playerId: victim!.id, kind: "last_words" });
    expect(state.events.at(-1)?.type).toBe("phase.changed");
    expect(state.events.some((event) => event.type === "last_words.submitted")).toBe(true);
  });

  it("offers an explicit scoped wolf discussion before the joint night kill votes", () => {
    let state = createGame({
      id: "test-wolf-discussion",
      seed: "wolf-discussion",
      config: { wolfDiscussion: "one_turn", lastWords: "none" }
    });
    state = advanceSystem(state);
    const inspect = pendingByKind(state, "inspect")[0];
    state = applyCommand(state, { type: "seer.inspect", actorId: inspect.actorId, targetId: inspect.legalTargetIds[0] });

    expect(state.phase).toBe("night_wolf_discussion");
    const whispers = pendingByKind(state, "whisper");
    expect(whispers.length).toBeGreaterThan(0);
    for (const whisper of whispers) {
      state = applyCommand(state, {
        type: "werewolf.whisper",
        actorId: whisper.actorId,
        text: `建议优先处理高影响目标，并同步白天的切割和站边策略。`
      });
    }

    expect(state.phase).toBe("night_wolves");
    expect(state.wolfWhispers).toHaveLength(whispers.length);
    expect(state.events.filter((event) => event.type === "werewolves.whispered")).toHaveLength(whispers.length);
    expect(serializePublicState(state)).not.toHaveProperty("wolfWhispers");
  });

  it("keeps core witch validation and role cardinality aligned with the harness boundary", () => {
    let state = createGame({ id: "test-core-witch-validation", seed: "core-witch-validation" });
    state = advanceSystem(state);
    const inspect = pendingByKind(state, "inspect")[0];
    state = applyCommand(state, { type: "seer.inspect", actorId: inspect.actorId, targetId: inspect.legalTargetIds[0] });
    for (const kill of pendingByKind(state, "kill")) {
      state = applyCommand(state, { type: "werewolf.killVote", actorId: kill.actorId, targetId: kill.legalTargetIds[0] });
    }
    const witch = pendingByKind(state, "witch")[0];
    const invalidSave = witch.legalPoisonTargetIds.find((playerId) => playerId !== witch.nightVictimId);
    expect(() => applyCommand(state, { type: "witch.act", actorId: witch.actorId, saveTargetId: invalidSave })).toThrow(/only save/i);
    expect(() =>
      createGame({
        id: "duplicate-seer",
        seed: "duplicate-seer",
        config: { seats: 3, roles: ["seer", "seer", "werewolf"] }
      })
    ).toThrow(/at most one/i);
  });

  it("derives event timestamps from sequence so same seed and commands yield identical event and state hashes", () => {
    const firstInitial = createGame({ id: "deterministic-event-clock", seed: "deterministic-event-clock" });
    const secondInitial = createGame({ id: "deterministic-event-clock", seed: "deterministic-event-clock" });
    expect(firstInitial.events).toEqual(secondInitial.events);
    expect(firstInitial.events[0]?.createdAt).toBe(new Date(1000).toISOString());

    const first = applyCommand(firstInitial, { type: "system.advance", actorId: "system" });
    const second = applyCommand(secondInitial, { type: "system.advance", actorId: "system" });
    expect(first.events).toEqual(second.events);
    expect(hashStableState(first)).toBe(hashStableState(second));
    expect(first.events.at(-1)?.createdAt).toBe(new Date(first.events.length * 1000).toISOString());
  });

  it("keeps the deterministic seed and hidden death sources out of every live view", () => {
    const initial = createGame({ id: "opaque-live-game", seed: "hidden-role-seed" });
    const observer = initial.players.find((player) => player.role === "villager") ?? initial.players[0];
    const source = initial.players.find((player) => player.role === "witch") ?? initial.players[1];
    const victim = initial.players.find((player) => player.id !== observer.id && player.id !== source.id) ?? initial.players[2];
    const state: GameState = {
      ...initial,
      phase: "day_speech",
      day: 1,
      deaths: [{ day: 1, playerId: victim.id, reason: "poison", sourceId: source.id }],
      events: [
        ...initial.events,
        {
          id: `${initial.id}:public-death`,
          seq: initial.events.length + 1,
          day: 1,
          phase: "day_speech",
          type: "player.died",
          actorId: "system",
          visibility: "public",
          payload: { playerId: victim.id, reason: "poison", sourceId: source.id },
          createdAt: "2026-07-13T00:00:00.000Z"
        },
        {
          id: `${initial.id}:postgame-private`,
          seq: initial.events.length + 2,
          day: 1,
          phase: "day_speech",
          type: "game.ended",
          actorId: "system",
          visibility: "postgame",
          payload: { secret: "not-live" },
          createdAt: "2026-07-13T00:00:01.000Z"
        }
      ]
    };
    const pending: Extract<PendingAction, { kind: "speech" }> = {
      kind: "speech",
      phase: "day_speech",
      actorId: observer.id,
      legalPressureTargetIds: state.players.filter((player) => player.id !== observer.id).map((player) => player.id)
    };

    const actorView = createPlayerView(state, observer.id, pending);
    const publicView = serializePublicState(state);

    expect(actorView).not.toHaveProperty("seed");
    expect(actorView).not.toHaveProperty("gameId");
    expect(publicView).not.toHaveProperty("seed");
    expect(publicView).not.toHaveProperty("id");
    expect(actorView.deaths[0]).not.toHaveProperty("sourceId");
    expect(JSON.stringify(actorView.recentEvents)).not.toContain("sourceId");
    expect(actorView.recentEvents.some((event) => event.id.endsWith("postgame-private"))).toBe(false);
  });
});
