import type { AgentPendingAction } from "../core/pending";
import type { GameCommand, GameState } from "../core/types";
import type {
  HarnessAgentConfig,
  HarnessRunOptions,
  HarnessRunResult,
  HarnessTurnTrace
} from "./types";
import {
  probeWerewolfSocialHarnessTurn,
  runWerewolfSocialHarnessPrefixAsHarnessResult
} from "./werewolfAdapter";

export async function runHarnessMatch(options: HarnessRunOptions): Promise<HarnessRunResult> {
  return runWerewolfSocialHarnessPrefixAsHarnessResult({
    id: options.initialState.id,
    ...options
  });
}

export async function probeHarnessTurn(options: {
  state: GameState;
  action: AgentPendingAction;
  agent: HarnessAgentConfig;
  reasoner: HarnessRunOptions["reasoner"];
}): Promise<{ trace: HarnessTurnTrace; command: GameCommand }> {
  return probeWerewolfSocialHarnessTurn(options);
}
