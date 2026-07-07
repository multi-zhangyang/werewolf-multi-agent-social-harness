# Harness Architecture

This document defines the engineering boundary for the multi-agent harness in this repository. It is intentionally narrower than a general agent framework: the Werewolf engine owns game truth, the harness owns experiment execution, and provider-backed model adapters are only reasoner/speech components.

## Core Principle

**LLM does not equal Agent.**

An LLM is a stateless text-generation service unless the application wraps it with identity, state, observation scope, policy, tools, action validation, memory, tracing, and metrics. In this project, the Agent is the harness-managed player actor. A configured provider protocol adapter is a `HarnessReasoner` component used inside that actor, not the actor itself.

Current code mapping:

- `AgentHarnessState` stores agent identity, model config, policy name, turn count, beliefs, private memos, and last intent.
- `WerewolfEnvironment` implements the local `MultiAgentEnvironment` contract around snapshot, pending actions, observation, step, done, and harness event recording.
- `planAction()` creates a `PolicyPlan` and authoritative candidate `GameCommand`.
- `OpenAIHarnessReasoner.think()` now depends on a protocol-neutral `ModelClient`; OpenAI-compatible Chat Completions, OpenAI Responses, and Anthropic Messages adapters normalize text/telemetry into that boundary.
- `runHarnessMatch()` drives the environment loop and applies commands through `WerewolfEnvironment.step()`.

## Component Boundaries

| Concept | Owner | Current representation | Engineering rule |
| --- | --- | --- | --- |
| Environment | Game engine plus harness runtime | `WerewolfEnvironment`, `GameState`, `getPendingActions()`, `applyCommand()` | The environment is the authority for phase, legal pending actions, state transitions, deaths, winner, and event log. |
| Agent state | Harness | `AgentHarnessState` | Agent memory and belief state live outside the LLM. They must be serializable enough for tracing and replay. |
| Observation | Harness view layer | `PlayerView` from `createPlayerView()` | An observation is a scoped projection of state for one player and one pending action. It must respect public/private visibility. |
| Policy | Harness strategy layer | `PolicyName`, `PolicyPlan`, `planAction()` | Policy maps observation plus agent state to an intended legal command. It is the default action authority. |
| Reasoner | Pluggable model/tool caller | `HarnessReasoner`, `OpenAIHarnessReasoner` | The reasoner may explain, critique, or phrase speech. It must not mutate game state or bypass action arbitration. |
| Action arbitration | Harness plus engine | `PolicyPlan.command`, `GameCommand`, `applyTurn()` | Commands are submitted only through typed `GameCommand` values and engine validation. Model text is never an executable command. |
| Trajectory | Event-sourced state | `harness.turn`, `harness.error`, game events | Every harness turn should be inspectable after the match with policy, command type, beliefs, reasoner output, usage, latency, and errors. |
| Metrics | Harness reporting | `MatchMetrics`, `collectHarnessMetrics()` | Metrics are computed from terminal state and event history, not from model self-report. |
| Replay | Harness responsibility | seed/config plus events/traces/commands | Replay should reapply recorded commands and speech or deterministic state transitions. Re-querying the model is a rerun, not a replay. |

## Execution Loop

1. `WerewolfEnvironment` exposes pending actions from the current `GameState`.
2. The harness creates a `PlayerView` for the selected acting player.
3. The harness updates that player's `beliefs` from the observation.
4. The policy layer creates a `PolicyPlan` with intent, confidence, tags, target, and candidate `GameCommand`.
5. The reasoner receives the view and policy plan. For speech turns it returns public speech text; otherwise it returns private tactical memo text.
6. The harness attaches speech only when the pending action is a speech action.
7. The harness records a `HarnessTurnTrace`.
8. The engine applies the typed `GameCommand` and emits the resulting game events.
9. At terminal state, metrics are computed from event history and game outcome.

## Environment

The environment boundary is deterministic game state plus legal transitions. It includes phase progression, pending action discovery, visibility rules, ability effects, vote resolution, death records, and game-over detection. `WerewolfEnvironment` wraps this boundary with `snapshot()`, `pending()`, `pendingActions()`, `observe()`, `step()`, `done()`, `recordTurn()`, and `recordError()`. The harness may drive the environment, but it must not duplicate environment truth in prompt text or reasoner output.

`system.advance` is an environment tick. Player actions such as `seer.inspect`, `werewolf.killVote`, `witch.act`, `speech.submit`, `vote.cast`, and `hunter.shoot` are the only legal player command shapes.

## Agent State

An agent has a stable `playerId`, configured `model`, selected `policyName`, private belief map, bounded private memos, and turn metadata. These fields are harness state. They can be influenced by observations and reasoner output, but they are not hidden inside the model provider.

Agent state should remain explicit because it is needed for debugging, comparison across model configurations, and replay-oriented inspection.

## Observation

An observation is the data visible to one agent at one decision point. `PlayerView` contains public player data, role-appropriate private information, recent visible events, speeches, votes, deaths, day/phase, and the current `PendingAction`.

The observation must be the only path for private game facts to reach policy or reasoner code. This keeps the harness compatible with adversarial and deception metrics: agents can act only on what they should know.

## Policy

Policy is the strategy layer that turns observation and agent state into an intended command. It can use heuristics, scripted role behavior, search, learned policies, or future model-assisted planning, but the output must remain a typed `PolicyPlan`.

The current policies are role-shaped: werewolf deception, village analysis, seer information gain, witch resource conservation, and hunter punishment. A model can explain or phrase the policy decision, but policy still owns the default command.

## Reasoner

The reasoner is intentionally narrow. It receives the selected policy plan and visible context, then returns text. On speech turns, that text becomes public speech after normalization. On non-speech turns, it becomes private tactical memo for trace and postgame analysis.

The reasoner must not return JSON commands, mutate state, select illegal targets, or become the final arbiter of the action. If a future implementation allows model-suggested plans, those suggestions must pass through the same policy and command validation boundary.

## Action Arbitration

Action arbitration is the rule that only typed, legal `GameCommand` values can change the environment. The harness chooses when to run agent turns, applies the selected command through the engine, and records errors if engine validation fails.

Votes and werewolf kill votes may be collected concurrently, but concurrency does not change authority: each recorded command is still applied as an explicit transition against engine state.

The generic scaffold has a separate pre-arbitration scorer registry in
`src/harness/scaffold.ts`. That registry resolves serializable scorer configs
into existing `AgentActionCandidateScorer` instances; it does not define a new
agent protocol, does not create actions, and does not replace environment
validation. The built-in `weighted-social-state` scorer only adds
evidence-backed score contributions to caller-provided candidates with explicit
`socialTargetIds`. Raw candidate commands, draft messages, scratchpads, and
arbitrary metadata stay out of the persisted arbitration summary.

The current production Werewolf path still uses `WerewolfAgentActor`,
`planAction()`, `PolicyPlan`, and `policy.social-target-arbitration.v1`.
That Werewolf-specific arbitration now reads explicit society ledgers already
present on the acting agent's `AgentSocialState`: commitments, coalitions,
gossip, norm sanctions, trust repairs, and betrayals. These records affect only
legal target ranking through categorical reasons and evidence refs; the policy
does not parse free text, read hidden truth, mutate ledgers, promote evaluator
metrics, or bypass engine validation. Wiring scaffold scorer configs into
production Werewolf would still be a separate runtime/config/schema change, not
a side effect of the scaffold registry.

## Trajectory

The trajectory is the postgame record of what happened and why. It combines core game events with harness events:

- `harness.turn`: trace id, player id, model, action kind, policy, command type, intent, confidence, tags, beliefs, private memo, optional public speech, latency, token usage, and provider request id.
- `harness.error`: actor, model, action kind, trace id, and error message.
- Core game events: inspections, wolf votes, witch actions, speeches, votes, deaths, phase changes, and game end.

Trajectory data is visible postgame because it may contain private state and model diagnostics.

## Metrics

Metrics are derived from terminal `GameState` and event history. Current metrics include winner, days, deaths, speeches, votes, harness turn count, harness error count, average latency, wolf vote accuracy, village vote accuracy, deception survival score, and model usage.

Future metrics should follow the same rule: compute from recorded facts. LLM-as-grader output can be added as a separate evaluation layer over recorded trajectories, not as a replacement for deterministic metrics.

## Replay

Replay means reconstructing a prior run from deterministic artifacts. The minimum replay inputs are initial seed/config, player setup, event stream, harness turn traces, and applied commands. A replay should not call the model provider again unless the user explicitly wants a rerun under current model behavior.

This distinction matters because model outputs can change with provider version, sampling, latency, and hidden service-side behavior. Recorded speech and commands are the authoritative replay surface; new reasoner calls create a new experiment.

## Guardrails

- Do not treat prompt text as the harness.
- Do not let model output bypass `GameCommand`.
- Do not store private role facts outside scoped observations, agent state, traces, or postgame records.
- Do not compute metrics from unverified model claims.
- Do not call a model during replay unless the run is intentionally marked as a rerun.
- Do not make external eval platforms the source of truth for state, trajectory, or metrics.
