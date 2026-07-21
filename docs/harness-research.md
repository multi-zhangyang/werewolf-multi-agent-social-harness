# Multi-Agent Harness Research Notes

This document records the verified external vocabulary used by the local
architecture. It is not evidence that this repository adopts any external
runtime. Local implementation claims below are tied to inspected repository
contracts; external claims are limited to the cited official documentation.

The project conclusion is fixed: provider-backed model adapters are optional
reasoners inside harness-managed agents. The product is an environment-
authoritative, replayable, evaluable multi-agent harness, not a group chat.

## Working Definitions

- **Environment**: the authority that exposes scoped observations and legal
  action conditions, validates actions, and commits state transitions.
- **Agent**: a durable actor with identity, private/social state, observation
  handling, policy, arbitration, and optional model/tool-backed reasoning.
- **Proposal**: a staged action/message candidate. It is not an environment or
  agent-state commit.
- **Committed step**: a validated environment transition, its published message
  envelopes, and the actor receipt that follows them.
- **Domain event**: a fact emitted by the domain transition. Provider telemetry,
  private reasoner memos, and harness failures are not domain events.
- **Execution evidence**: scheduler steps, scoped observations, proposed
  actions/messages, commit status, traces, failures, hashes, and ranges recorded
  by the harness.
- **Deterministic playback**: applying recorded committed native steps with zero
  actor/model/API calls and verifying their state and message consequences.
- **Fork/rerun**: a new execution lineage from a checkpoint. It may call models
  or external APIs and may diverge from the parent run.

## PettingZoo: Environment Cycles And Parallel Semantics

Official sources:

- AEC API: https://pettingzoo.farama.org/api/aec/
- Parallel API: https://pettingzoo.farama.org/api/parallel/
- Pinned AEC documentation source:
  https://github.com/Farama-Foundation/PettingZoo/blob/dc1a4c8b679783b2fcb95b5a0d5af2a629deedbd/docs/api/aec.md#L85-L111
- Pinned base environment contracts:
  https://github.com/Farama-Foundation/PettingZoo/blob/dc1a4c8b679783b2fcb95b5a0d5af2a629deedbd/pettingzoo/utils/env.py#L29-L100
- Pinned parallel environment contracts:
  https://github.com/Farama-Foundation/PettingZoo/blob/dc1a4c8b679783b2fcb95b5a0d5af2a629deedbd/pettingzoo/utils/env.py#L287-L331

Verified source implications:

- AEC is a sequential agent-environment cycle: one selected agent acts for an
  environment transition.
- Per-agent observation is distinct from global environment state.
- The Parallel API represents actions for live agents in one environment step;
  it is a different contract from AEC.
- Legal-action metadata or action masks help describe available choices, but
  the environment still owns `step()` and transition semantics.

Local architecture consequence:

- `SocialEnvironment.observe(agentId, pending)` and the Werewolf `PlayerView`
  implement actor-scoped observation boundaries.
- `WerewolfEnvironment.step()` remains the final validator even when policy has
  already selected from pending legal targets.
- `aec-batched-decision` means concurrent/shared-state decision collection plus
  sequential environment application. It is not a parallel environment.
- Local `parallel` mode is valid only with `SocialParallelEnvironment.stepBatch()`
  and an atomic joint transition. `Promise.all()` over reasoner calls does not
  satisfy that contract.

## OpenAI Agents: Runtime, Orchestration, Results, And Tracing

Official sources:

- Agents guide: https://developers.openai.com/api/docs/guides/agents
- Defining agents: https://developers.openai.com/api/docs/guides/agents/define-agents
- Running agents and the agent loop:
  https://developers.openai.com/api/docs/guides/agents/running-agents#the-agent-loop
- Orchestration: https://developers.openai.com/api/docs/guides/agents/orchestration
- Tracing:
  https://developers.openai.com/api/docs/guides/agents/integrations-observability#tracing
- Results: https://developers.openai.com/api/docs/guides/agents/results

Verified source implications:

- Agent definition, the runner/loop, orchestration, run results, and trace data
  are separate runtime concerns.
- Application-controlled orchestration is a supported boundary; orchestration
  does not have to be delegated to a model.
- Tracing is observability over execution. A trace records what runtime work
  occurred; it is not the application's domain-state authority.

Local architecture consequence:

- The harness, not a provider SDK or model, owns scheduling, observations,
  message commit, environment invocation, artifacts, and evaluation.
- `HarnessReasoner` is an optional component used by
  `WerewolfSocialActorAdapter` while driving a `WerewolfAgentActor` decision.
  Its private memo and provider telemetry are native execution evidence, not
  the agent definition and not `GameState` events. Public speech enters domain
  truth only through an accepted typed `speech.submit` command.
- A model handoff or structured response is, by itself, workflow data rather
  than committed social communication or a legal game transition. Social
  messages must pass through the local communication bus, and commands must
  pass environment validation.
- Local trace/error records belong to `SocialEpisodeArtifact` and JSONL
  observability records. They must not be inserted into the domain event log.

## LangGraph: Persistence, Checkpoints, And Time Travel

Official sources:

- Persistence: https://docs.langchain.com/oss/javascript/langgraph/persistence
- Checkpointers: https://docs.langchain.com/oss/javascript/langgraph/checkpointers
- Time travel: https://docs.langchain.com/oss/javascript/langgraph/use-time-travel
- Pinned checkpointer documentation source:
  https://github.com/langchain-ai/docs/blob/7c417783c90d5ee9fb03378eeddaf20082fddfc5/src/oss/langgraph/checkpointers.mdx#L19-L70
- Pinned time-travel overview:
  https://github.com/langchain-ai/docs/blob/7c417783c90d5ee9fb03378eeddaf20082fddfc5/src/oss/langgraph/use-time-travel.mdx#L9-L22
- Pinned replay/fork behavior:
  https://github.com/langchain-ai/docs/blob/7c417783c90d5ee9fb03378eeddaf20082fddfc5/src/oss/langgraph/use-time-travel.mdx#L123-L168

Verified source implications:

- LangGraph persistence saves checkpointed graph state associated with
  execution threads.
- Its time-travel documentation distinguishes replaying from a checkpoint and
  forking from checkpoint state.
- In that documentation, replay can re-execute downstream graph nodes. Those
  nodes may perform model or API work again.

Local architecture consequence:

- This repository must not borrow the word `replay` without qualifying its
  semantics. Re-executing nodes, policies, models, or APIs is not deterministic
  playback of a recorded match.
- `replaySocialEpisode()` applies recorded `commitStatus: "committed"` native
  steps, skips rejected steps, verifies state/event/message evidence, and
  constructs no actor or reasoner.
- A local fork/rerun may execute actors and models again, but it must receive a
  new run identity and retain immutable checkpoint and parent provenance.
- New local checkpoints use `harness.checkpoint.v2` and bind the native social
  execution prefix, channel topology, committed message prefix, domain state,
  actor state, batch-safe boundary, and content hashes. Fork/rerun restores
  that state into a new lineage; it is still not deterministic playback.

## Concordia: Componentized Social Actors, Not Rule Authority

Official sources:

- Repository and overview: https://github.com/google-deepmind/concordia
- Component documentation:
  https://github.com/google-deepmind/concordia/blob/main/concordia/components/README.md

Verified source implications:

- Concordia models entities as composable components and distinguishes agents,
  a Game Master, and an engine.
- Its agent components cover concerns such as memory, observation,
  instructions, planning/reflection, and action selection.
- Its architecture is useful as a decomposition reference for social actors,
  but a language-model Game Master may interpret natural-language action
  attempts into world outcomes.

Local architecture consequence:

- The local actor scaffold keeps identity, memory, beliefs, relationships,
  reputation, norms, goals, policy/arbitration, and reasoner output as
  separately auditable private state concerns.
- A reasoner/policy can stage a memo or candidate during `decide()`, but durable
  actor state changes only after a committed receipt. This transactional rule
  is stricter than a generic planning/action loop because it protects replay,
  checkpoint, and social-causality evidence from rejected proposals.
- `WerewolfEnvironment` and the core engine, not a Game Master or reasoner,
  interpret legal commands, resolve simultaneous action conflicts, and decide
  victory. Concordia is therefore a design reference, not a runtime dependency.

## Generic Artifact Envelope

The current local refactor adds `src/harness/episodeArtifacts.ts`. It owns the
domain-neutral portion of an artifact/checkpoint contract:

```text
HarnessEpisodeArtifactEnvelope
  = run identity + status + initial/final snapshot
  + SocialEpisodeArtifact + actor snapshots + fork provenance

HarnessCheckpointEnvelope
  = checkpoint identity + source hashes/cursor
  + state + actor state + committed social execution prefix
```

This module has no Werewolf state, role, team, command, evaluator, provider,
or UI imports. A domain supplies those through typed specializations and a
deterministic replay factory. The Werewolf compatibility layer continues to
own `MatchArtifact`, seed/config/assignment, domain events, evaluators, and
public DTO projection.

This applies the useful part of checkpoint systems such as LangGraph while
preserving a different replay contract: `validateHarnessCheckpointReplay()`
receives a domain replay function over recorded committed steps, never an
agent/model runner.

## Applied Local Separation

The external sources converge on boundaries that the local code now expresses:

```text
domain truth:
  GameState + domain GameEvent records

native execution authority:
  SocialEpisodeArtifact
    + explicit system/player steps
    + commitStatus
    + observations/actions/messages
    + trace/failure evidence
    + state/event/message hashes and ranges

generic artifact/checkpoint envelope:
  episode/checkpoint identity + stable hashes + batch boundary
  + actor snapshot frame identity + immutable fork provenance
  + domain-supplied replay factory

agent lifecycle:
  staged proposal
    -> environment commit
    -> message commit
    -> actor-scoped receipt
    -> committed actor state
    -> snapshot

legacy migration projection:
  HarnessStepRecord[] trajectory

deterministic playback:
  recorded committed native steps only
  + zero actor/policy/reasoner/provider calls

fork/rerun:
  new lineage from checkpoint
  + optional new model/API calls
```

This separation prevents four category errors:

1. Calling a chat completion an agent.
2. Calling provider telemetry a domain event.
3. Calling a rejected proposal a committed turn.
4. Calling fresh model/API execution deterministic replay.

External frameworks may remain design references or export consumers. They do
not replace local environment authority, scoped observations, native artifacts,
or evaluator evidence.
