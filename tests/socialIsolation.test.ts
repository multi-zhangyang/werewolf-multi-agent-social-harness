import { describe, expect, it } from "vitest";
import { hashStableState } from "../src/harness/hash";
import {
  runSocialEpisode,
  type SocialAction,
  type SocialActor,
  type SocialEnvironment
} from "../src/harness/social";

interface IsolationState {
  done: boolean;
  nested: { value: string };
}

interface IsolationPending {
  actorId: "a";
  kind: "act";
  nested: { value: string };
}

interface IsolationObservation {
  nested: { value: string };
}

interface IsolationCommand {
  actorId: "a";
  amount: number;
}

describe("generic social runner ownership isolation", () => {
  it("detaches pending, observation, identity, proposal, validation, and step inputs", async () => {
    const pendingTemplate: IsolationPending = {
      actorId: "a",
      kind: "act",
      nested: { value: "pending-original" }
    };
    const sharedAction: SocialAction<IsolationCommand> = {
      actorId: "a",
      kind: "act",
      command: { actorId: "a", amount: 1 }
    };
    let traceProviderSawOriginal = false;
    let actorPendingSawOriginal = false;
    let stepReceivedAmount: number | undefined;
    const state: IsolationState = { done: false, nested: { value: "observation-original" } };
    const environment: SocialEnvironment<IsolationState, IsolationObservation, IsolationPending, IsolationCommand> = {
      snapshot: () => structuredClone(state),
      pendingActions: () => state.done ? [] : [pendingTemplate],
      observe(_actorId, pending) {
        pending.nested.value = "environment-observe-mutated-argument";
        return state;
      },
      validateAction(command) {
        command.amount = 88;
        sharedAction.command.amount = 77;
        return { valid: true };
      },
      step(command) {
        stepReceivedAmount = command.amount;
        command.amount = 99;
        state.done = true;
        return structuredClone(state);
      },
      done: () => state.done
    };
    const actor: SocialActor<IsolationObservation, IsolationPending, IsolationCommand> = {
      id: "a",
      profile: {
        id: "isolation-profile",
        version: "1",
        model: "deterministic",
        policyId: "isolation.policy"
      },
      observe(observation) {
        observation.nested.value = "actor-observe-mutated";
      },
      decide(pending) {
        actorPendingSawOriginal = pending.nested.value === "pending-original";
        pending.nested.value = "actor-decide-mutated";
        return sharedAction;
      }
    };

    const episode = await runSocialEpisode({
      id: "ownership-isolation",
      domainId: "ownership-isolation",
      environment,
      actors: [actor],
      channels: [],
      schedulerMode: "aec",
      maxTransitions: 1,
      hashState: hashStableState,
      hashMessages: hashStableState,
      actorTurnIndexForDecision(context) {
        context.state.nested.value = "identity-provider-mutated-state";
        context.pendingAction.nested.value = "identity-provider-mutated-pending";
        return 1;
      },
      traceIdForDecision(context) {
        traceProviderSawOriginal =
          context.state.nested.value === "observation-original" &&
          context.pendingAction.nested.value === "pending-original";
        return "ownership-isolation:trace:1";
      }
    });

    expect(episode.status).toBe("completed");
    expect(traceProviderSawOriginal).toBe(true);
    expect(actorPendingSawOriginal).toBe(true);
    expect(pendingTemplate.nested.value).toBe("pending-original");
    expect(state.nested.value).toBe("observation-original");
    expect(stepReceivedAmount).toBe(1);
    expect(sharedAction.command.amount).toBe(77);
    expect(episode.steps).toHaveLength(1);
    expect(episode.steps[0]).toMatchObject({
      traceId: "ownership-isolation:trace:1",
      pendingAction: { nested: { value: "pending-original" } },
      observation: { nested: { value: "observation-original" } },
      action: { command: { actorId: "a", amount: 1 } },
      commitStatus: "committed"
    });
  });
});
