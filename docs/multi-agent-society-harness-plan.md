# Multi-Agent Society Harness Plan

Last checked: 2026-07-21.

This document is the working basis for the project goal:

```text
Build a domain-neutral, replayable, evaluable multi-agent adversarial/social
harness. Werewolf is the first pressure-test domain and cockpit presentation,
not the product boundary.
```

The core rule stays unchanged:

```text
Agent != chat completion.
Harness != prompt choreography.
JSON != agency.
```

An LLM may be a reasoner, speaker, critic, or reflection component inside an
agent. The harness owns identity, state, visibility, scheduling, legality,
environment commits, artifacts, replay, fork, and evaluation.

## External Basis

These references define the vocabulary we reuse. They are not imported as
runtime dependencies unless a future implementation explicitly chooses that.

| System | Relevant abstraction | Project decision |
| --- | --- | --- |
| PettingZoo AEC / Parallel API | Agent Environment Cycle for sequential turns; Parallel API for simultaneous actions; explicit observations, rewards, terminations, truncations, infos. Sources: https://pettingzoo.farama.org/api/aec/, https://pettingzoo.farama.org/api/parallel/, https://arxiv.org/abs/2009.14471 | Keep `SocialEnvironment` as the authority for scoped observation, legal action, transition, termination, and truncation. Use AEC for ordered speech/role actions; use true batch semantics only when the environment implements atomic batch resolution. |
| OpenSpiel | `Game` describes rules; `State` is a trajectory node; supports chance, sequential, simultaneous, imperfect-information, legal actions, information state, serialization. Sources: https://openspiel.readthedocs.io/en/latest/intro.html, https://github.com/google-deepmind/open_spiel/blob/master/docs/concepts.md, https://arxiv.org/abs/1908.09453 | Separate domain adapter/rules from run state. Treat role assignment, tie breaks, and chance as seeded environment facts. Replay/fork must serialize state, seed, actions, hashes, and adapter version. |
| AIWolf | Werewolf-specific agent lifecycle, public talk, wolf whisper, typed talk acts, role actions, competition statistics. Source: https://aiwolf.github.io/CompetitionProtocolDivision/en/regulation.html | Werewolf adapter should expose public talk and wolf/team/private channels through the generic message bus. Add typed speech-act metadata next to freeform utterance, but do not let AIWolf-specific protocol leak into generic harness core. |
| AutoGen | Runtime-managed identities, serializable messages, direct and pub-sub communication. Sources: https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/core-concepts/agent-identity-and-lifecycle.html, https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html | Use runtime-owned identity and serializable message envelopes. Every message needs channel, sender, recipients, visibility, typed act, content, evidence refs, and delivery/visibility semantics. Do not treat group chat transcript as environment state. |
| LangGraph | Graph/state workflow, reducers, persistence, checkpoints, stores, time travel. Sources: https://docs.langchain.com/oss/python/langgraph/graph-api, https://docs.langchain.com/oss/python/langgraph/persistence | Model the harness as a state machine/graph conceptually: observation projection -> agent update -> policy/reasoner -> arbitration -> environment step -> artifact/evaluator. Keep checkpoint/fork as local artifact authority, not model rerun. |
| OpenAI Agents / Responses / tracing | Agents SDK exposes agents, tools, handoffs, guardrails, streaming, traces/spans; Responses API supports streaming model calls. Sources: https://openai.github.io/openai-agents-python/agents/, https://openai.github.io/openai-agents-python/multi_agent/, https://openai.github.io/openai-agents-python/tracing/, https://platform.openai.com/docs/api-reference/responses | Borrow trace vocabulary and streaming completion discipline. Do not adopt the SDK's "Agent = LLM config" definition as this project's agent definition. Provider adapters remain protocol-based: OpenAI-compatible Chat Completions, OpenAI Responses, Anthropic Messages. |
| Concordia | Generative social simulation with Entities, Components, Engine, Game Master; agents propose actions, GM resolves outcomes. Sources: https://github.com/google-deepmind/concordia, https://arxiv.org/abs/2312.03664 | Use the Game Master principle: social actors can persuade, lie, threaten, or cooperate, but the harness/environment commits facts. Agent scaffold should be componentized: memory, beliefs, relationships, norms, reputation, goals, policy, reasoner. |
| Generative Agents | Memory stream, reflection, planning; social behavior emerges from observation, memory retrieval, reflection, and planning. Source: https://arxiv.org/abs/2304.03442 | Keep memory/reflection/planning explicit and evidence-backed. Reflections should become records with sources and confidence, not untracked prompt context. |
| SOTOPIA / social intelligence benchmarks | Interactive social scenarios, competing/cooperating social goals, holistic social evaluation. Source: https://arxiv.org/abs/2310.11667 | Evaluation should measure goal completion, relationship/reputation shifts, persuasion/deception exposure, strategy adaptation, and safety/norm violations across multi-turn interactions, not just win/loss. |

## Current Local Implementation

The current repository already has a substantial harness foundation.

| Plane | Current owners | Status |
| --- | --- | --- |
| Control plane | `src/harness/experiment.ts`, `src/harness/profiles.ts`, `src/harness/tournament.ts`, CLI scripts, server run routes | Experiment specs, profiles, assignment strategies, tournaments, bounded runs, timeout parsing, and provider protocol selection exist. |
| Environment plane | `src/core/*`, `src/harness/environment.ts`, `src/harness/werewolfAdapter.ts`, `src/harness/runtime.ts` | Werewolf engine owns phases, pending actions, legal commands, deaths, public last words, day-one sheriff election, votes, victory, and deterministic transitions. `GameState` / `GameEvent` are domain-only; harness traces, provider telemetry, and failures cannot change the domain hash. |
| Observation plane | `src/core/view.ts`, `src/harness/social.ts`, `WerewolfAgentActor` path in runtime | Agents receive scoped player views plus visible social channels/messages. Hidden truth is not a normal reasoner input. |
| Society plane | `src/harness/social.ts`, `src/harness/socialState.ts`, `src/harness/actor.ts`, `src/harness/policy.ts` | Message bus, channels, social state stores, relationships, reputation, norms, goals, commitments, coalitions, gossip, sanctions, trust repair, betrayal records, scoped speech-act ingestion, structured `metadata.socialFacts` ingestion, and social-target arbitration exist. Ingestion is evidence-backed and observation-scoped, not transcript inference. |
| Agent plane | `src/harness/scaffold.ts`, `src/harness/socialObservationIngestor.ts`, `src/harness/belief.ts`, `src/harness/reasoner.ts`, `src/harness/policy.ts` | Durable actor state, memory, beliefs, social ledgers, generic scaffold visible social-message ingestion, candidate scoring, action arbitration, and optional provider-backed reasoner exist. The generic scaffold now ingests `SocialObservation.visibleMessages` / wrapped `view.social.messages` into evidence-backed memory and social-state stores through the scaffold observation-ingestor path. Ingestion is scoped to the actor observation, uses explicit typed speech acts / structured social facts only, does not parse free text, and does not use hidden truth. Production Werewolf remains the first proof path over this generic scaffold capability. The model remains an optional reasoner/speech component, not the actor or store owner. |
| Provider plane | `src/agents/openaiClient.ts`, `src/agents/openaiResponsesClient.ts`, `src/agents/anthropicMessagesClient.ts`, `src/agents/providerRegistry.ts` | Protocol-based adapters exist. Live calls are streaming. OpenAI-compatible chat calls do not send max-token fields under current policy. No provider/model special casing should be added. |
| Artifact plane | `src/harness/artifacts.ts`, `src/harness/replay.ts`, `src/harness/matchComparison.ts`, server artifact/checkpoint routes | `harness.match.v2` uses native `socialEpisode.steps` as execution/replay/integrity authority. Zero-model replay, comparison, checkpoint/fork, lineage, branch tree, persistence indexes, and recovery audits exist. `trajectory` is legacy migration/debug projection only. New checkpoints/forks use `harness.checkpoint.v2` / `harness.fork-provenance.v2` over native execution prefixes. |
| Evaluation plane | `src/harness/evaluation.ts`, `src/harness/evaluator.ts`, `src/harness/socialEvaluator.ts`, `src/harness/werewolfResult.ts` | Deterministic outcome, vote accuracy, role survival, influence, deception, belief-shift association, reputation association, calibration, social-state, social-dynamics, social-fact ingest evidence, commitment/coalition association, and commitment/coalition lifecycle evaluators exist with metric ids/evidence refs. The social-fact ingest evidence evaluator is a deterministic zero-weight default runtime diagnostic for scoped exposure-to-journal links; it does not affect rewards or leaderboards. Broader norm/gossip/trust-repair/betrayal temporal evaluators exist as standalone zero-weight contracts and are not default runtime/tournament metrics unless explicitly wired. |
| API/server plane | `src/server/index.ts`, `src/server/store.ts` | Run, replay, artifact, comparison, checkpoint, fork, branch tree, tournament, recovery audit, and config APIs exist. A finished match is stored as exactly one integrity-validated `MatchArtifact`; summaries and public views are derived. Default host is local-only unless `HOST` is explicitly overridden. |
| React cockpit plane | `src/App.tsx`, `e2e/cockpitInteraction.spec.ts` | Ant Design cockpit reads API/artifact truth. Runs/timeline/society/lineage/evaluation/compare workspaces exist. Lineage workspace uses summary checkpoint/fork/branch-tree APIs and does not fetch full checkpoint artifacts in ordinary UI flow. |

The API/server projection contract is now structurally honest.
`PostgameMatchProjectionDto` and `MatchArtifactViewDto` are composed from
redacted harness step, social step/message/action/failure, command/pending-action,
agent/social-state, and snapshot-frame DTOs. `MatchComparisonSource` and
`TrajectoryJsonlSource` let comparison and JSONL serializers consume recorded
canonical or redacted structural fields without casting the projection to a
full replay artifact. Deep whitelists remove legal targets, provider
request/retry/stream telemetry, `infosByAgent`, private/team speech acts, nested
agent metadata, and evidence-ref descriptions. Focused validation for this slice
passed the public-view suite 11/11, a further focused DTO/comparison/JSONL set of
18 tests, and TypeScript typecheck; no new full-suite, E2E, or live-provider
result is implied.

## Harness Invariants

These invariants are non-negotiable for future work.

1. Environment authority

   Only the environment/domain adapter commits state transitions. Agent output,
   reasoner text, React state, and evaluator output are never direct truth
   mutation sources.

2. Scoped observation

   Every agent decision must be explainable from that actor's observation,
   visible messages, memory, social state, and allowed profile/role context.
   Hidden role truth must not enter normal decision prompts or UI state.

3. Typed legality boundary

   Natural language may propose intent or speech. Environment mutations pass
   through typed commands/actions that can be validated and replayed.

4. Society is not transcript

   A society record includes identity, channels, visibility, delivery,
   relationships, reputation, beliefs, goals, norms, coalitions, commitments,
   betrayals, trust repair, evidence refs, and state mutation journal entries.

5. Replay is not rerun

   Native replay consumes `socialEpisode.steps`, including explicit system and
   rejected steps, applies only committed actions, and validates state,
   event, and message ranges/hashes. It never calls actors, policies, reasoners,
   or model providers. A model-backed continuation is a new rerun/fork.

6. Fork has provenance

   A fork must carry parent checkpoint id, parent run/match, parent hashes,
   parent native execution-prefix boundary/counts, message/channel hashes,
   creation reason, and boundary validation. Legacy trajectory length or prefix
   is not lineage authority.

7. Evaluation reads facts

   Metrics are computed from artifacts, environment truth, scoped exposure
   records, state mutation journals, and postgame truth when explicitly marked.
   The evaluator must not trust an agent's self-claim as fact.

8. UI is a cockpit

   React stores filters, selections, open drawers, and form inputs. It does not
   invent hidden truth, winners, checkpoint state, or social facts.

9. Provider protocols stay standard

   OpenAI-compatible Chat Completions, OpenAI Responses, and Anthropic Messages
   are separate protocol adapters. Do not add special branches for a concrete
   hosted endpoint or model id.

10. Live model calls stream

   Live model validation must use streaming, bounded timeout/retry, completion
   accounting, provider failure records, and local parser/action validation.

11. Domain state is not telemetry

   `GameState` / `GameEvent` contain only domain facts. Reasoner memos, provider
   telemetry, harness traces, rejected proposals, and harness failures belong
   to native execution artifacts and do not alter the domain-state hash.

12. Commit precedes durable actor mutation

   A proposal is staged evidence, not a committed turn. Decision memory,
   reasoner memo, turn counters, emitted messages, and post-step agent snapshots
   become committed state only after environment validation and actor-scoped
   feedback. Rejections remain artifact evidence without publishing messages.

## Target Harness Capability Stack

The mature system should be able to run this loop:

```text
experiment spec
  -> seeded domain adapter
  -> profile/model/role assignment
  -> social topology
  -> scheduler
  -> scoped observation projection
  -> agent memory/belief/social update
  -> policy candidates
  -> optional reasoner/reflection/speech stream
  -> action arbitration
  -> environment legality and commit
  -> social message delivery receipts
  -> artifact step/checkpoint
  -> evaluator metrics with evidence refs
  -> replay/fork/tournament aggregation
  -> cockpit visualization
```

The important design choice is that the model is inside the agent plane, while
legality, state transition, replay, fork, and evaluation remain outside it.

## Agent Scaffold Backlog

The next agent work should extend the scaffold as an evidence-backed social
actor, not as a larger prompt. The current `src/harness/scaffold.ts` and
`src/harness/socialState.ts` already contain the basic stores, candidate
arbitration types, and tested actor-scoped speech-act ingestion slice; the
backlog below tracks remaining execution glue and broader coverage.

| Module | Responsibility | Required evidence |
| --- | --- | --- |
| `ObservationIngestor` | Implemented deterministic baseline for scoped visible social messages. It converts `SocialObservation.visibleMessages` and wrapped `view.social.messages` into evidence-backed message memory plus explicit typed speech-act / structured `metadata.socialFacts` social-state updates. Natural-language-only content is stored as ordinary message memory and is not parsed into social facts. Exact consumed message ids are persisted in the actor-private, versioned `AgentSocialState.messageIngestion` tracker so bounded-memory trimming and checkpoint/fork restoration cannot reapply an already consumed message. | Observation trace id, exact actor-scoped message ids, exact message sequence range, actor-scoped visibility, redaction policy. |
| `MemoryRetriever` | Retrieves relevant memories by recency, salience, importance, social target, and current pending action. | Memory entry ids, retrieval scores, reason for retrieval. |
| `BeliefUpdater` | Updates probabilistic claims about roles, teams, statements, contradictions, and action history. | Prior claim id, new evidence refs, confidence delta, contradiction records. |
| `TheoryOfMindStore` | Implemented deterministic baseline: records that agent A observed agent B make an explicit, typed statement (`stated_assertion`, `stated_intent`, `stated_commitment`, `stated_request`, `stated_agreement`, or `stated_disagreement`). This is an attribution ledger, not a claim that B is truthful, privately knows a fact, actually believes it, or will act on it. | Exact visible source message/speech-act id and sequence, observer-scoped delivery, evidence refs, receipt-gated durable state, redacted public projection. Free text, hidden/postgame messages, later actions, role/team truth, and evaluator hindsight are not inputs. Future belief/knowledge/goal inference, expiry, retraction, contradiction resolution, and arbitration weighting require an explicit domain contract. |
| `RelationshipUpdater` | Updates trust, suspicion, affinity, influence, debt, respect, and threat edges. | Message/action/outcome refs and before/after scores. |
| `ReputationUpdater` | Updates public/private reputation for honesty, competence, cooperation, threat, and norm compliance. | Scope, audience, evidence, confidence, source. |
| `NormLifecycle` | Creates, reinforces, violates, sanctions, and repairs norms. | Norm id, expected behavior, violation evidence, sanction/repair evidence. |
| `CommitmentTracker` | Records promises, stances, requested actions, deadlines, fulfillment, breach, and withdrawal. | Speaker, audience, target, deadline, later action evidence. |
| `CoalitionTracker` | Records explicit coalition formation, coordination, shared target persistence, betrayal, and dissolution evidence. Automatic coalition detection from repeated aligned actions remains future work; never treat a single same vote alone as coalition proof. | Repeated aligned actions plus explicit messages; never a single same vote alone. |
| `ClaimExtractor` | Consumes explicit typed speech acts into role claims, accusations, defenses, vote intents, requests, agreements, contradictions, commitments, and coalition signals; the implemented actor-scoped slice covers top-level `role_claim`, `accusation`, `vote_intent`, `role_action`, `claim`, `commitment`, and `coalition_signal` acts through focused tests. Structured `metadata.socialFacts` covers relationship, reputation, commitment/status, coalition/evidence, gossip, norm/status, norm-sanction/status, trust-repair/status, and betrayal/evidence. | Message id, speech act id, subject/target, confidence, adapter/source. |
| `CandidateGenerator` | Produces legal-intent candidates for speaking, voting, role actions, withholding, revealing, accusing, defending, coordinating, or passing. | Pending action id, legal target list, strategy tags. |
| `ReasonerAdapter` | Optional streaming model component that drafts memo, reflection, critique, speech, or candidate rationale. | Stream status, provider request id, latency, usage, parsed text, failure records. |
| `ActionArbitrator` | Scores candidates using utility, role/team goals, social risk, deception exposure, norms, reputation, and legality. | Candidate list, score contributions, rejected candidates, selected candidate id. |
| `DecisionTraceEmitter` | Writes compact, redaction-safe evidence for every decision. | Observation refs, retrieved memory refs, candidate summaries, reasoner telemetry, command type, post-state hash. |
| `RedactedSnapshotter` | Produces private/postgame/debug projections for agent state and social state. | Projection policy, omitted field counts, state hashes. |

Implementation order:

1. Keep `SocialMessage.speechActs` and `SocialMessage.deliveryReceipts` as
   top-level artifact facts. Deterministic deception evaluators now consume
   top-level `role_claim` and `accusation` acts before falling back to legacy
   metadata, and API/UI projections consume server-derived exposure records
   without changing environment authority.
2. Treat explicit actor-scoped speech-act and structured-fact ingestion as the
   current deterministic baseline. Relationship and reputation consequences
   require explicit structured numeric deltas; ordinary visible speech is not a
   default relationship/reputation mutation source. The same scoped ingestion
   now records only explicit statement-level Theory-of-Mind attributions; it
   never parses natural language into a mental state or treats an eventual
   action/outcome as evidence of a prior private intent.
3. Treat generic scaffold visible social-message observation ingestion as the
   current deterministic baseline. It reuses scoped `SocialObservation` /
   wrapped `view.social.messages` contracts, preserves hidden-truth exclusion,
   and does not parse free text. Its exact actor-scoped consumed-message
   identities are durable private state rather than an actor-instance cache or
   a global sequence watermark; this preserves exact-once store consequences
   after bounded-memory trimming and snapshot/checkpoint/fork restoration.
4. Preserve the implemented `evaluation.social-fact-ingest-evidence.v1`
   diagnostic as the current typed speech-act / structured-fact exposure-to-
   journal coverage baseline, then broaden artifact/evaluator evidence chains
   beyond it only through separate metric contracts.
5. Only then expand live reasoner prompts to use the new evidence summaries.

## Evaluation Backlog

The project should keep deterministic evaluators as the default. Model-graded
evaluators can be added later, but they must be a separate metric layer with
their own manifest and evidence refs.

Implemented baselines are deliberately conservative: they provide zero-weight
coverage, association, lifecycle, and temporal-order evidence. They do not
claim persuasion causality, reward impact, leaderboard value, or counterfactual
influence unless a future evaluator contract states and validates that stronger
semantics.

| Family | Metric candidates | Evidence rule |
| --- | --- | --- |
| Deception production | false role claim rate, false accusation rate, fabrication/distortion/omission/misdirection proxy, contradiction with own prior private evidence, strategic silence opportunity rate | A deception production metric needs the utterance, a typed claim/act, postgame truth or prior private evidence, and the agent's opportunity context. |
| Deception detection | suspicion precision/recall/F1, wolf-probability Brier score, false-positive-on-villager rate, deceiver ranking AUC, suspicion slope after exposure | Use only the detector's scoped observations and belief/reputation records available at that time. |
| Deception impact | exposure-adjusted false-claim follow rate, post-exposure belief shift, vote swing, reputation drop, survival benefit | Requires delivery/observation receipt before the later belief/vote/reputation/action change. |
| Persuasion attempt | pressure/request/accusation/defense count, evidence-grounded argument ratio, unsupported pressure ratio, norm invocation count, timing/bid priority | Attempt metrics read typed speech acts and evidence refs, not global transcript guesses. |
| Persuasion effect | vote-intent delta, actual vote swing, request compliance, audience conversion rate, resistance rate, induced norm/secret violation | Requires before/after state and scoped exposure. Do not infer causality from transcript order alone. |
| Coalition formation | repeated aligned vote/action score, mutual defense score, private coordination evidence, shared target persistence, commitment exchange count | A single same-target vote is insufficient. Require repeated behavior or explicit coordination evidence. |
| Coalition quality | cohesion, durability, coordination latency, division of labor, team objective contribution, information sharing efficiency | Compute by coalition id/member ids and timeline evidence. |
| Coalition failure | betrayal rate, broken commitment rate, fragmentation, friendly-fire vote rate, partner exposure rate, post-betrayal trust damage | Requires commitment/coalition records plus later contradictory action/effect evidence. |
| Norm and reputation | norm violation count, sanction rate, repair success rate, reputation calibration, trust repair acceptance | Requires norm/reputation/trust-repair ledgers with before/after values. |
| Harness reliability | invalid command rate, timeout rate, provider failure rate, replay pass rate, fork boundary pass rate, redaction violations | Must include failed/truncated runs in denominators. |

## Werewolf Pressure Mapping

Werewolf remains useful because it compresses many social harness stresses into
one domain:

| Generic harness mechanism | Werewolf mapping | What it proves |
| --- | --- | --- |
| Hidden information | Roles, teams, night actions, private inspection results | Observation projection and redaction work. |
| Public communication | Day speeches, accusations, defenses, vote pressure | Typed speech acts, persuasion attempts, public reputation shifts. |
| Team/private communication | Wolf whisper/team channel, role-private notes | Channel topology and scoped delivery work. |
| Private evidence | Seer result, witch resources/actions, hunter trigger | Agents can use private evidence without leaking it through ordinary UI/API paths. |
| Simultaneous barrier | Vote collection, wolf kill vote, night resolution | Joint actions can be collected then committed atomically. |
| Typed legal actions | vote, inspect, kill, save, poison, shoot, pass, speech submit | Natural language never mutates environment directly. |
| Commitments and betrayal | Public promises, vote commitments, wolf cover stories, partner exposure | Commitment and coalition ledgers are evaluator-ready. |
| Postgame reveal | Final roles, teams, deaths, winner | Evaluators can compare claims/beliefs/actions to truth with explicit visibility. |
| Replay/fork | Fork before a speech/vote/night action and rerun with another model/profile | Counterfactual experiments have provenance. |
| Tournament | Role/seat/seed/model/profile/scheduler variations | Aggregate claims can be reproduced from artifact sets. |

## Next Implementation Goals

### Goal 1: Typed Speech Acts Beside Freeform Speech

Why:

Werewolf deception, persuasion, commitment, and coalition metrics need more than
a raw transcript. AIWolf's protocol is too Werewolf-specific, but it proves the
value of typed talk acts.

Implemented base contract:

```ts
SocialMessage.speechActs?: Array<{
  id: string;
  kind:
    | "claim"
    | "role_claim"
    | "accusation"
    | "defense"
    | "vote_intent"
    | "request"
    | "agreement"
    | "disagreement"
    | "commitment"
    | "coalition_signal"
    | "threat"
    | "trust_repair"
    | "private_note"
    | "role_action"
    | "other";
  subjectId?: string;
  targetId?: string;
  value?: unknown;
  confidence?: number;
  evidenceRefs: EvidenceRef[];
  metadata?: Record<string, unknown>;
}>;
```

Werewolf proof:

- The Werewolf adapter explicitly translates public day speech into
  `role_claim` / `accusation`, public votes into `vote_intent`, wolf kill votes
  into `coalition_signal`, and seer, witch, and hunter actions into
  `role_action`.
- The generic communication bus canonicalizes explicit `speechActs` and generic
  `metadata.socialFacts`; it never infers domain semantics from arbitrary
  metadata fields or command labels.
- Legacy domain metadata remains available to the Werewolf actor as a temporary
  compatibility input, but it is not a generic semantic source.
- Explicit top-level `commitment` and structurally specified `coalition_signal` speech acts
  can be ingested into commitment/coalition ledgers.
- Structured `metadata.socialFacts` can be ingested into relationship,
  reputation, commitment, coalition, gossip, norm, norm-sanction, trust-repair,
  and betrayal ledgers. Free text is not parsed into these facts.

Evaluation impact:

- The implemented false-role-claim exposure, belief temporal association,
  reputation temporal association, and pressure-vote-follow metrics now read
  typed `role_claim` / `accusation` speech acts first, then use metadata only
  as a compatibility fallback.
- Vote-follow-after-pressure metrics reference scoped exposure to a typed
  accusation and preserve `speechActId`, `speechActKind`, and `claimSource`
  provenance in metric metadata.
- `evaluation.social-fact-ingest-evidence.v1` audits scoped exposure-to-journal
  coverage for explicit commitment/coalition speech acts and structured
  relationship/reputation `metadata.socialFacts`. It emits zero-weight link
  count/rate metrics plus missing-mutation diagnostics; it is not a causality,
  persuasion-success, deception-success, reward, or leaderboard metric.
- Commitment/betrayal metrics can reference public commitments and later votes.

Validation:

- `tests/evaluation.test.ts` covers typed `role_claim` priority over conflicting
  metadata, typed `accusation` pressure target priority, and metric provenance
  for `speechActId`, `speechActKind`, and `claimSource`.
- `tests/actorSocialClaims.test.ts` covers actor-scoped speech-act and
  structured-fact ingestion from visible `HarnessPlayerView.social.messages`
  into evidence-backed memory, belief, gossip, commitment, coalition,
  relationship, reputation, norm, sanction, trust-repair, betrayal, policy, and
  journal updates. It covers hidden message exclusion, bus-hidden structured
  facts, natural-language-only non-ingestion, and explicit top-level speech-act
  priority over conflicting legacy metadata.
- `tests/socialGraph.test.ts`, `tests/serverPublicViewApi.test.ts`, and
  `tests/matchComparison.test.ts` cover redacted server exposure projection
  consumption in UI/API/comparison surfaces.

### Goal 2: Delivery Receipts And Observation Receipts

Why:

Persuasion/deception cannot be evaluated from global messages alone. We need to
know who could see what, when, and through which channel.

Generic contract:

```ts
interface SocialDeliveryReceipt {
  id: string;
  messageId: string;
  messageSeq: number;
  channelId: string;
  senderId: string;
  observerId: string;
  visibility: SocialMessage["visibility"];
  deliveredAtTurn?: number;
  observationTraceId?: string;
  redactionPolicy: string;
}
```

Werewolf proof:

- Public messages create receipts for channel-visible observer ids computed by
  `SocialCommunicationBus`.
- Team/private messages create receipts for sender plus recipients allowed by
  the channel and message visibility.
- Postgame messages do not create runtime delivery receipts.
- Actual observed exposure is derived later from scoped observations through
  `deriveSocialExposureRecords()`. A delivery receipt is not itself proof that
  an actor observed the message on a later turn.
- `postgame-redacted` API artifacts materialize a sanitized
  `socialEpisode.exposureRecords` / `socialEpisode.exposureSummary` projection
  before private observations are redacted, so ordinary cockpit views can render
  scoped exposure evidence without reading raw observation payloads.

Evaluation impact:

- Delivery receipts give the exact runtime-visible audience. Metrics that need
  actual observation should use `SocialExposureRecord`.
- Belief/reputation temporal association can require receipt-before-mutation.
- UI social graph can distinguish "message existed" from "agent observed it".

Validation:

- Tests for public/team/private receipt visibility.
- Replay checks that receipt ordering is stable.
- E2E checks cockpit exposure table still uses API truth.

### Goal 3: Agent Reflection As Artifact, Not Prompt Residue

Why:

Generative Agents and Concordia show reflection is important, but unrecorded
reflection becomes unreplayable prompt state.

Generic contract:

```ts
interface ReflectionRecord {
  version: "harness.reflection.v1";
  id: string;
  agentId: string;
  createdAtTurn: number;
  kind: "memory_summary" | "belief_revision" | "strategy_update" | "social_risk" | "goal_revision";
  content: string;
  evidenceRefs: EvidenceRef[];
  confidence: number;
  visibility: "private" | "team" | "postgame";
  source: "policy" | "reasoner" | "evaluator" | "human";
}
```

Werewolf proof:

- Villager revises suspicion after speeches.
- Werewolf updates deception risk after public pressure.
- Seer updates information plan after inspections.

Evaluation impact:

- Information-use metric can compare reflection evidence to later votes.
- Deception susceptibility can compare false-claim receipts to belief revision.
- Strategy adaptation can be scored across phases.

Validation:

- Fake reasoner test creates deterministic reflection.
- Live streaming probe validates reflection parsing/storage only after provider
  stream completes.
- Replay does not regenerate reflections; it reuses recorded ones.

### Goal 4: Joint-Action Barrier For True Simultaneous Phases

Why:

Current batched decisions can parallelize model calls, but true simultaneous
environment semantics need atomic commit.

Generic contract:

```ts
interface JointActionBarrier<TPending, TCommand> {
  barrierId: string;
  pendingActions: TPending[];
  requiredActorIds: string[];
  optionalActorIds: string[];
  commandsByActor: Record<string, TCommand>;
  legalityByActor: Record<string, "accepted" | "rejected" | "missing" | "timed_out">;
  resolutionPolicy: string;
}
```

Werewolf proof:

- Day vote collection commits as one vote resolution barrier.
- Werewolf night kill vote commits as one team barrier.
- Tie breaks and absent commands are deterministic and artifact-recorded.

Evaluation impact:

- Vote coordination, abstention, timeout, and target-switch metrics become
  unambiguous.
- Scheduler waterfall can distinguish decision parallelism from environment
  atomicity.

Validation:

- Environment unit tests for `stepBatch`.
- Replay hash tests for barrier commit.
- UI waterfall E2E checks barrier records.

### Goal 5: Tournament Evidence Pack

Why:

For paper-quality experiments, a leaderboard row is not enough. Every aggregate
needs provenance and downloadable evidence.

Generic contract:

```text
tournament artifact set =
  experiment spec
  + environment/domain adapter version
  + provider config summary with secrets redacted
  + seed list
  + episode manifests
  + match artifacts
  + metrics JSONL
  + analysis CSV tables
  + human-readable summary
  + failure records
  + replay verification report
  + aggregation report
```

Werewolf proof:

- Run model/profile A vs B across role assignments and seeds.
- Export win rate, vote accuracy, deception exposure, belief calibration,
  latency, failure rate, replay pass rate, per-agent rows, per-episode rows,
  evaluator metric rows, and leaderboard rows.

Evaluation impact:

- Paper figures can be regenerated from local artifact sets.
- Failed matches remain counted instead of silently disappearing.

Validation:

- Tournament artifact tests for manifest completeness.
- Replay verifier over every completed match.
- CLI/API download test.

## Frontend Cockpit Direction

The cockpit should keep using Ant Design components and server truth. The
important views are:

1. Runs: experiment registry, model/profile assignment, status, artifact count.
2. Timeline: committed steps, scheduler/batch/barrier waterfall, reasoner stream
   telemetry, replay status.
3. Society: channels, messages, server-projected delivery/exposure graph,
   relationship/reputation state, mutation journal.
4. Lineage: checkpoints, fork lineage, branch tree, provenance and boundary
   validation. Ordinary UI uses summary APIs only.
5. Evaluation: metric registry, evidence refs, warning coverage, deterministic
   vs model-graded separation.
6. Compare: postgame-redacted match comparison, changed rows, metric deltas.
7. Tournament: artifact sets, leaderboard, failure accounting, replay pass rate.

UI quality means the user can click and the server moves. A beautiful static
screen is not acceptable.

## Validation Ladder

Use this ladder for non-trivial harness work:

```text
typecheck
  -> focused deterministic unit tests
  -> server API contract tests
  -> build
  -> local-only Playwright cockpit flow
  -> bounded streaming model probe if provider/reasoner changed
  -> bounded streaming match
  -> bounded streaming tournament
```

Do not replace live validation with a fake smoke test when the change touches
provider/reasoner behavior. Fake clients are useful for deterministic tests, not
for proving the live path.

## Current Verified Slice

As of this update, the current harness/society slice is:

```text
society.speech-act-commitment-coalition-ingestion.v1
society.structured-relationship-reputation-consequence-ingestion.v1
evaluation.social-fact-ingest-evidence.v1
agent.scaffold-visible-social-observation-ingestion.v1
agent.durable-social-message-ingestion-idempotency.v1
```

Current verified facts:

- `WerewolfAgentActor` consumes only actor-scoped `HarnessPlayerView.social.messages`.
- `agent.scaffold-visible-social-observation-ingestion.v1` moves visible social-message
  ingestion into the generic scaffold observation-ingestor path. The ingestor
  consumes only messages already present in the actor's scoped
  `SocialObservation.visibleMessages` / `view.social.messages`, updates
  `AgentSocialState` through existing evidence-backed store APIs, and keeps
  Werewolf as a proof domain rather than the owner of the capability.
- The generic scaffold observation ingestor records ordinary visible messages
  as evidence-backed memory and applies only explicit typed `SocialMessage.speechActs`
  / structured `metadata.socialFacts` through existing store APIs.
- Top-level `commitment` and structurally specified `coalition_signal` speech acts can create
  commitment and coalition records through existing social-state store APIs.
- Structured `metadata.socialFacts` can create relationship/reputation
  consequence mutations only when explicit numeric deltas are present.
- `evaluation.social-fact-ingest-evidence.v1` is implemented as a deterministic
  zero-weight postgame diagnostic.
- It links explicit actor-scoped exposure candidates to social-state mutation
  journal entries for top-level `commitment` speech acts, top-level structurally
  specified `coalition_signal` speech acts, structured relationship `metadata.socialFacts`
  with explicit numeric deltas, and structured reputation `metadata.socialFacts`
  with explicit numeric deltas.
- Candidate exposure comes only from scoped observation-derived exposure records,
  not a global transcript, `recipientIds`, or public visibility alone.
- Generic scaffold ingestion likewise reads only actor-scoped observation
  messages. It does not read global transcripts, infer exposure from public
  visibility or `recipientIds`, or use hidden truth.
- Visible-message exact-once identity is now durable in the actor-private,
  versioned `AgentSocialState.messageIngestion` tracker. It survives bounded
  memory trimming and snapshot/checkpoint/fork restoration, while legacy
  states best-effort hydrate retained message evidence. Exact ids are used
  instead of an unsafe global sequence watermark, and ordinary redacted API
  projections clear the private identity list.
- Missing-mutation candidates are reported as diagnostics, not failure,
  no-effect, causality, reward, deception success, persuasion outcome, or
  leaderboard evidence.
- Ordinary visible speech no longer produces heuristic relationship/reputation
  ledger mutations.
- Free text is not parsed into social facts.
- Hidden messages excluded from the actor view do not enter private social state
  or policy arbitration.
- This deterministic slice did not touch provider adapters, reasoner request
  shape, streaming protocol, timeout/retry policy, or live model arbitration.

Validation passed:

- `npx vitest run tests/actorSocialClaims.test.ts --reporter=dot`
- `npx vitest run tests/scaffold.test.ts tests/actorSocialClaims.test.ts --reporter=dot`
- `npx vitest run tests/actorSocialClaims.test.ts tests/socialState.test.ts tests/social.test.ts tests/scaffold.test.ts tests/harness.test.ts tests/artifacts.test.ts tests/evaluation.test.ts --reporter=dot`
- `npx vitest run tests/socialState.test.ts tests/evaluation.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot`
- `npx vitest run tests/social.test.ts tests/werewolfAdapter.test.ts tests/harness.test.ts --reporter=dot`
- `npx vitest run tests/actorSocialClaims.test.ts tests/werewolfAdapter.test.ts tests/harness.test.ts --reporter=dot`
- `npx vitest run tests/serverPublicViewApi.test.ts tests/serverTournamentArtifactsApi.test.ts tests/serverMatchArtifactsApi.test.ts --reporter=dot`
- `npx tsc --noEmit --pretty false --noErrorTruncation`
- `npm test -- --reporter=dot`

Current observed results after `agent.scaffold-visible-social-observation-ingestion.v1`:

- Focused scaffold/Werewolf actor suite passed: 2 files / 29 tests.
- Focused social-state/evaluation/artifact/tournament suite passed: 4 files /
  56 tests.
- Focused social/Werewolf adapter/harness suite passed: 3 files / 55 tests.
- Focused server public/tournament/match artifact API suite passed: 3 files /
  33 tests.
- Typecheck passed.
- Full deterministic Vitest suite passed: 23 files / 240 tests.
