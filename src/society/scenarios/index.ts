import type { AgentProfile, ScenarioId, SocialWorld } from "../contracts";
import { SocialWorldBase, type WorldSerializedState } from "../world";
import { PrisonersDilemmaWorld } from "./prisonersDilemma";
import { PublicGoodsWorld } from "./publicGoods";
import { TrustGameWorld } from "./trustGame";
import { UltimatumWorld } from "./ultimatum";
import { BeautyContestWorld } from "./beautyContest";
import { WerewolfWorld } from "./werewolf";
import { SealedBidAuctionWorld } from "./sealedBidAuction";
import { AvalonWorld } from "./avalon";
import { CentipedeGameWorld } from "./centipedeGame";
import { ChickenGameWorld } from "./chickenGame";
import { StagHuntWorld } from "./stagHunt";
import { NegotiationWorld } from "./negotiationGame";
import { LiarsDiceWorld } from "./liarsDice";
import { ALL_SCENARIOS, SCENARIO_METADATA } from "./metadata";

export { ALL_SCENARIOS, SCENARIO_METADATA } from "./metadata";

export function createWorld(input: {
  roomId: string;
  scenarioId: ScenarioId;
  profiles: AgentProfile[];
  rounds?: number;
  /** Checkpoint state for restart recovery (P3). */
  state?: WorldSerializedState;
}): SocialWorld {
  const metadata = SCENARIO_METADATA[input.scenarioId];
  if (!metadata) throw new Error(`SCENARIO_NOT_FOUND: '${input.scenarioId}' is not available.`);
  const range = metadata.playerRange;
  const min = range?.min ?? metadata.players;
  const max = range?.max ?? metadata.players;
  if (input.profiles.length < min || input.profiles.length > max) {
    const expected = range
      ? `${min}-${max} 名参与者`
      : `${metadata.players} 名参与者`;
    throw new Error(`PLAYER_COUNT_INVALID: ${metadata.name} requires ${expected}.`);
  }
  let world: SocialWorld;
  if (input.scenarioId === "prisoners-dilemma") world = new PrisonersDilemmaWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "public-goods") world = new PublicGoodsWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "trust-game") world = new TrustGameWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "ultimatum-game") world = new UltimatumWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "beauty-contest") world = new BeautyContestWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "sealed-bid-auction") world = new SealedBidAuctionWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "avalon") world = new AvalonWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "centipede-game") world = new CentipedeGameWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "chicken-game") world = new ChickenGameWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "stag-hunt") world = new StagHuntWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "negotiation-game") world = new NegotiationWorld(input.roomId, metadata, input.profiles, input.rounds);
  else if (input.scenarioId === "liars-dice") world = new LiarsDiceWorld(input.roomId, metadata, input.profiles, input.rounds);
  else world = new WerewolfWorld(input.roomId, metadata, input.profiles, input.rounds);
  if (input.state) {
    (world as SocialWorldBase).restoreState(input.state);
    world.pause();
  }
  return world;
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === "string" && ALL_SCENARIOS.some((scenario) => scenario.id === value);
}
