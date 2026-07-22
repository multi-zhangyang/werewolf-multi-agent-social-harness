# Social Adversarial Harness

This project now separates the generic multi-agent harness from the Werewolf presentation layer.

The harness goal is to run a small adversarial society:

- Agent profiles define identity, model, temperature, policy, role/persona metadata, and experiment identity.
- Environments expose scoped observations and legal pending actions.
- Actors observe, maintain private state, plan, and emit typed actions.
- Communication happens through explicit channels and messages.
- The runner records an episode artifact with steps, commands, observations, hashes, messages, and status.
- Evaluators read facts from the artifact and terminal state; model text is never trusted as the source of truth.

## Generic Layer

The standalone contract lives in `src/harness/social.ts`.

Core objects:

- `SocialAgentProfile`: model/persona/policy identity for an experimental actor.
- `SocialChannel`: public, team, private, and system communication topology.
- `SocialMessage`: recorded communication event with channel, sender, recipients, visibility, content, metadata, optional top-level `speechActs`, and optional `deliveryReceipts`.
- `SocialEnvironment`: domain adapter boundary with `snapshot`, `pendingActions`, `observe`, `step`, and `done`.
- `SocialParallelEnvironment`: optional extension for true joint-action resolution through `stepBatch(actionsByAgent)`.
- `SocialStepFeedback`: environment transition feedback with state, per-agent rewards, terminations, truncations, infos, and episode-level termination/truncation reasons.
- `SocialActor`: stateful actor boundary with profile, observation handling, and decision production.
- `SocialDomainAdapterManifest`: safe, canonical execution provenance for a new domain adapter: domain/adapter id and version plus semantic hashes for environment, command codec, observation projection, scheduler, and agent-state schema. It never contains closures, prompts, provider data, credentials, or private state.
- `SocialEpisodeArtifact`: replay/eval artifact containing profiles, channels, initial/final state, steps, messages, metrics, and optional adapter provenance. Old artifacts without a manifest remain legacy-compatible; a manifest-bearing artifact requires the exact runtime manifest before replay or checkpoint restoration can mutate an environment.

This layer is domain-neutral. It does not import Werewolf rules.

For `harness.match.v2`, `SocialEpisodeArtifact.steps` is also the native
execution authority. It records explicit system steps, committed player steps,
rejected proposals, scheduler/batch metadata, scoped observations, commands,
message/event ranges, failures, and hashes. The Werewolf `trajectory` field is a
legacy migration/debug projection only.

## Agent Scaffold And Scorer Registry

The generic agent scaffold lives in `src/harness/scaffold.ts`. It represents an
actor as identity, private memory, social state, optional reasoner memo,
candidate generation, evidence-backed candidate scoring, and action
arbitration. A model-backed reasoner can draft memo text, but it is not the
agent and it cannot mutate the environment.

The scaffold observation ingestor now consumes actor-visible social messages
from the scoped social observation path and records evidence-backed
memory/social-state updates through `AgentSocialState` store APIs. It is
domain-neutral: it does not read a global transcript, does not infer exposure
from public visibility or `recipientIds` alone, does not parse
natural-language-only content into social facts, and does not use hidden truth.
It accepts the existing `SocialObservation.visibleMessages` contract and the
wrapped `view.social.messages` shape used by adapter-projected views rather
than creating a parallel transcript interface.

`resolveAgentActionCandidateScorers()` is an internal scaffold resolver that
turns scorer configs into the existing `AgentActionCandidateScorer` protocol.
The default registry currently exposes only `weighted-social-state`. That
scorer reads the actor's own `AgentSocialState` and adds score contributions to
already generated candidates that declare `socialTargetIds`. The scorer can
consume relationship, reputation, belief, goal, norm, commitment, coalition,
gossip, norm-sanction, trust-repair, and betrayal ledgers when those ledgers
already exist in the actor state.

This resolver is not a public profile/spec field yet. CLI/API experiment
profiles still accept only the fields documented below. Production Werewolf
planning still uses `WerewolfAgentActor`, `planAction()`, and
`policy.social-target-arbitration.v1`. That Werewolf-specific policy can read
explicit society ledgers from the actor's social state for legal pressure/vote
target ranking, but scorer configs themselves still do not affect Werewolf
matches. A future bridge must be explicit and tested before scaffold scorer
configs become runtime profile/spec inputs.

### Scheduler Semantics

The generic runner supports three scheduler modes:

```text
aec
```

One selected actor observes, decides, and applies one environment transition.
This is the correct mode for strongly ordered phases such as seer inspection,
witch action, hunter shot, and sequential speeches.

```text
aec-batched-decision
```

Multiple actors decide from the same `decisionStateHash`, which lets the runner
parallelize actor/model work without changing environment semantics. Commands
are still applied one by one in deterministic order. This mode is useful for
current vote/kill collection when the environment has not implemented atomic
joint resolution.

```text
parallel
```

True joint-action mode. The environment must implement `stepBatch()`. The runner
must not silently degrade `parallel` into repeated `step()` calls. Conflict
resolution, tie breaks, rewards, terminations, truncations, and infos are owned
by the environment's atomic batch transition.

`simultaneous-batch` is kept only as a compatibility alias for
`aec-batched-decision`.

`Promise.all()` over actor/model calls is only an execution optimization. It is
not true parallel environment semantics.

Before environment preflight, the generic runner verifies that a scheduled
actor owns the returned `SocialAction.actorId` and every message draft's
`senderId`. This prevents one actor from impersonating another through a
generic action or social channel. Command-payload identity remains a domain
adapter responsibility because a generic command does not necessarily carry an
actor field.

`SocialEnvironment.step()` and `SocialParallelEnvironment.stepBatch()` are
atomic contracts: a throw must leave `snapshot()` unchanged. The runner cannot
roll back arbitrary domain state. When a hash-visible adapter violates that
contract, it records `environment_non_atomic_failure`; the failure remains
diagnostic evidence but is not valid replay authority. The communication bus
also prepares and validates a complete message batch before the environment
commits, then appends that batch atomically.

## Werewolf Adapter

Werewolf currently acts as one domain adapter:

- `WerewolfEnvironment` is the game-rule authority.
- `WerewolfAgentActor` is the stateful actor wrapper.
- `OpenAIHarnessReasoner` is only a speech/memo component inside the actor.
- `runHarnessMatch()` returns both Werewolf-specific results and a generic `socialEpisode` artifact.
- During `runHarnessMatch()`, the harness keeps a `SocialCommunicationBus`.
- Actor observations are assembled as `HarnessPlayerView`: the normal scoped `PlayerView` plus `social.channels` and `social.messages` visible to that actor.
- Public speech, public votes, hunter shots, werewolf team kill votes, private role actions, and private reasoner memos are emitted as `SocialMessage` envelopes after successful environment transitions.
- The bus assigns stable message ids, sequence numbers, timestamps, top-level speech acts, and delivery receipts when it commits those envelopes.
- `socialEpisode.steps[*].messageSeqRange` points back to the messages created by that turn.
- Werewolf supplies scoped `HarnessPlayerView.social.messages` as the first
  proof surface for the generic scaffold observation ingestor.
- The Werewolf actor path delegates reusable visible social-message ingestion
  to the generic ingestor instead of owning a parallel ingestion contract.
  It still performs Werewolf-specific interpretation for role claims, public
  votes, hunter shots, and wolf kill preferences.
- Actor-scoped speech-act and structured-fact ingestion consumes only
  `social.messages` present in each actor's `HarnessPlayerView`. It does not
  read a global transcript, infer exposure from public visibility or
  `recipientIds`, or use hidden truth.
- `AgentSocialState.messageIngestion` persists the exact actor-consumed message
  ids behind the reusable ingestor. The actor-local `seenMessageIds` set is only
  a performance cache: snapshot/checkpoint/fork restoration hydrates it from
  the versioned private tracker, and legacy snapshots best-effort migrate ids
  still present in retained message memory. Bounded-memory trimming therefore
  cannot make a restored actor reapply relationship, reputation, ledger,
  memory, or journal consequences from the same message.
- The tracker uses exact ids rather than a message-sequence high-watermark, so a
  lower-sequence message that becomes legally visible later is still ingested.
  Only messages already present in the actor-scoped observation enter the
  tracker; hidden/global transcript ids are never inferred. Ordinary
  `postgame-redacted` API projections retain the schema marker but clear the
  private consumed-message identities.
- Tested top-level `role_claim`, `accusation`, `vote_intent`, `role_action`,
  `claim`, `commitment`, and non-kill `coalition_signal` acts update private
  actor social state through existing evidence-backed memory, belief, gossip,
  commitment, and coalition store APIs.
- Tested structured `metadata.socialFacts` updates cover relationship,
  reputation, commitment/status, coalition/evidence, gossip, norm/status,
  norm-sanction/status, trust-repair/status, and betrayal/evidence records.
  Relationship and reputation consequence updates are accepted only from
  explicit structured numeric deltas; ordinary visible speech no longer writes
  default relationship/reputation ledger mutations.
- Natural-language-only message content is not parsed into social facts.
- `evaluation.social-fact-ingest-evidence.v1` is implemented as a deterministic,
  zero-weight postgame coverage diagnostic. It checks whether explicit
  top-level `commitment` / non-kill `coalition_signal` speech acts and
  structured relationship/reputation `metadata.socialFacts` that appeared in
  actor-scoped observations have matching evidence-backed social-state journal
  mutations.
- The diagnostic uses scoped `SocialExposureRecord` evidence from actor
  observations plus message and journal evidence refs. It does not infer
  exposure from a global transcript, `recipientIds`, or public visibility alone.
- This evaluator does not parse free text, infer hidden truth, assert causality,
  claim persuasion/deception success, affect rewards, or drive leaderboard
  ranking.
- Deterministic deception evaluators consume top-level `speechActs` for
  false-role-claim exposure, belief/reputation temporal association, and
  pressure-vote-follow metrics, while preserving metadata fallback for legacy
  Werewolf messages.
- `postgame-redacted` artifact projections now include sanitized
  `socialEpisode.exposureRecords` and `socialEpisode.exposureSummary` generated
  from scoped observations before private observations are redacted.

The reasoner input is intentionally scoped. It receives:

- `HarnessPlayerView` (`PlayerView` plus visible social messages/channels)
- `AgentPendingAction`
- readonly agent context
- policy plan

It does not receive full `GameState`, so custom reasoners cannot inspect hidden role truth through the harness interface. Team and private messages are filtered by the bus before they enter `view.social.messages`.

For communicative turns, a reasoner may also return a bounded list of
provider-neutral social-intent drafts (`claim`, `request`, `agreement`,
`disagreement`, `commitment`, `coalition_signal`, `threat`, or
`trust_repair`). A draft is not a message or social fact. It has no sender,
audience, visibility, id, evidence, or arbitrary metadata. The Werewolf adapter
first validates actor-visible targets and team membership, then the generic
message bus commits the accepted act and assigns message evidence. Actor
stores update only when that committed message later appears in the actor's
scoped observation.

## Experiment Profiles

Profiles can be provided by CLI/API as:

```bash
--profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35
```

Format:

```text
id:model[:policyName[:temperature]]
```

JSON arrays are also accepted by the parser:

```json
[
  {
    "id": "wolf",
    "model": "model-wolf",
    "policyName": "wolf-deceiver",
    "temperature": 0.7
  }
]
```

Implemented profile fields are `id`, `model`, `policyName`, and `temperature`. Valid `policyName` values are `balanced`, `wolf-deceiver`, `village-analyst`, `seer-information`, `witch-conservative`, and `hunter-punisher`. Scaffold scorer registry configs are not accepted in public profiles yet.

`--models` is still a shortcut for generated profiles. Generated ids are derived from the model name and index, for example `model-a-1`.

## Assignment JSON

Assignment config is defined by `HarnessAssignmentConfig` in `src/harness/profiles.ts`. It is used by `resolveAgentConfigs()`, `runTournament({ assignment })`, the match/tournament CLI `--assignment` flag, `AGENT_ASSIGNMENT`, and the Express `assignment` request field on match and tournament runs.

Default rotation:

```json
{
  "strategy": "profile-rotation"
}
```

Explicit seats use one-based seat numbers as object keys:

```json
{
  "strategy": "seat",
  "seats": {
    "1": "wolf",
    "2": "village"
  },
  "fallback": "profile-rotation"
}
```

Role assignment maps Werewolf roles to one profile id or a rotating list:

```json
{
  "strategy": "role",
  "roles": {
    "werewolf": "wolf",
    "seer": "village",
    "villager": ["village", "wolf"]
  },
  "fallback": "error"
}
```

Team assignment maps teams to one profile id or a rotating list:

```json
{
  "strategy": "team",
  "teams": {
    "werewolves": "wolf",
    "village": ["village", "wolf"]
  }
}
```

Supported role keys are `villager`, `werewolf`, `seer`, `witch`, and `hunter`. Supported team keys are `village` and `werewolves`. `fallback` is `profile-rotation` by default; use `error` when every relevant seat, role, or team must be covered explicitly.

CLI entry:

```bash
npm run arena:tournament -- \
  --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 \
  --assignment='{"strategy":"role","roles":{"werewolf":"wolf","villager":["village","wolf"]},"fallback":"profile-rotation"}' \
  --games=3 \
  --json=summary
```

API entry:

```bash
curl -X POST http://localhost:8787/api/tournaments/run \
  -H 'content-type: application/json' \
  -d '{"profiles":[{"id":"wolf","model":"model-wolf","policyName":"wolf-deceiver"},{"id":"village","model":"model-village","policyName":"village-analyst"}],"assignment":{"strategy":"team","teams":{"werewolves":"wolf","village":"village"},"fallback":"error"},"games":1,"maxTransitions":24}'
```

## Experiment Specs

The reusable control plane is `GenericExperimentSpecV1`, normalized to the
pure-JSON `harness.experiment.v1` contract by
`normalizeGenericExperimentSpec()`. It records domain/adapter identity, seed,
episode and actor counts, generic scheduler mode, profiles/model assignments,
execution bounds, evaluator ids, assignment/artifact/checkpoint/retry/provider
policy references, and domain-owned portable configuration. Provider policy is
an identity plus `stream: true`; endpoints, keys, headers, max-token controls,
raw request bodies, runtime clients/factories, and abort signals are rejected.
This is the contract a second domain can import from `src/harness/generic.ts`
without importing Werewolf core types.

`createGenericExperimentProvenance()` turns that normalized record into
`harness.experiment-provenance.v1` by retaining the canonical spec and its
stable hash. `HarnessEpisodeArtifactEnvelope.experiment` and
`HarnessCheckpointSource.experiment` carry the identity through persistence and
checkpoint selection. For an experiment-bound fork, the caller supplies the
child provenance and explicitly names every changed top-level spec field.
`harness.experiment-fork-lineage.v1` records both specs/hashes plus before/after
field hashes; validation rejects omitted, invented, duplicate, reordered, or
tampered declarations. Generic code verifies integrity but never guesses what
a seed/profile/model/scheduler/domain-config change means to a domain.

`runGenericExperiment()` is the reusable composition root above this contract.
It resolves evaluator ids before preparing any episode, schedules stable
`${seed}:gN` episode identities, delegates domain execution, binds the exact
experiment provenance into each canonical episode, runs the evaluator registry,
passes the normalized evaluation report to `HarnessEpisodeArtifactStore`, and
builds `harness.tournament-run-set.v1`. It also requires a generic run store:
the active experiment provenance/schedule is durable before the first prepare,
and finalization stores only ordered episode references after re-reading the
canonical episode store. Missing evaluator ids, adapter identity
mismatches, scheduler/actor-count mismatches, and contradictory provenance fail
closed. The generic runner has no provider/model branch and does not turn model
output into environment authority.

Every adapter callback receives a fresh clone of normalized spec/provenance;
mutating it cannot rewrite hidden authority or another episode. The shared run
deadline races in-flight prepare/run/artifact work as well as stopping new
scheduling. Before evaluation, generic identity/status/state/agent/social
fields are compared with the canonical artifact. The public execution result
omits preparation objects and raw domain results.

The single-episode store persists `artifact.json`, `trajectory.jsonl`,
`metrics.jsonl`, reviewed `failures.jsonl`, and a hashed checkpoint registry.
Checkpoint writes/reads/recovery require a separate domain strong verifier;
restart recovery revalidates content hashes, canonical JSONL, ordinary-file
status, realpath containment, and symlink absence. Reading these records never
constructs an actor or reruns a reasoner/provider.
The experiment run store uses immutable active/finalized revisions, treats its
index as a rebuildable cache, and revalidates all canonical episode references
after restart. It does not copy episode artifacts or evaluator sidecars into a
second authority.
The current manifest is v2; a strict compatibility reader recovers the prior
v1 artifact/trajectory-only layout with empty sidecars. Directory hashes are
re-derived from recorded identities, failure rows reject unknown fields, and a
checkpoint must be an exact step/message prefix of its verified parent rather
than merely an internally self-consistent checkpoint with the same run id.

The older contract below remains the Werewolf adapter specialization and CLI /
API compatibility surface; it is not the definition of the generic harness.

`TournamentExperimentSpecV1` is the supported JSON contract for reproducible batch runs. The version string is:

```json
"werewolf.experiment.v1"
```

The checked-in spec is executable:

```bash
npm run arena:tournament -- --spec=experiments/wolf-vs-village.json
```

Minimum useful shape:

```json
{
  "version": "werewolf.experiment.v1",
  "id": "wolf-vs-village",
  "kind": "tournament",
  "seed": "wolf-vs-village-smoke",
  "games": 3,
  "maxTransitions": 24,
  "timeout": "5m",
  "profiles": [
    { "id": "wolf-profile", "model": "model-wolf", "policyName": "wolf-deceiver", "temperature": 0.7 },
    { "id": "village-profile-a", "model": "model-village-a", "policyName": "village-analyst", "temperature": 0.35 }
  ],
  "assignment": {
    "strategy": "team",
    "teams": { "werewolves": "wolf-profile", "village": "village-profile-a" },
    "fallback": "error"
  }
}
```

Normalizer precedence is deliberate: environment defaults < spec fields < explicit CLI/API overrides. That means this is a short validation of the same experiment, not a different contract:

```bash
npm run arena:tournament -- --spec=experiments/wolf-vs-village.json --games=1 --maxTransitions=2 --timeout=90s
```

The API accepts either direct tournament fields or an embedded spec:

```bash
curl -X POST http://localhost:8787/api/tournaments/run \
  -H 'content-type: application/json' \
  -d '{"spec":{"version":"werewolf.experiment.v1","id":"wolf-vs-village","kind":"tournament","profiles":[{"id":"wolf","model":"model-wolf"},{"id":"village","model":"model-village"}],"assignment":{"strategy":"team","teams":{"werewolves":"wolf","village":"village"},"fallback":"error"}},"games":1,"maxTransitions":2}'
```

## Experiment Matrix Control Plane

`MatrixExperimentSpecV1` (`"harness.experiment-matrix.v1"`) composes many
normalized tournament experiments without changing the generic tournament
contract. A matrix may enumerate explicit `cells`, or expand `dimensions` for
models, profiles, assignments, seeds, game counts, transition bounds, and
temperatures. Every cell is run by the harness tournament control plane; the
matrix is an aggregation and artifact layer, not a browser-side simulation.

```bash
npm run arena:matrix -- --spec=experiments/matrix-smoke.json
```

The local API accepts a matrix directly or under `spec`:

```bash
curl -X POST http://localhost:8787/api/experiments/matrix/run \
  -H 'content-type: application/json' \
  -d '{"version":"harness.experiment-matrix.v1","id":"model-screen","kind":"matrix","base":{"models":["model-a","model-b"],"games":2,"maxTransitions":24},"dimensions":{"seeds":["screen-a","screen-b"]}}'
```

Top-level tournament-shaped fields (`models`, `profiles`, `assignment`, `seed`,
`games`, `maxTransitions`, `timeout`, `temperature`, `config`) are safe
overrides for the matrix `base` when the request contains `spec`. Server-side
validation rejects output directories and related filesystem controls both in
the base and in every cell.

Matrix lifecycle accounting is deliberately not binary:

- `cellsCompleted` / `gamesCompleted`: domain-terminal episodes.
- `cellsTruncated` / `gamesTruncated`: deliberately bounded, auditable,
  non-terminal episodes.
- `cellsFailed` / `gamesFailed`: preparation or execution failures.

The matrix result remains `status: "completed"` / `ok: true` if its control
plane scheduled without failures, even if bounded cells are truncated. This
does not imply a terminal game outcome: lifecycle counters and each cell's
`completed | truncated | failed` status remain explicit. Model/profile win-rate
and reward tables use terminal completed seats only; truncated and failed
episodes remain in status denominators and never become synthetic scorecard
rows. Pairwise p-values are descriptive, unpaired seat-level screening values
with Holm adjustment, not claims of causal or statistical model superiority.

With `exportArtifacts: true`, the server writes an allowlisted research bundle
only when `MATRIX_ARTIFACT_BASE_DIR` is configured. If only
`TOURNAMENT_ARTIFACT_BASE_DIR` is configured, matrix bundles are placed under
`<tournament-root>/matrices` so tournament and matrix recovery scanners cannot
confuse each other's UUID directories. Matrix bundles are local research
artifacts because their nested tournament manifests include research identity
and seed material; they are never eligible for public tournament-share routes.
The only registered downloads are the matrix manifest/spec/cells/statistics,
summary and CSV files, plus each nested tournament `manifest.json` — not the
entire nested tournament directory.

## Artifact Requirements

A serious multi-agent adversarial harness must preserve:

- status: completed, truncated, or failed
- termination, truncation, and failure reason
- truncation reason
- initial and final state
- scoped observation per turn
- complete typed command per turn
- scheduler mode
- batch id/index/size where applicable
- `decisionStateHash`
- pre/post state hashes
- reward, termination, truncation, and info feedback by agent
- episode-level terminated/truncated flags
- event seq range
- message seq range
- communication messages
- top-level message speech acts
- top-level message delivery receipts
- scoped social messages in observations
- derived social exposure records from scoped observations
- message seq range per turn
- profile ids and policy ids
- evaluator output
- redacted server exposure projections for ordinary cockpit/API views

The Werewolf adapter emits the native record through
`HarnessRunResult.socialEpisode`. `HarnessRunResult.trajectory` is retained as a
legacy migration/debug projection and is not the execution, replay, checkpoint,
or fork authority.

`GameState` and `GameEvent` contain only deterministic Werewolf domain facts.
Harness turn evidence, reasoner/provider telemetry, rejected proposals, and
structured failure evidence belong to `socialEpisode`; they never change the
domain-state hash. Agent proposal state is staged until the environment accepts
the command, and committed actor state is snapshotted only after actor-scoped
feedback.

## Export and Replay

CLI export is available through stdout or explicit files:

```bash
npm run arena:match -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --maxTransitions=24 --json=full
npm run arena:match -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --maxTransitions=24 --export=artifacts/match-artifact.json --exportJsonl=artifacts/trajectory.jsonl
npm run arena:tournament -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --games=3 --json=full > artifacts/tournament-artifacts.json
```

`arena:match -- --json=full` prints `{ summary, artifact }`. The artifact contains `initialState`, `finalState`, `trajectory`, `socialEpisode`, `events`, `evaluation`, `assignment`, and `resolvedAssignments`. `--export` writes that artifact object directly. `arena:tournament -- --json=full` includes full episode records; both terminal and bounded (`truncated`) episodes remain auditable. A `failed` episode retains structured failure evidence rather than being silently dropped.

Tournament lifecycle accounting is deliberately three-way:

- `gamesCompleted`: games that reached the domain's terminal rule.
- `gamesTruncated`: bounded, replayable but non-terminal games (for example a `maxTransitions` cap).
- `gamesFailed`: preparation or harness execution failures.

Model reward and win-rate aggregates are completed-only. Denominator, artifact,
and benchmark records preserve all three statuses. A tournament response with
`ok: true` / HTTP 200 means that no episode failed; it does **not** claim that
every episode reached a domain terminal state.

Current API behavior:

- `POST /api/matches/run` stores exactly one integrity-validated `MatchArtifact`
  as the authority for each finished match and returns public state, summary,
  `hasArtifact`, and artifact counters derived from it. Pre-artifact lifecycle
  records are separate and cannot masquerade as completed matches.
- `GET /api/matches/:id/artifact` defaults to the server-owned `postgame-redacted` projection. It redacts private observations, private message content, private agent state, and provider/private reasoning while retaining postgame truth for research analysis. `?view=full` is explicit local/debug access only; it is not the default response.
- `GET /api/matches/:id/artifact?view=postgame-redacted` includes sanitized `socialEpisode.exposureRecords` and `socialEpisode.exposureSummary`, derived server-side from full scoped observations before redaction.
- `GET /api/checkpoints/:id/artifact` defaults to the narrower `truth-redacted` projection. `?view=full` is explicit local/debug access; fork execution continues to read the canonical server-side checkpoint rather than any public projection.
- Artifact, checkpoint, and comparison projections set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Explicit full views also set a no-index robots directive. Full match-pair comparisons are request-local and are not saved into the comparison registry.
- `GET /api/matches/:id/trajectory.jsonl` defaults to the `postgame-redacted` JSONL projection. `?view=full` is explicit local/debug export access only. The JSONL contains header, step, trace, message, `social_speech_act`, `social_delivery_receipt`, `social_exposure`, social-state mutation, event, agent-state, and metric lines. Redacted projections use materialized exposure records instead of re-deriving from redacted observations.
- `POST /api/tournaments/run` returns redaction-safe episode summaries with
  `status` and `harnessStatus`; full trajectories and agent/social evidence are
  read from server-owned match artifacts or the registered tournament artifact
  pack. This keeps the response bounded and does not make UI state execution
  authority.

Default match evaluation includes `social.state.v1`,
`evaluation.commitment-coalition-association.v1`,
`evaluation.commitment-coalition-lifecycle-temporal-association.v1`,
`evaluation.social-fact-ingest-evidence.v1`, and `social.dynamics.v1`.
Broader norm, gossip, trust-repair, and betrayal temporal-association
evaluators exist as deterministic zero-weight contracts, but they are not
promoted into the default runtime/tournament registry unless a future change
wires them explicitly.

Replay is available through CLI, server-owned API, and TypeScript entries:

```bash
npm run arena:replay -- --artifact=artifacts/match-artifact.json
```

Use `POST /api/matches/:id/replay` for a server-owned match artifact. The server
does not accept client-submitted state or trajectories as replay truth.

```ts
import { replayWerewolfSocialEpisode } from "./src/harness/replay";

const result = replayWerewolfSocialEpisode(artifact.socialEpisode, {
  stopOnMismatch: true
});
```

Native replay expects the recorded `socialEpisode`. It starts from the recorded
initial domain state, applies explicit system transitions and only steps marked
`commitStatus: "committed"`, skips rejected proposals, validates event/message
ranges and pre/post hashes, rejects non-atomic environment failure records, and
never invents missing system transitions. It
does not create actors or call policies, reasoners, or model providers. Parallel
artifacts require an environment with an atomic `stepBatch()` implementation.
`replayHarnessTrajectory()` remains available only for legacy projection
verification.
The server-owned replay route returns redaction-safe summary evidence by default:
hashes, command counts, and mismatch counts. It does not return the replayed
`finalState`; full postgame/debug state belongs behind explicit artifact routes.

## Checkpoint And Fork Authority

New checkpoints use `harness.checkpoint.v2`. A checkpoint stores domain state,
agent snapshots, and a native `executionPrefix` containing the exact
`socialEpisode` step/message/channel prefix. Its source metadata binds the
boundary trace/native turn/batch, native step and message counts, state,
execution-prefix, agent, channel, and message hashes. Ordinary prefixes must end
at a complete scheduler batch; a terminal rejected failure may be preserved as
an explicit failed-run boundary.

Forks use `harness.fork-provenance.v2`. A fork restores the checkpoint's domain
state, agent states, channel topology, and committed message prefix, then starts
a new lineage that cites the parent native boundary and hashes. Neither
trajectory length nor a legacy trajectory prefix is a checkpoint selector,
replay input, or fork-provenance authority.

When the parent checkpoint is experiment-bound, fork creation also requires a
child experiment provenance and explicit changed-field declarations, even when
the declarations are empty because the spec is unchanged. The child episode
envelope must exactly match the lineage's child spec hash. Omitting experiment
metadata remains allowed only for artifacts/checkpoints created before this
optional binding existed.

`GET /api/checkpoints/:id/artifact` defaults to `truth-redacted`. Explicit
`?view=full` is local/debug access only; the fork endpoint restores the
canonical validated checkpoint from the server store rather than a serialized
public projection.

## Honest Postgame Projection DTOs

Postgame redaction no longer casts a structurally different object back to the
full `MatchArtifact` contract. `src/server/artifactProjection.ts` defines
`PostgameMatchProjectionDto`, `MatchArtifactViewDto`, redacted harness/social
step DTOs, redacted social message/draft/speech-act/delivery/failure DTOs, and
redacted agent/social-state/snapshot-frame DTOs. Redacted observation strings,
commands, and pending actions therefore have honest structural types rather than
pretending to be complete private runtime values.

`MatchComparisonSource` and `TrajectoryJsonlSource` are structural read-only
inputs for comparison and JSONL projection. They accept canonical artifacts or
the corresponding server-owned redacted DTO without weakening
`harness.match.v2` replay/integrity authority.

The projection boundary uses deep whitelists, not shallow top-level deletion:

- pending-action and command DTOs omit legal target ids and private target
  payloads;
- reasoner/turn-trace/action metadata omit provider request ids, retry history,
  stream details, private beliefs, arbitration, targets, and memos;
- social steps omit `infosByAgent`, actor snapshots, raw observations, and raw
  failure metadata;
- private/team message speech acts are omitted, while public speech acts remove
  nested metadata and evidence-ref descriptions;
- nested agent profile, memory, belief, relationship, reputation, and journal
  metadata are removed, and private ledgers remain unavailable in the ordinary
  projection.

Focused validation recorded for this DTO slice passed the public-view suite
11/11, a further focused DTO/comparison/JSONL set of 18 tests, and TypeScript
typecheck. Those focused results do not imply a new full-suite, E2E, or live
provider validation run.

## Next Engineering Steps

- Extend the implemented `evaluation.social-fact-ingest-evidence.v1` coverage
  diagnostic beyond the current commitment/coalition speech-act and
  relationship/reputation structured-fact slice only after preserving scoped
  exposure, journal evidence refs, and zero-weight/non-causal semantics.
- Add UI controls for profiles, assignment strategy, tournament size, and artifact export.
