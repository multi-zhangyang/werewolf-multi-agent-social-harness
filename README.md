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

## Required LLM environment

The runtime does not use a local scripted substitute when the API key is missing. Set:

```bash
export LLM_CHAT_COMPLETIONS_URL="https://your-openai-compatible-provider.example/v1/chat/completions"
export LLM_PROVIDER_PROTOCOL="openai-chat-completions"
export LLM_API_KEY="..."
export LLM_MODELS="model-a,model-b"
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
- Concrete model ids are runtime configuration, not project defaults.
- Select the adapter explicitly with `LLM_PROVIDER_PROTOCOL`; never infer protocol from a model string.

## Commands

```bash
npm test              # deterministic engine tests
npm run agent:probe   # real OpenAI-compatible model calls inside one harness turn
npm run arena:match   # full multi-agent harness match using the configured models
npm run arena:tournament -- --games=3 --maxTransitions=8 --timeout=5m
npm run arena:matrix -- --spec=experiments/matrix-smoke.json --outputDir=/tmp/werewolf-matrix-smoke --overwrite
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

Probe and match commands print a JSON `summary` with the harness turn, policy, command, model latency, and any real failure reason. Full match output includes a `MatchArtifact`; its `trajectory` and `socialEpisode` are the harness replay/evaluation surfaces.

Artifact export is available through stdout or explicit files:

```bash
npm run arena:match -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --maxTransitions=24 --json=full
npm run arena:match -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --maxTransitions=24 --export=match-artifact.json --exportJsonl=trajectory.jsonl
npm run arena:tournament -- --profiles=wolf:model-wolf:wolf-deceiver:0.7,village:model-village:village-analyst:0.35 --games=3 --json=full > tournament-artifacts.json
```

`arena:match -- --json=full` prints `{ summary, artifact }`. If you redirect stdout, unwrap `.artifact` before passing the file to `arena:replay`; `--export` writes the artifact object directly.
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

Experiment matrix runs are the next layer above tournament runs. A matrix spec
expands either explicit cells or dimensions into normalized tournament cells,
runs each cell through the same harness/tournament path, and aggregates
seat-level outcome statistics across cells:

```bash
npm run arena:matrix -- --spec=experiments/matrix-smoke.json --json=summary

npm run arena:matrix -- \
  --spec=experiments/matrix-smoke.json \
  --outputDir=/tmp/werewolf-matrix-smoke \
  --overwrite \
  --json=summary
```

`experiments/matrix-smoke.json` is intentionally small: one cell, one game, two
transitions, and the configured `yourmodel-k2.7` model. The two-transition budget is
deliberate: it advances past setup and reaches an agent decision, so the
artifact should include real provider request ids and completed streaming
telemetry without pretending to finish a full Werewolf game. For paper-scale
runs, increase `cells`, `dimensions`, `games`, and `maxTransitions`
deliberately.

Matrix artifact directories contain:

- `manifest.json`
- `spec.normalized.json`
- `cells.jsonl`
- `statistics.json`
- `summary.md`
- `model_stats.csv`
- `profile_stats.csv`
- `pairwise_model_comparisons.csv`
- nested tournament manifests under `tournaments/<cellId>/manifest.json`

The matrix statistics include model/profile win rates, Wilson 95% intervals,
reward means, reward standard errors, and pairwise model comparisons using an
unpaired seat-level two-proportion z-test with Holm correction. The statistic is
descriptive screening only: seat rows inside the same game are not independent,
and the artifact explicitly sets `superiorityClaims: false`.

The API equivalent is:

```bash
curl -X POST http://localhost:8787/api/experiments/matrix/run \
  -H 'content-type: application/json' \
  -d '{"spec":{"version":"harness.experiment-matrix.v1","id":"api-matrix","kind":"matrix","base":{"models":["model-a"],"games":1,"maxTransitions":1,"timeout":"5m"}}}'
```

To export matrix artifacts through the API/cockpit, configure either
`MATRIX_ARTIFACT_BASE_DIR` or `TOURNAMENT_ARTIFACT_BASE_DIR`; matrix artifact
sets default under the matrix base, or under
`<TOURNAMENT_ARTIFACT_BASE_DIR>/matrices` when only the tournament base exists.
Without a configured matrix artifact base, the cockpit still runs real matrix
experiments but does not request artifact export.

The API also stores a `MatchArtifact` for completed `/api/matches/run` records:

```bash
curl http://localhost:8787/api/matches/<match-id>/artifact
curl 'http://localhost:8787/api/matches/<match-id>/artifact?view=postgame-redacted'
curl http://localhost:8787/api/matches/<match-id>/trajectory.jsonl
```

Ordinary cockpit flows use `view=postgame-redacted`. That server projection
redacts private observations, private messages, private agent state, and private
model reasoning while preserving sanitized `socialEpisode.exposureRecords` and
`socialEpisode.exposureSummary` derived from scoped observations. Fetch the full
artifact or JSONL only for explicit postgame/debug/export work.

Replay has CLI, API, and programmatic entries:

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

const replay = replayHarnessTrajectory({
  initialState: artifact.initialState,
  trajectory: artifact.trajectory,
  stopOnMismatch: true
});
```

Replay re-applies recorded typed commands from `trajectory` and checks hashes. It should not call the model provider; re-querying a model is a new run, not a replay.
The public API replay response returns hash, command-count, and mismatch
summaries by default; it does not return the replayed `finalState`. Full
postgame/debug truth remains available through explicit artifact routes such as
`GET /api/matches/:id/artifact`.

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

The API route `POST /api/matches/run` accepts `models`, `profiles`, `assignment`, `maxTransitions`, `timeoutMs`/`timeout`, `temperature`, `seed`, and optional game `config`; completed responses include public state, summary, `hasArtifact`, and artifact counters. Ordinary UI reads redacted artifact projections with sanitized exposure records; full private/postgame truth remains behind explicit artifact/JSONL routes. `POST /api/harness/probe` accepts `model`, `timeoutMs`/`timeout`, and optional `seed`. `POST /api/tournaments/run` accepts `models`, `profiles`, `assignment`, `games`, `maxTransitions`, `timeoutMs`/`timeout`, `temperature`, `seed`, `continueOnError`, and optional game `config`; it returns `episodes`, whose completed entries include `trajectory`, `socialEpisode`, `assignment`, and `resolvedAssignments`. `POST /api/experiments/matrix/run` accepts a matrix spec plus the same top-level tournament override fields; it returns summary, cells, statistics, and optional artifact set metadata.

`POST /api/tournaments/run` also accepts `{ "spec": { ... } }`; top-level request fields such as `games`, `maxTransitions`, `timeout`, `profiles`, and `assignment` override the embedded spec using the same normalizer as `arena:tournament -- --spec`.
`POST /api/experiments/matrix/run` follows the same override rule, but applies
top-level fields to the matrix base before cell normalization.
