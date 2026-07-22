# Harness Architecture

This document describes the architecture that exists in this repository after
the native-execution refactor. The product is a domain-neutral multi-agent
adversarial/social harness. Werewolf is its first domain adapter and proof
surface; a collection of chat completions is not the product.

The external source vocabulary behind these boundaries is recorded in
[harness-research.md](harness-research.md).

## Core Invariants

1. An LLM is an optional reasoner inside an agent. It is not the agent, the
   scheduler, the environment, the artifact store, or an evaluator.
2. The environment is the only authority for domain legality and domain-state
   transitions.
3. `GameState` and `GameEvent` contain Werewolf domain truth only. Harness
   traces, provider telemetry, private memos, and failures do not become domain
   events and cannot change the domain hash.
4. A proposed command or message is not a committed turn. Agent decision state
   is committed only after the environment transition and message publication
   succeed.
5. `SocialEpisodeArtifact.steps` is the native execution authority. Its system,
   committed, and rejected steps are preserved in scheduler order.
6. Deterministic playback uses recorded committed steps and never calls an
   actor, policy, reasoner, or provider. A fork/rerun is a new execution lineage
   and may call them again.

A reasoner-produced public speech can become part of domain state only after it
has been normalized into a typed `speech.submit` command and accepted by the
environment. Reasoner memos and provider diagnostics remain execution evidence;
they are never smuggled into `GameState.events`.

## Ownership Boundaries

| Plane | Current representation | Authority rule |
| --- | --- | --- |
| Domain environment | `GameState`, `GameEvent`, `WerewolfEnvironment`, `applyCommand()` | Owns pending actions, command legality, deterministic transitions, phase progression, deaths, and victory. |
| Scheduler and runner | `runHarnessEpisode()`, `runSocialEpisode()`, `SocialEnvironment`, `SocialParallelEnvironment` | Selects actor/system work and records ordering; it cannot override environment validation. |
| Observation | `PlayerView`, `WerewolfSocialObservation`, observation assembler | Projects only actor-visible state and visible social channels/messages. |
| Agent | `WerewolfAgentActor`, `AgentHarnessState`, `AgentSocialState` | Owns durable private/social state through explicit actor lifecycle methods. |
| Policy and arbitration | `planAction()`, `PolicyPlan`, typed `GameCommand` | Proposes a typed candidate; the environment remains the final legality authority. |
| Reasoner | `HarnessReasoner`, model client adapters | May produce speech or a private tactical memo and telemetry; owns no environment or agent-state mutation authority. |
| Communication | `SocialCommunicationBus`, `SocialChannel`, `SocialMessage` | Validates message envelopes before the environment transition and publishes them after a successful transition. |
| Native artifact | `SocialEpisodeArtifact`, `SocialHarnessStep`, `SocialDomainAdapterManifest` | Records system/player steps, commit status, hashes, message/event ranges, traces, structured failures, and safe versioned domain-adapter provenance. |
| Generic control plane | `experimentSpec.ts`, `NormalizedGenericExperimentSpecV1` | Owns portable experiment identity, adapter/profile/model assignment, scheduler, limits, evaluator ids, and safe versioned policy refs; never persists factories, endpoints, credentials, or raw provider options. |
| Generic artifact/checkpoint core | `episodeArtifacts.ts`, `socialReplay.ts`, `episodeArtifactStore.ts`, `HarnessEpisodeArtifactEnvelope`, `HarnessCheckpointEnvelope` | Owns domain-neutral structural checks, strong semantic replay acceptance, snapshot/hash/batch/adapter/lineage invariants, and safe single-episode persistence. It receives domain validators and a deterministic environment factory and never calls a model. |
| Domain artifact | `GameState.events`, `MatchArtifact.events` | Records domain events only. |
| Evaluation | evaluator registry, `MatchMetrics`, evidence refs | Derives results from domain truth and native execution evidence, never model self-report alone. |
| UI/API | server projections and React cockpit | Consume recorded truth; they do not create hidden roles, transitions, or replay truth. |

The deleted `src/harness/contracts.ts` layer is not an architecture boundary.
The generic contracts are the `SocialEnvironment`, `SocialActor`, scheduler,
message-bus, and episode artifact types in `src/harness/social.ts`, plus the
domain-neutral artifact/checkpoint envelope in
`src/harness/episodeArtifacts.ts`. Werewolf knowledge stays in the core engine
and Werewolf adapter.

## Generic Artifact Core

`SocialEpisodeArtifact` is the native execution record. The generic envelope
around it is intentionally smaller than a domain artifact:

```text
HarnessEpisodeArtifactEnvelope<TState, TObservation, TPending, TCommand, TAgent>
  = artifact identity + run identity + status
  + initial/final TState
  + SocialEpisodeArtifact<TState, TObservation, TPending, TCommand>
  + durable TAgent[] + optional fork provenance

HarnessCheckpointEnvelope<TState, TAgent, TObservation, TPending, TCommand>
  = checkpoint identity + source hashes and batch boundary
  + TState + durable TAgent[] + committed execution prefix
```

For new adapter-bound executions, `SocialDomainAdapterManifest` serializes a
safe domain id, adapter id/version, semantic digest, and canonical provenance
for the environment, command codec, observation projection, scheduler, and
agent-state schema. It deliberately excludes function source, prompts,
credentials, endpoints, provider diagnostics, and private state. Legacy
artifacts that predate this contract remain explicitly readable, but cannot be
retroactively claimed as adapter-bound.

`validateHarnessEpisodeArtifactEnvelope()` is intentionally structural-only:
it verifies state, actor, message, frame, and provenance hashes plus generic
sequence/batch invariants. Persistence, evaluation authority, and fork-source
acceptance use the stronger `verifyHarnessEpisodeArtifact()` boundary. That
boundary requires exact runtime/recorded adapter identity, a deterministic
environment factory, state/message hashers, a recorded-step semantic validator,
and an explicit durable-agent-state policy. A state-bearing artifact cannot opt
out; each committed actor receipt boundary must have a resolvable snapshot.
Callbacks receive clones, malformed/throwing callbacks fail closed, and replay
never constructs an actor, policy, reasoner, model client, or provider request.

`HarnessEpisodeArtifactStore` is the domain-neutral, single-episode disk
authority. It hashes run ids into fixed child directories, writes canonical
artifact/trajectory/manifest files atomically, rebuilds its index by recovery
scan after restart, and invokes the supplied strong verifier before put and
after every read. Manifest digests, regenerated JSONL equality, regular-file
checks, realpath containment, and symlink rejection prevent a persisted record
from gaining authority through path or content tampering.

`validateHarnessCheckpointReplay()` receives a domain-owned deterministic
replay function. Checkpoint creation and restoration additionally require an
explicit recorded-agent-state policy before factories run. A bare compacted
checkpoint may validate only its selected final actor boundary because the
full parent snapshot-frame sidecar is not necessarily embedded; full historical
semantic validation belongs to the canonical parent artifact before checkpoint
selection.

`MatchArtifact` and `HarnessCheckpoint` are Werewolf specializations of these
envelopes. They add seed/config/assignment, Werewolf events and evaluation,
the legacy trajectory migration projection, and the `matchId` compatibility
alias. A new domain can use the generic envelope without importing roles,
teams, `GameState`, or Werewolf evaluators.

## Evaluation And Execution Evidence Boundaries

`HarnessEvaluationContext<TState, TMetrics, TSocialEpisode, TAgent,
TTrajectory>` is parameterized by the domain's actor snapshot and trajectory
types. A generic evaluator therefore cannot require a Werewolf `PlayerView`,
`GameCommand`, or legacy `HarnessStepRecord` unless it is explicitly a
Werewolf evaluator. Its omitted `TAgent`/`TTrajectory` defaults preserve the
legacy Werewolf public TypeScript API; a new domain supplies its own fourth and
fifth generic arguments.

`SocialAgentSnapshot` is the minimum projection accepted by the generic social
evaluators: durable actor identity, optional profile/model/policy identifiers,
an optional `AgentSocialState`, and an optional state hash. New adapters supply
`id`; old Werewolf artifacts are read through their existing `playerId` and
`social.agentId` fields during the compatibility migration. Generic social
metric subjects expose `actorId` and `policyId`; the historical `playerId` and
`policyName` aliases are retained only for existing artifact/API readers.

The generic `executionEvidence.ts` module extracts structured failure evidence
without inspecting a domain marker. `werewolfExecutionEvidence.ts` owns the
legacy `werewolf-harness-turn` decoder and its `HarnessTurnTrace` projection.
The marker and envelope remain unchanged so `harness.match.v2` artifacts and
checkpoints remain readable, but a future domain cannot be mistaken for a
Werewolf trace merely because it has a similarly shaped metadata object.

Metric-promotion mechanics are generic, while catalog ownership is domain
specific. `socialMetricPromotion.ts` owns reusable social diagnostics and
`werewolfMetricPromotion.ts` composes those rules with Werewolf scorecard and
diagnostic metrics. The generic evaluation layer owns only matching, finite
numeric value checks, positive-weight checks, evidence requirements, policy
validation, and report materialization.

When an evaluation report is created, each metric receives an immutable
`promotionDecision` containing the policy/catalog identity and hashes, final
class, scorecard eligibility, decision id when applicable, reasons, and a
`recorded` resolution. Artifact readers must use that stored decision. A legacy
artifact without one is resolved only through a conservative recovery policy
derived from its report summary and is labelled `legacy_recomputed`; an
uncataloged historical metric never becomes scorecard-eligible merely because a
newer catalog happens to recognize it.

The hashes are provenance identifiers, not a complete historical policy
snapshot. Integrity validation can prove report-internal consistency between
stored decisions and their summary, but it deliberately does not recompute an
old decision from whatever catalog code happens to be installed today. A future
fully derivable audit format would need a canonical, content-addressed policy
snapshot or registry artifact in addition to these hashes.

Comparison artifacts retain the old class projection for compact filtering, and
add a fixed per-metric decision snapshot only for audit: policy/catalog
identity, catalog decision id, scorecard eligibility, reason codes, and whether
the result was recorded or legacy-recomputed. A same-class metric is therefore
still marked changed when its promotion provenance changes. The projection does
not include catalog rationales, evaluator metadata, or free-form evidence text.

Tournament registry and benchmark artifacts expose a singular
`metricPromotionPolicy`/catalog descriptor only when every evaluation report
has the same descriptor. A mixed tournament uses `null` for those singular
fields, sets `mixedMetricPromotionPolicies`, and preserves the complete sorted
`metricPromotionPolicies` list. This prevents the first episode's policy from
being misrepresented as a tournament-wide rule.

## Canonical Commit Lifecycle

The production player-step lifecycle is:

```text
selected pending action
  -> scoped environment observation and visible social messages
  -> actor observe
  -> policy/reasoner decision and staged proposal
  -> runner verifies scheduled action/message ownership
  -> optional pure `validateAction(command, pending)` preflight
  -> validate proposed message envelopes
  -> environment validates and commits typed command again
  -> message bus publishes validated drafts
  -> actor receives actor-scoped committed receipt
  -> actor commits turn/memo/decision/last-plan state
  -> post-feedback agent snapshot is captured
  -> native SocialHarnessStep is finalized
```

`WerewolfSocialActorAdapter.decide()` stages proposal data. It does not increment
the actor's committed turn count or persist the memo, decision, or last plan.
`SocialActor.onStepResult()` receives the outcome. The Werewolf adapter calls
`WerewolfAgentActor.commitTurn()` only for a `committed` receipt. The
post-environment snapshot hook runs after that receipt, so its agent-state hash
describes the committed actor state at that boundary.

The runner owns a separate `transactionId` for that lifecycle. An action's
`traceId` is evidence identity and may be supplied by a domain adapter or
policy; it must never be used as the key that resolves staged private state.
Each receipt carries the runner transaction id, and the runner gives actors an
isolated serializable receipt copy. An actor therefore cannot mutate an action
or metadata object that will later be written into the native artifact. The
Werewolf adapter computes its expected post-commit agent-state hash while the
proposal is staged, then verifies that the committed staged state matches it;
it does not fill or rewrite artifact metadata from the receipt callback.

Failure semantics are explicit:

- A decision, message-validation, or environment-step failure produces a
  `SocialHarnessStep` with `commitStatus: "rejected"` and structured `failure`
  evidence.
- A rejected step retains proposal and failure evidence, publishes no messages,
  owns no committed message range, and does not count as a committed actor turn.
- A rejected step must not change the domain-state hash.
- If actor feedback fails after the environment and message bus already
  committed, the step remains `commitStatus: "committed"` and carries
  `actor_step_feedback` failure evidence. Playback therefore follows
  `commitStatus`, not the mere presence of an `error` field.
- If a post-step snapshot/observer hook fails after commit, the step likewise
  remains committed and records `after_environment_step` or combined
  post-commit failure evidence.
- If an environment mutates state and then throws, the runner records
  `environment_non_atomic_failure`; this violates the environment contract and
  is explicitly non-replayable rather than being silently accepted as a normal
  rejected proposal.

System transitions such as `system.advance` are explicit native system steps.
Playback must not infer or silently insert a missing system transition.

## Environment And Action Authority

`WerewolfEnvironment` exposes `snapshot()`, `pending()`, `pendingActions()`,
`observe()`, pure `validate()`, `step()`, and `done()`. The generic adapter
maps the pure check to `SocialEnvironment.validateAction(command, pending)` so
the runner can reject an illegal proposal before it publishes a message draft.
`step()` retains the same legality assertion as the authoritative second check.
The environment has no trace-writing or error-writing method. It checks that
each submitted command matches the current pending action and its legal targets
before applying it through the core engine.

The generic `SocialEnvironment` contract requires `step()` and `stepBatch()` to
be atomic: if either throws, a following `snapshot()` must be observationally
unchanged. The runner cannot invent a rollback for arbitrary domain state. It
does detect hash-visible violations, preserves structured failure evidence, and
refuses to treat such a trajectory as deterministic replay authority. The
Werewolf joint batch implementation applies into an isolated working state and
only assigns it after every command succeeds.

Before the environment preflight, the runner also enforces that the scheduled
actor owns `SocialAction.actorId` and every message draft's `senderId`.
Environment adapters remain responsible for command-payload identity because a
generic `TCommand` need not expose an actor field.

The only domain mutations are accepted typed commands such as
`system.advance`, `seer.inspect`, `werewolf.killVote`, `witch.act`,
`speech.submit`, `vote.cast`, and `hunter.shoot`. Prompt text, private memos,
provider request ids, retry telemetry, evaluator output, and UI state cannot
directly mutate the environment.

Scheduling mode does not weaken this boundary:

- `aec` decides and applies one selected actor transition at a time.
- `aec-batched-decision` may collect decisions from a shared decision state but
  applies them sequentially.
- `parallel` is a true joint environment transition only when the environment
  implements `stepBatch()`. Concurrent reasoner calls alone are not a parallel
  environment.

Before concurrent collection, every joint batch must have one pending action
per actor. Duplicate actor ids are rejected as explicit scheduler-validation
records before any `observe()` or `decide()` call, preventing two speculative
turns from racing over one actor's staged state. A true parallel batch delivers
all committed actor receipts before any post-step snapshot hook runs, so every
snapshot frame for that batch describes the same complete post-commit agent
set. If an AEC batched proposal is abandoned because another decision fails or
an earlier sequential transition ends the episode, the proposal still receives
a rejected receipt and an explicit `batch_aborted` native step. It is preserved
for audit and replay, but is not counted as a second root harness/provider
failure.

## Observation And Communication

An observation is an actor-scoped projection, not a copy of global state.
`PlayerView` carries public state plus only the private facts legally visible to
that player. The social observation assembler adds only channels and messages
visible through the communication bus.

Message envelopes record intended recipients and channel visibility. They do
not by themselves prove that an actor observed a message. Actor-scoped
`SocialExposureRecord` evidence is the authority for who actually saw what and
when. This distinction is required for influence, deception, belief-update, and
hidden-information evaluation.

## Agent And Reasoner

An agent is a harness-managed social actor with durable identity, profile/role
assignment, observations, memory, beliefs, relationships, reputation, norms,
goals, policy, arbitration, and committed decision state. Its serializable
state supports audit, checkpoint/fork work, and postgame comparison.

The current reasoner receives scoped visible context and a policy plan through
one streaming cognition request. It may produce public speech for a speech
action or a private tactical memo plus an optional internal
`ACTION_CANDIDATE` envelope for an action proposal. The envelope is advisory
evidence only: `WerewolfAgentActor.applyReasonerProposal()` keeps the policy's
command kind and accepts only legal target/resource choices, then the
environment validates the resulting command again. Structured data is useful
for typed commands and artifacts, but returning JSON is not agency.

## Artifact Separation

`MatchArtifact` version `harness.match.v2` has three deliberately separate
record families:

- `finalState` and `events` are Werewolf domain truth.
- `socialEpisode` is native scheduler/environment/message-bus execution
  authority. Its steps contain observations, actions, `commitStatus`, hashes,
  event/message ranges, trace metadata, and failures.
- `trajectory` is a legacy successful-player-command projection retained for
  checkpoint migration. It omits native system and rejected steps and is not
  execution authority.

Native scheduler `turnIndex` counts native steps. Legacy trajectory
`turnIndex` counts its older player-only projection. Their values have different
semantics and must not be assumed equal; trace ids provide the migration
cross-link for committed player steps.

JSONL export preserves the same separation:

- `event` records come only from domain events;
- `social_step` records come from native episode steps;
- `trace` records are extracted from native step action metadata;
- `error` records are extracted from native structured step failures.

Metrics and evaluators follow those sources. Outcome and game-rule facts come
from domain state/events. Harness turn counts, provider usage/latency, rejected
attempts, and failure attribution come from native social-step evidence. A
provider call used by a rejected proposal may still count toward real usage,
but it is not a committed domain or actor turn.

## Deterministic Playback And Fork/Rerun

`replaySocialEpisode()` and `replayWerewolfSocialEpisode()` implement native
deterministic playback. Playback:

1. starts from the recorded `socialEpisode.initialState`;
2. restores the recorded initial message prefix and verifies its hash;
3. processes explicit native steps in order;
4. applies only steps whose `commitStatus` is `committed` and skips rejected
   steps while checking that they changed neither domain state, event range,
   nor messages;
5. uses `stepBatch()` for a recorded atomic parallel batch;
6. for an adapter-bound artifact, exact-matches the supplied replay runtime
   manifest before calling `environment.step()` or `stepBatch()`;
7. verifies pre/post state hashes, domain event ranges, message ranges and
   envelopes, final state hash, and final message hash;
8. when a domain supplies `validateRecordedAgentState`, audits a recorded
   receipt-after durable snapshot against its prior snapshot, the replay
   pre/post state, committed messages, and canonical scoped-observation
   exposures. A true parallel batch is audited once only after its full atomic
   receipt boundary.

Playback constructs no actors and invokes no policy, reasoner, or provider.
The optional agent-state callback is pure and receives only recorded prefix
evidence; it cannot use future steps, reconstruct an actor, or obtain a model
judgment. This provides a domain-neutral seam for rejecting a rehashed social
memory/belief/relationship snapshot whose cited evidence was never visible to
that actor, without making the generic harness understand a domain's beliefs.
`replayHarnessTrajectory()` remains only for legacy trajectory/checkpoint
migration; it is not the match-v2 execution authority.

An artifact containing `environment_non_atomic_failure` is not a valid replay
artifact. The runner keeps that failure record for diagnosis, but playback
returns a mismatch instead of pretending that the broken transition can be
reproduced by skipping it.

Domain event timestamps are deterministic sequence-derived values rather than
wall-clock reads. They remain displayable event metadata while allowing the same
seed and command sequence to produce identical event arrays and state hashes.

A fork/rerun is different: it restores an immutable checkpoint into a new run,
may invoke actors and providers again, and must preserve parent/checkpoint
provenance and divergence evidence. New checkpoints use
`harness.checkpoint.v2`: the checkpoint binds the native execution prefix,
explicit system/committed/rejected steps, scoped channel topology, committed
message prefix, domain state, actor snapshots, batch-safe boundary, and
content hashes. Fork provenance uses native boundary turn/trace, execution
prefix, channel, message, state, actor, and adapter hashes. A checkpoint
runtime must exact-match the recorded adapter manifest before verifier,
environment factory, or actor restoration work starts. It does not reinterpret
a legacy trajectory length as a native scheduler position.

This terminology intentionally avoids calling model/API re-execution
"deterministic replay." New model calls always create a rerun or fork, never a
playback of recorded truth.

## Guardrails

- Do not reintroduce harness trace/error pseudo-events into `GameState`.
- Do not add a mutable pre-step hook that can alter domain state with telemetry.
- Do not commit agent decision state before environment and message commit.
- Do not replay from the legacy projection when a native social episode exists.
- Do not infer a missing system transition during native playback.
- Do not treat intended message recipients as proof of observation.
- Do not let model output or UI state bypass typed command validation.
- Do not compute authoritative metrics from unverified model claims.
- Do not call a provider during deterministic playback.
