import type { GameState, Phase } from "../../core/types";
import type { SocialDomainAdapterManifest } from "../domainAdapter";
import { hashStableState } from "../hash";
import type { WerewolfLivePublicState } from "../types";

/**
 * Project only facts that are safe to render while a hidden-information match
 * is still running. This deliberately does not reuse PlayerView or the wider
 * PublicGameState: both can contain role revelation, night subphase, pending
 * action, or cadence details that are inappropriate for a public live table.
 */
export function projectWerewolfLivePublicState(state: GameState): WerewolfLivePublicState {
  return {
    phase: publicLivePhase(state.phase),
    day: state.day,
    players: state.players
      .map((player) => ({
        id: player.id,
        seat: player.seat,
        name: player.name,
        alive: player.alive,
        isSheriff: player.isSheriff,
        ...(player.eliminatedAt
          ? {
              eliminatedAt: {
                day: player.eliminatedAt.day,
                reason: player.eliminatedAt.reason
              }
            }
          : {})
      }))
      .sort((left, right) => left.seat - right.seat),
    speeches: state.speeches.map((speech) => ({
      day: speech.day,
      playerId: speech.playerId,
      text: speech.text,
      ...(speech.kind ? { kind: speech.kind } : {})
    })),
    votes: state.votes.map((vote) => ({
      day: vote.day,
      voterId: vote.voterId,
      ...(vote.targetId ? { targetId: vote.targetId } : {}),
      ...(vote.abstain ? { abstain: true } : {})
    })),
    deaths: state.deaths.map((death) => ({ day: death.day, playerId: death.playerId, reason: death.reason })),
    ...(state.currentSpeakerSeat === undefined ? {} : { currentSpeakerSeat: state.currentSpeakerSeat })
  };
}

function publicLivePhase(phase: Phase): WerewolfLivePublicState["phase"] {
  if (phase === "game_over") return "game_over";
  return phase.startsWith("night_") ? "night" : "day";
}

/**
 * Safe, versioned provenance for the first domain adapter. The hashes cover
 * only public semantic descriptors; they intentionally exclude model setup,
 * prompts, provider data, player secrets, and closure source text.
 */
export function createWerewolfSocialDomainAdapterManifest(
  rulesetId: GameState["config"]["rulesetId"]
): SocialDomainAdapterManifest {
  const component = (kind: SocialDomainAdapterManifest["components"][number]["kind"], id: string, descriptor: unknown) => ({
    kind,
    id,
    version: "1",
    semanticHash: hashStableState(descriptor)
  });
  const components = [
    component("agent_state_schema", "werewolf.agent-harness-state", { version: 2, stores: ["memory", "beliefs", "social", "outcome"] }),
    component("command_codec", "werewolf.game-command", { version: 1, rulesetId }),
    component("environment", "werewolf.social-environment", { version: 1, rulesetId }),
    component("observation_projection", "werewolf.player-view", { version: 1, scoped: true }),
    component("scheduler", "werewolf.joint-phase-scheduler", { version: 1, supported: ["aec-batched-decision", "parallel"] })
  ] as const;
  return {
    schemaVersion: "harness.domain-adapter.v1",
    domainId: "werewolf",
    adapterId: "werewolf.social",
    adapterVersion: "1",
    semanticHash: hashStableState({ adapter: "werewolf.social", version: 1, rulesetId, components }),
    components
  };
}
