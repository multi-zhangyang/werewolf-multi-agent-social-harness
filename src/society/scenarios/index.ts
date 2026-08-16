import type { AgentProfile, ScenarioId, SocialWorld } from "../contracts";
import { PrisonersDilemmaWorld } from "./prisonersDilemma";
import { PublicGoodsWorld } from "./publicGoods";
import { TrustGameWorld } from "./trustGame";
import { UltimatumWorld } from "./ultimatum";
import { BeautyContestWorld } from "./beautyContest";
import { WerewolfWorld } from "./werewolf";
import { ALL_SCENARIOS, SCENARIO_METADATA } from "./metadata";

export { ALL_SCENARIOS, SCENARIO_METADATA } from "./metadata";

export function createWorld(input: {
  roomId: string;
  scenarioId: ScenarioId;
  profiles: AgentProfile[];
  rounds?: number;
}): SocialWorld {
  const metadata = SCENARIO_METADATA[input.scenarioId];
  if (!metadata) throw new Error(`SCENARIO_NOT_FOUND: '${input.scenarioId}' is not available.`);
  if (input.profiles.length !== metadata.players) {
    throw new Error(`PLAYER_COUNT_INVALID: ${metadata.name} requires ${metadata.players} participants.`);
  }
  if (input.scenarioId === "prisoners-dilemma") return new PrisonersDilemmaWorld(input.roomId, metadata, input.profiles, input.rounds);
  if (input.scenarioId === "public-goods") return new PublicGoodsWorld(input.roomId, metadata, input.profiles, input.rounds);
  if (input.scenarioId === "trust-game") return new TrustGameWorld(input.roomId, metadata, input.profiles, input.rounds);
  if (input.scenarioId === "ultimatum-game") return new UltimatumWorld(input.roomId, metadata, input.profiles, input.rounds);
  if (input.scenarioId === "beauty-contest") return new BeautyContestWorld(input.roomId, metadata, input.profiles, input.rounds);
  return new WerewolfWorld(input.roomId, metadata, input.profiles, input.rounds);
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === "string" && ALL_SCENARIOS.some((scenario) => scenario.id === value);
}
