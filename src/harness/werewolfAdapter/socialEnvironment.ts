import { getPendingActions } from "../../core/engine";
import { isAgentPendingAction } from "../../core/pending";
import type { GameCommand, GameState, PendingAction, PlayerState } from "../../core/types";
import { WerewolfEnvironment } from "../environment";
import type {
  SocialAction,
  SocialActionValidationResult,
  SocialChannel,
  SocialEnvironment,
  SocialObservationAssembler,
  SocialParallelEnvironment,
  SocialSystemTransitionProvider
} from "../social";
import {
  WEREWOLF_SYSTEM_ACTOR_ID,
  WEREWOLF_SYSTEM_PROFILE,
  type WerewolfSocialObservation,
  type WerewolfSocialPendingAction
} from "./adapterTypes";

export class WerewolfSocialEnvironment
  implements
    SocialEnvironment<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>,
    SocialParallelEnvironment<GameState, WerewolfSocialObservation, WerewolfSocialPendingAction, GameCommand>
{
  constructor(readonly environment: WerewolfEnvironment) {}

  static fromState(initialState: GameState): WerewolfSocialEnvironment {
    return new WerewolfSocialEnvironment(new WerewolfEnvironment(initialState));
  }

  snapshot(): GameState {
    return this.environment.snapshot();
  }

  pendingActions(): WerewolfSocialPendingAction[] {
    return this.environment.pendingActions();
  }

  observe(agentId: string, pending: WerewolfSocialPendingAction): WerewolfSocialObservation {
    if (!isAgentPendingAction(pending)) {
      throw new Error(`System pending action ${pending.kind} cannot be observed as a player action.`);
    }
    const view = this.environment.observe(agentId, pending);
    return {
      kind: "player",
      agentId,
      view: {
        ...view,
        social: {
          channels: [],
          messages: []
        }
      }
    };
  }

  step(command: GameCommand): GameState {
    return this.environment.step(command);
  }

  validateAction(command: GameCommand, pending: WerewolfSocialPendingAction): SocialActionValidationResult {
    if (pending.kind === "advance" && command.type !== "system.advance") {
      return {
        valid: false,
        code: "pending-kind-mismatch",
        message: `Command ${command.type} cannot resolve system pending action ${pending.kind}.`
      };
    }
    if (pending.kind !== "advance" && command.type === "system.advance") {
      return {
        valid: false,
        code: "pending-kind-mismatch",
        message: `System advance cannot resolve agent pending action ${pending.kind}.`
      };
    }
    if (pending.actorId && command.actorId !== pending.actorId) {
      return {
        valid: false,
        code: "actor-mismatch",
        message: `Command actor ${command.actorId} does not match pending actor ${pending.actorId}.`
      };
    }
    return this.environment.validate(command);
  }

  stepBatch(commandsByAgent: Record<string, GameCommand>): GameState {
    return this.environment.stepBatch(commandsByAgent);
  }

  done(): boolean {
    return this.environment.done();
  }

  pending(): PendingAction[] {
    return this.environment.pending();
  }
}

export const assembleWerewolfSocialObservation: SocialObservationAssembler<
  WerewolfSocialObservation,
  WerewolfSocialPendingAction
> = (context) => {
  if (context.environmentObservation.kind === "system") return context.environmentObservation;
  return {
    ...context.environmentObservation,
    view: {
      ...context.environmentObservation.view,
      social: {
        channels: context.visibleSocial.channels,
        messages: context.visibleSocial.messages
      }
    }
  };
};

export const werewolfSystemTransition: SocialSystemTransitionProvider<
  GameState,
  WerewolfSocialObservation,
  WerewolfSocialPendingAction,
  GameCommand
> = (context) => {
  const pending = getPendingActions(context.state);
  if (pending.length !== 1 || pending[0].kind !== "advance") return undefined;
  const advance = pending[0];
  return {
    actorId: WEREWOLF_SYSTEM_ACTOR_ID,
    profileId: WEREWOLF_SYSTEM_PROFILE.id,
    pendingAction: advance,
    observation: {
      kind: "system",
      agentId: WEREWOLF_SYSTEM_ACTOR_ID,
      gameId: context.state.id,
      phase: context.state.phase,
      day: context.state.day,
      pendingAction: advance,
      social: {
        channels: [],
        messages: []
      }
    },
    action: systemAdvanceAction()
  };
};

export function createWerewolfSocialChannels(players: PlayerState[]): SocialChannel[] {
  const playerIds = players.map((player) => player.id);
  const wolfIds = players.filter((player) => player.team === "werewolves").map((player) => player.id);
  return [
    {
      id: "table",
      kind: "public",
      participantIds: playerIds,
      readableBy: "all"
    },
    {
      id: "werewolf-team",
      kind: "team",
      participantIds: wolfIds,
      readableBy: "participants"
    },
    ...players.map((player) => ({
      id: `private-${player.id}`,
      kind: "private" as const,
      participantIds: [player.id],
      readableBy: "participants" as const
    }))
  ];
}

function systemAdvanceAction(): SocialAction<GameCommand> {
  return {
    actorId: WEREWOLF_SYSTEM_ACTOR_ID,
    kind: "system.advance",
    command: {
      type: "system.advance",
      actorId: WEREWOLF_SYSTEM_ACTOR_ID
    }
  };
}
