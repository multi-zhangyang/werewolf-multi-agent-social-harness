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
- `SocialEpisodeArtifact`: replay/eval artifact containing profiles, channels, initial/final state, steps, messages, and metrics.

This layer is domain-neutral. It does not import Werewolf rules.

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

The Werewolf adapter now emits these through `HarnessRunResult.trajectory` and `HarnessRunResult.socialEpisode`.

## Export and Replay

CLI export is available through stdout or explicit files:

```bash
npm run arena:match -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --maxTransitions=24 --json=full
npm run arena:match -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --maxTransitions=24 --export=match-artifact.json --exportJsonl=trajectory.jsonl
npm run arena:tournament -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --games=3 --json=full > tournament-artifacts.json
```

`arena:match -- --json=full` prints `{ summary, artifact }`. The artifact contains `initialState`, `finalState`, `trajectory`, `socialEpisode`, `events`, `evaluation`, `assignment`, and `resolvedAssignments`. `--export` writes that artifact object directly. `arena:tournament -- --json=full` includes `episodes`; completed episodes carry `trajectory`, `socialEpisode`, `assignment`, and `resolvedAssignments`.

Current API behavior:

- `POST /api/matches/run` stores a `MatchArtifact` on completed match records and returns public state, summary, `hasArtifact`, and artifact counters.
- `GET /api/matches/:id/artifact` returns the stored `MatchArtifact`; `?view=postgame-redacted` returns a server projection with private observations, private message content, private agent state, and provider/private reasoning redacted.
- `GET /api/matches/:id/artifact?view=postgame-redacted` includes sanitized `socialEpisode.exposureRecords` and `socialEpisode.exposureSummary`, derived server-side from full scoped observations before redaction.
- `GET /api/matches/:id/trajectory.jsonl` returns a JSONL projection with header, step, trace, message, `social_speech_act`, `social_delivery_receipt`, `social_exposure`, social-state mutation, event, agent-state, and metric lines. Redacted projections use materialized exposure records instead of re-deriving from redacted observations.
- `POST /api/tournaments/run` returns `episodes`; completed entries include `trajectory`, `socialEpisode`, `assignment`, and `resolvedAssignments`.

Default match evaluation includes `social.state.v1`,
`evaluation.commitment-coalition-association.v1`,
`evaluation.commitment-coalition-lifecycle-temporal-association.v1`,
`evaluation.social-fact-ingest-evidence.v1`, and `social.dynamics.v1`.
Broader norm, gossip, trust-repair, and betrayal temporal-association
evaluators exist as deterministic zero-weight contracts, but they are not
promoted into the default runtime/tournament registry unless a future change
wires them explicitly.

Replay is available through CLI, API, and TypeScript entries:

```bash
npm run arena:replay -- --artifact=match-artifact.json
```

```bash
curl -X POST http://localhost:8787/api/replay \
  -H 'content-type: application/json' \
  -d @match-artifact.json
```

```ts
import { replayHarnessTrajectory } from "./src/harness/replay";

const result = replayHarnessTrajectory({
  initialState: artifact.initialState,
  trajectory: artifact.trajectory,
  stopOnMismatch: true
});
```

Replay expects `initialState` plus the recorded `trajectory`. It advances deterministic system phases, re-applies recorded commands, records the saved harness trace, and checks pre/post state hashes. It does not call the reasoner or model provider.
The public API replay route returns redaction-safe summary evidence by default:
hashes, command counts, and mismatch counts. It does not return the replayed
`finalState`; full postgame/debug state belongs behind explicit artifact routes.

## Next Engineering Steps

- Extend the implemented `evaluation.social-fact-ingest-evidence.v1` coverage
  diagnostic beyond the current commitment/coalition speech-act and
  relationship/reputation structured-fact slice only after preserving scoped
  exposure, journal evidence refs, and zero-weight/non-causal semantics.
- Define server-owned redacted DTOs for social ledger summaries before React
  renders detailed commitment, coalition, gossip, sanction, repair, betrayal,
  relationship, or reputation records.
- Add UI controls for profiles, assignment strategy, tournament size, and artifact export.
