# Werewolf Multi-Agent Arena

React + TypeScript implementation of a real social-deduction game loop and a multi-agent adversarial harness. The engine is deterministic and event-sourced; the harness owns observation, belief updates, role policies, action arbitration, trajectories, and metrics. Provider-backed model adapters are used as pluggable reasoner/speech components, not as Agents themselves.

Harness terminology is defined in [docs/architecture.md](docs/architecture.md), with the standalone social harness contract in [docs/social-harness.md](docs/social-harness.md), external research notes in [docs/harness-research.md](docs/harness-research.md), and the current multi-agent society harness plan in [docs/multi-agent-society-harness-plan.md](docs/multi-agent-society-harness-plan.md). In project terms, an Agent is the stateful player actor managed by the harness; an LLM is only the optional reasoner inside that actor.

## Run

```bash
npm install
cp .env.example .env.local
# Fill LLM_API_KEY or export it in the shell.
npm run dev
```

Frontend: `http://127.0.0.1:5173` by default. If that port is occupied, Vite will pick the next local-only port and print it.

API: `http://127.0.0.1:8787` by default. Set `HOST` explicitly if you intentionally want a different bind address.

> Deployment boundary: the bundled Express server is a **local research and
> development server**, not an Internet-facing multi-tenant service. It has
> local-only defaults and local gates for full/research artifacts, but run,
> probe, and postgame research routes are intentionally not a public auth
> surface. Do not bind it directly to a public interface. Put any remote use
> behind an authenticated, rate-limited reverse proxy and use the
> truth-redacted share APIs rather than research projections.

## Required LLM environment

The runtime does not use a local scripted substitute when the API key is missing. Set:

```bash
export LLM_CHAT_COMPLETIONS_URL="https://your-openai-compatible-provider.example/v1/chat/completions"
export LLM_PROVIDER_PROTOCOL="openai-chat-completions"
export LLM_API_KEY="..."
export LLM_MODELS="grok-4.5"
export LLM_STREAM=true
export LLM_TIMEOUT_MS=120000
export LLM_RETRY_COUNT=2
```

Default protocol is `openai-chat-completions`. In that protocol no `max_tokens`, `max_completion_tokens`, or equivalent max-token request limit field is sent. Streaming is enabled by default through `stream: true`. Transient retries use the same model only; the harness does not substitute another model or use a fake local fallback.

Provider integration policy:

- Do not add provider-specific request/response branches for one hosted endpoint.
- OpenAI-compatible Chat Completions adapters must follow the OpenAI-compatible `/chat/completions` request and SSE streaming shapes.
- OpenAI Responses support is implemented as a separate `openai-responses` protocol adapter with `/responses`, `input`/`instructions`, and `response.output_text.delta` stream events.
- Anthropic support is implemented as a separate `anthropic-messages` protocol adapter with Messages/SDK-shaped `system`, `messages`, `stream`, and `content_block_delta` events. Anthropic Messages requires explicit `ANTHROPIC_MAX_TOKENS`; this is not sent by the default Chat Completions adapter.
- Concrete model ids remain runtime configuration. The checked-in local template
  currently selects `grok-4.5`; changing it must not create a provider- or
  model-specific adapter branch.
- Select the adapter explicitly with `LLM_PROVIDER_PROTOCOL`; never infer protocol from a model string.
- Default `agent:probe`, `arena:match`, and `arena:tournament` CLI summaries expose only provider protocol/configuration state, bounded metrics, safe failure classification, and stream-completion status. They deliberately omit provider endpoints, provider request ids, and raw provider errors. `--json=full` is explicit local/debug output and must not be published without applying the artifact redaction policy.

## Werewolf proof ruleset

The first adapter is the documented deterministic `classic-9-seat-v1` proof
ruleset. It has one optional Seer, Witch, and Hunter at most; duplicate special
role cards are rejected at game creation rather than silently losing a turn.
The engine, not a model or the React cockpit, owns the following rules:

- `sheriff: "day1"` opens a public day-one election after night resolution.
  Every living player casts one unweighted ballot, including self-nomination.
  A unique plurality becomes sheriff; a tie or all-abstention leaves the office
  vacant. The elected sheriff's ordinary exile vote uses
  `sheriffVoteWeight`. The office becomes vacant on death; this ruleset has no
  unconfigured transfer/tie-break procedure.
- `lastWords: "all"` queues one ordered public final statement per eliminated
  player before the engine resumes the next public/night phase.
  `firstNightOnly` applies only to first-night kill/poison deaths, and `none`
  suppresses the phase. Last words are typed `lastWords.submit` actions and
  recorded public messages/events, not transcript-only UI text.
- Witch save must target the actual selected wolf-night victim, and poison
  must target a living non-self player. These checks exist in the core engine
  as well as the harness adapter.
- `wolfDiscussion: "one_turn"` enables one serialized, wolf-team-only
  `werewolf.whisper` per living wolf before the night kill-vote batch. It is
  off by default so existing experiment specifications retain their previous
  transition and provider-call budgets; enable it explicitly in a game config
  when studying private coordination.
- `timers` are presentation/default-duration metadata for human-facing
  surfaces. They are not a wall-clock authority for unattended model runs;
  harness `timeout` and `maxTransitions` are the deterministic execution
  bounds recorded in artifacts.

Different real-world Werewolf variants make different choices about sheriff
handoff, election ties, hunter poison, and potion timing. Add a versioned
ruleset contract before changing any of these deterministic semantics; do not
hide a variant change in a prompt or UI branch.

## Commands

```bash
npm test              # deterministic engine tests
npm run agent:probe   # real OpenAI-compatible model calls inside one harness turn
npm run arena:match   # full multi-agent harness match using the configured models
npm run arena:tournament -- --games=3 --maxTransitions=8 --timeout=5m
npm run build         # typecheck and production build
```

Profile-based adversarial run:

```bash
npm run arena:tournament -- \
  --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 \
  --games=3 \
  --maxTransitions=24 \
  --timeout=5m \
  --json=summary
```

Profiles are `id:model[:policyName[:temperature]]`. They are the harness-level Agent identities used for profile stats, trajectory records, social episode artifacts, and evaluator output. `--models` remains a shortcut that creates default profiles.

The profile parser also accepts a JSON array with the implemented fields `id`, `model`, `policyName`, and `temperature`:

```json
[
  { "id": "wolf", "model": "model-wolf", "policyName": "wolf-deceiver", "temperature": 0.7 },
  { "id": "village", "model": "model-village", "policyName": "village-analyst", "temperature": 0.35 }
]
```

Assignment JSON controls profile placement. It is accepted by `--assignment`, `AGENT_ASSIGNMENT`, `POST /api/matches/run`, `POST /api/tournaments/run`, and the library-level `runTournament({ assignment })`. Supported strategies are:

```json
{ "strategy": "profile-rotation" }
```

```json
{ "strategy": "seat", "seats": { "1": "wolf", "2": "village" }, "fallback": "profile-rotation" }
```

```json
{ "strategy": "role", "roles": { "werewolf": "wolf", "seer": "village" }, "fallback": "error" }
```

```json
{ "strategy": "team", "teams": { "werewolves": "wolf", "village": ["village", "wolf"] } }
```

`roles` supports `villager`, `werewolf`, `seer`, `witch`, and `hunter`. `teams` supports `village` and `werewolves`. Role/team values may be a profile id string or a profile id array; arrays rotate by local role/team occurrence and episode index. `fallback` is `profile-rotation` by default, or `error` to require explicit coverage.

Example assignment run:

```bash
npm run arena:match -- \
  --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 \
  --assignment='{"strategy":"team","teams":{"werewolves":"wolf","village":"village"},"fallback":"error"}' \
  --maxTransitions=24 \
  --json=summary
```

Experiment specs make tournament runs reproducible. The checked-in spec at `experiments/wolf-vs-village.json` uses `version: "werewolf.experiment.v1"` and is executable:

```bash
npm run arena:tournament -- --spec=experiments/wolf-vs-village.json
```

Spec fields are normalized by the harness, not by ad hoc CLI parsing: `id`, `kind`, `seed`, `games`, `maxTransitions`, `timeout`/`timeoutMs`, `profiles`, `assignment`, `temperature`, `json`, `continueOnError`, and optional game `config`. Environment values are defaults, spec fields override them, and explicit CLI flags override the spec:

```bash
npm run arena:tournament -- --spec=experiments/wolf-vs-village.json --games=1 --maxTransitions=2 --timeout=90s
```

The `wolf-vs-village` spec uses team assignment, so werewolf seats are resolved to `wolf-profile` and village seats rotate between `village-profile-a` and `village-profile-b`; it is not just model rotation by seat. The checked-in models are placeholders for contract examples; replace them with runtime-configured live models before claiming real provider validation.

Short real-API validation run:

```bash
npm run arena:tournament -- --games=1 --maxTransitions=2 --timeout=90s --json=summary
```

API equivalents:

```bash
curl -X POST http://localhost:8787/api/harness/probe \
  -H 'content-type: application/json' \
  -d '{"model":"model-a","timeout":"90s"}'

curl -X POST http://localhost:8787/api/tournaments/run \
  -H 'content-type: application/json' \
  -d '{"models":["model-a","model-b"],"games":1,"maxTransitions":2,"timeout":"90s"}'
```

Probe and match commands print a JSON `summary` with the harness turn, policy,
command, model latency, and any real failure reason. Full match output uses
`harness.match.v2`. Its `socialEpisode.steps` are the native execution, replay,
and integrity authority. `trajectory` remains only a legacy migration/debug
projection and must not be used to reconstruct missing native system or rejected
steps.

Artifact export is available through stdout or explicit files:

```bash
npm run arena:match -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --maxTransitions=24 --json=full
npm run arena:match -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --maxTransitions=24 --export=artifacts/match-artifact.json --exportJsonl=artifacts/trajectory.jsonl
npm run arena:tournament -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --games=3 --json=full > artifacts/tournament-artifacts.json
```

`arena:match -- --json=full` prints `{ summary, artifact }`. If you redirect stdout, unwrap `.artifact` before passing the file to `arena:replay`; `--export` writes the artifact object directly. Full artifacts can contain private observations and reasoner evidence, so keep local exports under the ignored `artifacts/` directory or outside the repository.
`socialEpisode.messages[*]` may include top-level `speechActs` and `deliveryReceipts`; these are evaluator-ready typed facts, not only display metadata. JSONL exports include flat `social_speech_act`, `social_delivery_receipt`, and derived `social_exposure` records for analysis.

Tournament directory export is the paper/reproduction artifact pack. Use
`arena:tournament -- --outputDir=<dir>` or `POST /api/tournaments/run` with
`exportArtifacts: true` and a configured `TOURNAMENT_ARTIFACT_BASE_DIR`. The
directory includes `manifest.json`, `spec.normalized.json`, `assignment.json`,
aggregate `episodes.jsonl` / `trajectory.jsonl` / `metrics.jsonl`, per-match
artifacts under `matches/`, audit files (`integrity.jsonl`, `failures.jsonl`,
`cost_latency.json`), deterministic aggregate reports (`leaderboard.json`,
`benchmark_statistics.json`), a human-readable `summary.md`, and tabular
analysis exports (`episodes.csv`, `agents.csv`, `metrics.csv`,
`leaderboard.csv`). CSV files are derived from recorded harness artifacts; they
do not replace replay or JSONL evidence.

The API also stores a `MatchArtifact` for completed `/api/matches/run` records:

```bash
curl 'http://localhost:8787/api/matches/<match-id>/artifact?view=postgame-redacted'
curl 'http://localhost:8787/api/matches/<match-id>/artifact?view=truth-redacted'
curl 'http://localhost:8787/api/matches/<match-id>/artifact?view=full'
curl 'http://localhost:8787/api/matches/<match-id>/trajectory.jsonl?view=postgame-redacted'
```

A finished server match has exactly one validated `MatchArtifact` as its
canonical stored value; response summaries, counters, public state, trajectory
JSONL, and cockpit views are derived projections. The domain `GameState` and
`GameEvent` stream contain only Werewolf facts. Reasoner memos, provider
telemetry, harness traces, and harness failures live in the native execution
artifact and do not alter the domain-state hash.

Omitting `view` for a match artifact or trajectory JSONL is equivalent to
`view=postgame-redacted`. That server projection redacts private observations,
private messages, private agent state, and private model reasoning while
preserving sanitized `socialEpisode.exposureRecords` and
`socialEpisode.exposureSummary` derived from scoped observations.
`view=truth-redacted` is the narrower public/share projection. Fetch an
artifact or JSONL with `view=full` only for explicit local postgame/debug/export
work; it is not the API default.

The redacted route now returns an honest `PostgameMatchProjectionDto`, not a
structurally redacted object cast back to `MatchArtifact`. Its redacted harness
step, social step/message, command/pending-action, failure, delivery/speech-act,
agent-state, and snapshot-frame DTOs make omitted private fields explicit in the
type contract. Comparison and trajectory JSONL use their own structural source
types, so they can consume either canonical artifacts or server-owned redacted
projections without treating a projection as replay authority. The projection
uses deep whitelists: legal targets and provider request/stream telemetry are
removed, `infosByAgent` is omitted, private/team speech acts are not exposed,
nested agent metadata is stripped, and evidence-ref descriptions are removed.

### Cockpit projection boundaries

The React Cockpit is a presentation and analysis surface over server-owned
projections; it is never a source of game truth. Its **狼人杀复盘** workspace
renders a narrow review model rather than receiving a raw `GameState` in JSX:

- `postgame-redacted` is a clearly labelled local postgame review. Private
  reasoner evidence is redacted, but it may reveal a seat's role so the game can
  be reviewed after it ends. It is not a public/live-game view.
- `truth-redacted` is the public/share-safe view. The review board displays
  only public phase/day data, seat status, public speeches, sheriff/exile
  ballots, deaths without a source id, and public event metadata. It never
  derives or renders a seat role, team, ability, night action, private social
  message, agent state, model/profile identity, winner, or raw event payload.

The client-side selector fails closed: even if an incorrectly shaped upstream
`truth-redacted` payload contains hidden fields, they are not copied into the
review model. The authoritative server projection and its API tests remain the
security boundary; the selector is a second containment boundary for the UI.

Replay has CLI, server-owned API, and programmatic entries:

```bash
npm run arena:replay -- --artifact=artifacts/match-artifact.json
```

Use `POST /api/matches/:id/replay` for a server-owned match artifact. The server
does not accept client-submitted state or trajectories as replay truth.

```ts
import { replayWerewolfSocialEpisode } from "./src/harness/replay";

const replay = replayWerewolfSocialEpisode(artifact.socialEpisode, {
  stopOnMismatch: true
});
```

Native replay starts from the recorded `socialEpisode.initialState`, applies
explicit recorded system steps and only committed player steps, validates
domain event/message ranges and hashes, and skips rejected proposals. It does
not call actors, policies, reasoners, or model providers. Re-querying a model is
a new fork/rerun, not replay. `replayHarnessTrajectory()` remains a legacy
projection verifier, not the `harness.match.v2` authority.
The server-owned replay response returns hash, command-count, and mismatch
summaries by default; it does not return the replayed `finalState`. Full
postgame/debug truth remains available through explicit artifact routes such as
`GET /api/matches/:id/artifact`.

Persisted checkpoints use `harness.checkpoint.v2` and bind a batch-safe native
`executionPrefix` together with domain state, agent snapshots, channel topology,
message prefix, hashes, and boundary metadata. Forks use
`harness.fork-provenance.v2`; they restore that native prefix state and record
parent native-step/message/hash provenance. Legacy trajectory length is not a
checkpoint selector or lineage authority.

`GET /api/checkpoints/:id/artifact` defaults to `view=truth-redacted`; explicit
`view=full` is local/debug access only. Fork execution always restores the
canonical validated checkpoint stored by the server, not an API projection.

### Domain-neutral checkpoint and fork contract

The Werewolf server routes remain Werewolf adapters, but the underlying
checkpoint operation is now reusable without importing Werewolf state, roles,
or a reasoner. `buildHarnessCheckpointAtPrefix()` selects exactly one complete
native scheduler boundary, resolves the domain-owned durable actor snapshot at
that boundary, replays the prefix without actors or model calls, and emits the
existing generic `HarnessCheckpointEnvelope`. `runForkedHarnessEpisode()` then
asks the domain only to restore its environment and actors from that recorded
state; it does not deserialize policy closures or provider clients.

```ts
import { buildHarnessCheckpointAtPrefix } from "./src/harness/episodeArtifacts";
import { runForkedHarnessEpisode } from "./src/harness/checkpointRuntime";

const checkpoint = buildHarnessCheckpointAtPrefix({
  artifactVersion: "ledger.checkpoint.v1",
  kind: "ledger-checkpoint",
  sourceArtifactVersion: "ledger.episode.v1",
  episode,
  selector: { nativeStepCount: 12 },
  // Domain-owned durable actor state; never recreated by a model during replay.
  resolveAgentSnapshot,
  replayPrefix: replayLedgerEpisode
});

const fork = await runForkedHarnessEpisode({
  checkpoint,
  runtime: { createEnvironment, restoreActors },
  episode: { id: "ledger-fork-01", schedulerMode: "aec" }
});
```

`runHarnessEpisode()` also accepts an opt-in `captureAgentSnapshots` callback.
It records a cloned full actor-state snapshot only after an environment commit
and receipt delivery (after the full receipt set in a parallel batch), then binds the
snapshot hash to the native step. `replaySocialEpisode()` audits inline
recorded snapshots when present; that audit checks hashes, rejected-step
non-mutation, and shared parallel-batch state without constructing an actor or
calling a model. Canonical compacted match artifacts use the generic
`harness.agent-snapshot-frame.v1` sidecar registry: its frame id/hash/payload
binding, references, and final-agent hash are audited model-free during replay.
Domain adapters may add stronger domain-specific snapshot schema checks, but
they must not reconstruct durable agent state from commands or retry a model.

The generic tournament control plane can likewise persist a minimal research
run set through `buildGenericTournamentRunSetArtifact()` and
`writeGenericTournamentRunSetArtifact()`. Its fixed layout is
`manifest.json`, `episodes.jsonl`, `metrics.jsonl`, and one canonical
`episodes/<index>.json` file per materialized domain episode. This layer owns
only ordered seeds and `completed | truncated | failed` accounting; domain
adapters own artifact validation, replay/fork codecs, redaction, public shares,
and any role/team/winner leaderboard semantics. Runtime `prepared` objects are
intentionally never serialized.

Historical end-to-end validation on 2026-07-14 used the then user-specified configured
OpenAI-compatible endpoint and `tencent/hy3:free`. The streaming probe passed
1/1. A first match with a 40-second bound timed out and correctly remained a
failed/rejected native step with zero commits; this failure is part of the
validation record, not discarded. A second `maxTransitions=2` match completed
its model stream with `completedBy: provider_stop_event`, committed one model
turn with zero harness errors, then ended with the expected bounded `truncated`
status. Its two native steps replayed with matching state/message hashes, zero
mismatches, and full artifact integrity success.

The production Express-backed Playwright cockpit passed 1/1 and treats HTTP 207
or any reported harness failure as test failure. The first real tournament run
exposed a model-list parser bug: `splitModels()` incorrectly split slash-bearing
model ids. The delimiter was narrowed from `/[,\s/]+/` to `/[,\s]+/` and an
experiment regression test was added. The second real tournament completed one
game with zero failed games, one harness turn, zero harness errors, and 641
metrics. Final deterministic validation passed 24 test files / 253 tests,
TypeScript typecheck, production build, and `git diff --check`. The existing
large-chunk build warning and intentional invalid-streaming-JSON parser-test
stderr remained non-fatal. No provider request id, credential, or raw sensitive
provider output is part of these records.

Current incremental validation is intentionally recorded separately from that
historical run: the production dependency audit is clean after moving the
dev-only launcher out of runtime dependencies and upgrading its vulnerable
transitive parser; focused engine/harness tests cover sheriff election, last
words, role cardinality, core witch legality, and day-vote separation. A
bounded real streaming probe is required whenever the provider/reasoner path
changes and is reported only through its safe summary.

Useful CLI limits:

```bash
# Probe one real harness turn per model. Duration values accept ms, s, or m.
npm run agent:probe -- --models=model-a --timeout=30s

# Run a bounded full match. maxTransitions limits engine/harness transitions.
npm run arena:match -- --models=model-a,model-b --seed=smoke-1 --maxTransitions=40 --timeout=3m
```

For non-interactive validation you can also set:

```bash
export PROBE_TIMEOUT_MS=30000
export MATCH_MAX_TRANSITIONS=40
export MATCH_TIMEOUT_MS=180000
export TOURNAMENT_GAMES=3
export TOURNAMENT_TIMEOUT_MS=600000
```

The API route `POST /api/matches/run` accepts `models`, `profiles`, `assignment`, `maxTransitions`, `timeoutMs`/`timeout`, `temperature`, `seed`, and optional game `config`; completed responses include public state, summary, `hasArtifact`, and artifact counters. Ordinary UI reads the default `postgame-redacted` artifact projections with sanitized exposure records; `truth-redacted` is the public/share projection, while full private/postgame truth requires an explicit `view=full` artifact or JSONL request. `POST /api/harness/probe` accepts `model`, `timeoutMs`/`timeout`, and optional `seed`. `POST /api/tournaments/run` accepts `models`, `profiles`, `assignment`, `games`, `maxTransitions`, `timeoutMs`/`timeout`, `temperature`, `seed`, `continueOnError`, and optional game `config`; it returns bounded, redaction-safe episode summaries plus `gamesCompleted`, `gamesTruncated`, and `gamesFailed`. `gamesCompleted` means the domain reached a terminal outcome; `gamesTruncated` means an auditable run hit a configured bound; `gamesFailed` is an execution failure. `ok: true` means no failures, not that every game reached terminal state. Full trajectory/social evidence remains server-owned in match artifacts and tournament packs.

`POST /api/experiments/matrix/run` adds the reusable experiment-matrix control
plane (`harness.experiment-matrix.v1`): it schedules normalized tournament cells
from explicit cells or dimensions, preserves `completed` / `truncated` /
`failed` cell and game counts, and returns server-recorded model/profile and
descriptive pairwise statistics. Terminal completed seats are the only
win-rate/reward denominator; bounded and failed episodes remain visible rather
than being promoted to completed results. `exportArtifacts: true` writes a
local-only research bundle to `MATRIX_ARTIFACT_BASE_DIR` (or a namespaced
`matrices` child under `TOURNAMENT_ARTIFACT_BASE_DIR`). Registered matrix
downloads are allowlisted and are intentionally separate from public
tournament-share routes. The Cockpit's **实验矩阵** workspace consumes these
server projections and download URLs; it does not calculate winners, p-values,
or artifact paths locally.

`POST /api/tournaments/run` also accepts `{ "spec": { ... } }`; top-level request fields such as `games`, `maxTransitions`, `timeout`, `profiles`, and `assignment` override the embedded spec using the same normalizer as `arena:tournament -- --spec`.
