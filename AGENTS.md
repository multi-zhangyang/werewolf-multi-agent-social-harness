# AGENTS.md

This file is the operating guide for all agents working in this repository.

The project is **not** merely a Werewolf web game. The target is a
domain-neutral, replayable, evaluable, multi-agent adversarial/social harness.
Werewolf is the first high-pressure domain adapter and React presentation layer.

Read this file before making architecture, harness, agent, evaluation, UI, or
API changes.

Current canonical reading order:

```text
latest user message
  -> section 13 latest execution lock
  -> section 12 active goal charter
  -> section 1 user-specific operating principles
  -> section 7 validation policy
  -> section 8 coding rules
  -> older baseline/status/backlog sections
```

If duplicated guidance appears in this file, preserve the stricter harness-first
interpretation and the newest explicit user correction. Status sections describe
what exists; goal sections describe what must become true before the project is
considered mature.

## 0. Current Project Identity

Project name:

```text
werewolf-multi-agent-arena
```

Core product:

```text
A multi-agent adversarial society harness with Werewolf as the first domain.
```

North star:

```text
Given a set of agent profiles, a social environment, a communication topology,
a scheduler, an evaluator registry, and a seed, the harness can run automated
multi-agent adversarial/social experiments, record what every agent observed,
remembered, believed, said, decided, and caused, and output replayable,
forkable, auditable, and aggregatable artifacts.
```

The system must support:

- multi-agent adversarial play
- hidden information
- scoped observations
- explicit communication channels
- stateful agents
- memory, beliefs, relationships, goals, norms, and reputation
- typed legal actions
- deterministic environment authority
- replay without model calls
- fork/rerun with provenance
- tournament-level evaluation
- React-based game and analysis UI

The wrong target:

```text
Several LLM chat sessions talk to each other and occasionally return JSON.
```

The correct target:

```text
Harness-managed social actors operate in a rule-governed environment. LLMs are
optional reasoner/speech/reflection components inside those actors, not the
actors themselves and not the environment authority.
```

## 1. User-Specific Operating Principles

The user has been explicit about standards. Follow these as repository policy.

1. Be ashamed of guessing interfaces; be proud of reading the code and docs.
2. Be ashamed of vague execution; be proud of seeking confirmation when truly blocked.
3. Be ashamed of inventing business rules blindly; be proud of human-confirmed requirements.
4. Be ashamed of creating new interfaces unnecessarily; be proud of reusing existing ones.
5. Be ashamed of skipping or faking the test flow; be proud of testing proactively.
6. Be ashamed of breaking architecture; be proud of following project boundaries.
7. Be ashamed of pretending to understand; be proud of honest uncertainty.
8. Be ashamed of blind modification; be proud of cautious refactoring.

Additional user preferences:

- The user wants a serious **harness** design, not "AI chat".
- The user rejects making the LLM return JSON as the definition of an agent.
- The user wants multi-agent adversarial society design first; Werewolf is the presentation/domain.
- Real model calls must use streaming to reduce timeout risk.
- The env file is configured for the OpenAI-compatible endpoint and the live
  model set `kimi-k2.7`, `deepseek-v4-flash`, and `minimax-m3`; do not ask the
  user for the key again unless calls fail due to authentication or
  connectivity.
- For large research or implementation tasks, use parallel subagents when allowed by the current tool policy and when the work can be split cleanly.

### 1.1 User Doctrine, Verbatim Intent

The following doctrine is repository policy. Future agents should read it before
planning or coding:

```text
1. 以暗猜接口为耻，以认真查阅为荣
2. 以模糊执行为耻，以寻求确认为荣
3. 以盲想业务为耻，以人类确认为荣
4. 以创造接口为耻，以复用现有为荣
5. 以跳测流程为耻，以主动测试为荣
6. 以破坏架构为耻，以遵循规范为荣
7. 以假装理解为耻，以诚实无知为荣
8. 以盲目修改为耻，以谨慎重构为荣
```

Operational translation:

- Never guess a local interface when code, tests, docs, or type definitions can
  be inspected.
- If a requirement changes behavior, hidden information rules, evaluation
  semantics, persistence format, or public API shape and cannot be inferred from
  existing sources, ask for confirmation instead of inventing the business rule.
- Prefer extending existing contracts over creating new parallel contracts.
- Validate any non-trivial change with the repo's scripts before reporting it as
  done. Do not replace a real required validation with a fake smoke test,
  fallback path, or mock portal.
- Preserve the architecture boundary between generic harness, domain adapter,
  agent scaffold, model client, server API, and React UI.
- Say what is unknown when it is unknown. Do not imply that a design is backed by
  research, tests, or code inspection unless it is.
- Make refactors narrowly, with tests, and with clear migration intent.

### 1.2 Current User Corrections To Preserve

The user has strongly corrected earlier direction. Keep these corrections active:

- This project is a **multi-agent adversarial harness** and a **multi-agent
  society runtime**. The Werewolf game is the first visual/domain adapter, not
  the essence of the product.
- "Ask several AIs to chat" is not the deliverable.
- "Make the model return JSON" is not an agent design. JSON or structured data
  can be an internal typed artifact, parser result, command envelope, evaluator
  record, or trace record, but it is not the definition of agency.
- The harness must own orchestration, scheduling, visibility, communication,
  action legality, state transition authority, artifacts, replay, fork, and
  evaluation.
- Agent design must include durable identity, private state, memory, beliefs,
  relationships, goals, norms, reputation, policy, optional reasoner, and action
  arbitration.
- Multi-agent social behavior means cross-agent communication, deception,
  persuasion, coalition formation, trust, suspicion, reputation, norm pressure,
  coordination, and adversarial adaptation. It is not a transcript-only feature.
- When researching best practices, use current internet sources and primary
  documentation where possible. Do not "imagine" what PettingZoo, AutoGen,
  LangGraph, OpenAI Agents, Concordia, AIWolf, or other harnesses do.
- For real model calls, use streaming requests. Long non-streaming chat
  completions are likely to timeout and are against project policy.
- The OpenAI-compatible endpoint, API key, and model are already in `.env` and
  `.env.local`. Do not ask for them again unless validation proves the values do
  not work. Do not duplicate the secret key in docs, logs, screenshots, or final
  answers.

### 1.3 Subagent Policy

The user explicitly requires using subagents for efficiency. When the current
tool policy exposes multi-agent/subagent tools and the task is a meaningful
development, research, audit, or planning turn, spawn **6** subagents in
parallel with independent, bounded tasks.

This is a standing repository instruction from the user, not a one-turn
permission. The default for meaningful work is a full 6-subagent round. Only
technical tool unavailability, secret-handling risk, or a genuinely tiny
single-step task should reduce that number; if that happens, record the reason.
Use subagents proactively for work that is independent, bounded, and useful to
parallelize, while keeping the main agent responsible for integration and
correctness.

Good subagent splits:

- research scout for current external docs and best practices
- codebase mapper for local modules, tests, and contracts
- harness design critic for scheduler/environment/artifact boundaries
- agent scaffold critic for memory/belief/relationship/norm/goal design
- UI/UX scout for React cockpit layout and hidden-information display rules
- validation/test scout for missing tests, failure modes, and replay concerns

Rules:

- The main agent remains responsible for synthesis, code edits, and final
  correctness.
- Do not blindly paste subagent output. Verify claims against source links,
  local code, or tests.
- Use subagents for parallelizable research, auditing, and alternative analysis;
  do not use them to avoid understanding the architecture.
- If subagent tools are unavailable, continue with direct research/inspection and
  note that no subagents were available if relevant.

### 1.4 Persistent Runtime Configuration

The user has explicitly provided and approved the model endpoint configuration.
Treat the following as persistent project assumptions unless validation proves
otherwise:

```text
LLM_CHAT_COMPLETIONS_URL=https://llm.kimchi.dev/openai/v1/chat/completions
LLM_MODELS=kimi-k2.7,deepseek-v4-flash,minimax-m3
LLM_STREAM=true
```

The API key exists in `.env` and `.env.local`. Never ask the user for this key
again unless a real validation run proves that authentication or connectivity is
broken. Never paste the key into this file, tests, logs, final answers, browser
screenshots, artifacts, or subagent prompts.

Real model calls must use streaming chat-completions requests. The harness may
support non-streaming only for explicit local tests or fake clients, but live
agent decisions should call the OpenAI-compatible endpoint with `stream: true`
and bounded timeout/retry behavior. Long non-streaming calls are considered a
known timeout risk and should not be used for production harness validation.
Live provider request bodies must not include `max_tokens`,
`max_completion_tokens`, or equivalent max-token limiting fields unless the user
explicitly changes this instruction in a later message.

When changing model/reasoner behavior, the validation ladder is:

```text
fake deterministic tests
  -> typecheck
  -> unit/integration tests
  -> bounded streaming probe
  -> bounded streaming match
  -> bounded streaming tournament
```

Do not claim that the configured provider works unless the stream completed, the
response was parsed by the local adapter, and the resulting candidate passed the
policy/arbitration/environment validation path.

### 1.5 Required Work Protocol For Future Agents

Before doing meaningful work, a future agent must:

1. Read this `AGENTS.md`.
2. Inspect relevant local code and tests before naming or changing interfaces.
3. Search current primary sources when the task asks for research or touches
   volatile external APIs/frameworks.
4. Decide whether subagents would materially speed up independent research,
   auditing, or implementation work.
5. Keep the main critical path local while subagents handle sidecar work.
6. Make narrowly scoped edits.
7. Validate proportionally before reporting completion.

The expected loop is:

```text
read local contract
  -> identify exact owner module
  -> inspect nearby tests
  -> optionally delegate independent sidecar tasks
  -> patch the smallest compatible surface
  -> run focused validation
  -> update docs/status if behavior changed
```

Do not:

- invent an interface when the repo already has one
- guess how an endpoint, schema, runner, or evaluator works
- make UI state a source of truth
- add a model call where deterministic replay should run
- write a fake "agent" that is only a chat completion
- hide failures behind aggregate tournament summaries
- leave subagents running after their results are consumed
- leak provider secrets to child tasks

### 1.6 User Correction Handling Protocol

The user has repeatedly corrected the same failure mode: treating this project
as prompt orchestration, AI chat, or model JSON formatting. When the user
mentions `harness`, `multi-agent`, `agent society`, `八荣八耻`, or says that the
assistant is drifting, future agents must stop and re-anchor on this file before
continuing.

Required response pattern after such a correction:

```text
1. Re-read this AGENTS.md, especially sections 1, 2, and 5.
2. Restate the eight operating principles if the user explicitly asks.
3. Identify the actual architecture owner before changing code.
4. Inspect local interfaces/tests or current primary external docs.
5. Produce or implement a harness-level plan, not a chat-only plan.
6. Validate with tests or clearly state which validation was not run.
```

Do not answer these corrections with generic apologies. Convert the correction
into a concrete change in architecture, code, tests, docs, or the work plan.

Examples of acceptable re-anchoring:

- "This belongs in `src/harness/social.ts` because it changes scheduler
  semantics."
- "This belongs in `src/harness/scaffold.ts` or `socialState.ts` because it
  changes agent private state."
- "This belongs in `src/harness/evaluation.ts` because it changes evaluator
  registry behavior."
- "This requires current documentation research because the user asked for
  external harness best practices."
- "This cannot be inferred safely from the repo, so ask the user before
  inventing the business rule."

Examples of unacceptable re-anchoring:

- "We can just ask every model to respond in JSON."
- "The React UI can keep its own hidden role state."
- "The evaluator can ask the acting model whether it deceived someone."
- "Replay can rerun the same prompts."
- "The tournament can drop failed matches from the leaderboard."
- "A transcript is enough to represent social dynamics."

### 1.7 Secret And Env Handling

The user provided the OpenAI-compatible endpoint, API key, and model and asked
that they be configured in env files. Treat that as already handled by `.env`
and `.env.local` unless validation proves otherwise.

Rules:

- Do not paste `LLM_API_KEY` into `AGENTS.md`, tests, artifacts, prompts,
  screenshots, terminal summaries, or final answers.
- It is acceptable for `.env.example` to contain placeholders.
- It is acceptable for `.env` / `.env.local` to contain the real key because
  those are local runtime configuration files, but do not display their contents.
- When checking env state, print only variable names or redacted values.
- If a future agent must update env files, use exact existing variable names
  where possible: `LLM_CHAT_COMPLETIONS_URL`, `LLM_API_KEY`, `LLM_MODELS`,
  `LLM_STREAM`, `LLM_TIMEOUT_MS`, and `LLM_RETRY_COUNT`.
- Never ask the user for the key again unless a real streaming validation call
  proves authentication or connectivity is broken.

Env read boundary:

- Application code, scripts, and tests may load runtime configuration through
  `process.env`, Node `--env-file-if-exists`, or equivalent configured runtime
  loading.
- Agents must not open, `cat`, print, screenshot, quote, summarize, or pass the
  contents of `.env` or `.env.local` to users, logs, prompts, subagents, tests,
  artifacts, or final answers.
- Env audits should use redacted presence checks only, for example variable
  names or `<set>/<missing>` summaries.
- If an env edit is explicitly required, use the existing variable names and do
  not echo secret values in terminal output or final summaries.

### 1.8 Standing User Directives Captured From The Build Conversation

These instructions should be treated as persistent project context. They are not
one-off chat preferences.

Core user intent:

```text
We are building a multi-agent adversarial society harness.
Werewolf is the first concrete domain and UI presentation.
The core deliverable is not AI chat, not prompt choreography, and not JSON output.
```

The user has repeatedly emphasized:

- Build a **harness**: an execution, orchestration, evaluation, replay, and
  artifact system.
- Build a **multi-agent society**: actors have identity, state, communication
  rights, relationships, beliefs, goals, reputation, norms, and adaptive
  strategies.
- Build **adversarial interaction**: deception, coalition, persuasion,
  uncertainty, information asymmetry, strategic voting, tactical silence,
  betrayal, public claims, private coordination, and postgame analysis.
- Use Werewolf to present and pressure-test the system, but keep the generic
  harness reusable for other domains.
- Do not reduce the design to "LLMs chatting with each other".
- Do not reduce the design to "make the model return JSON".
- Do not invent local interfaces. Inspect code first.
- Do not invent external framework behavior. Research current docs first when
  the task depends on external systems.
- Do not ask again for the already configured model endpoint/key/model unless
  real validation proves they are broken.
- Real model calls must use streaming requests.
- A fake, mocked, or deterministic run may be useful as a unit test, but it is
  never proof that the live provider/model path works. Live model validation
  must be a real streaming call through the configured provider.
- For large research, audit, planning, or implementation work, use up to **6**
  subagents in parallel when the current tool environment supports it and the
  work can be split safely.

What "harness" means in this repository:

```text
harness =
  experiment specification
  + profile/model assignment
  + domain adapter
  + scheduler
  + observation visibility
  + social communication topology
  + agent lifecycle management
  + typed action legality boundary
  + environment transition authority
  + trace and artifact recording
  + deterministic replay
  + checkpoint/fork provenance
  + evaluator registry
  + tournament execution
  + UI/API exposure over recorded truth
```

What "agent" means in this repository:

```text
agent =
  durable identity
  + role/profile assignment
  + private state
  + memory
  + beliefs
  + relationships
  + reputation view
  + norms
  + goals
  + policy
  + optional model-backed reasoner
  + action arbitration
  + emitted command/message drafts
```

What "reasoner" means:

```text
reasoner =
  optional component inside an agent.
  It may draft speech, produce a memo, critique a plan, summarize evidence,
  estimate social risk, or propose candidates.
  It is not the agent itself and must not mutate the environment directly.
```

What "JSON" means:

```text
JSON or structured output is an encoding, not agency.
Structured records are useful for commands, artifacts, traces, metrics, and
parser outputs, but they do not prove that a multi-agent system exists.
```

Required reaction when the user says the work is drifting into chat:

1. Re-read sections 1, 2, and 5 of this file.
2. Restate the eight user principles if explicitly asked.
3. Identify the harness owner module before changing code.
4. Inspect existing contracts and tests.
5. Convert the correction into a concrete harness-level change or plan.
6. Validate and report what was actually checked.

Subagent execution detail:

- For meaningful development, research, audit, or planning work, spawn the full
  6 subagents in parallel when the tool environment supports it.
- Use them for independent, bounded work such as external research, local code
  mapping, evaluator design review, UI audit, test-gap audit, or alternative
  architecture critique.
- Reduce below 6 only for tool unavailability, secret-handling risk, or a tiny
  single-step task, and record the reason if it matters.
- Do not send provider secrets or hidden env values into subagent prompts.
- Ask subagents for citations, file paths, exact contracts, or concrete risks,
  not vague opinions.
- Main agent must integrate the work, verify claims, edit files, run tests, and
  own the final result.
- If subagent tools are not exposed in the current environment, continue with
  direct inspection/research and note the constraint only when relevant.

Live API detail:

- Configured endpoint variable: `LLM_CHAT_COMPLETIONS_URL`.
- Configured model variable: `LLM_MODELS`, currently expected to include
  `kimi-k2.7`, `deepseek-v4-flash`, and `minimax-m3`.
- Configured stream flag: `LLM_STREAM=true`.
- The API key belongs only in local env files and must never be copied into
  docs, test fixtures, final answers, issue text, screenshots, frontend payloads,
  artifacts, or subagent prompts.
- Do not print `.env` or `.env.local` contents. If checking them, print only
  variable names or redacted presence checks.
- Live calls should be bounded by timeout/retry policy and should record
  provider errors, aborted streams, retries, latency, and usage when available.

### 1.9 Explicit Memory Lock From The User

This section captures the latest direct user instructions as durable repository
memory. Future agents must treat it as active policy, not background color.

The user asked for these instructions to be written into `AGENTS.md` in detail.
Do not rely on transient chat memory for them.

#### 1.9.1 Work Ethic Baseline

The eight principles in section 1.1 are not slogans. They are the operating
standard for every meaningful repository change:

- **Read before acting.** Inspect source files, tests, docs, route handlers,
  types, scripts, env variable names, and existing architecture before proposing
  or changing an interface.
- **Confirm when blocked.** If the user intent, business rule, visibility rule,
  evaluator definition, persistence semantics, or public API behavior cannot be
  inferred safely from the repository and sources, ask a concise confirmation
  question rather than inventing it.
- **Do not hallucinate product requirements.** Werewolf rules, harness behavior,
  social dynamics, evaluator metrics, tournament semantics, and UI truth sources
  must come from user direction, checked references, or existing repo contracts.
- **Reuse before creating.** Before adding a new type, route, adapter, runner,
  evaluator, store, action envelope, or message format, search for the existing
  owner and extend it if compatible.
- **Validate proactively.** Any non-trivial change must run the narrow relevant
  tests first, then broader checks as risk increases. Do not report "done" if
  validation was skipped; say exactly what was and was not run.
- **Respect boundaries.** Keep generic harness code generic. Keep Werewolf
  domain details in Werewolf engine/adapter modules. Keep UI as a consumer of
  harness/API/artifact truth, never the source of hidden game truth.
- **Admit uncertainty.** If a claim is based on inference, mark it as inference.
  If a source was not checked, do not imply it was checked.
- **Refactor cautiously.** Prefer narrow, behavior-preserving changes with tests
  over broad rewrites. Never revert user or other-agent work unless explicitly
  asked.

#### 1.9.2 Harness First, Werewolf Second

The user is building a **multi-agent adversarial society harness**. Werewolf is
the first domain adapter and UI representation, not the architecture center.

Therefore, when designing goals, code, tests, docs, APIs, or UI, start from the
harness capability and then map it to Werewolf:

```text
goal wording:
  Build/extend a reusable harness capability.

proof domain:
  Show that capability under Werewolf hidden-information pressure.

presentation:
  Render the resulting state, actions, messages, traces, metrics, and artifacts
  in React without inventing an alternate truth source.
```

Correct examples:

- "Add checkpoint/fork provenance to the harness, then expose Werewolf match
  forks through server/API and replay UI."
- "Add scoped communication channels to the generic social harness, then map
  Werewolf public day talk, wolf chat, private seer inspect, and private witch
  action onto those channels."
- "Add evaluator registry metadata and evidence refs, then implement Werewolf
  deception, vote accuracy, coalition, and information-use metrics as domain
  evaluators."
- "Add agent social memory/belief/relationship/norm stores, then let Werewolf
  agents update suspicion, trust, claims, voting pressure, and alliance evidence."

Wrong examples:

- "Start six chat completions and call the transcript a society."
- "Ask each model for JSON and call that an agent framework."
- "Let React track hidden roles or final winners independently."
- "Let model output mutate environment state without harness validation."
- "Treat a pretty Werewolf screen as proof that the multi-agent harness exists."

#### 1.9.3 Agent Is Not A Chat Completion

The user explicitly rejected the idea that "model returns JSON" is agent design.
Preserve this distinction in code, plans, tests, and explanations.

An agent in this repository must be modeled as a harness-managed social actor:

```text
Agent =
  durable actor id
  + profile/model assignment
  + role/domain assignment
  + private observations
  + private state snapshot
  + memory store
  + belief state
  + relationship/trust/suspicion model
  + reputation and norm view
  + goals and incentives
  + policy/arbitration layer
  + optional model-backed reasoner
  + legal command/message proposal
  + traceable decision evidence
```

The LLM, when present, is a component inside that actor. It may produce natural
language, reflections, critiques, candidate actions, or evidence summaries. It
does not own identity, memory, legality, environment mutation, replay, fork, or
evaluation.

JSON and structured data remain allowed where they are engineering artifacts:

- typed commands
- internal parser results
- artifact records
- metric records
- checkpoint snapshots
- replay inputs
- API payloads
- UI view models

But structured output is never sufficient evidence of agency. The harness must
validate, arbitrate, commit, record, and evaluate behavior.

#### 1.9.4 Harness Ownership Checklist

Before any implementation or plan, identify which harness plane owns the change.
If none fits, inspect the code again before creating a new plane.

Core planes:

- **Control plane**: experiment specs, seeds, profile/model assignment,
  tournament setup, run ids, provenance, timeout/retry policy.
- **Environment plane**: domain state, legal pending actions, command legality,
  deterministic transitions, deaths, victory, phase progression.
- **Observation plane**: scoped visibility, private/public channels, redaction,
  who knew what and when.
- **Society plane**: communication topology, messages, relationships, trust,
  suspicion, norms, reputation, coalition and conflict evidence.
- **Agent plane**: identity, private state, memory, beliefs, goals, policy,
  reasoner integration, decision traces.
- **Artifact plane**: trajectory records, JSONL, checkpoints, fork provenance,
  failure records, redaction, replay authority.
- **Evaluation plane**: metric registry, evidence refs, deterministic vs
  model-graded metrics, aggregation, leaderboard inputs.
- **API/server plane**: safe exposure of harness truth, artifact downloads,
  checkpoint/fork endpoints, tournament execution, config summaries.
- **React cockpit plane**: interactive presentation and analysis of harness
  state/artifacts; no independent hidden truth.

When changing a feature, write or think in this form:

```text
Owner:
  <plane and module>

Existing contracts checked:
  <files/tests/docs inspected>

Harness invariant:
  <what must remain true after the change>

Validation:
  <focused tests/typecheck/build/smoke run>
```

#### 1.9.5 Subagent Execution Permission

The user explicitly wrote that future agents may, at any time and for efficiency,
open up to **6** subagents for parallel development, research, audit, or planning
when the current tool environment supports it.

This permission is durable. It does not require re-asking each turn.

Use subagents when:

- the task requires current internet research across several systems
- local architecture mapping can be split by module ownership
- evaluator, harness, UI, API, and test risks can be audited independently
- the implementation has separable slices whose findings can be integrated by
  the main agent
- a second opinion would materially reduce interface guessing or architectural
  drift

Do not use subagents when:

- the change is tiny and direct inspection is faster
- secrets would need to be copied into prompts
- the work requires one coherent edit that the main agent must understand fully
- subagent output would be unverified speculation

Subagent prompt rules:

- Give each subagent a bounded, concrete task.
- Ask for file paths, line references, primary source links, exact contracts, or
  explicit risks.
- Do not ask subagents to invent business rules.
- Do not pass `.env` contents, API keys, hidden user credentials, or private
  artifacts unless explicitly required and safe under current policy.
- Main agent must verify and integrate all results before editing or finalizing.

#### 1.9.6 Real API Calls Must Stream

The user explicitly instructed that real API calls must use streaming requests
because non-streaming calls are prone to timeout.

Repository policy:

- Live model decisions use OpenAI-compatible chat-completions with
  `stream: true`.
- The configured endpoint is represented by `LLM_CHAT_COMPLETIONS_URL`.
- The configured model list is represented by `LLM_MODELS`; current validated
  live models include `kimi-k2.7`, `deepseek-v4-flash`, and `minimax-m3`.
- The stream flag is represented by `LLM_STREAM=true`.
- Do not send `max_tokens`, `max_completion_tokens`, or equivalent max-token
  fields on live provider requests unless a later explicit user instruction
  changes this policy.
- The API key must exist only in local env files and must not be copied into
  documentation, prompts, test fixtures, frontend payloads, screenshots,
  artifacts, logs, final answers, or subagent prompts.
- Do not ask the user for the key again unless a real streaming validation run
  proves authentication or connectivity is broken.

When validating real model behavior:

1. Run deterministic fake-client tests first.
2. Run typecheck and relevant unit/integration tests.
3. Run a bounded streaming probe only if model/reasoner behavior changed.
4. Run a bounded streaming match only if the probe passes and the task requires
   live behavior proof.
5. Record stream completion, aborts, provider errors, retries, latency, and
   usage when available.

Never claim that a live model path works merely because a request was sent. The
stream must complete, the local adapter must parse the response, and the
proposed action/message must pass policy and environment validation.

#### 1.9.7 Goal Design For This Project

Future "goal" definitions should be written as harness capabilities with clear
artifact and validation outputs.

Use this template:

```text
Goal:
  <one reusable harness capability>

Why it matters:
  <what multi-agent society/adversarial capability it unlocks>

Generic contract:
  <domain-neutral state/action/message/evaluator/artifact/API contract>

Werewolf proof:
  <how Werewolf demonstrates the capability under hidden information>

Replay/fork impact:
  <whether deterministic replay, checkpoint, fork, or provenance changes>

Evaluation impact:
  <which metrics/evidence refs/leaderboard fields become possible>

UI/API impact:
  <how React/server consume recorded harness truth>

Validation:
  <tests, typecheck, build, fake-client smoke, optional streaming smoke>
```

Preferred goal stack:

1. Generic social harness runner with scheduler, scoped observation, legal
   actions, and committed step records.
2. Agent scaffold with durable state, memory, beliefs, relationships, norms,
   reputation, goals, policy, optional reasoner, and action arbitration.
3. Communication topology and social message bus with visibility, redaction,
   delivery receipts, evidence refs, and replayable ordering.
4. Domain adapter contract that maps a concrete game/simulation onto generic
   harness actions, observations, messages, and evaluators.
5. Artifact, replay, checkpoint, fork, and failure records as the audit source
   of truth.
6. Evaluator registry with deterministic metrics, evidence refs, aggregation,
   tournament leaderboard, and optional model-graded evaluators kept separate.
7. Server/API exposure for match run, artifact download, replay, tournament,
   checkpoint, fork, and configuration summaries.
8. React cockpit that visualizes seats, phases, role cards, speech, votes,
   night actions, traces, social graph, metrics, replay, and tournaments from
   harness/API/artifact truth.
9. Additional domains after the generic harness boundary remains stable.

#### 1.9.8 Current Local Environment Notes

The active workspace for this project has been provided as:

```text
/root/wererwolf1
```

The user session reported this tmux startup/config issue:

```text
/root/.tmux.conf:54: invalid option: extended-keys-format
```

Treat this as an environment note. Do not let it distract from harness work
unless the user asks to fix tmux or terminal behavior. If terminal tooling fails
because of tmux configuration, inspect `/root/.tmux.conf` carefully before
editing it and avoid destructive changes.

### 1.10 Latest User Instruction Lock

This section captures the latest explicit user direction and should be treated
as high-priority operating memory for future agents.

The user's latest operational instruction is:

```text
Read AGENTS.md, obey the treaty, then perform deep research and execution for
the task. When useful and supported by the tool environment, start subagents to
accelerate the work.
```

The newest hard validation correction is:

```text
All required model-call validation must be real. The user rejects fake smoke
tests, fallback validation, fake provider portals, and any report that presents
mocked behavior as live agent/harness proof.
```

Operational meaning:

- Unit tests may use deterministic fakes or mocks only when they are named and
  reported as unit tests for local contracts.
- A fake or mocked test must never be called a real provider smoke, live harness
  validation, or proof that an agent/model path works.
- If a task changes model, reasoner, live agent decision, provider, retry,
  timeout, or streaming behavior, run a bounded real streaming validation
  through the configured provider unless an external outage blocks it.
- Do not add fallback provider portals or model-substitution paths to make
  validation appear green.
- If a real streaming call fails, report the classified failure honestly rather
  than masking it with fallback behavior.

This means every future agent should follow this sequence for substantial work:

1. Read this file first.
2. Re-anchor on the eight user principles in section 1.1.
3. Identify whether the work is harness, agent scaffold, society, domain
   adapter, artifact/replay, evaluator, tournament, API/server, or React
   cockpit work.
4. Inspect existing local contracts and tests before designing or editing
   interfaces.
5. If the task depends on current external systems or best practices, perform
   current research against primary sources and preserve citations in the final
   answer or produced docs.
6. If the work can be split safely, use subagents for independent research,
   code mapping, architecture critique, UI audit, evaluator critique, or
   validation-risk review.
7. Integrate all findings in the main agent. The main agent remains accountable
   for architecture, edits, tests, and the final answer.
8. Make narrowly scoped edits that reuse existing repo contracts wherever
   possible.
9. Validate the change proportionally.
10. Report what changed, what was validated, and what remains uncertain.

#### 1.10.1 Harness Is The Goal, Werewolf Is The Proof Surface

When the user asks for "the overall goal", "goal design", "harness design",
"multi-agent confrontation", "multi-agent society", or "continue", do not
default to React screens or prompt templates. Start from the reusable harness
capability.

Correct framing:

```text
Primary goal:
  Build a domain-neutral multi-agent adversarial/social harness that can
  orchestrate stateful social actors under hidden information, scoped
  communication, legal action boundaries, replay, fork, tournament, and
  evaluation.

First proof domain:
  Use Werewolf to pressure-test deception, persuasion, coalition formation,
  asymmetric information, public/private communication, voting, night actions,
  and adversarial win conditions.

Presentation:
  Build a React cockpit that displays harness truth: seats, roles according to
  visibility, phase timeline, speech, messages, votes, night actions, traces,
  metrics, replay, forks, and tournament results.
```

Never invert this into:

```text
Build a Werewolf UI, then wire some chatbots into it.
```

#### 1.10.2 Required Goal Shape

A goal in this project must be a capability milestone with evidence. It should
not be a vague task label.

Use this expanded shape for planning and status updates:

```text
Goal id:
  <stable id, e.g. harness.provider-failure-attribution.v1>

Capability:
  <one reusable capability the harness gains>

Owner plane:
  <control | environment | observation | society | agent | artifact |
   evaluation | tournament | API/server | React cockpit>

Owner modules:
  <exact local files/modules after inspection>

Problem boundary:
  <what this solves and what it deliberately does not solve>

Existing contracts checked:
  <files/tests/docs inspected before interface changes>

Generic contract:
  <domain-neutral types, state, actions, messages, events, artifacts,
   evaluator records, or APIs affected>

Werewolf proof:
  <how Werewolf demonstrates this capability under hidden-information pressure>

Agent/society impact:
  <how identity, memory, beliefs, relationships, reputation, norms, goals,
   policy, messages, deception, coalition, trust, suspicion, or action
   arbitration change>

Replay/fork impact:
  <whether deterministic replay, checkpoint, fork, state hash, or provenance
   changes>

Evaluation impact:
  <metrics, evidence refs, aggregation, leaderboard, failure attribution, or
   evaluator registry changes>

UI/API impact:
  <how server routes or React consume recorded harness truth>

Validation:
  <focused tests, typecheck, build, deterministic smoke, optional bounded
   streaming probe/match/tournament>

Promotion rule:
  <what must be true before moving to the next capability>

Non-goals:
  <explicit scope limits to prevent drifting into UI-only or chat-only work>
```

Minimum acceptance:

- A harness goal must leave typed contracts, state transitions, artifacts,
  replay/evaluation implications, and tests.
- An agent scaffold goal must leave serializable state stores, controlled
  mutation APIs, policy/arbitration behavior, and evidence-backed updates.
- A society goal must leave scoped channels/messages/visibility/reputation or
  relationship evidence that can be replayed and evaluated.
- An evaluator goal must leave versioned metrics with evidence refs and clear
  aggregation semantics.
- A React goal must consume harness/API/artifact truth and must not introduce
  hidden state as an independent source of truth.
- No goal is complete merely because a model produced text, JSON, or a
  convincing transcript.

#### 1.10.3 Multi-Agent Society Requirements

The phrase "multi-agent society" has a concrete meaning in this repository.
Future work should preserve or extend these requirements:

- Agents have durable identities independent of model calls.
- Agents have private observations assembled by the harness.
- Agents can maintain memory, beliefs, relationships, suspicion, trust,
  reputation, norms, goals, commitments, and tactical plans.
- Agents can communicate through explicit channels with scoped visibility.
- Public speech, private team chat, direct messages, system messages, claims,
  commitments, pressure, accusations, defense, coordination, and deception are
  society-layer records, not loose prompt text.
- The harness records who could see each message, when it was delivered, and
  what evidence it created.
- The environment owns truth and legal transitions. Agents may propose actions,
  but the harness/environment validates and commits them.
- Evaluators infer influence, deception, collaboration, vote accuracy,
  reputation calibration, norm pressure, and survival/reward from artifacts and
  events, not from self-report.
- Replay uses recorded artifacts and deterministic state transitions, never
  fresh model calls.
- Forks preserve parent provenance, restored state, restored agent snapshots,
  message continuity, and divergence evidence.

If an implementation only produces a transcript between LLMs, it does not meet
the society requirement.

#### 1.10.4 Agent Scaffold Requirements

An agent implementation must remain meaningful even when the model reasoner is
disabled, replaced with a deterministic fake, or swapped to another provider.

Required scaffold concepts:

```text
AgentIdentity
AgentProfile
Role/domain assignment
PrivateObservation
PrivateStateSnapshot
MemoryStore
BeliefStore
RelationshipStore
ReputationView
NormStore
GoalStack
Policy
ReasonerAdapter
ActionArbitrator
DecisionTrace
EvidenceRef
```

Decision flow:

```text
scheduler selects actor
  -> harness assembles scoped observation
  -> agent updates private stores with evidence refs
  -> policy retrieves relevant memories/beliefs/relationships/norms/goals
  -> optional reasoner drafts speech, critique, or candidate action
  -> arbitrator ranks candidates by goals, social risk, legality, and context
  -> harness converts candidate into typed command/message
  -> environment validates and commits or rejects
  -> trace/artifact/evaluator records preserve what happened
```

The reasoner may help think. It is not the agent, not the state owner, not the
arbiter of legality, and not the replay authority.

#### 1.10.5 Subagent Acceleration Rule

The user explicitly requires **6** subagents for meaningful parallelizable work
when the tool environment supports it. This instruction is standing and does not
need to be re-confirmed each turn.

Use the full 6-subagent round when it materially improves speed or quality:

- one subagent researches current primary docs for external frameworks
- one maps existing local harness contracts and tests
- one audits agent scaffold state/memory/belief boundaries
- one audits evaluator/tournament/artifact implications
- one audits React/API truth-source implications
- one acts as a critical reviewer for architecture drift and missing validation

Subagent prompts must be bounded and concrete. Ask for:

- source links or exact file paths
- line references where possible
- existing interfaces and tests
- risks and missing validation
- concise recommendations tied to evidence

Do not ask subagents for vague product imagination. Do not pass `.env` contents,
API keys, private credentials, or hidden artifacts to subagents. The main agent
must verify subagent claims before using them.

If subagent tools are not available, the main agent should still proceed by
direct inspection/research and should not use tool unavailability as a reason to
avoid useful work.

#### 1.10.6 Provider And Streaming Rule

The user has already provided the OpenAI-compatible provider configuration and
asked that it be treated as persistent local runtime configuration.

Persistent non-secret values:

```text
LLM_CHAT_COMPLETIONS_URL=https://llm.kimchi.dev/openai/v1/chat/completions
LLM_MODELS=kimi-k2.7,deepseek-v4-flash,minimax-m3
LLM_STREAM=true
```

Secret handling:

- The API key belongs only in `.env` and `.env.local`.
- Never paste the API key into `AGENTS.md`, README, docs, tests, artifacts,
  prompts, browser UI, screenshots, subagent prompts, terminal summaries, or
  final answers.
- Do not print `.env` or `.env.local` contents. If env inspection is necessary,
  print only variable names or redacted presence checks.
- Do not ask the user for the key again unless a bounded streaming validation
  run proves authentication or connectivity is broken.

Live provider behavior:

- Real model decisions must use streaming chat-completions requests.
- Non-streaming is acceptable only for deterministic fake clients, local unit
  tests, or explicitly isolated adapter tests.
- Live calls must use bounded timeout/retry behavior.
- Provider telemetry should record stream completion, aborts, timeout,
  retry/failure cause, latency, usage, provider request id, and attempts when
  available.
- Never claim the provider path works unless the stream completed, the local
  adapter parsed it, and the action/message passed policy and environment
  validation.

#### 1.10.7 Continue/Resume Protocol

When the user says "continue", "继续", "读 AGENTS.md 后继续", or asks for deep
execution, future agents should not restart from a blank plan.

Resume protocol:

1. Read `AGENTS.md`.
2. Inspect the current repo state and relevant tests.
3. Identify the highest-priority known gap or active slice from sections 6 and
   9 unless the user gives a newer specific target.
4. State the owner plane and files before editing.
5. Make a small, coherent improvement that advances the harness capability.
6. Run focused validation, then broader validation if the blast radius warrants
   it.
7. Update `AGENTS.md`, docs, or tests when behavior, contracts, or known gaps
   change.

Default priority order unless superseded by user instruction:

1. Generic harness authority and scheduler boundaries.
2. Agent scaffold state/memory/belief/relationship/norm/reputation/goal stores.
3. Communication topology and replayable social message evidence.
4. Artifact, replay, checkpoint, fork, and failure provenance.
5. Evaluator registry, deterministic metrics, evidence refs, and tournament
   aggregation.
6. Provider streaming reliability, timeout/retry/abort attribution, and
   model-specific failure diagnostics.
7. Server/API exposure over harness truth.
8. React cockpit visualization over artifacts/API, with strict hidden-truth
   boundaries.
9. Additional Werewolf roles/rules or other domains after the generic harness
   boundary remains stable.

#### 1.10.8 Communication Style With This User

The user strongly prefers concrete execution over vague planning. Future agents
should therefore:

- read and inspect before asserting
- be explicit about what is known from code, what is known from research, and
  what is inferred
- ask confirmation only when the repo and sources cannot determine a risky
  business or architecture choice
- avoid generic apologies and convert corrections into concrete edits, tests,
  docs, or plans
- never present "LLM chat plus JSON" as an agent architecture
- keep final answers focused on what changed, what was validated, and the next
  useful harness-level step

## 2. Non-Negotiable Architecture Boundary

The central rule:

```text
LLM != Agent
```

An LLM is a model service. It has no durable identity, no memory, no legal
action boundary, no relationship state, no observation filter, no replay
contract, and no authority over the environment unless the harness wraps it.

In this project:

```text
Agent =
  Identity
  + Private State
  + Memory
  + Beliefs
  + Relationship Model
  + Norm / Reputation View
  + Goals
  + Policy
  + Optional Reasoner
  + Action Arbitration
```

The LLM is only:

```text
Reasoner =
  memo generator
  + speech/reflection component
  + strategy critic
  + summarizer
  + optional candidate planner
```

The LLM must not:

- own the game state
- read hidden state except through scoped observations
- mutate environment state
- bypass `GameCommand` / typed command validation
- be trusted as the source of metrics
- be called during deterministic replay
- be treated as the whole Agent

Structured data is allowed for harness internals:

- typed commands
- artifact schemas
- evaluator records
- traces
- metrics
- checkpoints

Structured data is **not** the proof that something is an agent. Do not design
"agent behavior" as "ask the model to output JSON".

### 2.1 Harness, Agent, Reasoner, And Chat Boundaries

Use these definitions consistently:

```text
Harness =
  runtime that schedules actors
  + scopes observations
  + mediates communication
  + validates typed actions
  + advances the environment
  + records traces/artifacts/checkpoints
  + runs replay/fork/tournament/evaluation

Environment =
  source of truth
  + legal transition function
  + hidden-state authority
  + event emitter

Agent =
  harness-managed social actor
  + durable identity
  + private serializable state
  + memory/belief/relationship/norm/reputation/goal stores
  + policy and action arbitration
  + optional reasoner/speech/reflection modules

Reasoner =
  model-backed or local component that can help think, summarize, critique,
  draft speech, or propose candidates; it is not the actor and not the state
  transition authority.

Chat =
  one possible communication form, represented as scoped SocialMessage records.
  Chat is data in the society layer, not the whole runtime.
```

Required runtime sequence for a live decision:

```text
1. Scheduler chooses a pending actor or pending batch.
2. ObservationAssembler builds a scoped observation from environment state and
   visible social messages.
3. Agent observes and updates its own private state through controlled stores.
4. Policy/Reasoner/Arbitrator produce a candidate decision.
5. Harness converts the decision into a typed command or rejects it.
6. Environment validates and applies the command or joint action.
7. SocialCommunicationBus commits messages only according to the transition
   policy.
8. TraceRecorder records observation, private reasoning summary, action, state
   hashes, message ranges, event ranges, and feedback.
9. Evaluators consume artifacts/events/messages, not model self-report.
```

Anti-patterns:

- direct model-to-model hidden prompt sharing outside `SocialCommunicationBus`
- unscoped global context that leaks hidden roles, private notes, or team chat
- agent memory stored only in a prompt string
- model text treated as a legal command without arbitration and validation
- replay implemented by asking models to act again
- metric implemented by asking the acting model whether it did well
- parallelism defined as `Promise.all` model calls without joint environment
  resolution
- Werewolf-specific types imported into generic harness modules
- UI state becoming a second source of game truth

### 2.2 Harness As Product Core

The harness is the product core. It is not a helper around a chat session.

Think of the harness as five planes:

```text
Control plane
  experiment spec
  profile registry
  assignment strategy
  seed schedule
  scheduler selection
  timeout/retry/cancellation policy
  tournament orchestration

Environment plane
  source-of-truth state
  pending action discovery
  observation projection
  legal action validation
  deterministic state transition
  rewards/terminations/truncations/infos
  event emission

Society plane
  channels
  visibility
  message envelopes
  conversation threads
  claims
  commitments
  gossip
  influence evidence
  relationship/reputation/norm updates

Agent plane
  durable identity
  private state
  memory
  beliefs
  relationship estimates
  norms/reputation/goals
  policy
  reasoner adapter
  action arbitration

Evidence plane
  traces
  messages
  events
  state hashes
  checkpoints
  replay records
  evaluator records
  tournament artifacts
```

Each plane must have a clear authority. Authority must not collapse into the
model call.

Authority map:

```text
Experiment normalization: harness/control plane
Role/seat/profile assignment: harness/control plane
Truth state: environment plane
Observation visibility: environment + harness observation assembler
Communication visibility: society plane/message bus
Private memory/beliefs: agent plane store APIs
Command legality: policy prefilter + environment final validation
Environment mutation: environment only
Replay: artifact/replay engine only, no model calls
Evaluation: evaluator registry over artifacts/events/messages/state
UI display: API/artifact consumer, never source of hidden truth
```

When adding a capability, first identify which plane owns it. If the owner is
unclear, inspect the existing modules and tests before adding a new abstraction.

### 2.3 JSON Is Not Agency

The user explicitly rejects the idea that "agent design" means "make the AI
return JSON." This rule must be preserved even when structured data is useful.

Allowed uses of structured data:

- typed environment commands after policy/arbitration
- message envelopes and channel records
- observation snapshots or hashes
- private state snapshots
- checkpoint records
- evaluator metric records
- tournament JSONL
- parser outputs from reasoner text
- UI/API payloads

Disallowed framing:

- defining an agent as a model response schema
- trusting model JSON as a legal action
- letting model JSON mutate memory, beliefs, relationships, norms, reputation,
  or environment truth directly
- claiming multi-agent behavior because several prompts returned structured
  blobs
- treating JSON validity as evidence that deception, persuasion, coordination,
  or social adaptation occurred

If structured model output is introduced, name the component honestly:

```text
ReasonerAdapter
SpeechDraftParser
CandidateActionParser
MemoSummarizer
ClaimExtractor
EvaluatorJudgeAdapter
```

Then route its output through the normal ownership chain:

```text
model/local reasoner output
  -> parser or adapter
  -> policy/arbitration
  -> typed candidate
  -> environment validation
  -> committed event/message/action
  -> trace/artifact/evaluator evidence
```

The agent is the whole stateful actor lifecycle, not the parser result.

### 2.4 Harness-Level Definition Of "Multi-Agent"

In this repository, `multi-agent` means the harness can run multiple stateful
actors whose observations, private states, actions, messages, and outcomes are
separate, scoped, and auditable.

Minimum multi-agent requirements:

- at least two independently identifiable actors
- actor-specific observations
- actor-specific private state
- actor-specific policy/reasoner configuration
- explicit scheduling semantics
- explicit communication topology
- artifact records that preserve which actor saw, said, believed, decided, and
  caused what
- deterministic replay of committed state transitions without model calls

Minimum adversarial/social requirements:

- hidden or asymmetric information
- competing goals or incentives
- communication that can affect later actions
- evidence of deception, persuasion, coordination, trust, suspicion, reputation,
  coalition, or norm behavior
- evaluators that can measure at least some of those dynamics from artifacts

What does not count:

- one prompt containing multiple character names
- a group chat transcript without scoped observations
- multiple model calls sharing one global hidden prompt
- no per-agent state besides message history
- no environment authority beyond model text
- no replay/fork/evaluation path

### 2.5 Harness And Agent Scaffold Must Be Real Runtime Software

The harness/agent scaffold must be implemented as explicit runtime software with
typed contracts, stores, schedulers, and artifact records. Prompt text is allowed
inside a reasoner adapter, but prompt text is not the architecture.

Required generic harness contracts:

```text
SocialEnvironment<TState, TObservation, TPending, TCommand>
  Owns truth projection, pending action discovery, and legal transition.

SocialActor<TObservation, TPending, TCommand>
  Owns one actor lifecycle: observe, decide, emit command/message drafts.

SocialScheduler
  Chooses actor order or batch semantics and records why/how a decision happened.

SocialCommunicationBus
  Owns channels, message envelopes, visibility, deterministic ordering, and
  message commit rules.

ObservationAssembler
  Combines domain observation with actor-visible social context without leaking
  hidden truth.

SystemTransitionProvider
  Allows environment-owned transitions when no agent pending action exists.

TraceRecorder / ArtifactWriter
  Records steps, messages, state hashes, traces, failures, metrics, and replay
  material.

EvaluatorRegistry
  Runs versioned evaluators over artifacts/events/messages/state and emits metric
  records with evidence refs.
```

Required agent scaffold contracts:

```text
AgentPrivateState
  Serializable durable private state.

MemoryStore
  Append/retrieve observations, messages, actions, outcomes, reflections, and
  commitments with evidence refs.

BeliefStore
  Track claims, confidence, contradictions, source evidence, and revision history.

RelationshipGraph
  Directed A -> B social estimates such as trust, suspicion, influence, threat,
  debt, affinity, and cooperation.

ReputationLedger
  Evidence-backed public/private estimate of honesty, competence, cooperation,
  threat, and norm compliance.

NormState
  Obligations, prohibitions, permissions, conventions, violations, sanctions, and
  compliance status.

GoalStack
  Long-term identity goals, episode goals, tactical goals, commitments, and
  cancelled/completed/impossible goals.

PolicyEngine
  Enumerates, filters, scores, and selects legal candidates from the actor's
  current state and observation.

ReasonerAdapter
  Optional model/local component for memos, reflection, critique, candidate
  generation, speech drafting, or summarization.

ActionArbitrator
  Converts policy/reasoner candidates into one typed command/message draft set
  subject to legality checks.
```

Minimum lifecycle for a serious agent:

```text
observe(scoped observation)
  -> record observation evidence in memory
  -> ingest visible social messages
  -> update beliefs/relationships/reputation/norms via store APIs
  -> retrieve relevant private state
  -> enumerate legal candidate actions from pending action
  -> optionally ask reasoner for memo/critique/speech/candidates
  -> arbitrate one command draft and optional message drafts
  -> return SocialAction to harness
  -> harness/environment validate and commit or reject
  -> record feedback/outcome/reflection evidence
```

Required anti-regression tests when changing this area:

- actor observations are scoped and do not leak hidden information
- actors cannot decide before observe when the scaffold requires observe-first
- policy actor id must match the harness-selected actor
- reasoner output cannot mutate private stores directly
- reasoner output cannot bypass command validation
- emitted messages are committed only through the bus
- failed decisions produce failed artifacts or explicit rejected-action records
- replay uses recorded commands/artifacts and does not call a model
- social state snapshots or hashes remain serializable and evidence-backed

Generic-vs-domain boundary:

```text
Generic harness may know:
  actor id
  pending action object as an opaque typed value
  command object as an opaque typed value
  scheduler semantics
  state hash
  scoped observation object
  message envelopes
  artifacts
  evaluators

Generic harness must not know:
  Werewolf role truth
  Werewolf night order
  Werewolf victory rules
  Werewolf-specific legal target rules
  Werewolf UI labels

Werewolf adapter may know:
  GameState
  PlayerView
  PendingAction
  GameCommand
  GameEvent
  role-specific ability rules
  Werewolf channels and message extractors
```

When a new feature is proposed, classify it before coding:

```text
If it schedules actors, scopes visibility, commits messages, records artifacts,
replays, forks, evaluates, or runs tournaments -> harness.

If it updates memory, beliefs, relationships, norms, reputation, goals, policy,
or reasoner arbitration -> agent scaffold.

If it applies Werewolf rules, role actions, vote resolution, death resolution,
or victory conditions -> Werewolf core/environment/adapter.

If it displays existing state/artifacts or sends explicit user commands -> UI/API.
```

Do not create a new interface until this classification has been checked against
existing files and tests.

## 3. Existing Repository Baseline

Key current files:

```text
src/core/engine.ts            Werewolf rules and state transitions
src/core/types.ts             GameState, GameCommand, roles, events, phases
src/core/pending.ts           Pending action discovery
src/core/view.ts              Scoped PlayerView creation

src/harness/runtime.ts        Current Werewolf-specific match runner
src/harness/environment.ts    WerewolfEnvironment wrapper
src/harness/actor.ts          WerewolfAgentActor
src/harness/policy.ts         Role-shaped policies
src/harness/reasoner.ts       OpenAI-compatible harness reasoner
src/harness/social.ts         Generic social harness draft
src/harness/scaffold.ts       Generic scaffolded social actor draft
src/harness/socialState.ts    Evidence-backed AgentSocialState store baseline
src/harness/artifacts.ts      MatchArtifact and JSONL export
src/harness/replay.ts         Deterministic Werewolf replay
src/harness/evaluation.ts     Evaluator registry skeleton
src/harness/evaluator.ts      Werewolf adversarial evaluator
src/harness/tournament.ts     Tournament runner
src/harness/tournamentArtifacts.ts Tournament artifact directory writer
src/harness/profiles.ts       Profiles and assignment
src/harness/experiment.ts     Experiment spec normalization

src/agents/openaiClient.ts    OpenAI-compatible streaming client
src/server/index.ts           Express API
src/App.tsx                   React UI
src/styles.css                UI styling

docs/architecture.md          Existing LLM != Agent architecture note
docs/social-harness.md        Current social harness notes
docs/harness-research.md      Existing research notes
```

Current reality:

- The Werewolf engine and harness are already deterministic and event-oriented.
- The OpenAI-compatible client defaults to streaming.
- Profiles, assignment, replay, evaluator report, and artifact export exist.
- `runHarnessMatch()` is now the production Werewolf compatibility entrypoint
  over the generic Werewolf social wrapper. `runtime.ts` no longer contains the
  old direct `WerewolfEnvironment` / `WerewolfAgentActor` match loop; it keeps
  only public compatibility delegates. `probeHarnessTurn()` delegates to the
  adapter-owned `probeWerewolfSocialHarnessTurn()` helper and preserves the
  diagnostic probe shape without applying or persisting the planned command.
- `social.ts` contains the generic social harness baseline, including `aec`,
  `aec-batched-decision`, the old `simultaneous-batch` compatibility alias,
  true `parallel` mode gated on `stepBatch`, `SocialStepFeedback`, deterministic
  message sequencing, transactional message commit, and failed social artifacts
  for missing actor, observe failure, decide failure, and step failure.
- `scaffold.ts` contains a generic scaffolded social actor baseline with
  observe-before-decide enforcement, policy authority, reasoner memo recording,
  actor id validation, monotonic memory sequence behavior, and an additive
  `AgentSocialState` snapshot.
- `socialState.ts` contains the current domain-neutral, pure-data baseline for
  memory, beliefs, directed relationships, norms, reputation, and goals. Store
  mutations require evidence refs for belief/relationship/reputation/norm/goal
  updates, remain JSON-serializable, and are wired into `ScaffoldedSocialActor`
  without making the reasoner state authority.
- The Werewolf runtime now uses a live `SocialCommunicationBus` for public,
  team, private, and reasoner-memo messages, and actor observations include the
  actor-visible social channels/messages.
- `WerewolfAgentActor` now owns an `AgentSocialState` baseline in the main
  harness path. It records scoped observations, visible social messages,
  generic belief claims, reasoner memo evidence, policy decision evidence,
  directed relationship/reputation evidence from visible messages, an episode
  goal, and a `socialStateHash`. The reasoner receives only the hash in its
  context, not the full private social state.
- Live social message metadata no longer includes true hidden `role` / `team`;
  postgame evaluators should recover truth from final game state instead of
  actor-visible message metadata.
- `socialEpisode` records message envelopes and step metadata including
  `decisionStateHash`, `messageSeqRange`, scheduler mode, and batch metadata.
- The Werewolf `runHarnessMatch()` path returns `completed`, `truncated`, or
  `failed`. Reasoner/actor/environment failures produce a partial result with
  current state, successful replayable trajectory prefix, failed social episode
  status, `failureReason`, `failureStateHash`, harness error event, metrics and
  evaluation available so far. CLI and server save returned failed artifacts.
- JSONL export includes header, match metrics, evaluation report, channel,
  replayable step, trace, message, event, error, and evaluator metric records.
- Tournament artifact directory export exists for CLI/script paths. The writer
  emits `manifest.json`, `registry.json`, `episodes.jsonl`, `trajectory.jsonl`,
  `metrics.jsonl`, `failures.jsonl`, `leaderboard.json`, and
  `matches/{match_id}.json`; it preserves truncated/failed harness status,
  writes returned failed harness runs as partial match artifacts, does not fake
  match artifacts for pre-harness failures, redacts known secrets, and defaults
  to fail-if-exists collision behavior.
- `HarnessEvaluationReport` now carries an optional evaluator registry snapshot
  with evaluator id, label, version, input/output schema identifiers,
  deterministic vs model-graded mode, metric ids, rubric text, dependency
  metadata, aggregation policy, and visibility. Tournament `registry.json` and
  match JSONL evaluation report records preserve that snapshot when available.
  Evaluator and metric records still need narrower module splits and more
  precise evidence refs for rigorous benchmarking.
- Failed attempted Werewolf decisions are not yet represented as their own
  typed failed-step union in `HarnessStepRecord[]`; current replay semantics keep
  `trajectory` as successful applied steps only.

Current env:

```text
.env
.env.local
```

Both are configured with the OpenAI-compatible chat completions URL, API key,
`LLM_MODELS=kimi-k2.7,deepseek-v4-flash,minimax-m3`, `LLM_STREAM=true`,
timeout/retry defaults, and local match/tournament defaults. Do not ask for
these values again unless a validation run proves they are invalid or missing.
Do not copy the API key into docs, screenshots, issue text, final answers, or
test fixtures.

## 4. External Design References To Preserve

Use the ideas below, but do not blindly migrate the harness to an external
runtime.

### PettingZoo

Reference:

- https://pettingzoo.farama.org/main/api/aec/
- https://pettingzoo.farama.org/main/api/parallel/

Use for:

- AEC agent/environment cycle semantics
- true parallel/joint-action distinction
- per-agent rewards, terminations, truncations, infos
- contract-style environment tests

Important distinction:

```text
Promise.all over model calls is not a parallel environment.
```

True parallel means:

```text
environment.stepBatch(actionsByAgent)
```

The environment atomically resolves the joint action.

### OpenAI Agents SDK

Reference:

- https://openai.github.io/openai-agents-python/agents/
- https://openai.github.io/openai-agents-python/multi_agent/
- https://openai.github.io/openai-agents-python/tracing/
- https://openai.github.io/openai-agents-python/handoffs/

Use for:

- trace/span vocabulary
- handoff concepts
- distinction between code orchestration and LLM orchestration

Do not use for:

- giving a generic SDK control of Werewolf or social environment state
- replacing typed environment transitions with tool calls

### AutoGen

Reference:

- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/agent-and-agent-runtime.html
- https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html
- https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html

Use for:

- runtime/message separation
- serializable pure-data messages
- direct request/response and pub/sub communication patterns
- save/load state concepts

Do not use for:

- treating a group chat as the harness

### LangGraph

Reference:

- https://docs.langchain.com/oss/python/langchain/multi-agent
- https://docs.langchain.com/oss/python/langgraph/persistence
- https://docs.langchain.com/oss/python/langgraph/use-time-travel

Use for:

- checkpoint/store distinction
- time travel/fork conceptual model
- context engineering and scoped handoffs

Do not use for:

- making graph nodes the source of game truth

### Generative Agents / Concordia / AI Town

Reference:

- https://arxiv.org/abs/2304.03442
- https://github.com/joonspk-research/generative_agents
- https://github.com/google-deepmind/concordia
- https://github.com/a16z-infra/ai-town

Use for:

- memory stream
- reflection
- planning
- componentized agent state
- Game Master / environment authority
- social simulation beyond chat transcripts

### AIWolf / Social Deduction AI

Reference:

- https://aiwolf.org/en/protocol
- https://aiwolf.org/en/aiwolf_contest

Use for:

- Werewolf-specific agent protocol inspiration
- communication logs
- server-managed games
- role-based policies
- competition/tournament evaluation

## 5. Goal Hierarchy

This project should be implemented through explicit goals. Do not jump directly
to UI polish or extra Werewolf roles before the harness goals are sound.

### 5.0 How To Design Goals In This Repo

Goals are capability milestones, not vague task labels. A good goal has:

```text
problem boundary
architecture owner
inputs
outputs
state authority
failure behavior
artifact shape
tests
validation command
promotion rule for the next goal
```

The dependency direction is mandatory:

```text
Social Harness Core
  -> Agent Scaffold
  -> Communication/Society Layer
  -> Domain Adapter, starting with Werewolf
  -> Artifact/Replay/Fork
  -> Evaluator Registry
  -> Tournament Harness
  -> React Cockpit
```

Do not invert this dependency direction. Examples:

- Do not build React-only hidden role state that the harness cannot replay.
- Do not add Werewolf-only shortcuts to generic harness modules.
- Do not add evaluator metrics that cannot point to artifact evidence.
- Do not add agent prompt features that bypass memory, policy, arbitration, and
  typed commands.
- Do not add tournament summaries that cannot be rebuilt from saved artifacts.

Goal output should be inspectable:

- A harness goal should leave behind typed contracts, runner behavior, artifacts,
  and tests.
- An agent scaffold goal should leave behind serializable state stores, policy
  authority, reasoner boundaries, and tests proving the agent can act without an
  LLM.
- A society goal should leave behind scoped channels, message envelopes,
  visibility tests, relationship/reputation/norm update evidence, and replay
  behavior.
- A Werewolf adapter goal should leave behind adapter code that maps engine
  state/actions/events to generic social observations/actions/messages without
  leaking hidden truth.
- An evaluation goal should leave behind versioned evaluators, metric records,
  evidence references, aggregation rules, and tournament integration.
- A UI goal should leave behind a cockpit that consumes artifacts/runtime APIs
  rather than inventing a separate frontend truth.

When a task is large, split it into vertical slices:

```text
contract -> implementation -> artifact output -> tests -> CLI/API/UI exposure
```

Every slice should either preserve existing behavior or produce a failed
artifact with enough provenance to debug it.

### 5.1 Goal Specification Template

Every substantial goal should be written and implemented with this structure.
This avoids vague work labels such as "improve agents" or "make UI better".

```text
Goal id:
Goal name:
Problem boundary:
Architecture owner:
Domain-neutral or domain-specific:
Inputs:
Outputs:
State authority:
Scheduling semantics:
Visibility semantics:
Communication semantics:
Agent-state impact:
Environment transition impact:
Artifact shape:
Replay/fork impact:
Evaluator impact:
Failure behavior:
Public API/CLI/UI exposure:
Tests:
Validation commands:
Promotion rule:
Non-goals:
Known risks:
```

Definitions:

- `Problem boundary` says exactly what the goal solves and what it does not
  solve.
- `Architecture owner` names the module family that owns the capability. For
  example, generic scheduling belongs in `src/harness/social.ts`, not in
  `src/App.tsx` or a Werewolf role policy.
- `Domain-neutral or domain-specific` prevents Werewolf-specific shortcuts from
  entering generic harness code.
- `State authority` names who can mutate truth. Usually this is the environment,
  not an agent, reasoner, UI component, or evaluator.
- `Scheduling semantics` says whether the goal uses AEC, batched AEC decision,
  or true parallel `stepBatch`.
- `Visibility semantics` says which actor can observe which state/message and
  how hidden information is protected.
- `Communication semantics` says which channel and message envelope rules apply.
- `Agent-state impact` says whether memory, beliefs, relationships, norms,
  reputation, goals, or commitments change.
- `Environment transition impact` says which typed commands can be applied and
  where legality is validated.
- `Artifact shape` says what records are produced and how they can be audited.
- `Replay/fork impact` says whether the goal changes deterministic replay or
  checkpoint restore behavior.
- `Evaluator impact` says which metrics, evidence refs, and aggregation rules
  are affected.
- `Failure behavior` says what partial artifact is produced on error.
- `Promotion rule` says what must be true before the next goal can start.
- `Non-goals` prevents scope drift.

Minimum goal acceptance rule:

```text
No goal is accepted because "the model answered".
A goal is accepted only when the harness contract, artifacts, tests, and
validation path prove the capability.
```

### 5.2 Current Goal Stack For This Project

The overall goal is not "build a Werewolf app". The top-level goal stack is:

```text
G0 Architecture Boundary
  Keep LLM, Agent, Harness, Environment, Evaluator, and UI responsibilities
  separate.

G1 Domain-Neutral Social Harness Core
  Build the scheduler, environment contract, observation scoping, action
  validation path, trace recorder, and failure artifact semantics.

G2 Agent Scaffold
  Build durable social actors with private state, memory, beliefs,
  relationships, norms, reputation, goals, policy, reasoner adapter, and action
  arbitration.

G3 Communication And Society Layer
  Build scoped channels, message envelopes, conversation threads, gossip,
  commitments, influence evidence, relationship updates, reputation updates,
  and norm tracking.

G4 Domain Adapter Layer
  Adapt a concrete domain to the generic harness. Werewolf is the first domain,
  but the harness must be able to support other adversarial/social domains.

G5 Artifact, Replay, Checkpoint, Fork
  Produce durable artifacts that can replay without model calls, fork with
  provenance, and support postgame analysis.

G6 Evaluator Registry
  Version deterministic and model-graded evaluators, require evidence refs, and
  make metrics aggregatable across runs.

G7 Tournament Harness
  Run many episodes under explicit assignment/seed/config schedules, preserve
  failures, and write directory artifacts that can rebuild leaderboards.

G8 React Cockpit
  Present live games, replays, social graphs, traces, artifacts, and tournament
  metrics without inventing a second source of truth.
```

The goal stack is dependency-ordered. A future agent may work on a later goal
only if it does not violate earlier goals. For example, React cockpit work is
allowed, but it must consume harness artifacts/API state rather than inventing
hidden role state in the browser.

### 5.3 Multi-Agent Society Goal

The most important capability is a reusable multi-agent adversarial society, not
a transcript generator.

Society state should eventually include:

```text
agent identities
private memories
belief graphs
relationship graph
reputation ledger
norm registry
conversation threads
claims and commitments
gossip provenance
coalitions
conflicts
trust/suspicion estimates
influence evidence
sanctions and rewards
```

The society layer must be able to answer postgame audit questions such as:

- What did each actor know at the moment it acted?
- Which messages were visible to that actor?
- Which private memories or beliefs were updated from those messages?
- Which public claims contradicted later revealed truth?
- Which agent influenced another agent's vote or target selection?
- Which coalition formed, broke, or betrayed an agreement?
- Which norm was invoked, followed, violated, or sanctioned?
- Which deception was successful, and what evidence shows success?
- Which relationship or reputation update can be traced to which event/message?

The answer to those questions must come from artifacts and evaluator evidence,
not from asking the acting model after the fact.

### 5.4 Harness Framework Goal

The harness framework must become the durable core product. It should be
domain-neutral and should support multiple domains with adapters.

Required harness responsibilities:

```text
experiment/spec normalization
seed schedule generation
agent/profile/assignment resolution
environment construction
scheduler selection
observation assembly
visibility filtering
message bus mediation
agent observe/decide lifecycle
policy and action arbitration
typed command validation
environment transition
trace recording
state hashing
checkpointing
artifact writing
deterministic replay
fork/rerun with provenance
evaluator registry execution
tournament aggregation
cost/latency/failure accounting
```

The harness must own orchestration. Agents may propose actions; environments
validate and apply actions; evaluators score artifacts. No model provider should
be trusted as any of those authorities.

Harness primitives should stay stable:

```text
SocialEnvironment<TState, TObservation, TAction>
SocialParallelEnvironment<TState, TObservation, TAction>
SocialScheduler
SocialActor<TObservation, TAction>
SocialCommunicationBus
SocialEpisodeArtifact
SocialStepRecord
HarnessRunResult
MatchArtifact
TournamentResult
EvaluatorRegistry
```

Before adding a primitive, inspect the existing harness modules first. Extend
existing contracts when that preserves clarity and replayability. Add a new
contract only when the existing contract cannot express the required semantics.

### 5.5 Agent Scaffold Goal

An agent scaffold goal is successful only if the actor has durable state and can
act without a live model. A model-backed reasoner can improve speech, reflection,
strategy critique, or candidate generation, but the agent exists outside the
model call.

Required scaffold boundaries:

```text
AgentRuntime owns lifecycle.
AgentProfile describes identity and configuration.
AgentPrivateState stores durable serializable state.
MemoryStore stores evidence.
BeliefStore stores claims and confidence.
RelationshipGraph stores directed social estimates.
NormState stores obligations/prohibitions/permissions/conventions.
ReputationLedger stores evidence-backed public/social reputation.
GoalStack stores long-term, episode, tactical, and commitment goals.
PolicyEngine enumerates and scores candidate legal actions.
ReasonerAdapter calls model/local reasoner when permitted.
ActionArbitrator chooses a candidate and blocks illegal/badly shaped output.
Harness/Environment validates final typed command.
```

Agent state must be serializable, hashable or snapshot-compatible, and
artifact-visible at least through hashes/summaries. Private chain-of-thought
should not be dumped verbatim, but decision evidence, policy summaries, reasoner
memos, state hashes, and causality refs should be available for audit.

Agent design anti-patterns:

- storing all memory only in the prompt
- storing hidden truth in private state because the test fixture knows it
- letting a model directly mutate beliefs or relationships without store APIs
- treating a text answer as a command before policy/arbitration validation
- using global transcript context that includes messages the actor could not see
- updating reputation from self-report rather than evidence
- replaying by asking the model to "do the same thing again"

### 5.6 Canonical Master Goal

The master goal should be written as a harness capability, not as a game screen.

Canonical statement:

```text
Build a domain-neutral multi-agent adversarial society harness that can run,
record, replay, fork, and evaluate stateful social actors under scoped
observations, explicit communication, legal action validation, deterministic
environment transitions, and tournament-grade artifact output. Werewolf is the
first domain adapter and React cockpit surface used to prove the harness under
hidden-information deception and coalition pressure.
```

Canonical master goal record:

```text
Goal id:
  MASTER

Goal name:
  Multi-Agent Adversarial Society Harness

Problem boundary:
  Create the reusable harness, agent scaffold, society layer, artifact system,
  evaluator registry, tournament runner, and cockpit needed to study adversarial
  social agents. Do not define success as "models chatted" or "the UI looks
  like Werewolf".

Architecture owner:
  src/harness/* for harness/agent/society/artifact/evaluator/tournament
  src/core/* for Werewolf truth and rules
  src/server/* for API/runtime exposure
  src/App.tsx and src/styles.css for cockpit presentation

Domain-neutral or domain-specific:
  Harness, agent scaffold, communication, artifacts, replay, evaluator registry,
  and tournament runner are domain-neutral first.
  Werewolf rules, role abilities, role-specific pending actions, and Werewolf UI
  labels are domain-specific.

Inputs:
  experiment spec
  agent profiles
  domain adapter
  role/seat assignment strategy
  seed schedule
  scheduler mode
  model/provider config from env
  evaluator registry
  timeout/retry policy

Outputs:
  HarnessRunResult
  MatchArtifact
  SocialEpisodeArtifact
  replayable trajectory
  scoped social messages
  trace records
  agent state hashes/summaries
  evaluator metrics with evidence refs
  tournament directory artifacts
  React cockpit views

State authority:
  Environment owns truth and legal transitions.
  Harness owns scheduling, visibility, communication commit, trace/artifact
  recording, replay/fork, and tournament execution.
  Agents own private state through store APIs only.
  Reasoners own no truth and no direct mutation authority.
  UI owns no game truth.

Scheduling semantics:
  AEC for one-actor-at-a-time decisions.
  AEC batched decision for concurrent model/policy calls that still apply
  commands sequentially.
  True parallel only when the environment implements stepBatch and resolves
  joint actions atomically.

Visibility semantics:
  Every observation and message must be scoped to the actor/channel/phase.
  Hidden roles, private abilities, team chat, and private memos must not leak
  into live public views.
  Postgame artifacts may reveal hidden truth with visibility labels.

Communication semantics:
  All actor-to-actor communication flows through the communication bus or an
  explicit environment-mediated channel. Messages need sender, recipients,
  channel, visibility, sequence, causality refs, and deterministic ordering.

Agent-state impact:
  Agents need durable identity, private memory, beliefs, directed relationships,
  norms, reputation, goals, policy, optional reasoner output, and action
  arbitration. State changes should cite evidence refs.

Environment transition impact:
  Commands must be typed and validated. Illegal action attempts should produce
  failure artifacts or rejected-action records instead of silent correction.

Artifact shape:
  Artifacts must preserve enough state, trajectory, messages, traces, metrics,
  errors, hashes, and provenance for replay, audit, tournament aggregation, and
  postgame UI inspection.

Replay/fork impact:
  Replay must not call models. Forks may call models again but must record
  forkOf provenance, checkpoint ids, new run ids, and divergence evidence.

Evaluator impact:
  Evaluators must be versioned, modular, evidence-backed, scoped, aggregatable,
  and saved in registry snapshots. Social metrics must not rely only on model
  self-report.

Failure behavior:
  Failed, truncated, and completed runs all produce artifacts. Failures should
  preserve partial trajectory, latest state hash, actor/profile/model
  attribution where possible, and provider timeout/stream/retry data where
  relevant.

Public API/CLI/UI exposure:
  CLI and server expose match, replay, tournament, artifact, and profile/config
  flows. React cockpit consumes API/artifact state and does not invent hidden
  truth.

Tests:
  Unit tests for engine, social harness, scaffold stores, artifacts, replay,
  evaluator registry, tournament writer, and server/API helpers where present.
  Integration tests for match/tournament flows with deterministic fake
  reasoners. Real API smoke only for bounded streaming validation.

Validation commands:
  npx tsc --noEmit --pretty false
  npm test
  npm run build
  npm run agent:probe -- --models=kimi-k2.7 --timeout=90s
  npm run arena:match -- --models=kimi-k2.7 --maxTransitions=4 --timeout=120s --json=summary
  npm run arena:tournament -- --games=1 --maxTransitions=4 --timeout=180s --json=summary

Promotion rule:
  Advance to later goals only when earlier authority boundaries, tests,
  artifacts, and replay semantics remain intact.

Non-goals:
  Do not build a chat-only system.
  Do not optimize UI polish ahead of harness correctness.
  Do not add Werewolf-only shortcuts to generic modules.
  Do not make model JSON the definition of agent design.

Known risks:
  hidden information leakage
  replay divergence
  model timeout or stream abort
  evaluator metrics without evidence
  tournament summaries hiding failures
  UI becoming a second source of truth
  generic harness polluted by Werewolf-specific types
```

### 5.7 Goal Gate Checklist

Every substantial goal should pass these gates before being described as done.

Gate 1: ownership

- the architecture owner is named
- generic vs domain-specific boundary is explicit
- no duplicate interface is introduced without checking existing modules

Gate 2: state authority

- truth mutation owner is explicit
- private agent state mutation path is explicit
- reasoner authority is limited
- UI state is read-only relative to harness truth

Gate 3: visibility

- observations are actor-scoped
- messages are channel-scoped
- hidden information leakage tests or reasoning exist
- live view and postgame view are separated

Gate 4: action legality

- legal actions are enumerated or discoverable
- policy may propose candidates
- arbitration selects a candidate
- environment validates final command
- rejected/invalid/failure behavior is recorded

Gate 5: artifacts

- state hashes are recorded where useful
- messages/events/steps/traces are connected by ids or ranges
- failures preserve partial data
- JSONL export remains audit-useful
- tournament summaries are rebuildable from raw files

Gate 6: replay/fork

- replay uses recorded commands/artifacts only
- replay does not call models
- fork has checkpoint id and provenance
- divergence can be inspected

Gate 7: evaluation

- evaluator id/version is present
- metric scope and subject are clear
- denominator/confidence/aggregation exist where applicable
- evidence refs point to artifacts/events/messages/state/agent_state
- model-graded evaluators are separate from deterministic metrics

Gate 8: validation

- focused tests were run for the changed module
- typecheck was run for TypeScript contract changes
- build was run for frontend/package changes
- bounded streaming smoke was run only when model/reasoner behavior changed
- any skipped validation is stated honestly

### 5.8 Active Build Priorities

Prefer this order when no newer user instruction overrides it:

```text
1. Migrate Werewolf runtime toward generic social harness runner.
2. Split AgentSocialState baseline into production store modules.
3. Add checkpoint/fork primitives with provenance.
4. Harden evaluator registry and evidence-backed social metrics.
5. Improve tournament artifact completeness and failure attribution.
6. Build React cockpit panels against artifacts/API.
7. Add richer Werewolf roles/rules only after harness boundaries remain stable.
```

Priority details:

- Generic runner migration means `runHarnessMatch()` becomes a compatibility
  wrapper where feasible, not a permanent Werewolf-only orchestration island.
- Store split means memory, belief, relationship, norm, reputation, and goal
  modules can evolve independently with versioned snapshots and tests.
- Checkpoint/fork means replay remains deterministic while forked experiments
  can diverge with recorded provenance.
- Evaluator hardening means social/deception/influence/reputation metrics point
  to evidence and can aggregate across tournaments.
- Tournament hardening means failed/truncated runs remain visible and raw
  metrics can rebuild leaderboards.
- React cockpit means table, replay, social graph, trace inspector, artifact
  browser, and tournament dashboard consume harness truth.

### 5.9 Done Means Harness Evidence Exists

The phrase "done" should mean:

```text
contract exists
implementation follows the contract
artifact evidence exists
tests cover the behavior
validation command passed or was honestly skipped
```

The phrase "not done" applies when:

- the behavior exists only in a prompt
- the UI displays data the harness cannot produce
- a model call is required for replay
- a metric has no evidence refs
- a failure path drops the partial run
- hidden truth can leak into live observations
- the code works only for Werewolf but was added to a generic module
- the system cannot distinguish actor state from reasoner text

### 5.10 Current Goal Design For The Overall Product

When asked "how should the overall goal be designed", use this section as the
answering and implementation anchor.

The goal must be designed as a layered harness capability stack, not as a
Werewolf feature list and not as a chat workflow.

Primary goal statement:

```text
Build a domain-neutral multi-agent adversarial society harness that can run
stateful social agents in hidden-information, adversarial, communication-heavy
environments; record scoped observations, messages, decisions, private-state
summaries, state transitions, failures, replay material, and evaluator metrics;
and use Werewolf as the first domain adapter and React cockpit.
```

The goal stack should be split into nine durable capability goals:

```text
G0 Architecture Boundary
  Prevent degradation into AI chat, prompt orchestration, or JSON-only agents.

G1 Generic Social Harness Core
  Run multiple actors with scoped observations, explicit scheduler semantics,
  communication bus integration, typed actions, environment authority, failure
  behavior, and artifacts.

G2 Agent Scaffold
  Give every actor durable identity, serializable private state, memory, beliefs,
  relationships, reputation, norms, goals, policy, optional reasoner, and action
  arbitration.

G3 Communication And Society Layer
  Model public, team, private, system, and postgame channels; preserve who could
  see what; extract claims, commitments, influence, deception, coalitions, gossip,
  trust, suspicion, and norm pressure as evidence-backed runtime concepts.

G4 Werewolf Domain Adapter
  Map Werewolf state, pending actions, legal commands, role abilities, speeches,
  votes, night actions, deaths, and victory conditions onto the generic harness
  without leaking hidden truth.

G5 Artifact, Replay, Checkpoint, Fork
  Persist every run as replayable and auditable data; replay without model calls;
  fork from checkpoints with provenance.

G6 Evaluator Registry
  Version deterministic and optional model-graded evaluators; emit metric records
  with scope, subject, denominator, confidence, aggregation policy, and evidence
  refs.

G7 Tournament Harness
  Run automated comparisons across models, profiles, seeds, roles, seats,
  schedulers, and domain configs while preserving failures and raw artifacts.

G8 React Cockpit
  Present the arena, replay, social graph, traces, artifacts, and tournament
  metrics as a high-quality UI that consumes harness truth.
```

The current practical development sequence should be:

```text
1. Stabilize generic social runner contracts.
2. Migrate Werewolf execution toward the generic runner in vertical slices.
3. Split the social-state baseline into production memory/belief/relationship/
   reputation/norm/goal stores.
4. Add checkpoint and fork primitives.
5. Harden evaluators and metric evidence refs.
6. Harden tournament artifacts and failure attribution.
7. Expand React cockpit only against harness/API/artifact truth.
8. Add richer Werewolf rules or other domains after the harness boundary holds.
```

Each goal must be represented by real deliverables:

```text
contract
implementation
artifact evidence
tests
validation command
known limitations
next promotion gate
```

Do not accept goal completion if the only output is:

- a prompt
- a model persona
- a transcript
- a JSON schema for model replies
- UI mock data
- a non-replayable demo
- an evaluator score without evidence refs
- a tournament summary that hides failed runs

#### 5.10.1 Multi-Agent Society Goal Detail

The multi-agent society goal is not "agents can send messages". It requires a
runtime social substrate.

Required society primitives:

```text
Actor identity:
  stable id, profile id, role/seat assignment, model/provider profile, team when
  legally visible, public name, private state id.

Observation boundary:
  every actor sees only legal environment observations plus bus-visible social
  messages.

Communication topology:
  public table, team channels, private/local memos, direct channels where a
  domain permits them, system channels, and postgame-only views.

Social memory:
  actor-specific record of observations, claims, accusations, votes, promises,
  betrayals, help, harm, contradictions, and outcomes.

Belief dynamics:
  claims and inferred facts with confidence, evidence, contradiction tracking,
  and revision history.

Relationship dynamics:
  directed trust/suspicion/influence/threat/cooperation/affinity/debt estimates
  updated from evidence.

Reputation dynamics:
  evidence-backed estimates of honesty, competence, cooperation, threat, and
  norm compliance.

Norm dynamics:
  public and private expectations, violations, sanctions, and compliance status.

Goal dynamics:
  long-term role goals, local tactical goals, public/private commitments,
  completed/failed/impossible/cancelled goals.

Influence/deception dynamics:
  connect message exposure to later belief/action shifts and to hidden-truth
  contrast where postgame truth is available.
```

Minimum acceptance for this goal:

- actor-visible social context is included in observations
- each actor has independent private social state
- messages have deterministic sequence and visibility
- memory/belief/relationship/reputation/norm/goal updates cite evidence refs
- social-state hashes or summaries appear in artifacts
- evaluators can compute at least baseline social-state metrics from artifacts
- hidden truth is not injected into live observations or private stores unless
  legally observed/inferred

#### 5.10.2 Harness Framework Goal Detail

The harness framework goal is the core product goal. It must be domain-neutral
and independently valuable without the Werewolf UI.

Required framework surfaces:

```text
ExperimentSpec
  domain id, seed schedule, profiles, assignment strategy, scheduler mode,
  max transitions, timeout/retry policy, evaluator set, artifact output policy.

ProfileRegistry
  model/provider config, policy config, temperature, role/team preferences,
  scaffold options, reasoner options.

DomainAdapter
  initial state factory, pending discovery, observation projection, command
  validation/application, event extraction, message extraction, evaluator hooks.

Scheduler
  aec, aec-batched-decision, and true parallel only with environment stepBatch.

Runner
  executes the decision loop, enforces actor lifecycle, handles system
  transitions, validates commands, commits messages, records traces, returns
  completed/truncated/failed result.

ArtifactStore
  match artifact, social episode artifact, JSONL export, tournament directory,
  checkpoints, failure records, secret redaction.

ReplayEngine
  deterministic replay from initial state + committed commands/messages/hashes,
  no model calls.

ForkEngine
  restore checkpoint, rerun from divergence point, record forkOf provenance.

EvaluatorRegistry
  manifest, metric schema, deterministic evaluator execution, optional
  model-graded evaluator separation, aggregation policy.

TournamentRunner
  executes multiple experiments, preserves failed/truncated runs, writes
  rebuildable metrics and leaderboards.
```

Minimum acceptance for this goal:

- a non-Werewolf domain could theoretically plug in by implementing the adapter
  surface
- scheduler semantics are explicit in artifacts
- failed runs return partial artifacts
- replay does not call models
- model/provider calls are optional and bounded
- evaluator records cite evidence
- tournament output can be rebuilt from saved raw files

#### 5.10.3 Agent Scaffold Goal Detail

The agent scaffold goal is successful only when agents remain agents without an
LLM. The model is an optional reasoner, not the identity or state store.

Required scaffold behavior:

```text
initialize profile and private state
observe scoped environment/social context
append memory evidence
update beliefs/relationships/reputation/norms/goals through store APIs
retrieve relevant context
generate candidate actions from policy and optional reasoner
score candidates by utility/risk/social context/legal fit
arbitrate one command and message draft set
return to harness for validation
record outcome and reflection
snapshot or hash state for artifacts
```

Agent policies should support multiple strategy families:

- deterministic baseline policy for tests and replay-friendly smoke runs
- role-shaped heuristic policy for Werewolf
- adversarial deception policy for wolves or adversarial domains
- cooperative evidence-sharing policy for village-like teams
- cautious/private-information policy for special roles
- experimental learned/search/utility policies later
- optional model-backed reasoner for speech, memo, critique, and candidate
  generation

Agent scaffold acceptance:

- actor can decide without a model provider
- model output is never directly trusted as environment truth
- illegal model suggestions are rejected or converted by policy/arbitration
- private state is serializable
- evidence-backed memory/belief/social updates exist
- actor-specific state can be summarized in artifacts without leaking secrets
- tests prove reasoner cannot mutate internal stores directly

#### 5.10.4 Werewolf As First Domain Adapter

Werewolf is the first proving ground because it stresses hidden information,
public reasoning, private team coordination, deception, voting, role abilities,
and postgame truth comparison.

Werewolf adapter must preserve:

- role assignment and hidden truth in core/environment
- scoped live player views
- public day speech channel
- werewolf team night channel
- private seer/witch/hunter tactical observations
- legal target validation
- death/vote/night-resolution events
- last words / sheriff extensions only after core harness boundaries are stable
- postgame role/truth reveal in artifacts/UI, not live leakage

Werewolf-specific strategy design belongs in policies/agent profiles/adapters,
not in generic harness modules.

Werewolf MVP acceptance:

- generic social runner can drive at least a legal prefix through the adapter
- main runtime records social episode sidecar steps matching replay trajectory
- public/team/private messages are committed through the bus
- hidden role/team metadata is absent from live message metadata
- replay remains deterministic from committed steps
- Werewolf metrics and social-state metrics are emitted with evidence refs

#### 5.10.5 Evaluation And Tournament Goal Detail

Evaluation is not "ask the model who played well". Evaluation must consume
artifacts.

Required deterministic evaluator families:

- outcome and win-rate metrics
- role/seat/profile/model split metrics
- vote accuracy and false-positive metrics
- wolf kill coordination and target quality
- public claim consistency after postgame truth is known
- deception exposure, false-claim consistency, follow, and temporal association
  metrics; counterfactual deception-success metrics only after a separate
  causal/counterfactual design exists
- influence vote-shift metrics
- reputation calibration metrics
- norm compliance/violation metrics
- invalid action and failure-rate metrics
- latency/token/retry/stream-abort metrics

Model-graded evaluators may be added later only as separate evaluators with:

- evaluator id/version
- judge model/profile
- rubric version
- input evidence refs
- confidence/uncertainty
- explicit separation from deterministic metrics

Tournament acceptance:

- failed/truncated/completed episodes all appear in outputs
- leaderboard can be rebuilt from metrics JSONL
- failures are attributable to actor/profile/model/phase when possible
- artifacts redact secrets
- seed/assignment/profile/scheduler config is persisted
- metric aggregation rules are explicit

### Goal 0: Architecture Boundary

Purpose:

```text
Prevent the system from degrading into LLM chat or prompt-only orchestration.
```

Acceptance criteria:

- `LLM != Agent` is preserved in docs and code structure.
- `Environment` is the only state-transition authority.
- `Agent` has explicit state outside the LLM.
- `Reasoner` cannot directly execute environment actions.
- all environment mutations go through typed legal commands.
- replay never calls a model provider.
- metrics are computed from artifacts/events, not model self-report.

### Goal 1: Generic Social Harness Core

Purpose:

```text
Create the domain-neutral multi-agent adversarial/social runner.
```

Core modules:

```text
SocialHarnessRunner
SocialScheduler
SocialEnvironment
SocialParallelEnvironment
SocialActor
SocialCommunicationBus
ObservationAssembler
TraceRecorder
CheckpointStore
ArtifactWriter
ReplayEngine
EvaluatorRegistry
TournamentRunner
```

Scheduler modes:

```text
aec
  One selected agent acts. The environment updates after each action.

aec-batched-decision
  Multiple actors decide from the same decisionStateHash, often concurrently,
  but commands are still applied sequentially. This is useful for model-call
  efficiency and simultaneous-feeling phases, but it is not true parallel.

parallel
  The environment receives a joint action map and resolves it atomically through
  stepBatch(actionsByAgent). Only use this when the environment implements true
  joint-action resolution.
```

Required transition feedback:

```ts
interface SocialStepFeedback<TState, TObservation> {
  state: TState;
  observationsByAgent: Record<string, TObservation>;
  rewardsByAgent: Record<string, number>;
  terminationsByAgent: Record<string, boolean>;
  truncationsByAgent: Record<string, boolean>;
  infosByAgent: Record<string, Record<string, unknown>>;
  episodeTerminated: boolean;
  episodeTruncated: boolean;
  terminationReason?: string;
  truncationReason?: string;
}
```

Acceptance criteria:

- `simultaneous-batch` is renamed or aliased to `aec-batched-decision`.
- `parallel` is impossible without `stepBatch`.
- every decision records `decisionStateHash`.
- every step records `preStateHash` and `postStateHash`.
- every step records observation, pending action, action, message range, event range, and trace ids.
- runner returns `completed`, `truncated`, or `failed`.
- failures produce partial artifacts instead of throwing away the run.
- actor missing, observe failure, decide failure, and environment step failure are test-covered.
- message publication is transactional with environment step, or rejected/attempted messages are explicitly recorded.

### Goal 2: Agent Scaffold

Purpose:

```text
Build reusable harness-managed social agents that can exist across domains.
```

Agent scaffold layers:

```text
AgentRuntime
  AgentProfile
  AgentPrivateState
  MemoryStore
  BeliefStore
  RelationshipGraph
  NormState
  ReputationLedger
  GoalStack
  PolicyEngine
  ReasonerAdapter
  ActionArbitrator
```

Minimum state:

```ts
interface AgentSocialState {
  agentId: string;
  profile: SocialAgentProfile;
  memory: MemoryStore;
  beliefs: BeliefStore;
  relationships: RelationshipGraph;
  norms: AgentNormState;
  reputation: ReputationView;
  goals: GoalStack;
  lastPlan?: SocialPlan;
}
```

Memory rules:

- memory is append-only by default
- entries include seq, source, visibility, salience, importance, evidence refs, tags
- save observations, messages, actions, outcomes, reflections, and commitments
- retrieval should not be only "last N"; use recency + relevance + importance + social context

Belief rules:

- belief is not memory
- beliefs store claims, confidence, evidence refs, contradictions, and timestamps
- hidden truth never enters beliefs unless visible through observation or inferred

Relationship rules:

- relationships are directed edges
- `A -> B` can differ from `B -> A`
- track trust, suspicion, affinity, influence, debt, respect, threat
- update from direct interaction, gossip, shared votes, betrayals, help, harm, and norm violations

Norm rules:

- support obligations, prohibitions, permissions, and conventions
- track scope, condition, expected behavior, sanction, source, confidence, status
- distinguish public norms from internalized agent norms

Reputation rules:

- reputation is computed from evidence, not model self-report
- track honesty, competence, cooperation, threat, norm compliance
- gossip must carry source credibility and confidence

Goal rules:

- separate long-term identity goals, episode goals, tactical goals, and commitments
- plans can be updated, cancelled, and evaluated after outcomes

Policy rules:

- policy is typed action authority
- policy may use heuristics, search, learned policy, utility scoring, or model-generated candidates
- model candidates must pass arbitration and environment validation

Reasoner rules:

- reasoner may reflect, summarize, critique, draft speech, or propose options
- reasoner must not mutate memory, belief, relationship, norms, or environment directly
- reasoner output is recorded for traceability

Agent decision loop:

```text
observe scoped view
  -> append observation evidence to memory
  -> retrieve relevant memory/beliefs/relationships/norms/goals
  -> update beliefs and relationship/reputation estimates through store APIs
  -> enumerate legal/tactically relevant candidate actions
  -> optionally ask reasoner for critique, speech draft, or plan candidates
  -> score candidates by role goals, social goals, risk, and legality
  -> arbitrate one typed action
  -> emit command draft and message drafts
  -> let harness/environment validate and commit
  -> record outcome and reflection evidence
```

Agent implementation rules:

- LLM output may be natural language, a memo, a critique, a speech draft, or a
  candidate plan. It is not automatically a command.
- If structured extraction from LLM output is used, keep it behind a parser or
  reasoner adapter and still pass through policy/arbitration/environment
  validation.
- An agent should be able to run with deterministic or heuristic policy only.
  Model-backed reasoning improves behavior; it does not create the agent.
- Private state updates should cite evidence refs where possible.
- Hidden truth must never be written into an agent's private stores unless the
  agent legally observed it or inferred it from visible evidence.
- Agent state snapshots or hashes should be available for artifacts and replay
  audits.

Acceptance criteria:

- an agent can act without an LLM
- an agent's state is serializable
- reasoner output cannot bypass action arbitration
- scaffold has tests for observe-before-decide, actor id validation, memory trimming, reasoner memo recording, and policy authority
- Werewolf actor can eventually be implemented on top of this scaffold

### Goal 3: Communication And Society Layer

Purpose:

```text
Make social interaction first-class instead of treating messages as incidental logs.
```

Core modules:

```text
SocialCommunicationBus
ChannelRegistry
VisibilityPolicy
MessageEnvelope
ConversationThread
GossipLedger
NormRegistry
RelationshipUpdater
ReputationUpdater
InfluenceTracker
```

Channel types:

```text
public      visible to all eligible participants
team        visible to a team, e.g. Werewolf night channel
private     visible to sender/recipient or local agent only
system      emitted by environment/harness
postgame    hidden during play, visible in artifact review
```

Society semantics:

```text
society state =
  communication topology
  + active channels
  + message history
  + conversation threads
  + commitments and claims
  + relationship graph
  + reputation ledger
  + norm registry
  + influence evidence
  + gossip provenance
```

The society layer must support:

- public discussion and announcements
- private reflection/memo records
- team coordination channels
- direct private messages where a domain permits them
- system messages from the environment/harness
- public claims about roles, facts, intentions, votes, and suspicions
- commitments, promises, threats, accusations, defenses, and retractions
- gossip with source, target, claim, confidence, and source credibility
- relationship updates from observed evidence
- reputation updates from observed evidence
- influence tracking from speech exposure to later vote/action changes
- norm tracking for obligations, prohibitions, permissions, conventions, and
  violations

Important:

- A transcript is not enough. The harness must preserve who could see what,
  when they saw it, what later actions/belief updates are temporally linked by
  evidence, and which stronger causal or counterfactual claims remain
  unproven.
- Social messages are not just UI text. They are auditable runtime artifacts and
  evaluator evidence.
- Agent-to-agent communication must go through the bus or an explicit
  environment-mediated mechanism. No hidden side-channel prompts.

Message envelope requirements:

```ts
interface SocialMessage {
  id: string;
  seq: number;
  channelId: string;
  senderId: string;
  recipientIds: string[];
  visibility: "private" | "team" | "public" | "postgame";
  content: string;
  createdAt: string;
  causalityRefs?: string[];
  metadata?: Record<string, unknown>;
}
```

Acceptance criteria:

- every message has sender, recipients, channel, visibility, seq, and causality refs where possible
- observations include only messages visible to that agent
- postgame artifacts can include private information without leaking it during live play
- public speech, team chat, private memo, and system messages share one bus
- relationship, reputation, influence, and norm updates consume message/event evidence
- message timestamps are deterministic or derived from episode clock when replay determinism matters

### Goal 3.1 Social Dynamics That Must Be Modeled

Multi-agent society work should produce inspectable social dynamics. The
following are not UI decorations; they are runtime/evaluator concepts.

Claims:

```text
claim id
speaker
target(s)
content
claim type: role, fact, intent, accusation, defense, vote promise, ability result
visibility
evidence refs
confidence if asserted
later truth status: true, false, ambiguous, unverifiable, contradicted
```

Commitments:

```text
commitment id
speaker
beneficiary or target
promised action or stance
condition
deadline or phase
visibility
fulfilled / broken / impossible / withdrawn
evidence refs
```

Coalitions:

```text
coalition id
members
visible or inferred
formation evidence
coordination evidence
shared targets
betrayal evidence
duration
impact on votes/actions
```

Influence:

```text
influencer
recipient
message/event exposure
recipient prior stance if known
recipient later stance/action
time delta
confidence
alternative explanations
```

Deception:

```text
speaker
statement or action
hidden truth contrast
recipient exposure
recipient belief/action shift
benefit to deceiver/team
later detection status
evidence refs
```

Trust and suspicion:

```text
source agent
target agent
score or categorical estimate
evidence refs
last update
reason class: vote alignment, contradiction, claim, ability result, gossip,
  betrayal, protection, attack, coordination, norm violation
```

Norm pressure:

```text
norm id
scope
expected behavior
invocation evidence
violation evidence
sanction or reward
affected reputation edge
```

Important design rule:

```text
The harness should record enough raw evidence first. Higher-level social
interpretation can be added by evaluators or derived ledgers, but it must cite
the underlying message/event/step/state evidence.
```

### Goal 4: Werewolf Domain Adapter

Purpose:

```text
Use Werewolf as the first domain adapter and pressure test for hidden-identity,
deception, persuasion, and coalition behavior.
```

Werewolf adapter responsibilities:

```text
GameState -> PlayerView / SocialObservation
PendingAction -> Social pending action
GameCommand -> SocialAction.command
GameEvent -> SocialEvent
Speech/Vote/NightAction -> SocialMessage and evaluator evidence
```

MVP rule configuration:

```text
9 seats
2 werewolves
4 villagers
1 seer
1 witch
1 hunter
sheriff initially off
last words on
reveal on death on
max days bounded
```

Core flow:

```text
role reveal
night: seer inspect
night: wolves kill vote
night: witch save/poison
night resolve
day death announcement
last words if applicable
day speech
day vote
exile resolve
hunter shot if applicable
game over check
next night
```

Werewolf-specific social requirements:

- werewolves have a team channel
- public day speech is a public channel message
- private tactical memo is private/postgame evidence, not public speech
- seer inspection is private to seer during play and postgame evidence later
- witch victim and potion state must not leak outside legal observation
- hunter shot state must remain environment-controlled
- votes and wolf kill votes should be `aec-batched-decision` until true `stepBatch` is implemented

Acceptance criteria:

- Werewolf adapter can be driven by generic social harness
- `runHarnessMatch()` becomes a compatibility wrapper around generic harness where feasible
- no Werewolf-specific type leaks into generic social harness modules
- all role abilities remain validated by `WerewolfEnvironment` / core engine
- message bus becomes authoritative for speech/team/private/system messages

### Goal 5: Artifact, Replay, Checkpoint, Fork

Purpose:

```text
Make every run auditable, replayable, and usable for evaluation.
```

Match artifact must include:

```text
artifact version
run id
match id
seed
config
profiles
assignment
resolved assignments
status
termination/truncation/failure reason
initial state
final state
trajectory
scheduler frames
messages
events
agent states or agent state hashes
checkpoints
evaluation report
metrics
errors
model usage
latency
```

Step record must include:

```text
trace id
turn index
batch id/index/size
scheduler mode
actor id
profile id
model
pending action
observation or observation hash/ref
policy plan
reasoner output summary
command
decision state hash
pre state hash
post state hash
message seq range
event seq range
reward/termination/truncation/info feedback
span ids
error if any
```

Tournament artifact directory:

```text
manifest.json
registry.json
spec.normalized.json
assignment.json
episodes.jsonl
trajectory.jsonl
metrics.jsonl
failures.jsonl
cost_latency.json
leaderboard.json
matches/{match_id}.json
matches/{match_id}.jsonl
```

Replay semantics:

```text
replay:
  Uses recorded initial state, commands, messages, and hashes.
  Does not call models.
  Checks pre/post state hashes and event/message ranges.

fork:
  Restores from a checkpoint.
  May call reasoner/policy again.
  Must create a new run id and record forkOf provenance.
```

Acceptance criteria:

- completed, truncated, and failed runs all produce artifacts
- replay never calls `HarnessReasoner`
- failed artifacts preserve partial trajectory and state hash at failure point
- JSONL export is not lossy for audit-critical data
- tournament results can be reconstructed from artifact files, not process memory

### Goal 6: Evaluator Registry

Purpose:

```text
Make evaluation modular, versioned, evidence-based, and aggregatable.
```

Evaluator registry entry shape:

```ts
interface EvaluatorManifestEntry {
  id: string;
  version: string;
  inputSchema: string;
  outputSchema: string;
  mode: "deterministic" | "model_graded";
  metricIds: string[];
  rubric?: string;
  dependencies?: {
    judgeModel?: string;
    promptVersion?: string;
  };
  aggregation: string;
  visibility: "public" | "private" | "postgame";
}
```

Metric record shape should evolve toward:

```ts
interface HarnessMetricRecord {
  metricId: string;
  evaluatorId: string;
  evaluatorVersion: string;
  scope: "episode" | "team" | "agent" | "profile" | "model" | "role" | "seat";
  subject: Record<string, unknown>;
  value: number | string | boolean | null;
  unit?: string;
  higherIsBetter?: boolean;
  denominator?: number;
  confidence?: number;
  aggregation?: string;
  evidenceRefs: Array<{
    artifact: "trajectory" | "message" | "event" | "trace" | "state" | "agent_state" | "metric";
    id?: string;
    seq?: number;
    traceId?: string;
    description?: string;
  }>;
  scenario?: string;
  split?: string;
  metadata?: Record<string, unknown>;
}
```

Initial evaluator modules:

```text
werewolf.outcome.v1
werewolf.vote_accuracy.v1
werewolf.role_survival.v1
social.deception_claim_consistency.v1
social.influence_vote_shift.v1
social.coordination_team_alignment.v1
social.reputation_calibration.v1
social.state.v1
harness.reliability.v1
harness.cost_latency.v1
```

Metrics to support:

- team win rate
- model/profile win rate
- role-balanced win rate
- seat-balanced win rate
- vote accuracy
- village false-positive rate
- werewolf misdirection success
- claim consistency
- known-false public claim rate
- influence follow-through
- vote shift after exposure to speech
- team coordination
- wolf kill alignment
- public evidence sharing
- reputation calibration
- invalid action rate
- failed run rate
- truncation rate
- token usage
- latency p50/p95
- retry count
- estimated cost with pricing snapshot

Acceptance criteria:

- evaluators are versioned
- metric records cite evidence
- deception/influence/collaboration are not only smoke heuristics
- model-graded evaluators, if added, are separate from deterministic metrics
- evaluator registry snapshot is saved in tournament artifacts

### Goal 7: Tournament Harness

Purpose:

```text
Move from single-match demos to automated, comparable multi-agent experiments.
```

Tournament input:

```text
experiment spec
profiles
assignment strategy
role config
seed schedule
game count
scheduler mode
evaluator registry
artifact output dir
timeout
continueOnError
```

Assignment strategies:

```text
profile-rotation
seat
role
team
```

Tournament output:

```text
manifest
registry snapshot
normalized experiment spec
assignment export
episode summaries
full match artifacts
trajectory JSONL
metrics JSONL
failure JSONL
leaderboard
cost/latency report
```

Acceptance criteria:

- same spec can be rerun
- seed schedule is explicit
- role/seat assignment is recorded
- continueOnError does not hide failures
- errors are attributed to actor/profile/model where possible
- leaderboard does not mix model, profile, role, and team dimensions
- bootstrap CI or similar uncertainty estimate can be added later without changing raw artifacts

### Goal 7.1 Tournament Artifact Writer Design Rules

The tournament writer should be additive and should not make
`runTournament()` itself responsible for arbitrary filesystem policy unless the
write is intentionally part of a CLI/script layer.

Preferred design:

```text
runTournament()
  creates game state
  resolves profiles/assignments
  calls runHarnessMatch()
  builds or exposes per-match artifacts while full HarnessRunResult is in scope
  returns TournamentResult with episode summaries and artifact references

writeTournamentArtifactDirectory()
  receives TournamentResult and/or captured MatchArtifact records
  writes a directory of manifest, registry, JSONL, leaderboard, and match files
```

Do not reconstruct full match artifacts from reduced episode summaries if the
full `HarnessRunResult` is still available. Reduced `TournamentEpisode` records
can lose details such as full initial/final state, failure state hash, events,
or truncation/failure fidelity. Build `MatchArtifact` from `HarnessRunResult`
using the existing artifact builder.

Required directory layout:

```text
manifest.json
registry.json
spec.normalized.json
assignment.json
episodes.jsonl
trajectory.jsonl
metrics.jsonl
failures.jsonl
cost_latency.json
leaderboard.json
matches/{match_id}.json
matches/{match_id}.jsonl
```

Recommended optional files:

```text
README.generated.md
```

`manifest.json` should include:

- artifact version
- experiment id
- created timestamp
- seed
- seed schedule
- models
- profile ids and profile versions if available
- assignment strategy and resolved assignments summary
- role/game config
- scheduler mode
- evaluator registry ids/versions
- games requested/completed/failed/truncated
- file list with relative paths
- overwrite/collision policy
- source git commit if available
- local package version if available

`episodes.jsonl` should include one summary per episode:

- episode index
- seed
- match id
- run id
- status
- harness status
- winner, phase, day
- assignment summary
- resolved model/profile/role/seat mapping
- metric summary
- evaluation report id/summary if available
- failure reason if any
- relative path to full match artifact if present

`trajectory.jsonl` should aggregate per-match trajectory/export records:

- preserve original record type
- add tournament episode index
- add tournament seed
- add match id
- add run id
- preserve trace id, actor id, step index, hashes, message ranges, and event
  ranges

`metrics.jsonl` should include evaluator metric records with:

- metric id
- evaluator id and version when available
- scope
- subject
- value
- denominator/confidence when available
- evidence refs
- episode index
- match id
- seed
- profile/model/role/seat dimensions when known

`failures.jsonl` should include:

- episode index
- seed
- match id if available
- run id if available
- status and harness status
- failure reason
- failure state hash if available
- actor/profile/model attribution if known
- provider error/timeout/retry/stream-abort data if available
- partial artifact path if available

`leaderboard.json` should not be a lossy substitute for raw metrics. It is a
derived view and should be rebuildable from `episodes.jsonl` and `metrics.jsonl`.

Status fidelity rule:

```text
TournamentEpisode.status may be coarse.
HarnessRunResult.status / episode.harnessStatus is authoritative for completed
vs truncated vs failed match fidelity.
```

Failure fidelity rule:

```text
Returned failed harness results should still produce failed MatchArtifact files.
Outer catch failures that happen before a HarnessRunResult exists should produce
failure JSONL records and manifest entries, not fake full match artifacts.
```

CLI rules:

- keep stdout machine-readable when `--json` is used
- report artifact directory paths inside the JSON result, not ad hoc stdout text
- write human progress/heartbeat logs to stderr only
- support an explicit output directory option such as `--outputDir` or
  `--exportDir`
- define overwrite/collision behavior clearly

Server rules:

- do not accept arbitrary host filesystem output paths from public API requests
  without a configured base directory and path containment checks
- prefer returning logical artifact ids or relative paths from the server
- avoid embedding full per-match artifacts in normal tournament API responses
  unless explicitly requested, because artifacts can be large

Artifact writer tests should prove:

- all expected files are written
- failed episodes appear in `failures.jsonl`
- returned failed harness runs still write partial match artifacts
- truncated status is not collapsed into completed status in artifact files
- leaderboard can be rebuilt from raw JSONL
- metrics preserve evaluator/source/scope/subject fields
- trajectory JSONL includes tournament context and original trace fields
- output remains valid when an episode failed before a full match artifact exists
- no API key or provider secret appears in any artifact
- rerunning into the same path obeys the documented collision policy

### Goal 8: React Cockpit

Purpose:

```text
Build a game/experiment cockpit, not a marketing page and not a chat window.
```

Major views:

```text
ArenaTable
ExperimentConfigPanel
AgentProfilePanel
AssignmentPanel
PhaseTimeline
PlayerSeatRing
SpeechFeed
VotePanel
NightActionPanel
SocialGraphPanel
TraceInspector
ArtifactPanel
ReplayStepper
TournamentLeaderboard
MetricsDashboard
```

UI principles:

- first screen should be the usable arena/dashboard
- player seats are central
- phase, pending action, and legal targets must be obvious
- speech feed and system log are separated
- public/live view must not leak hidden role information
- postgame view may reveal roles, private memo, team chat, and traces
- profiles are the single source of truth for model configuration
- no mismatch where UI model chips show one model but match request uses another
- replay UI should be driven by artifact data, not ad hoc frontend inference
- social graph UI should be driven by artifact messages, social/evaluator
  evidence refs, and agent-state summaries, not ad hoc frontend inference

Core UI objects:

```text
role card
player seat
speech item
vote marker
night action panel
message channel filter
trace span viewer
metric card
artifact download
replay scrubber
social graph edge
```

Acceptance criteria:

- match can be run from UI using env-configured defaults
- profile/assignment editing is explicit and reflected in request payload
- artifact can be downloaded
- trajectory JSONL can be downloaded
- replay can be triggered and inspected
- tournament leaderboard can be viewed
- social graph can be inspected from artifact-backed actor/message/evidence
  records
- postgame/private information is visually and logically separated from live/public information

## 6. Implementation Roadmap

Work in small verifiable slices. Do not rewrite the whole repo at once.

### Phase 0: Baseline Hygiene

Tasks:

- Keep env loading stable.
- Fix local shell noise if it blocks work, including `/root/.tmux.conf` option issues.
- Confirm `LLM_STREAM=true` remains default.
- Keep typecheck and tests passing.

Validation:

```bash
npx tsc --noEmit --pretty false
npm test
npm run build
```

### Phase 1: Social Scheduler Semantics

Status:

- Baseline implemented in `src/harness/social.ts` and covered by
  `tests/social.test.ts`.
- Treat this phase as a regression contract unless a new scheduler capability is
  being added.
- `runSocialEpisode()` now supports an optional domain-neutral observation
  assembly hook. The hook receives the environment observation, actor id,
  pending action, current state snapshot, and `SocialCommunicationBus` scoped
  visible channels/messages before `actor.observe()`.
- `runSocialEpisode()` now supports an optional system-transition hook for
  domains that need environment-owned transitions when no agent action is
  pending, such as Werewolf `system.advance`.
- The default observation path remains backward-compatible when no assembler is
  provided.

Tasks:

- Rename or alias `simultaneous-batch` to `aec-batched-decision`.
- Add a distinct `parallel` scheduler mode.
- Add `SocialStepFeedback`.
- Add `SocialParallelEnvironment.stepBatch`.
- Record reward/termination/truncation/info feedback.
- Add truncation and failure reasons to social artifacts.
- Continue hardening system-transition provenance as domain adapters migrate.

Tests:

- AEC single-agent selection
- batched decision same `decisionStateHash`
- true parallel requires `stepBatch`
- max transition truncation
- actor missing failure artifact
- observe failure artifact
- decide failure artifact
- environment step failure artifact
- system transition success and failure artifacts

### Phase 2: Message Bus In Main Runtime

Status:

- Baseline implemented for Werewolf public/team/private/reasoner-memo messages,
  actor-visible social observations, message envelopes, and `messageSeqRange`.
- Generic `runSocialEpisode()` can now merge bus-visible messages/channels into
  actor observations through the optional observation assembler, with tests for
  public and private scoped visibility.
- Continue hardening system messages, failed-step attempted/rejected message
  records, and adapter migration.

Tasks:

- Make `SocialCommunicationBus` deterministic or episode-clock based.
- Continue hardening `ObservationAssembler` semantics for migrated domain
  adapters.
- Keep merging bus-visible messages into actor observations as domains move onto
  `runSocialEpisode()`.
- Publish Werewolf public speech to bus.
- Publish werewolf team messages to team channel when applicable.
- Publish system messages to system channel.
- Record `messageSeqRange` on steps.

Tests:

- public messages visible to all
- team messages visible only to team
- private messages visible only to sender/recipient/postgame
- failed step does not commit messages unless explicitly marked attempted/rejected

### Phase 3: Agent Scaffold Stores

Status:

- Initial scaffold exists with actor id validation, observe-before-decide,
  policy authority, reasoner memo recording, and monotonic memory sequence tests.
- `src/harness/socialState.ts` now provides a pure-data `AgentSocialState`
  baseline with memory, generic belief claims, directed relationship edges,
  reputation records, norm records, and goal stack records.
- `ScaffoldedSocialActor` now exposes `state.social` while preserving the legacy
  `state.memory` compatibility view.
- `WerewolfAgentActor` now owns `AgentSocialState` in the real Werewolf harness
  path and records observation/message/memo/decision evidence plus
  `socialStateHash`.
- `WerewolfAgentActor` now ingests visible public role-claim message metadata
  into the observer's `BeliefStore`. When an actor observes a social message
  with `metadata.claimedRole`, it records a `claimedRole` belief about the
  speaker with message evidence. This records the observed assertion only; it
  does not treat the claimed role as hidden truth.
- Reasoner input mutation is isolated from internal state and from policy input;
  reasoner output is recorded as memo evidence, not as direct store mutation.
  The Werewolf reasoner context includes only `socialStateHash`, not the full
  private social state.
- Belief, relationship, reputation, norm, and goal updates require explicit
  evidence refs through store APIs.
- Full production stores are still needed as separate modules with richer
  retrieval, migration/versioning, evidence indexing, redacted memory retrieval
  for reasoner context, and stronger artifact/evaluator summaries.

Completed baseline tasks:

- Add `socialState.ts`.
- Upgrade `ScaffoldedSocialActor` to use `AgentSocialState`.
- Wire baseline `AgentSocialState` into `WerewolfAgentActor`.
- Add `socialStateHash` to agent state, reasoner context, trace, step, and
  artifacts.
- Add final `agent_state` JSONL records to match artifact export.
- Remove true hidden `role` / `team` from actor-visible live social message
  metadata.

Remaining tasks:

- Split the current baseline into durable `memory.ts`, `beliefStore.ts` or
  `socialBelief.ts`, `relationship.ts`, `norms.ts`, `reputation.ts`, and
  `goals.ts` modules once the contracts stabilize.
- Add `beliefStore.ts` or `socialBelief.ts`.
- Add `relationship.ts`.
- Add `norms.ts`.
- Add `reputation.ts`.
- Add `goals.ts`.
- Add richer retrieval, restore/migration, and artifact state summaries.
- Add redacted, visibility-scoped memory retrieval for model reasoning.
- Add evaluator metrics over social state evidence.

Tests:

- observe-before-decide requirement
- policy actor id validation
- reasoner memo storage
- memory trimming
- belief evidence updates
- relationship directed edge updates
- reputation evidence updates
- norms do not directly mutate environment
- goal stack status updates
- reasoner cannot mutate internal stores or pollute policy input
- Werewolf actor social state records scoped observation/memo/decision evidence
- Werewolf actor social state records visible role claims as message-backed
  belief evidence without leaking hidden role truth
- live social message metadata does not leak hidden role/team
- match JSONL exports final `agent_state` records

### Phase 4: Werewolf Adapter Migration

Status:

- `runHarnessMatch()` is now the authoritative Werewolf compatibility wrapper
  over `runWerewolfSocialHarnessPrefixAsHarnessResult()`. It must keep returning
  the legacy-shaped `HarnessRunResult`; do not expose raw generic social
  artifacts through existing replay/artifact APIs without a schema decision.
- The generic runner now has system-transition and observation-assembly hooks,
  reducing two migration blockers.
- `src/harness/werewolfAdapter.ts` now provides a thin Werewolf social adapter
  baseline around the existing `WerewolfEnvironment`, including
  `system.advance` transition mapping, scoped social observation assembly, and
  Werewolf social channel construction.
- The same adapter module now includes `WerewolfSocialActorAdapter`, which wraps
  the existing `WerewolfAgentActor` behind generic `SocialActor` and preserves
  the observe/plan/reasoner/commit/act lifecycle for generic-runner experiments.
- `src/harness/werewolfAdapter.ts` now owns shared Werewolf social channel and
  message draft helpers. `runHarnessMatch()` and `WerewolfSocialActorAdapter`
  both use the same message extractor for public speech, public votes, hunter
  shots, werewolf team kill votes, seer inspections, witch actions, and private
  reasoner memos.
- `WerewolfSocialActorAdapter` now returns `SocialAction.messages`, so generic
  `runSocialEpisode()` validates and commits Werewolf private/team/public message
  drafts through `SocialCommunicationBus` instead of dropping them.
- Live Werewolf message metadata must not carry hidden `role`, hidden `team`, or
  strategy-leaking `policyName`; trace/action/command metadata is enough for
  correlation, while role/team truth belongs in postgame artifacts and final
  state.
- A deterministic adapter test proves `runSocialEpisode()` can drive the
  Werewolf prefix `system.advance -> seer.inspect` through the existing core
  legality checks with the real Werewolf actor lifecycle and a fake reasoner, and
  now also proves the adapter commits private seer and private reasoner memo
  messages through the generic social bus.
- A deterministic batched-adapter test proves `runSocialEpisode()` can drive the
  Werewolf `night_wolves` two-actor kill-vote segment with
  `aec-batched-decision`, shared `decisionStateHash`, sequential application
  from the shared decision state, team-channel kill-vote messages, private
  reasoner memos, and no live role/team/policy metadata leakage.
- A deterministic public-speech adapter test proves a Werewolf speech draft
  emitted by `WerewolfSocialActorAdapter` is committed by generic
  `runSocialEpisode()` through `SocialCommunicationBus`, recorded in
  `messageSeqRange`, included in a later non-sender actor's scoped observation,
  and then written into that actor's message memory, relationship edge, and
  reputation record as message-backed evidence without exposing hidden `role`,
  hidden `team`, or `policyName` metadata.
- The Werewolf runtime now captures `SocialHarnessStep` records as sidecar
  artifacts when each authoritative Werewolf transition is applied.
- Vote and wolf-kill batches record actual runtime scheduler metadata
  (`aec-batched-decision`, batch id, batch index, batch size, and sequential
  resolution policy) instead of reconstructing that metadata after the fact from
  trajectory hashes.
- `HarnessStepRecord[]` remains the replay source of truth; social steps mirror
  successful applied trajectory steps and do not include failed attempted steps
  until replay semantics are extended.
- The remaining migration blocker is not `system.advance`, scoped social
  observation, public/team/private message propagation, basic actor lifecycle
  adaptation, channel construction, or message draft extraction anymore. The
  remaining blocker is preserving replay-grade `HarnessStepRecord` fields,
  harness turn events, action trace parity, live vs postgame redaction, and
  failure fidelity when the main `runHarnessMatch()` path eventually delegates
  more work to `runSocialEpisode()`.

Tasks:

- Keep `runHarnessMatch()` as compatibility wrapper.
- Internally move toward generic `runSocialEpisode()`.
- Let `WerewolfEnvironment` satisfy the generic social environment contract.
- Keep shared message extractors in the Werewolf adapter and add event extractors
  when generic runner migration needs them.
- Keep all legal action validation in core engine/environment.
- Preserve `HarnessStepRecord` as replay authority until generic replay can
  represent Werewolf trace/policy/reasoner fields.
- Add an integration layer that converts generic social steps plus adapter
  decision metadata into replay-grade `HarnessStepRecord` without making failed
  attempted steps part of replay trajectory.

Tests:

- existing engine tests remain green
- replay remains deterministic
- hidden role information does not leak through observation
- Werewolf public speech creates a bus message, records `messageSeqRange`,
  appears in a later non-sender actor's scoped observation through the adapter
  observation assembler, and updates message-backed memory/relationship/
  reputation and claimed-role belief evidence for the observing actor
- Werewolf team channel remains private during play
- social episode steps match trajectory trace ids, hashes, message ranges, and
  event ranges
- generic social runner can drive a Werewolf `system.advance -> seer.inspect`
  prefix through the adapter
- `WerewolfSocialActorAdapter` preserves actor observations, turns, private
  memos, social memory entries, and social state hash when driven by
  `runSocialEpisode()`
- generic Werewolf adapter commits private seer action and reasoner memo messages
  through `SocialCommunicationBus`, records `messageSeqRange`, and does not expose
  `role`, `team`, or `policyName` in live message metadata
- generic social harness rejects invalid action messages before stepping the
  environment and keeps bus-owned `id`/`seq`/`createdAt` out of actor drafts

### Phase 5: Artifact And Failed Runs

Status:

- Baseline implemented for `HarnessRunStatus = "failed"`, failed
  `runHarnessMatch()` partial results, failed social episodes, top-level match
  `failureReason` / `failureStateHash`, CLI/server artifact saving for returned
  failed results, and tournament counting of returned failed episodes.
- JSONL export now emits header, match metrics, evaluation report, channel,
  step, trace, message, `social_exposure`, event, error, `agent_state`, and
  metric records. `social_exposure` records are derived through
  `deriveSocialExposureRecords()` and preserve message/trace/observation
  evidence refs rather than relying on frontend transcript inference.
- Final-state checkpoint/fork primitives now exist in `src/harness/artifacts.ts`.
  `buildFinalHarnessCheckpoint()` creates `harness.checkpoint.v1` records with a
  checkpoint id, parent run/match/trace/turn provenance, state hash, restored
  state, restored agent states, trajectory prefix, and social message prefix.
  `forkHarnessRunOptions()` creates `runHarnessMatch()` options with restored
  `initialState`, restored `initialAgentStates`, and `forkOf` provenance.
- `runHarnessMatch()` can initialize `WerewolfAgentActor` instances from restored
  `AgentHarnessState` snapshots while allowing explicit profile/model/temperature
  config to remain the control-plane input. Fork results and match artifacts
  preserve `forkOf` provenance.
- `WerewolfAgentActor` hydrates already-seen social message ids from restored
  social memory evidence, so forked actors do not blindly re-record old visible
  messages as new observations.
- Social-bus fork continuity baseline now exists. `SocialCommunicationBus`
  accepts a validated restored message prefix, `runSocialEpisode()` accepts
  `initialMessages`, `HarnessRunOptions` accepts `initialSocialMessages`, and
  `forkHarnessRunOptions()` restores `checkpoint.socialMessages` into the fork
  runtime bus. Fork reasoner observations now include scoped-visible parent
  messages, fork artifacts preserve the parent message prefix, and new fork
  messages continue from `checkpoint.source.messageSeq + 1`.
- Checkpoint provenance is trusted only when it is produced by
  `buildFinalHarnessCheckpoint()` or an equivalent validator. API/store code must
  reject or flag tampered checkpoints where `hashStableState(checkpoint.state)`
  differs from `checkpoint.source.stateHash`, trajectory length/provenance does
  not match the stored prefix, or message sequence provenance contradicts the
  stored message prefix.
- Server/API exposure baseline now exists. `src/server/store.ts` has an
  in-memory checkpoint registry, and `src/server/index.ts` exposes checkpoint
  creation, checkpoint summary listing, explicit full postgame/debug checkpoint
  artifact retrieval at `/api/checkpoints/:id/artifact`, and checkpoint fork
  execution through id-based routes. The server app is testable through
  `createServerApp()` with injectable fake reasoners while the production entry
  still uses the env-backed streaming reasoner path.
- Checkpoint/fork API safety baseline now exists. The first server API version
  rejects path/file/output/raw artifact/raw checkpoint request fields, generates
  checkpoint ids server-side, validates checkpoint provenance before fork, keeps
  normal match summaries redacted, exposes only `checkpointCount` in normal
  match list/detail responses, and returns checkpoint summaries plus an
  explicit artifact URL from default checkpoint create/detail routes instead of
  embedding full checkpoint state, agent snapshots, trajectory, or social
  messages.
- Current `trajectory` intentionally remains a successful replayable prefix.
  A typed failed-step union needs a separate replay contract before adding failed
  attempted decisions into `HarnessStepRecord[]`.

Tasks:

- Add `failed` to `HarnessRunStatus`.
- Return partial result on reasoner/actor/environment errors.
- Save failed artifacts in server and CLI.
- Expand JSONL export.
- Add checkpoint ids and span ids.
- Extend checkpoint/fork beyond the current final-state baseline: arbitrary
  checkpoint positions, persisted checkpoint files, UI exposure, divergence
  inspection, and branch lineage visualization.

Server/API checkpoint and fork implementation notes:

- Add an in-memory checkpoint registry beside the existing in-memory match store
  first; do not introduce filesystem persistence until a safe configured base
  directory and retention policy exist.
- Generate checkpoint ids server-side. Public APIs must not accept
  `checkpointId`, `path`, `file`, `artifactPath`, `checkpointPath`, `outputDir`,
  raw `artifact`, or raw `checkpoint` payloads for fork execution in the first
  server API version.
- `POST /api/matches/:id/checkpoints` should require an existing stored match
  artifact, build a final checkpoint with `buildFinalHarnessCheckpoint()`, store
  it, and return a postgame/debug artifact response. It must not add full hidden
  checkpoint contents to normal match list/detail responses.
- `GET /api/checkpoints` should return summaries only by default. Full
  checkpoints contain hidden state, private observations, private memos,
  trajectory, and social messages, and should be treated like postgame/debug
  artifacts.
- `POST /api/checkpoints/:id/fork` should use `forkHarnessRunOptions()` and the
  same env-backed streaming reasoner path as match runs. The first version should
  accept only bounded operational knobs such as `reason`, `maxTransitions`, and
  `timeoutMs`; avoid model/profile/assignment override semantics until the
  desired counterfactual policy is confirmed.
- Fork responses should mirror existing match-run status semantics: completed
  fork as normal success, harness-level failed/truncated result preserved in a
  stored artifact, thrown server/model failures reported without fabricating a
  full successful artifact.
- Checkpoint and fork APIs are id-based. They must not become general host
  filesystem readers or writers.
- Full checkpoint and raw artifact endpoints are postgame/debug surfaces. Live
  public state must continue to use redacted public serialization and must not
  reveal hidden roles, private memos, team channels, provider headers, env values,
  or API keys.

Tests:

- reasoner throw creates failed artifact
- illegal command creates failed artifact
- partial replay reaches last successful step
- JSONL contains step, message, social exposure, trace, event, agent state,
  metric, and error records
- final checkpoint can restore state and agent snapshots into a forked
  `runHarnessMatch()` call, and fork provenance survives into `MatchArtifact`
- server/API can create/list/read final checkpoints, reject filesystem/raw
  artifact request fields, fork from stored checkpoints with fake reasoner
  injection, and store fork provenance on the new match artifact
- checkpoint/store/API boundary rejects or flags tampered checkpoint state hash,
  mismatched trajectory length, mismatched final trace/turn provenance, and
  mismatched social message sequence provenance
- fork semantics explicitly test social message behavior: restored parent
  messages are visible through the runtime bus with correct scoped visibility
- fork message sequence semantics are tested: new fork messages continue after
  the restored parent prefix rather than restarting branch-local message seq
- fork run does not mutate the checkpoint object, including state, agent
  snapshots, trajectory, and social messages
- duplicate, missing, or extra restored agent states are rejected or handled by a
  documented validator before API/store fork execution
- forked artifact JSONL header includes exact `forkOf` provenance; non-fork
  header uses stable absence semantics such as `forkOf: null`
- tournament artifact output preserves fork provenance in per-match artifacts
  and aggregate trajectory records, and exposes lineage summaries if server/UI
  needs fork lookup without opening full artifacts
- direct API/artifact serialization paths are checked for secret leakage with
  sentinel values; do not rely only on tournament file-writer redaction

### Phase 6: Evaluator Registry Hardening

Status:

- `HarnessMetricRecord` has additive `subject`, `evaluatorId`,
  `evaluatorVersion`, `denominator`, `confidence`, `aggregation`,
  `evidenceRefs`, `scenario`, and `split` fields while preserving the legacy
  `id`, `source`, and `subjectId` fields.
- `runEvaluationRegistry()` normalizes evaluator id/version and defaults
  `evidenceRefs` to an array for every metric.
- `HarnessEvaluatorManifestEntry` now exists as the full evaluator registry
  entry shape with id, label, version, input schema, output schema, evaluator
  mode, metric ids, optional rubric, dependencies, aggregation policy, and
  visibility.
- `HarnessEvaluator` and `HarnessEvaluationModuleResult` support optional
  manifest metadata. `runEvaluationRegistry()` preserves declared manifests and
  builds deterministic fallback entries for evaluators that only provide
  id/label/version.
- Built-in `werewolf.adversarial.v1`, narrower Werewolf evaluator modules, and
  `social.state.v1` declare complete manifest metadata, and match JSONL plus
  tournament `registry.json` preserve those fields.
- `werewolf.adversarial.v1` remains the aggregate compatibility output key for
  `AdversarialEvaluation` and `HarnessRunResult.evaluation`, while default
  runtime metric ownership is split across `werewolf.outcome.v1`,
  `werewolf.vote_accuracy.v1`, `werewolf.role_survival.v1`,
  `werewolf.influence.v1`, `werewolf.deception.v1`, and
  `werewolf.social_calibration.v1`.
- Werewolf adversarial metrics now include representative subject,
  denominator, confidence, aggregation, and evidence refs.
- Werewolf role-survival metrics now exist as deterministic postgame evaluator
  metrics (`agent.survival_rate` and `role.survival_rate`) with zero weight so
  they audit survival without perturbing reward leaderboards.
- `social.state.v1` exists as a separate evaluator in
  `src/harness/socialEvaluator.ts` and is registered alongside
  `werewolf.adversarial.v1` in `runHarnessMatch()`.
- Social-state metrics point to compact `agent_state` evidence refs with
  `socialStateHash` descriptions instead of dumping every private store detail
  into metric records.
- `social.dynamics.v1` now exists as a deterministic social dynamics evaluator
  registered alongside social-state evaluation. It audits influence edges,
  coordination messages, coalition signals, reputation evidence rate, norm
  pressure count, and norm resolution rate from serialized `AgentSocialState`
  without asking agents or models to self-report.
- `evaluation.social-fact-ingest-evidence.v1` now exists as a deterministic,
  zero-weight, postgame evaluator in `src/harness/socialEvaluator.ts` and is
  registered in the normal Werewolf harness result path. It audits scoped
  exposure-to-journal coverage for explicit commitment/coalition speech acts and
  structured relationship/reputation `metadata.socialFacts`, and it does not
  alter rewards, leaderboard summaries, deception scores, influence scores, or
  `evaluationReport.summary.agentScores`.
- `social.dynamics.v1` also consumes harness-derived scoped exposure records
  from `deriveSocialExposureRecords()` when `context.socialEpisode` is present.
  It now emits `agent.social.exposure_received_count`,
  `agent.social.public_exposure_received_count`, and
  `agent.social.unique_exposure_source_count` from recorded actor observations,
  not from global transcripts or recipient envelopes alone. Observation evidence
  is mapped into trace evidence refs because metric evidence refs do not yet
  have a first-class `observation` artifact kind.
- `werewolf.deception.v1` now emits deterministic public role-claim consistency
  metrics: `agent.false_role_claim_count` and
  `agent.false_role_claim_rate`. These compare `speech.submitted` public
  `claimedRole` records against postgame role truth and cite both speech event
  evidence and state evidence for the revealed role truth. This is a first
  evidence-backed deception/claim-consistency slice, not a complete social
  deception evaluator.
- `werewolf.deception.v1` also consumes `context.socialEpisode` when present
  and emits scoped false-role-claim exposure metrics:
  `agent.false_role_claim_exposure_received_count` and
  `agent.false_role_claim_unique_speaker_count`. These metrics join committed
  `public-speech` messages carrying `metadata.claimedRole` to postgame
  `finalState.players[].role`, then count only the false claims that actually
  appeared inside later actor-scoped observations via
  `deriveSocialExposureRecords()`. They must not infer exposure from the global
  transcript, `recipientIds`, or public visibility alone. Unobserved false
  claims remain claim facts but are not exposure evidence for any observer.
  Observation evidence is mapped to trace evidence refs until metric evidence
  refs support a first-class `observation` artifact kind.
- `werewolf.deception.v1` now also emits pressure-follow signals after scoped
  false role-claim exposure:
  `agent.false_role_claim_pressure_vote_follow_count` and
  `agent.false_role_claim_pressure_vote_follow_rate`. These metrics apply only
  when a false public role claim also carries `metadata.pressureTargetId` and a
  later vote decision's scoped observation contained that exact false-claim
  message. The evaluator then verifies the committed `vote.cast` command against
  `finalState.votes` and public vote events, and counts a follow only when the
  observer voted for the false claimant's pressure target on the same game day.
  This is an artifact-backed behavioral follow signal, not a causal claim and
  not model self-report. It must tolerate runtime social action kinds such as
  `vote.cast`; do not key this metric on a single display string such as
  `vote`.
- `werewolf.social_calibration.v1` now exists as a deterministic postgame
  Werewolf evaluator. It emits zero-weight calibration metrics:
  `agent.wolf_belief_brier_score` from final `AgentHarnessState.beliefs`
  wolf probabilities, and
  `agent.social.reputation_threat_brier_score` from evidence-backed
  `AgentSocialState.reputation.records[].threat` values normalized from
  `[-1,1]` to `[0,1]`. Both compare against postgame team truth and cite mapped
  social evidence refs, `agent_state`, and state truth evidence. This makes
  belief/reputation calibration artifact-visible without asking models to judge
  themselves or changing reward leaderboards.
- Social dynamics metrics map stored social evidence refs to `message`, `event`,
  `trace`, `state`, or `agent_state` metric evidence refs, preserving the
  artifact link instead of treating a transcript as the evaluator authority.
- Match JSONL and tournament `metrics.jsonl` preserve additive metric fields,
  including evaluator id/version, subject, denominator, confidence,
  aggregation, and evidence refs.

Completed baseline tasks:

- Keep evaluator manifest/registry snapshots versioned and artifact-visible.
- Expand metric records.
- Split existing adversarial evaluator metrics into narrower deterministic
  Werewolf evaluator modules while preserving aggregate `AdversarialEvaluation`
  compatibility.
- Add metric evidence refs.
- Add evaluator-level aggregation policies.

Remaining tasks:

- Replace remaining coarse `state` evidence refs with more precise
  event/message/trace refs where available.
- Add deterministic social deception and richer reputation calibration
  evaluators beyond the current social dynamics baseline.
- Keep model-graded evaluators separate from deterministic metrics when they
  are introduced.

Tests:

- registry snapshot saved
- evaluator manifest entries preserve schemas, mode, metric ids, rubric,
  dependencies, aggregation policy, and visibility
- metric evidence refs point to artifact records
- summary aggregation respects scope
- evaluator version changes are visible in report
- runtime report includes both `werewolf.adversarial.v1` and `social.state.v1`
- runtime report keeps `werewolf.adversarial.v1` as aggregate output and
  registers narrower Werewolf metric evaluators
- artifact JSONL and tournament metrics attribute Werewolf reward/survival
  metrics to their narrower evaluator ids
- artifact JSONL and tournament metrics preserve additive metric fields
- social-state metrics cite `agent_state` evidence
- runtime report includes `social.dynamics.v1`
- runtime report includes `evaluation.social-fact-ingest-evidence.v1`
- social fact ingest evidence evaluator is present in runtime evaluation
  registry, match artifact registry, JSONL metrics, and tournament metrics paths
- social fact ingest evidence metrics remain zero-weight and preserve
  `causalClaim: false`
- scoped exposure is required; unobserved messages, `recipientIds`, public
  visibility, and global transcripts do not create ingest-link evidence
- free-text-only messages are ignored by the evaluator
- missing mutation candidates are reported as diagnostics, not failures,
  no-effect claims, reward impact, causality, or leaderboard value
- social dynamics evaluator turns scoped message exposure artifacts into
  evidence-backed agent metrics
- Werewolf deception evaluator records false public role-claim count/rate from
  public speech events and postgame role truth evidence
- Werewolf deception evaluator records false role-claim exposure from scoped
  social observations, proves unobserved false claims are not counted, proves
  truthful observed claims are ignored, and cites message/trace/state evidence
- Werewolf deception evaluator links scoped false role-claim pressure exposure
  to same-day vote-follow signals, proves unobserved same-target votes are not
  counted, proves truthful pressure claims are ignored, and cites
  message/trace/vote-event/state evidence
- Werewolf social calibration evaluator records final wolf-belief and
  reputation-threat Brier scores against postgame team truth, preserves
  zero-weight reward isolation, and appears in runtime, match artifact, and
  tournament artifact registry/metrics paths
- artifact JSONL and tournament metrics preserve social dynamics metric ids,
  evaluator attribution, and evidence refs

### Phase 7: Tournament Artifact Writer

Status:

- Baseline implemented in `src/harness/tournamentArtifacts.ts`.
- `runTournament()` can collect full `MatchArtifact` records while
  `HarnessRunResult` is still in scope through `includeArtifacts` and can expose
  artifacts to a sink through `artifactSink`.
- CLI supports `--outputDir` / `--exportDir` and `--overwrite`.
- Writer emits manifest, registry, normalized experiment spec JSON,
  assignment JSON, episodes JSONL, aggregate trajectory JSONL, metrics JSONL,
  failures JSONL, cost/latency JSON, leaderboard JSON, and per-match JSON and
  JSONL files.
- Normalized spec export baseline now exists. `spec.normalized.json` preserves
  the exact `NormalizedTournamentExperiment` used by the run, including
  normalized models, profiles, assignment, games, seed, max transitions,
  timeout, temperature, JSON mode, continue-on-error policy, and domain config
  when present. CLI and server tournament entry points pass the normalized
  control-plane spec into `runTournament()` so artifact writers do not
  reconstruct it from reduced summaries.
- Assignment export baseline now exists. `assignment.json` preserves tournament
  assignment strategy, profiles, models, per-episode resolved assignments,
  per-agent player/seat/profile/model/temperature/role/team/policy mapping,
  fork provenance, and relative match JSON/JSONL paths when match artifacts
  exist. Pre-harness failures still receive an assignment episode record without
  fake match artifacts.
- Per-match JSONL export baseline now exists. `matches/{match_id}.jsonl`
  preserves the same match-level trajectory/export records as `toTrajectoryJsonl()`
  without tournament-added fields, while aggregate `trajectory.jsonl` remains
  the tournament-context-enriched stream. Because both paths parse
  `toTrajectoryJsonl()`, `social_exposure` records are preserved in per-match
  JSONL and aggregate `trajectory.jsonl`; aggregate records add episode index,
  tournament seed, episode seed, run id, and match id context without changing
  the underlying message/trace/observation evidence refs.
- Returned failed harness runs write partial failed match artifacts; pre-harness
  failures write failure records without fake match artifacts.
- Truncated status is preserved through `harnessStatus`, match artifact status,
  manifest counts, and aggregate trajectory headers.
- Tournament artifact fork-lineage summaries now exist. When a match artifact or
  episode carries `forkOf`, the writer surfaces compact fork provenance in
  `manifest.json` (`forkCount`, `forks`, and per-match `forkOf`),
  `episodes.jsonl`, `leaderboard.json`, and failure records, while aggregate
  `trajectory.jsonl` preserves the original match header `forkOf`.
- Tournament cost/latency report baseline now exists. `cost_latency.json`
  aggregates calls, prompt/completion/total tokens, latency, average latency,
  harness turns/errors, provider request ids, and attempt counts by tournament,
  model, and episode. It now also includes `providerFailures` aggregates for
  failed provider/model attempts, including failure kind, provider stage, status,
  timeout, abort, retryable, request id, and attempts where the failed
  `harness.error` payload provides that evidence. It records token/latency totals
  only; it does not invent provider pricing or dollar cost estimates without a
  configured pricing table.
- Tournament failure attribution baseline now exists. `failures.jsonl` includes
  `primaryFailure` and `failureAttributions` derived from `harness.error`
  events and episode agent assignments, including actor id, profile id, model,
  seat, role, team, policy, action kind, trace id, event id, and event seq when
  available. Provider-backed harness failures now carry a redaction-safe
  `providerFailure` summary and flattened fields such as failure kind, provider
  stage, status, timeout, abort, retryable, attempts, max attempts, and provider
  request id when available. Pre-harness failures explicitly retain empty
  attribution instead of inventing a fake actor or provider failure.
- Provider failure attribution baseline now exists. `src/agents/openaiClient.ts`
  tags HTTP, timeout, abort, stream-missing-body, stream-invalid-JSON,
  stream-empty, non-JSON, empty-content, and network failures with structured
  `failureKind` / `providerStage` metadata while preserving existing retry
  behavior. `src/harness/runtime.ts` preserves provider failure cause chains into
  `harness.error` payloads without storing raw provider bodies, headers, prompts,
  authorization data, or API keys in artifacts.
- Provider retry and stream success telemetry baseline now exists. Successful
  provider calls can carry `retryHistory` with per-attempt failure kind, stage,
  status, timeout, abort, retryable flag, delay, and message. Streaming successes
  carry `stream.completedBy` as either `done_sentinel` or `reader_done` without
  changing provider behavior. Runtime traces and step `reasonerOutput` preserve
  this telemetry so match/tournament artifacts can audit successful retries and
  stream completion mode.
- Server-side tournament artifact export/download baseline now exists.
  `src/server/index.ts` accepts bounded `exportArtifacts: true` on
  `POST /api/tournaments/run` only when `TOURNAMENT_ARTIFACT_BASE_DIR` or an
  injected test base directory is configured. The server generates artifact-set
  ids, writes under the configured base directory, registers absolute paths only
  in private server store state, exposes safe summaries through
  `GET /api/tournament-artifacts` and `GET /api/tournament-artifacts/:id`, and
  serves only registered relative files through
  `GET /api/tournament-artifacts/:id/files/<relative-file>`. Public responses do
  not expose `outputDir` or writer-returned absolute paths, and tournament run
  responses strip inline per-match `episode.artifact` when export is enabled.
- Tournament artifact API safety baseline now exists. Server tournament export
  rejects public request filesystem controls such as `outputDir`, `exportDir`,
  `path`, `file`, `artifactPath`, `checkpointPath`, `overwrite`, `baseDir`,
  `manifestPath`, and `registryPath` at the top level and inside nested `spec`.
  Download routes reject missing artifact-set ids, absolute paths, traversal,
  backslash traversal, empty path segments, and unregistered files without
  leaking local base directories in error bodies.
- Default collision policy is fail-if-exists; explicit overwrite is required to
  replace existing files.
- Verified with deterministic tests and a no-model CLI smoke using
  `maxTransitions=0`.

Completed baseline tasks:

- Add output directory writer.
- Write manifest, registry, normalized spec, assignment, episodes, trajectory,
  metrics, failures, cost/latency, leaderboard, matches, and per-match JSONL.

Remaining tasks:

- Add provider-specific error code normalization and cross-provider live
  streaming validation for retry/stream telemetry once bounded provider probes
  are explicitly needed.
- Deepen React artifact replay/tournament analytics UI over the safe server
  artifact-set API.
- Add persisted artifact-set indexing if server restarts need to retain
  previously written tournament artifact directories.

Tests:

- tournament writes all expected files
- normalized spec export can be re-normalized by the existing experiment spec
  parser and preserves run control-plane fields
- assignment export records strategy, profiles, models, per-episode resolved
  assignments, and per-agent seat/profile/model/role/team mappings
- failed episode writes failures JSONL
- per-match JSONL files exist for returned match artifacts, preserve match-level
  headers, and failed partial artifacts also receive JSONL
- aggregate `trajectory.jsonl` preserves `social_exposure` records from
  per-match JSONL with tournament episode context, while per-match JSONL remains
  free of tournament-added fields
- forked artifact lineage appears in manifest, episodes, leaderboard, aggregate
  trajectory header, and per-match JSON
- cost/latency report preserves token, latency, provider request id, and attempt
  summaries without leaking provider secrets
- failure records attribute harness errors to actor/profile/model/role/team when
  `harness.error` evidence exists, and keep pre-harness attribution empty
- provider failures preserve redaction-safe kind/stage/status/timeout/abort/
  retryable/attempt fields in `harness.error`, `failures.jsonl`, and
  `cost_latency.json` without leaking raw provider bodies, headers, or bearer
  tokens
- fake-fetch provider client tests cover retry history, HTTP retry/non-retry,
  stream `done_sentinel` vs `reader_done`, invalid stream JSON, empty stream,
  abort-before-start, network failure, non-stream parse failure, and non-stream
  empty-content failure
- leaderboard can be rebuilt from metrics JSONL
- server tournament artifact API tests cover configured-base export,
  no-base rejection, forbidden filesystem request fields, safe artifact-set
  listing/detail, registered file downloads, response stripping of inline match
  artifacts, traversal rejection, unregistered-file rejection, and store reset
  behavior

### Phase 8: React Cockpit

Status:

- Match artifact download/replay panels already existed for completed harness
  matches.
- Tournament artifact browser/download baseline now exists in `src/App.tsx`.
  The cockpit fetches `GET /api/tournament-artifacts`, renders server-registered
  artifact-set summaries, displays only logical relative filenames and
  server-provided download URLs, and can trigger a bounded
  `exportArtifacts: true` smoke tournament to populate the browser. The UI does
  not accept arbitrary local paths and does not make tournament artifacts a live
  hidden-state truth source.
- Tournament analytics baseline now exists in `src/App.tsx`. For the selected
  artifact set, the cockpit loads `leaderboard.json`, `cost_latency.json`,
  `failures.jsonl`, and `metrics.jsonl` through registered server download URLs,
  then renders model/profile leaderboard rows, provider/cost health, failure
  summaries, and evaluator metric groups from recorded artifacts rather than
  model self-report.
- Tournament drilldown baseline now exists in `src/App.tsx`. The cockpit renders
  episode status/truncation counts, per-episode leaderboard rows,
  retry/provider failure stage/status breakdowns, metric evidence-ref summaries
  with confidence/denominator hints, and richer failure attribution fields such
  as actor/profile/model/action/trace/timeout/retry/attempt data. Provider
  request ids remain non-prominent diagnostic data and are not used as UI keys.
- Artifact-driven social graph inspection baseline now exists in `src/App.tsx`
  for completed match artifacts. The cockpit derives actor nodes, message-flow
  edges, subjective relationship edges, and reputation records from recorded
  `MatchArtifact` data: `socialEpisode.messages`, `socialEpisode.channels`, and
  `agents[].social` state. It preserves evidence-ref summaries and visibility
  labels, treats relationship/reputation records as an observer agent's
  subjective state rather than objective global truth, and does not make React a
  hidden-state authority.
- Harness-level message-exposure derivation now exists in
  `src/harness/social.ts`. `deriveSocialExposureRecords()` converts recorded
  social episode steps into reusable exposure records from generic
  `visibleMessages`, Werewolf `observation.social.messages`, and wrapped
  generic-adapter `observation.view.social.messages`, preserving observed
  message id/sequence, observer id, turn index, action kind, trace id, channel,
  visibility, message kind, and evidence refs. The React social graph consumes
  those harness-derived records instead of owning the exposure parsing rule, so
  it can distinguish a message envelope/recipient edge from evidence that a
  later actor actually saw the message before deciding. React does not infer
  exposure from a global transcript or from `recipientIds` alone.

Tasks:

- Make profiles the model config source of truth.
- Add scheduler mode selector.
- Deepen artifact-driven replay panels beyond the existing match replay and
  tournament download browser baseline.
- Deepen artifact-driven social graph inspection with richer filters, evidence
  cross-links, trace links, fork/branch context, and clearer live/postgame
  visibility controls.
- Deepen artifact-driven exposure cross-links from committed public/team/private
  message records, observation evidence, trace ids, and `messageSeqRange` fields
  into richer drilldowns, so the cockpit can navigate from a statement to the
  exact later votes/actions whose scoped observations contained it.
- Deepen tournament dashboard navigation beyond the current episode/provider/
  metric-evidence/failure-attribution baseline.
- Separate live/public and postgame/private views.

Tests/validation:

- `npm run build`
- manual UI smoke with local dev server
- no hidden role leakage in live view
- social graph renders from artifact/API data, not independent frontend truth
- graph edges preserve evidence refs or artifact record references
- live/public graph rendering does not reveal hidden role/team/private state
- postgame/private graph data is labeled as revealed artifact/debug truth
- public-message exposure edges are derived from recorded message visibility and
  actor observation evidence, not inferred from hidden frontend state,
  `recipientIds`, or a global transcript
- generic `deriveSocialExposureRecords()` covers generic `visibleMessages`,
  direct Werewolf social observations, wrapped generic-adapter observations,
  message/trace/observation evidence refs, action kind, trace id, and turn index
- no text overlap on desktop/mobile
- artifact download works

## 7. Validation Policy

Always validate changes proportionally to risk.

Default validation:

```bash
npx tsc --noEmit --pretty false
npm test
```

Frontend or package changes:

```bash
npm run build
```

Harness CLI smoke:

```bash
npm run arena:match -- --maxTransitions=1 --timeout=1s --json=summary
```

Real API smoke when changing model/reasoner behavior:

```bash
npm run agent:probe -- --models=kimi-k2.7 --timeout=90s
```

Bounded real match:

```bash
npm run arena:match -- --models=kimi-k2.7 --maxTransitions=4 --timeout=120s --json=summary
```

Tournament smoke:

```bash
npm run arena:tournament -- --games=1 --maxTransitions=4 --timeout=180s --json=summary
```

Do not claim real API validation if the call was not run successfully.

## 8. Coding Rules For This Repo

When researching:

- If the user asks to research, browse current sources and cite them in the
  answer or docs you produce.
- Prefer primary docs, papers, official repos, and source code over blog
  summaries.
- Record the difference between verified facts, local code evidence, and design
  inference.
- For volatile API behavior, model/provider behavior, framework docs, or current
  best practices, verify before claiming.
- For harness concepts, compare against real systems such as PettingZoo,
  AutoGen, LangGraph, OpenAI Agents SDK, Concordia/generative agents, AIWolf,
  and related social deduction AI work, but adapt only what fits this repo's
  architecture.

Before editing:

- inspect existing modules
- prefer `rg` and `rg --files`
- read nearby code
- preserve existing patterns
- avoid unrelated refactors

When editing:

- use `apply_patch` for manual edits
- keep edits scoped
- do not revert user or other-agent changes
- do not introduce new frameworks without a clear need
- do not duplicate environment truth in prompts
- do not bypass typed command validation
- do not turn replay into rerun

When adding interfaces:

- first check whether `src/harness/social.ts`, `src/harness/types.ts`, `src/harness/contracts.ts`, or existing core types can be extended
- keep generic harness modules free of Werewolf-specific imports
- keep Werewolf-specific logic in adapter/core modules
- include tests for any public contract

When adding evaluator metrics:

- compute from artifact/state/events when possible
- include evidence refs
- include denominator where applicable
- separate deterministic metrics from model-graded metrics
- version the evaluator

When using LLM APIs:

- use streaming by default
- do not substitute another model silently
- do not use fake fallback for real harness validation
- record latency, usage, provider request id, attempts, and errors
- read provider config from `.env` / `.env.local`
- default live model set is `kimi-k2.7`, `deepseek-v4-flash`, and `minimax-m3`
  unless profile/config explicitly says otherwise
- call the OpenAI-compatible chat completions endpoint with `stream: true` for
  real model decisions
- use explicit timeouts and bounded retries
- record incomplete streams, aborts, retry causes, and final failure reasons
- never log or copy the API key into docs, terminal summaries, frontend payloads,
  artifacts, or final answers
- never claim a real model call succeeded unless the stream completed and the
  result passed local validation

When using subagents:

- split only independent work
- pass concrete questions and file/source targets
- ask for citations or file references
- keep secrets out of subagent prompts unless absolutely required and safe under
  the current tool policy
- merge results only after the main agent checks them against code, tests, or
  primary sources

## 9. Immediate Known Gaps

These are known project gaps. Prefer addressing them before adding flashy UI or
extra roles.

1. `runHarnessMatch()` is now a compatibility wrapper around the generic
   Werewolf social runner. Stale legacy-parity tests have been reframed into
   fixed production wrapper/generic contract tests, and private runtime legacy
   helper cleanup is complete. Continue hardening failure/provider/message/event
   contracts before adding flashy UI or extra roles.
2. Raw generic `SocialEpisodeArtifact.steps` are still broader than legacy
   replay records. Existing replay/artifact APIs must continue consuming
   projected committed `HarnessStepRecord[]` until a versioned generic social
   replay contract exists. A match artifact integrity validator baseline now
   exists for structural social-sidecar audit: social messages, channels,
   `messageSeqRange`, trajectory/social-step parity, event range references,
   scoped observation exposure references, agent social journal evidence/ranges,
   and evaluation metric counts can be checked without model calls. This is not
   yet full generic social replay of message bus delivery and social-state
   mutation semantics.
3. Failed attempted Werewolf decisions are represented by `harness.error`
   events and result/artifact failure fields, not by a typed failed step record.
   If failed steps are added later, replay must be extended before mixing them
   into `HarnessStepRecord[]`.
4. Illegal-command/environment-step failure now has an explicit Werewolf runtime
   test: a pathological no-legal-target seer inspect proposal is rejected by
   the environment authority, records `harness.turn` plus `harness.error`, and
   does not create a replayable failed `HarnessStepRecord`. A broader
   environment authority matrix also rejects illegal wolf kill, witch save,
   speech pressure, vote, and hunter shot commands while preserving the pre-step
   state. Remaining work is to extend the matrix when new roles, sheriff/last
   words variants, or true parallel joint-action semantics add new legality
   boundaries.
5. Werewolf still uses `aec-batched-decision` for votes and wolf kill votes;
   true Werewolf `parallel` requires a domain-level `stepBatch`/joint resolution
   design before use.
6. `WerewolfAgentActor` now owns the `AgentSocialState` baseline, but it is not
   yet implemented directly on top of `ScaffoldedSocialActor` and the generic
   social runner; `runHarnessMatch()` remains a Werewolf-specific compatibility
   path. Adapter-level generic-runner tests now cover public speech propagation
   through `SocialCommunicationBus` into a later actor's scoped observation and
   message-backed memory/relationship/reputation/claimed-role belief evidence.
   Werewolf social projection helpers for assembling harness player views,
   converting legacy `HarnessStepRecord` values into `SocialHarnessStep`
   records, and building Werewolf `SocialEpisodeArtifact` output now live in
   `werewolfAdapter.ts` instead of `runtime.ts`, so `runtime.ts` is thinner and
   the Werewolf-specific social artifact mapping sits beside the adapter's
   channels, system transitions, observation assembly, and message drafts. The
   generic social runner now also accepts an optional domain-provided event
   sequence extractor and fills `SocialHarnessStep.eventSeqRange` without
   importing Werewolf types; `werewolfAdapter.ts` exposes the corresponding
   `werewolfEventSeq()` helper for GameState events. The generic runner now
   also has an optional domain-neutral `beforeEnvironmentStep` hook that runs
   after social message validation and before the environment transition. The
   Werewolf adapter uses this hook through `recordWerewolfHarnessTurn()` to
   append legacy-compatible `harness.turn` events from `WerewolfSocialActorAdapter`
   traces in generic `runSocialEpisode()` paths. The remaining gap is full
   compatibility-wrapper migration, especially failure/error parity,
   legacy `HarnessStepRecord` parity, and replay parity.
7. Agent social state baseline exists in `socialState.ts` and is wired into the
   Werewolf actor path. The state aggregate is now composed from per-store
   factory helpers for memory, beliefs, relationships, reputation, norms, and
   goals without changing the serialized `AgentSocialState` shape. Store
   mutations for memory, beliefs, relationships, reputation, norms, and goals
   require evidence refs. Visible social-message ingestion now derives
   evidence-backed belief claims from existing safe message metadata for role
   claims, pressure targets, public vote targets, public hunter shots, and
   werewolf-team kill preferences; these claims are created only from messages
   actually present in the actor's scoped observation path. Remaining work is
   production-quality split modules, versioned snapshots, richer retrieval,
   durable evidence indexing, broader commitment/coalition outcome evaluators,
   redacted reasoner memory context, and stronger artifact/evaluator summaries.
8. Social dynamics evaluator baseline exists for influence edges, coordination
   messages, coalition signals, scoped message exposure, public exposure,
   unique exposure sources, reputation evidence rate, norm pressure count, and
   norm resolution rate. Werewolf deception metrics now also include public
   false role-claim count/rate backed by speech events and postgame role truth,
   plus scoped false-role-claim exposure counts derived from actual
   actor-observation artifacts and same-day vote-follow signals after scoped
   false pressure claims. Werewolf social calibration now also audits final
   wolf-probability beliefs and reputation threat estimates against postgame
   team truth with Brier metrics. Remaining work is richer deception-specific
   social evaluators, gossip/claim extraction, longitudinal belief/action-shift
   linkage after deception exposure, richer reputation update semantics, and
   deeper norm-pressure evidence.
9. Tournament directory export baseline exists, including
   `spec.normalized.json`, `assignment.json`, `episodes.jsonl`,
   `trajectory.jsonl`, `metrics.jsonl`, `integrity.jsonl`, `failures.jsonl`,
   `cost_latency.json`, `leaderboard.json`, and per-match JSON/JSONL artifacts.
   Per-match JSONL and aggregate `trajectory.jsonl` now include
   `social_exposure` records derived from scoped observations, and
   `failures.jsonl` includes actor/profile/model/role/team attribution when
   `harness.error` evidence exists. `integrity.jsonl` is a first-class
   structural artifact-integrity evidence stream, not an evaluator metric stream
   or runtime failure stream; manifest summaries include integrity ok/error
   counts and per-match integrity status. Match artifact structural integrity
   validation now catches corrupt social message sequences, step message ranges,
   scoped exposure references, trajectory/social-step mismatches, journal
   evidence/range corruption, hidden-truth journal flags, event mirror drift,
   and metric-count drift. Server-side id-based export/download baseline now
   exists under a configured safe base directory and registers `integrity.jsonl`
   as a downloadable JSONL artifact. Tournament artifact-set registration now
   has a server-owned disk index baseline under the configured artifact base
   directory, so list/detail/download routes can rehydrate exported artifact
   sets after the process-local store is cleared or a new server app instance is
   created. The persisted index stores relative registered file paths only;
   public DTOs still expose server download URLs and never expose `outputDir` or
   absolute paths. Artifact-set recovery now also scans generated UUID child
   directories for writer-produced `manifest.json` files when the server-owned
   index is missing, stale, or contains invalid records; scanned manifests must
   declare `artifactVersion: harness.tournament.v1`, `kind: tournament`, scalar
   identity fields, and the strict registered tournament file set before they
   are exposed. Registered downloads now perform lstat/realpath containment
   checks before `readFile()`, reject symlinked artifact set directories and
   symlinked registered files, and still require the requested relative path to
   be in the server-registered allowlist.
   Remaining work is stronger metric evidence refs, deeper React artifact
   analysis surfaces such as replay, trace, and social-graph drilldowns,
   open-file-handle/TOCTOU hardening if the artifact API threat model is raised,
   and full generic social replay beyond structural integrity.
10. Final-state checkpoint/fork baseline exists with durable checkpoint ids,
    restored state, restored agent snapshots, `forkOf` provenance, replay/fork
    tests, checkpoint provenance validation, and server/API exposure for
    id-based checkpoint create/list/read/fork. Server-side checkpoint artifact
    persistence now has an optional `CHECKPOINT_ARTIFACT_BASE_DIR` baseline:
    checkpoints are written as validated `harness.checkpoint.v1` JSON files
    under `checkpoints/<checkpointId>.json`, a redacted
    `checkpoints.index.json` registry is repaired from disk, routes rehydrate
    checkpoints after process-local store clear or fresh server app startup,
    invalid index records and malformed checkpoint files are ignored, and
    symlinked checkpoint files are rejected before they can be downloaded or
    forked. Public checkpoint responses remain summaries plus artifact URLs and
    do not expose restore state by default; full checkpoint artifacts remain an
    explicit postgame/debug surface. Social-bus continuity baseline also exists:
    fork runs restore parent message prefixes into the live bus and continue
    message seq after the parent boundary, including fork from persisted
    checkpoint files. Server-side match artifact persistence now has an optional
    `MATCH_ARTIFACT_BASE_DIR` baseline: completed/truncated/failed
    `harness.match.v1` artifacts are written under `matches/<matchId>.json`,
    a redacted `matches.index.json` registry is repaired from disk, match
    list/detail/artifact/trajectory/replay/checkpoint routes rehydrate
    server-owned artifacts after process-local store clear or fresh server app
    startup, and checkpoint fork child artifacts persist with full `forkOf`
    provenance. Replayed restored matches remain model-free and
    server-owned; client-submitted replay bodies are ignored by the id-based
    replay route. Malformed match files, stale/traversal/absolute/backslash
    index records, and symlinked artifact files are ignored without public path
    leakage. Match/checkpoint artifact writes now reject pre-existing symlinked
    artifact subdirectories before writing outside configured bases, and
    match/checkpoint index writers rehydrate existing persisted records before
    appending new artifacts so the first post-restart write does not drop older
    records. Fork artifact integrity validation now permits restored agent
    journals to reference inherited parent-checkpoint trace evidence through
    the explicit internal `forkOf.parentEvidenceTraceIds` set, while still
    rejecting unrelated missing trace references. This matters for
    multi-generation forks because Werewolf trace ids are tied to the domain
    state id, not necessarily to each branch match/run id. New fork artifacts
    record the exact inherited trace ids derived from checkpoint trajectory
    records and checkpoint agent social-journal evidence; old artifacts without
    that field retain the legacy direct-parent prefix compatibility path.
    Public fork summaries do not expose `parentEvidenceTraceIds`, and public
    API error text now redacts harness/social/probe-like raw trace ids. Public
    match summaries now preserve harness-level status with additive `harnessStatus`
    and `truncationReason` fields, so bounded/truncated runs are visible in
    list/detail/run responses and the React cockpit without breaking the
    existing stored-match `status` compatibility field. Server-side artifact
    recovery audit diagnostics now exist through
    `GET /api/artifact-recovery-audits`: malformed match files, malformed
    checkpoint files, malformed tournament child manifests, invalid index JSON,
    invalid index shape, stale or malicious index records, bad generated-file
    names, and rejected tournament directory entries are recorded before index
    repair. Public recovery audit records are white-listed to `id`, `createdAt`,
    `store`, `source`, `code`, `artifactId`, `relativeFile`, and `message`;
    audit ids are hashed, artifact ids are limited to generated UUIDs or
    `<rejected>`, relative files are limited to known safe artifact/index
    patterns or `<rejected>`, and tests assert no configured artifact base path
    leaks. Recovery audit records now persist to a server-owned versioned JSONL
    sidecar named `artifact_recovery_audits.jsonl` under each configured
    match/checkpoint/tournament artifact base. The sidecar is loaded before
    recovery scans, appended only for newly inserted deterministic audit ids,
    survives repaired-index restarts, is not registered as a tournament
    artifact-set download, and stores sanitized records rather than raw bad
    index/manifest/file contents. Sidecar loading now also reports malformed
    JSONL lines and invalid sidecar record shapes through sanitized
    `source: sidecar` diagnostics with hidden detail keys, static messages, and
    no raw line, raw exception, or sidecar-provided message exposure; duplicate
    sidecar records collapse through the same deterministic audit id path.
    Persisted sidecar diagnostics also reload their validated hidden
    `detailKey` values so multiple diagnostics with identical public
    store/source/code/relative-file fields remain distinct across restarts while
    `detailKey` stays out of the public API DTO.
    Sidecar files that are symlinks, directories, or otherwise fail safe
    regular-file checks are reported as non-blocking `sidecar_file_rejected`
    diagnostics and ignored without reading or appending to the unsafe file.
    Directory and child-manifest recovery now emits granular safe failure
    codes instead of collapsing all candidate artifacts into broad generic
    buckets: match artifacts distinguish invalid JSON, invalid shape/version,
    identity mismatch, unsafe regular-file checks, and structural integrity
    failure; checkpoint artifacts distinguish invalid JSON, invalid
    shape/version, identity mismatch, unsafe regular-file checks, and
    provenance/structural failure; tournament child manifests distinguish
    unsafe generated directories, unsafe manifest files, invalid JSON, invalid
    shape/version, identity mismatch, and unexpected registered file sets.
    The old broad `file_rejected` and `manifest_rejected` codes remain
    allowlisted for persisted sidecar compatibility, but current directory and
    manifest scans use the granular codes. The public recovery-audit API now
    also supports safe query narrowing and bounded pagination:
    `GET /api/artifact-recovery-audits?store=<match|checkpoint|tournament>&source=<index|directory|manifest|sidecar>&code=<safe_code>&limit=<1..500>&offset=<0..1000000>`.
    The default no-query response remains backward-compatible through the
    existing `records` field, while additive `filters` and `page` metadata let
    React diagnostics and experiment tooling page large audit sets without
    exposing raw paths, rejected query values, sidecar internals, or hidden
    harness truth. The React cockpit now consumes this server-owned endpoint
    through a first-class `恢复审计` tab in the central evidence panel. That tab
    uses the existing shadcn `Select`, `Table`, `Button`, `Badge`, `Card`, and
    `ScrollArea` components, keeps filtering/pagination server-backed, renders
    only the public audit DTO fields, and does not infer filesystem state or
    hidden game truth on the client. The cockpit also supports the additive
    deep link `?tab=diagnostics` so visual validation and research demos can
    open the recovery-audit surface directly without changing application
    truth.
    A first fork-lineage/divergence summary baseline now exists through
    `GET /api/matches/:id/fork-lineage`. The route is server-owned, id-based,
    and derived from stored match artifacts plus the checkpoint registry. It
    returns only a white-listed `server.fork-lineage-summary.v1` summary:
    redacted `forkOf` provenance, parent checkpoint/run hash refs, child
    trajectory/message counts, first/final child hash refs, and boundary
    booleans for parent state continuity, checkpoint-source consistency, and
    social-message prefix continuity. It does not return checkpoint restore
    state, agent snapshots, raw trace ids, full trajectory, social message
    bodies, private memos, hidden roles, filesystem paths, or raw checkpoint
    artifacts. The React `ReproducibilityPanel` now consumes that endpoint and
    renders a compact shadcn-backed fork boundary/divergence summary with
    status badges and hash/count rows; it remains a cockpit over server
    artifact truth, not an independent lineage authority.
    A direct checkpoint child-branch index now exists through
    `GET /api/checkpoints/:id/forks`. The route loads server-owned match and
    checkpoint artifact stores, verifies the checkpoint id, scans stored match
    artifacts for direct children whose `forkOf.checkpointId` matches the
    checkpoint, sorts children by `createdAt` descending, and returns only a
    white-listed `server.checkpoint-forks-summary.v1` summary. Child rows
    include run/match ids, created time, harness status, trajectory/message
    counts, redacted fork provenance, and nested `server.fork-lineage-summary.v1`
    boundary evidence. The endpoint does not return checkpoint restore state,
    child full artifacts, raw trace ids, full trajectories, social message
    arrays, private memos, hidden roles, profile/model assignment details, or
    filesystem paths. Tests cover missing checkpoint, empty child list,
    multiple children sorted newest-first, restart/rehydration, and redaction.
    The React `ReproducibilityPanel` now requests this endpoint for the active
    parent checkpoint and renders the server-owned child branch list inside the
    existing fork-lineage panel with shadcn `Badge`, `ScrollArea`, `Separator`,
    `Table`, and `Tooltip` primitives. React does not infer fork children from
    local checkpoints, tournament artifacts, or loaded match artifacts.
    A multi-generation checkpoint branch-tree query now exists through
    `GET /api/checkpoints/:id/branch-tree`. The route is server-owned and
    derives a flat branch graph from persisted match artifacts plus the
    checkpoint registry: checkpoint nodes, match/fork nodes, and
    checkpoint-fork / match-checkpoint edges. It returns only the white-listed
    `server.checkpoint-branch-tree-summary.v1` DTO: redacted root checkpoint
    summary, counts for checkpoints/matches/edges/maxDepth, compact checkpoint
    node summaries, compact fork child summaries with nested fork-lineage
    boundary evidence, edge ids/status flags, explicit `limits`,
    `okScope: returned`, and `truncation` metadata. Optional safe query controls
    `maxDepth=<0..100>` and `maxNodes=<1..1000>` bound the returned branch graph
    at the server boundary; truncated responses report reasons plus omitted
    checkpoint/match/edge candidate counts instead of letting React infer
    completeness. The endpoint does not return checkpoint restore state, full
    artifacts, raw trace ids, full trajectories, social message arrays, private
    memos, hidden roles, profile/model assignment internals, or filesystem
    paths. Tests now cover missing checkpoint, empty branch tree, in-memory
    multi-generation branch trees, persisted restart/rehydration branch trees,
    `maxDepth=0`, `maxDepth=1`, and `maxNodes=1` truncation, invalid limit rejection, redaction,
    and the multi-generation fork artifact integrity path that preserves
    inherited social-journal evidence refs. The React `ReproducibilityPanel`
    consumes this server DTO and renders a compact `多代分支树` view with shadcn
    `Badge`, `ScrollArea`, `Separator`, and `Tooltip` primitives, including
    server-provided limit/truncation status; React does not reconstruct lineage
    from local checkpoints, loaded artifacts, or tournament summaries.
    Remaining work is arbitrary mid-trajectory checkpoints, cursor/page
    iteration over very large branch forests, richer divergence inspection
    beyond boundary hash/count continuity, and optional deeper audit-log
    durability hardening such as fsync/atomic append strategy if the threat
    model is raised further.
    Tournament artifact-set child-manifest recovery now also rejects arbitrary
    contained `matches/*` filenames: per-match JSON/JSONL files must match the
   existing writer-produced `matches/tournament-<safe-seed>-<episode>.json`
   and `.jsonl` stem pattern before a restored manifest is registered. This
   prevents malicious but in-base manifests from exposing arbitrary labels as
   public registered download names while preserving the current tournament
   artifact writer contract.
11. Evaluator registry now has a full manifest schema baseline with id, label,
    version, input/output schema identifiers, deterministic vs model-graded
    mode, metric ids, rubric, dependencies, visibility, and explicit aggregation
    metadata. Werewolf outcome/reward, vote accuracy, role survival, influence,
    and deception metrics are split into narrower deterministic evaluator
    modules while `werewolf.adversarial.v1` remains the aggregate compatibility
    output key. Social dynamics metrics now cover first-order influence,
    coordination, coalition, scoped message exposure, reputation-evidence, and
    norm-pressure signals, while Werewolf deception metrics now include
    evidence-backed false role-claim count/rate and scoped false-role-claim
   exposure plus pressure vote-follow metrics. Werewolf social calibration
   metrics now score final wolf-belief and reputation-threat calibration
   against postgame team truth. The later `agent.social-update-journal.v1`
   baseline adds ordered redacted social-state mutation evidence, and the later
   standalone `evaluation.deception-belief-shift.v1` baseline consumes that
   journal for belief-only false-role-claim temporal association. The later
   `evaluation.commitment-coalition-lifecycle-temporal-association.v1` baseline
   consumes the same journal for zero-weight commitment/coalition lifecycle
   temporal association. The later
   `evaluation.norm-sanction-lifecycle-temporal-association.v1` baseline
   consumes the same journal for zero-weight norm and norm-sanction lifecycle
   temporal association. The later
   `evaluation.gossip-exposure-temporal-association.v1` baseline consumes the
   journal plus scoped social exposure records for zero-weight gossip exposure
   temporal association. The later trust-repair lifecycle,
   relationship-temporal, and reputation-temporal association baselines consume
   ordered redacted journal evidence for zero-weight trust-repair follow-up
   association. The later
   `evaluation.betrayal-lifecycle-temporal-association.v1` baseline consumes
   explicit betrayal records and ordered redacted betrayal journal evidence for
   zero-weight betrayal lifecycle temporal association. Broader relationship
   formation, broader reputation outcome effects beyond implemented
   trust-repair association baselines, broader norm outcome effects, broader
   commitment/coalition outcome effects, broader betrayal relationship,
   reputation, outcome, causal, and counterfactual variants, and counterfactual
   deception effects remain future separately named evaluator contracts.
   Remaining work is adding still more precise evidence refs and keeping future
   model-graded evaluators separated from deterministic metrics.
12. Metric records have additive denominator, confidence, evidence refs, subject
    snapshots, split/scenario fields, and aggregation policy fields, but
    built-in evaluators still need broader precise evidence refs and more
    consistent split/scenario population.
13. Deception/influence/collaboration metrics are currently too heuristic and
    need evidence-based implementations.
14. Tournament artifact writer exists and now surfaces fork lineage summaries in
    manifest, episode, leaderboard, failure, trajectory, and per-match artifact
    outputs. It also writes `cost_latency.json` with token, latency, provider
    request id, and attempt summaries, writes `spec.normalized.json` with the
    normalized experiment control-plane input, writes `assignment.json` with
    resolved profile/model/seat/role/team mappings, and writes per-match JSONL
    files beside per-match JSON artifacts. It also writes `integrity.jsonl`
    with structural match-artifact validation records and manifest ok/error
   counts. Server-side tournament artifact export/download now exists through
   safe artifact-set ids and registered relative-file downloads under a
   configured base directory, including `integrity.jsonl`. React cockpit
   artifact-set browsing/downloading now consumes that server API, lists the
   integrity artifact in the core download set, and loads `integrity.jsonl` into
   tournament analytics to show structural ok/error counts and per-match
   integrity records. Server-side artifact-set registry persistence now writes
   and reloads a redacted server-owned `artifact_sets.index.json` under the
   configured artifact base directory; tests cover rehydration through a fresh
   server app instance and continued rejection of unregistered index/traversal
   downloads without base-dir leakage. Server-side recovery now also has a
   strict child-manifest scanning fallback for externally restored artifact
   directories and realpath/lstat download hardening for registered files;
   tests cover missing-index child-manifest rehydrate, malformed child manifests,
   stale or malicious index records, and registered-file symlink escapes.
   Remaining work is deeper replay/tournament analytics UI and optional
   open-file-handle/TOCTOU hardening if the server artifact API needs a stronger
   filesystem attacker model.
15. Tournament failure records now include actor/profile/model-specific
    attribution when `harness.error` evidence exists. Provider-backed
    `harness.error` events now preserve redaction-safe failure kind, provider
    stage, status, timeout, abort, retryable, attempts, max attempts, provider
    request id, retry cause, and abort reason when available. Provider client
    successes and final failures now preserve compact per-attempt retry history.
    Remaining failure attribution work is provider-specific error code
    normalization and validating these classifications against bounded live
    streaming probes when model/provider behavior changes.
16. Cost/latency JSON captures tournament-level calls, token usage, latency,
    provider request ids, attempt counts, and provider failure aggregates by
    tournament/model/episode. Successful provider calls now preserve stream
    completion mode (`done_sentinel` vs `reader_done`) in traces and step
    reasoner summaries. Remaining provider telemetry gaps are validated
    stream-abort semantics across supported endpoints and optional pricing/cost
    estimates if a pricing table is explicitly configured later.
17. Profiles are now the single source of truth for model configuration across
    the main React cockpit, match API, tournament experiment normalization, and
    public/stored match/tournament summaries. React no longer keeps a separate
    `selectedModels` state; run/export/probe controls derive runtime model ids
    from normalized profiles. `/api/matches/run` resets stored/public `models`
    from explicit profiles before creating the match record.
    `normalizeTournamentExperimentSpec()` derives normalized `models` from the
    resolved profiles even when stale top-level `models` are supplied, so
    tournament success and failure summaries no longer report stale request
    models. Regression coverage exists in `tests/experiment.test.ts`,
    `tests/serverPublicViewApi.test.ts`, and
    `tests/serverTournamentArtifactsApi.test.ts`. Remaining work is optional
    browser/component-level fetch-payload tests for the React cockpit, and any
    future decision to migrate `/api/harness/probe` from a diagnostic
    single-model endpoint to an explicit profile-based diagnostic contract
    should be treated as a separate API change.
18. React cockpit now has a tournament artifact-set browser/download baseline
    over `/api/tournament-artifacts` and uses server-provided registered
    download URLs rather than arbitrary paths. It also has an artifact-driven
    tournament analytics baseline over `leaderboard.json`, `cost_latency.json`,
    `failures.jsonl`, `metrics.jsonl`, and `integrity.jsonl`, plus an initial
    episode/provider/metric-evidence/failure-attribution/artifact-integrity
    drilldown, and a completed-match artifact social graph inspection baseline
    over recorded messages, subjective relationship edges, reputation records,
    and evidence summaries.
    Server-side public match view redaction now has a baseline:
    `serializePublicState()` returns a white-listed `PublicGameState` without
    hidden `night` state, private/postgame events, full metrics, source ids,
    hidden roles/teams, pending hunter internals, or private harness memos; the
    full postgame truth remains available through artifact routes.
    React cockpit still needs deeper artifact-driven replay, trace inspection,
    richer graph drilldown/cross-linking, richer tournament navigation, and
    stricter visual/data separation between live/public, actor-scoped,
    postgame artifact, probe, and debug replay surfaces.

## 10. Desired End State

The mature system should support scenarios beyond Werewolf:

- Werewolf
- Avalon / Resistance-style hidden role games
- Diplomacy-like negotiation
- debate and persuasion arenas
- market/social exchange simulations
- coalition formation
- trust and reputation experiments
- norm compliance experiments
- adversarial deception benchmarks

The generic harness should remain stable while each domain supplies:

```text
state schema
pending action schema
observation projection
legal command schema
environment transition function
message/event extractors
domain-specific evaluators
UI adapter
```

Final guiding statement:

```text
Build a domain-neutral multi-agent adversarial society harness. Agents are
stateful social actors with memory, beliefs, relationships, norms, reputation,
goals, policies, and optional reasoners. The environment owns truth and legal
state transitions. Artifacts, replay, evaluation, and tournaments make behavior
auditable and comparable. Werewolf is the first proof that the harness works
under hidden information, deception, persuasion, and coalition pressure.
```

## 11. Detailed Goal And Execution Lock

This section captures the current detailed product goal and execution plan. It
exists because the user explicitly asked that the goal design and multi-agent
harness direction be written into `AGENTS.md` in detail.

Future agents must treat this as durable repository memory.

### 11.1 Product Goal In One Sentence

```text
Build a domain-neutral, replayable, forkable, evaluable multi-agent
adversarial/social harness where stateful agents interact through scoped
observations, explicit communication channels, legal action boundaries, durable
private/social state, artifact-backed evaluation, and automated tournaments;
use Werewolf only as the first pressure-test domain and React cockpit surface.
```

This means the product is not:

- a Werewolf-only game
- an LLM group chat
- a prompt chain
- a JSON-output parser
- a React demo with mock hidden roles
- a benchmark summary that cannot be rebuilt from artifacts

The product is:

- a harness runtime
- an agent scaffold
- a social communication substrate
- a domain adapter system
- an artifact/replay/fork system
- an evaluator/tournament system
- a React cockpit over recorded harness truth

### 11.2 Required Goal Grammar

Every substantial goal must be stated as a reusable capability, not as a vague
activity.

Use this exact grammar for planning, implementation notes, and status updates:

```text
Goal id:
  <stable dot-separated id, e.g. server.tournament-artifact-download.v1>

Capability:
  <the durable harness/system capability that will exist after the change>

Owner plane:
  <control | environment | observation | society | agent | artifact |
   replay/fork | evaluation | tournament | API/server | React cockpit>

Owner modules:
  <exact files after inspection, not guesses>

Existing contracts checked:
  <files/tests/docs/source links inspected before changing interfaces>

Problem boundary:
  <what this solves>

Non-goals:
  <what this explicitly does not solve>

State authority:
  <who may mutate truth/private state/artifacts>

Generic contract:
  <domain-neutral types, runtime behavior, artifact records, evaluator records,
   API shape, or UI view model affected>

Werewolf proof:
  <how the first domain demonstrates the generic capability>

Agent/society impact:
  <memory, beliefs, relationships, reputation, norms, goals, messages,
   deception, coalition, trust, suspicion, arbitration, or policy effects>

Replay/fork impact:
  <whether deterministic replay, checkpoints, forks, hashes, or provenance are
   affected>

Evaluation/tournament impact:
  <metrics, evidence refs, aggregation, leaderboard, failure attribution, cost,
   latency, or provider telemetry changes>

UI/API impact:
  <how server routes or React consume recorded harness truth>

Failure behavior:
  <what artifact, error event, or partial result is produced on failure>

Validation:
  <focused tests, typecheck, build, fake-client smoke, optional bounded
   streaming probe/match/tournament>

Promotion rule:
  <what must be true before moving to the next capability>
```

A goal is invalid if it can be completed by saying "the model answered." A goal
is valid only when contracts, runtime behavior, artifacts, and validation prove
the capability.

### 11.3 Master Capability Backlog

Use this backlog when the user says "continue", "继续", asks for overall goal
design, or asks for the next harness-level work and does not give a newer
specific target.

#### MASTER.0 Architecture Boundary

Capability:

```text
Keep LLM, Agent, Harness, Environment, Evaluator, Tournament, API, and UI
responsibilities separate so the system cannot collapse into AI chat.
```

Owner plane:

```text
all planes, enforced mostly in src/harness/*, src/core/*, src/server/*,
src/App.tsx, tests/*, and this file
```

Required invariants:

- `LLM != Agent`
- reasoner output is advisory and never the state authority
- environment owns hidden truth and legal transitions
- harness owns scheduling, visibility, communication commit, traces, artifacts,
  replay, fork, and tournament control
- evaluators consume artifacts/events/messages/state, not model self-report
- UI consumes API/artifact truth and does not invent hidden roles, winners, or
  private state

Validation:

- inspect interfaces before changing them
- add or update tests when boundaries are touched
- run `npx tsc --noEmit --pretty false`
- run `npm test`
- run `npm run build` for frontend/API/package changes

Promotion rule:

```text
No later goal may add a shortcut that violates these boundaries.
```

#### MASTER.1 Generic Social Harness Runner

Capability:

```text
Run domain-neutral social environments with explicit scheduler semantics,
scoped observations, legal action boundaries, communication bus integration,
failed-step artifacts, and deterministic trace output.
```

Owner plane:

```text
control, environment, observation, society, artifact
```

Owner modules:

```text
src/harness/social.ts
src/harness/contracts.ts
src/harness/environment.ts
src/harness/runtime.ts
src/harness/types.ts
tests/social.test.ts
tests/harness.test.ts
tests/werewolfAdapter.test.ts
```

Deliverables:

- generic runner API that can drive a domain adapter
- scheduler modes with precise semantics:
  - `aec`
  - `aec-batched-decision`
  - true `parallel` only when `stepBatch` exists
- observation assembly that never leaks hidden truth
- actor lifecycle enforcement
- system transition handling
- failed/truncated/completed result semantics
- trace records with state hashes and message ranges

Werewolf proof:

- Werewolf runtime becomes a compatibility wrapper around generic execution
  where feasible
- public speech, wolf team coordination, private role action, vote, night kill,
  death, and victory remain domain-owned

Acceptance:

- a non-Werewolf domain can implement the same environment contract in
  principle
- scheduler mode appears in artifacts
- failed actor/environment decisions produce failure artifacts
- replay trajectory contains only committed successful transitions unless a
  typed failed-step union is deliberately added with replay support

#### MASTER.2 Agent Scaffold And Private Social State

Capability:

```text
Represent agents as durable social actors with identity, private state, memory,
beliefs, relationships, reputation, norms, goals, policy, optional reasoner, and
action arbitration.
```

Owner plane:

```text
agent, society, artifact
```

Owner modules:

```text
src/harness/scaffold.ts
src/harness/socialState.ts
src/harness/actor.ts
src/harness/policy.ts
src/harness/reasoner.ts
tests/scaffold.test.ts
tests/socialState.test.ts
tests/harness.test.ts
```

Deliverables:

- production-quality split stores for:
  - memory
  - beliefs
  - relationships
  - reputation
  - norms
  - goals
- serializable snapshots
- state hashes or redacted summaries in artifacts
- evidence refs for every meaningful social-state mutation
- deterministic policy path that works without a live model
- reasoner integration that can draft, critique, summarize, or propose but not
  mutate stores directly
- action arbitration that filters illegal or malformed candidates before the
  environment sees them

Werewolf proof:

- villagers form suspicion and trust from visible speech/votes
- wolves maintain deception/coordination state without leaking hidden team
  truth into public artifacts
- special roles preserve private observations and tactical goals

Acceptance:

- actor can decide without model provider
- private state is serializable
- reasoner output cannot mutate internal state directly
- hidden truth is only stored when legally observed or inferred from visible
  evidence
- tests cover observe-before-decide, actor id validation, evidence-backed
  mutations, and reasoner authority limits

#### MASTER.3 Communication And Multi-Agent Society Layer

Capability:

```text
Make communication a first-class, scoped, replayable social substrate with
channels, messages, claims, commitments, relationships, influence, deception,
coalitions, and norm evidence.
```

Owner plane:

```text
society, observation, artifact, evaluation
```

Owner modules:

```text
src/harness/social.ts
src/harness/socialState.ts
src/harness/socialEvaluator.ts
src/harness/evaluation.ts
src/harness/evaluator.ts
tests/social.test.ts
tests/socialState.test.ts
tests/evaluation.test.ts
```

Required primitives:

- public channels
- team channels
- private/local memo channels
- system channels
- postgame-only reveal views
- deterministic message sequence numbers
- visibility metadata
- delivery or visibility evidence
- claim and contradiction evidence
- commitment and betrayal evidence
- trust/suspicion/reputation updates
- norm invocation, violation, sanction, and resolution records
- coalition and influence evidence

Werewolf proof:

- day talk is public
- wolf coordination is team-scoped
- seer/witch/hunter observations remain private unless voluntarily claimed
- public claims can be compared to postgame truth
- later votes/actions can be linked to prior message exposure
- public-channel messages can be traced from committed message records to later
  actor-scoped observations before they are used as exposure evidence for
  influence, coordination, deception, or vote/action analysis

Acceptance:

- social messages are never loose prompt text only
- every committed message has channel, sender, recipients/visibility, sequence,
  timestamp/order, and causality refs where relevant
- evaluators can compute baseline influence, coordination, deception, and norm
  signals from artifacts

#### MASTER.4 Domain Adapter Layer

Capability:

```text
Support concrete games/simulations through adapters while preserving generic
harness ownership.
```

Owner plane:

```text
environment, observation, domain adapter
```

Owner modules:

```text
src/core/*
src/harness/werewolfAdapter.ts
src/harness/environment.ts
src/harness/runtime.ts
tests/engine.test.ts
tests/werewolfAdapter.test.ts
tests/harness.test.ts
```

Werewolf adapter responsibilities:

- initial game state
- pending action discovery
- scoped player views
- legal command validation
- environment transitions
- event extraction
- message extraction
- domain evaluator hooks
- hidden truth handling

Generic harness must not import Werewolf-only role rules, victory rules, or UI
labels. If a generic module needs a Werewolf-specific type, stop and redesign
the adapter boundary first.

Acceptance:

- Werewolf proves the adapter contract under hidden information
- another domain can be added without changing core harness authority
- UI receives rendered views or artifacts, not raw hidden truth during live play

#### MASTER.5 Artifact, Replay, Checkpoint, And Fork

Capability:

```text
Persist every meaningful run as auditable data that can replay without model
calls and fork with explicit provenance.
```

Owner plane:

```text
artifact, replay/fork, control
```

Owner modules:

```text
src/harness/artifacts.ts
src/harness/replay.ts
src/harness/tournamentArtifacts.ts
src/core/engine.ts
src/server/store.ts
src/server/index.ts
tests/artifacts.test.ts
tests/replay.test.ts
tests/tournamentArtifacts.test.ts
tests/serverCheckpointApi.test.ts
```

Deliverables:

- match artifact
- social episode artifact
- JSONL export
- state hashes
- failure records
- checkpoint records
- fork provenance
- replay verification
- divergence inspection baseline
- secret redaction

Acceptance:

- replay never calls models
- forks record parent checkpoint/run lineage
- failed/truncated/completed runs all preserve useful artifacts
- artifacts do not leak provider secrets
- server-side artifact download uses a configured safe base directory and
  containment checks

#### MASTER.6 Evaluator Registry And Social Metrics

Capability:

```text
Make evaluation versioned, evidence-backed, aggregatable, and separated from
model self-report.
```

Owner plane:

```text
evaluation, tournament, artifact
```

Owner modules:

```text
src/harness/evaluation.ts
src/harness/evaluator.ts
src/harness/socialEvaluator.ts
src/harness/tournament.ts
src/harness/tournamentArtifacts.ts
tests/evaluation.test.ts
tests/tournament.test.ts
tests/tournamentArtifacts.test.ts
```

Required deterministic metric families:

- outcome and win rate
- role/seat/profile/model splits
- vote accuracy and false positives
- invalid action rate
- survival and role utility
- wolf coordination and target quality
- claim consistency after truth reveal
- deception exposure, false-claim consistency, follow, and temporal association
- influence and vote shift
- coalition formation/betrayal
- relationship/reputation calibration
- norm pressure/compliance/violation
- provider latency/token/retry/stream failure aggregates

Model-graded evaluators are allowed later only if they are separated with:

- evaluator id/version
- judge model/profile
- rubric version
- input evidence refs
- confidence/uncertainty
- explicit deterministic-vs-model-graded label

Acceptance:

- metric records include subject/scope, denominator where applicable, evidence
  refs, confidence where useful, aggregation policy, and evaluator registry
  metadata
- tournament leaderboard can be rebuilt from saved raw metric files

#### MASTER.7 Tournament Harness

Capability:

```text
Run automated multi-agent comparisons across models, profiles, roles, seats,
seeds, schedulers, and configs while preserving failures and raw artifacts.
```

Owner plane:

```text
control, tournament, artifact, evaluation, provider telemetry
```

Owner modules:

```text
src/harness/experiment.ts
src/harness/tournament.ts
src/harness/tournamentArtifacts.ts
src/scripts/runTournament.ts
src/server/index.ts
src/server/store.ts
tests/experiment.test.ts
tests/tournament.test.ts
tests/tournamentArtifacts.test.ts
```

Deliverables:

- normalized experiment spec
- profile/model/seat/role assignment record
- seed schedule
- episode records
- per-match JSON and JSONL
- trajectory JSONL
- metrics JSONL
- failures JSONL
- cost/latency/provider telemetry JSON
- leaderboard JSON
- registry snapshot
- safe server-side artifact download

Acceptance:

- failed/truncated/completed runs are all visible
- pre-harness failures do not fake match artifacts
- provider failures include redaction-safe attribution
- leaderboard is rebuildable from raw metrics
- public server APIs never accept arbitrary host output paths

#### MASTER.8 React Cockpit

Capability:

```text
Render a high-quality live/replay/analysis cockpit over harness truth.
```

Owner plane:

```text
React cockpit, API/server, artifact consumer
```

Owner modules:

```text
src/App.tsx
src/styles.css
src/server/index.ts
tests/serverCheckpointApi.test.ts
future UI tests when added
```

Required cockpit views:

- arena table with seats and phase state
- role cards with visibility-aware rendering
- speech/message timeline
- vote and night-action panels
- system event log
- replay controls
- trace inspector
- social graph
- checkpoint/fork panel
- tournament leaderboard
- artifact browser/download
- config/profile/model summary

Acceptance:

- live UI does not leak hidden truth
- postgame UI labels revealed truth clearly
- UI state is never the authority for game truth
- cockpit consumes API/artifact data
- desktop/mobile layouts avoid text overlap and preserve clear controls

### 11.4 Implemented Concrete Goal Contract

The following concrete implementation slice is now implemented and should be
treated as an active contract. Future work should preserve these API/security
semantics and build React artifact browsing on top of them rather than creating
a parallel artifact path.

```text
Goal id:
  server.tournament-artifact-download.v1

Capability:
  Server-side tournament artifact export and download under a configured
  safe base directory.

Owner plane:
  API/server + artifact + tournament

Owner modules:
  src/server/index.ts
  src/server/store.ts
  src/harness/tournamentArtifacts.ts
  src/harness/tournament.ts
  tests/serverTournamentArtifactsApi.test.ts
  .env.example if adding a documented optional variable

Problem boundary:
  The CLI can already write tournament artifacts. The server needs a safe API
  flow for exporting and downloading those artifacts without accepting arbitrary
  host filesystem paths from public requests.

Non-goals:
  Do not build a full React artifact browser in this slice.
  Do not change tournament metric semantics.
  Do not expose raw provider secrets, prompts, hidden env values, or arbitrary
  filesystem paths.
  Do not embed full per-match artifacts in the normal tournament run response.

State authority:
  Tournament runner produces result data.
  Tournament artifact writer writes files.
  Server owns artifact-set ids, configured base directory resolution, path
  containment checks, and download authorization/lookup.
  Request body must not control absolute output paths.

Generic contract:
  A server-controlled artifact-set registry and download API over existing
  tournament artifacts.

API shape:
  POST /api/tournaments/run accepts a bounded boolean
  `exportArtifacts: true`.
  Public requests reject fields such as `outputDir`, `path`, `file`,
  `artifactPath`, `exportDir`, `checkpointPath`, `overwrite`, `baseDir`,
  `manifestPath`, `registryPath`, or other raw filesystem path controls at the
  top level and inside nested `spec`.
  GET /api/tournament-artifacts lists artifact-set summaries.
  GET /api/tournament-artifacts/:id returns one safe summary.
  GET /api/tournament-artifacts/:id/files/<relative-file> serves only
  registered files under the artifact set directory.

Security requirements:
  Use a configured base directory, for example
  `TOURNAMENT_ARTIFACT_BASE_DIR`.
  Generate artifact-set ids server-side.
  Resolve all downloads under the registered artifact directory.
  Reject absolute paths, traversal, unregistered files, missing artifact ids,
  and unknown files.
  Do not expose absolute server paths in normal API responses.
  Redact secrets from artifacts using the existing artifact writer behavior.

Werewolf proof:
  Running a small deterministic tournament can export Werewolf match artifacts,
  then download manifest/metrics/trajectory/per-match files through the server.

Agent/society impact:
  No direct agent behavior change. The value is that multi-agent society
  experiments become auditable through downloadable raw artifacts.

Replay/fork impact:
  Downloaded artifacts should include replayable trajectory and fork/provenance
  records when present.

Evaluation/tournament impact:
  Downloaded artifacts should include registry, metrics, failures,
  cost_latency, leaderboard, and per-match records so tournament analysis can be
  rebuilt offline.

Failure behavior:
  Export requested without configured base directory returns a clear 400.
  Unsafe request fields return 400.
  Unsafe downloads return 400 or 404 without leaking local paths.
  Tournament failures remain represented through existing failure
  artifacts.

Validation:
  npx vitest run tests/serverTournamentArtifactsApi.test.ts
  npx tsc --noEmit --pretty false
  npm test
  npm run build
  secret scan over AGENTS.md, src, tests for accidental provider key leakage

Promotion rule:
  Move to React artifact browser only after the server exposes safe, id-based,
  path-contained artifact downloads with tests.
```

This promotion rule is satisfied for the server/API baseline. The next UI slice
may consume these endpoints, but must not make React the source of artifact or
hidden-state truth.

### 11.5 Runtime Provider And Secret Rule

The configured live model provider is already captured through env files. This
file may record non-secret operational values only:

```text
LLM_CHAT_COMPLETIONS_URL=https://llm.kimchi.dev/openai/v1/chat/completions
LLM_MODELS=kimi-k2.7,deepseek-v4-flash,minimax-m3
LLM_STREAM=true
```

The API key must never be written into `AGENTS.md`, README, tests, artifacts,
frontend payloads, screenshots, subagent prompts, or final answers. If a user
asks to "write this into AGENTS.md" and the referenced content includes a
secret, write the operational memory and variable names, not the secret value.

Live provider calls must use streaming. A live path is not validated unless:

- the request used `stream: true`
- the stream completed or failed with classified telemetry
- the local adapter parsed the result
- policy/arbitration accepted a candidate
- environment validation accepted the final command/message
- artifacts recorded the decision or failure

### 11.6 Subagent Rule For Future Work

The user requires full 6-subagent parallelization for meaningful work when the
tool environment supports it. Use them when the work is meaningfully parallel,
such as:

- current internet research on primary docs
- local codebase mapping
- harness boundary critique
- agent scaffold critique
- evaluator/tournament artifact audit
- API/server security audit
- React cockpit truth-source audit

Do not reduce below 6 except for tool unavailability, secret-handling risk, or
tiny edits where direct inspection is faster. Do not
send secrets to subagents. The main agent must integrate and verify all
subagent claims.

### 11.7 What The Next Agent Should Do On Resume

When resuming from this point:

1. Read `AGENTS.md`.
2. Check the newest user message first.
3. If no newer target overrides the backlog, use section 13.11 and section
   13.13 as the authoritative next-goal list. Do not resume older completed
   section-11 slices by default.
4. Inspect the owner modules and tests named by the selected section-13 goal
   before changing APIs, harness runtime, agent scaffold, evaluators, or UI.
5. Implement the smallest safe contract.
6. Add focused tests.
7. Run focused validation, then typecheck/full tests/build if warranted.
8. Update `AGENTS.md` known gaps after behavior changes.

Do not restart from product brainstorming unless the user explicitly asks for a
new plan. The architecture direction is already locked: harness first, agent
society second, Werewolf as proof surface, React as cockpit over truth.

## 12. Active Goal Charter For Harness And Multi-Agent Society

This section is the current answer to the user's request:

```text
Tell me how the overall goal should be designed, especially the multi-agent
adversarial society, harness framework, and agent scaffold; then write it into
AGENTS.md in as much detail as possible.
```

Future agents should use this as the active goal charter when the user says
`continue`, `go on`, `keep building`, or asks what the goal is.

### 12.1 Goal Design Principle

The top-level goal must not be designed around screens, prompts, or individual
Werewolf features. It must be designed around durable harness capability.

Correct goal shape:

```text
Capability first:
  What reusable harness/social/agent/evaluation capability will exist?

Runtime authority second:
  Which component owns truth, scheduling, visibility, legality, artifacts, or
  state mutation?

Werewolf proof third:
  How does Werewolf pressure-test this capability under hidden information,
  deception, voting, role powers, and social inference?

React cockpit fourth:
  How does the UI present the harness/API/artifact truth without becoming a
  hidden state authority?

Validation last:
  What tests, typechecks, artifact checks, replay checks, smoke checks, or
  streaming probes prove the capability?
```

Wrong goal shape:

```text
Make several models chat.
Make the model return JSON.
Make a pretty Werewolf UI with local mock truth.
Ask the evaluator model who won socially.
Summarize a transcript and call it replay.
Run a tournament but drop failed runs.
```

The short form:

```text
Goal = harness capability + agent/social state + artifact evidence + evaluator
proof + Werewolf adapter proof + React cockpit presentation.
```

### 12.2 Master Goal

The master goal for the repository is:

```text
Build a domain-neutral multi-agent adversarial society harness that can run
stateful agents through scoped observations, explicit communication channels,
legal action boundaries, durable private/social state, deterministic
environment transitions, replayable artifacts, checkpoint/fork provenance,
evidence-backed evaluators, and automated tournaments; use Werewolf as the
first domain adapter and React as a cockpit over recorded truth.
```

This master goal decomposes into three primary build pillars:

```text
Pillar A:
  Multi-agent harness framework.

Pillar B:
  Multi-agent society and agent scaffold.

Pillar C:
  Werewolf proof domain and React analysis cockpit.
```

The first two pillars are the product. The third pillar is the first proof
surface.

### 12.3 Pillar A: Multi-Agent Harness Framework Goal

Goal id:

```text
harness.framework.v1
```

Capability:

```text
Provide a reusable runtime for adversarial/social multi-agent experiments.
The harness must schedule actors, project scoped observations, commit
communication, validate actions, call environment transitions, record traces,
handle failures, write artifacts, replay without model calls, fork from
checkpoints, run evaluators, and aggregate tournaments.
```

State authority:

- The environment owns canonical domain truth.
- The harness owns actor scheduling, observation projection, message commit,
  action legality boundary, lifecycle control, trace recording, artifact
  recording, replay, fork, evaluator execution, and tournament orchestration.
- The agent owns its private state and proposes actions/messages.
- The reasoner may propose text, analysis, summaries, or candidates, but never
  commits state.
- The UI displays state derived from API/artifacts and never mutates hidden
  truth directly.

Required harness contracts:

```text
ExperimentSpec:
  domain id, seed, scheduler mode, profiles, model assignments, actor count,
  role/seat assignment policy, max transitions, timeout/retry policy,
  evaluator set, artifact policy, checkpoint policy, provider policy.

DomainAdapter:
  create initial state, enumerate pending actors/actions, project observation,
  validate command, apply command, emit events, emit messages, expose safe
  postgame truth, supply domain evaluator context.

Scheduler:
  aec, aec-batched-decision, and true parallel semantics only where the
  environment can validate a batch atomically.

Runner:
  loop over scheduled actors/system steps, deliver observations, invoke agents,
  validate proposals, apply transitions, commit messages, record traces,
  classify completion/truncation/failure.

MessageBus:
  scoped channels, sequence numbers, visibility records, delivery/exposure
  evidence, redaction rules, message causality refs.

ArtifactStore:
  match artifacts, social episode records, trajectory JSONL, metrics JSONL,
  failure JSONL, checkpoints, fork provenance, registry snapshots, redaction.

ReplayEngine:
  replay from initial seed/config plus committed commands/messages/events/hashes
  without calling providers.

ForkEngine:
  restore a checkpoint, run from a divergence point, record parent run,
  checkpoint id, changed config/profile/model/seed, and fork reason.

EvaluatorRegistry:
  deterministic evaluator manifests, model-graded evaluator separation,
  evidence refs, aggregation policy, metric schema, leaderboard input.

TournamentRunner:
  execute many runs over seeds, roles, seats, profiles, models, schedulers, and
  domain configs; preserve failed/truncated/completed runs.
```

Harness acceptance gates:

- A non-Werewolf domain can implement the adapter surface in principle.
- Every committed transition has actor id, observation refs, proposed
  action/message refs, validation result, environment event refs, and state hash
  where available.
- Failed actor decisions, provider failures, invalid commands, environment
  exceptions, truncations, and timeouts are represented as artifacts or failure
  records.
- Replay does not call a model provider.
- Fork lineage can be inspected from artifacts.
- Evaluators can rebuild metrics from saved artifacts.
- Tournament leaderboards can be rebuilt from raw metric records.
- Hidden truth is not injected into live observations unless the adapter says it
  is legally visible.

Promotion rule:

```text
Do not add more Werewolf-only features if the change actually belongs in the
generic harness runner, message bus, artifact store, replay/fork engine, or
evaluator registry.
```

### 12.4 Pillar B: Multi-Agent Society Goal

Goal id:

```text
society.substrate.v1
```

Capability:

```text
Make society a first-class runtime substrate, not an after-the-fact transcript.
Agents must communicate through scoped channels, observe only what they are
allowed to observe, remember social evidence, update beliefs and relationships,
form commitments, apply norms, coordinate, deceive, persuade, sanction, and
adapt strategy based on what they actually observed.
```

Required society entities:

```text
Actor:
  durable actor id, public display identity, profile id, optional model profile,
  domain seat/role assignment, team when legally visible, private state id.

Channel:
  public, team, private, direct if domain permits, system, self memo,
  postgame-only reveal.

Message:
  id, sequence, sender, channel, recipients or visibility rule, body or safe
  content, metadata, causality refs, created-at transition, redaction class.

Observation:
  actor id, transition id, visible domain state, visible messages, visible
  events, pending legal action, redactions, source state hash when available.

ExposureRecord:
  actor id, message id, observation id/ref, transition id, channel, delivery
  mode, whether the message was actually present in that actor's observation.

Claim:
  speaker, subject, predicate, value, confidence if available, evidence
  message/event, scope, later truth comparison if available.

Commitment:
  actor, promised action/stance, target, audience, deadline/phase, evidence,
  fulfilled/broken/unknown status.

RelationshipRecord:
  source actor, target actor, trust, suspicion, affinity, influence,
  cooperation, threat, debt, evidence refs, update history.

ReputationRecord:
  target actor, observer or public scope, honesty, competence, threat,
  cooperation, norm compliance, evidence refs.

NormRecord:
  norm id, group/channel scope, expectation, violation, sanction, repair,
  evidence refs.

CoalitionRecord:
  members, public/private status, shared target/goal, formation evidence,
  coordination evidence, betrayal evidence, dissolution evidence.
```

Required social dynamics:

- Public persuasion: an agent tries to shift group belief or vote.
- Private/team coordination: a subgroup forms or executes a plan.
- Deception: an agent asserts a claim inconsistent with hidden/postgame truth or
  with its private knowledge.
- Suspicion: an agent increases estimated adversarial probability for another
  actor based on visible evidence.
- Trust: an agent increases willingness to follow, protect, or cooperate with
  another actor.
- Reputation: social estimates persist beyond a single message.
- Norm pressure: agents invoke, violate, enforce, or repair social expectations.
- Coalition: agents align around a target, defense, vote, kill, or information
  strategy.
- Betrayal: an actor breaks a commitment or harms a prior ally.
- Influence: a visible message or action is later linked to belief/action shifts
  by exposed observers.

Minimum acceptance:

- The harness can prove who saw which message before that message is used as
  evidence for influence or deception metrics.
- Social-state updates cite evidence refs.
- Actor-specific social states can diverge.
- Public transcript is not treated as universal knowledge unless the observation
  records prove delivery/visibility.
- Postgame truth can be used by evaluators, but not by live actor observations.
- Social metrics are artifact-derived, not based on model self-report.

### 12.5 Pillar B: Agent Scaffold Goal

Goal id:

```text
agent.scaffold.v1
```

Capability:

```text
Represent each agent as a harness-managed actor with identity, private state,
memory, beliefs, relationships, reputation, norms, goals, policy, optional
reasoner, candidate generation, action arbitration, and traceable decisions.
The agent must remain an agent even when no model provider is available.
```

Agent internal lifecycle:

```text
1. initialize
   Load actor id, profile, model policy, role/seat assignment, strategy family,
   private stores, deterministic fallback policy, and reasoner config.

2. observe
   Receive one scoped observation from the harness. Never read global hidden
   truth directly.

3. ingest
   Append observed events/messages to memory. Extract explicit claims,
   commitments, pressure, accusations, votes, defenses, contradictions, and
   relevant domain facts from safe metadata and visible content.

4. update stores
   Update beliefs, relationships, reputation, norms, goals, and tactical state
   through store APIs that require evidence refs.

5. retrieve
   Select relevant memory, current beliefs, social graph neighborhood, pending
   goals, legal actions, and risk signals for the decision.

6. reason
   Optionally call a model-backed reasoner using streaming. The reasoner may
   draft speech, critique strategy, summarize evidence, or propose candidates.
   It does not mutate stores and does not commit commands.

7. generate candidates
   Policy creates one or more legal-intent candidates: speak, vote, inspect,
   protect, poison, kill, pass, claim, accuse, defend, coordinate, or withhold.

8. arbitrate
   Score candidates for legality, utility, risk, social cost, team objective,
   role objective, deception exposure, and consistency with commitments.

9. propose
   Return a command/message proposal to the harness.

10. validate externally
   Harness/domain adapter validates and commits or rejects the proposal.

11. learn from outcome
   Record success/failure, environment events, social reactions, and reflection
   into private state.

12. snapshot
   Emit redacted state summaries, hashes, or artifact records as allowed.
```

Required stores:

```text
MemoryStore:
  chronological observations, events, messages, decisions, outcomes,
  reflections, evidence ids, redaction class.

BeliefStore:
  facts and probabilities about actors, roles, teams, actions, claims, goals,
  contradictions, confidence, evidence, revision history.

RelationshipStore:
  directed trust, suspicion, influence, cooperation, affinity, threat, debt,
  trend, evidence.

ReputationStore:
  honesty, competence, threat, cooperation, norm compliance, public/private
  scope, evidence.

NormStore:
  active expectations, violations, sanctions, compliance, repair, local social
  rules, evidence.

GoalStore:
  long-term role/team goals, tactical goals, public commitments, private plans,
  priority, status, blocking evidence.

PolicyState:
  strategy family, risk appetite, deception appetite, cooperation tendency,
  claim posture, voting posture, communication style, fallback behavior.
```

Strategy families to support:

- Deterministic baseline: for tests, replay-friendly smoke runs, and failure
  isolation.
- Evidence-driven villager: tracks claims/votes, estimates wolf probability,
  avoids hidden-truth leakage.
- Deceptive wolf: coordinates privately, crafts public false narratives, tracks
  exposure risk, protects partners.
- Information role: preserves private observations, decides when and how to
  reveal, manages credibility.
- Protective role: reasons about target risk, bait, claims, and expected wolf
  action.
- Hunter-like retaliation role: plans credible threat, last words, and
  post-death action where the domain permits it.
- Social manipulator: applies pressure, frames alternatives, forms coalitions,
  and tests reactions.
- Cautious survivor: minimizes exposure, avoids premature claims, preserves
  optionality.
- Experimental model-backed reasoner: drafts language and candidate rationale
  while policy/arbitration remains in code.

Agent scaffold acceptance:

- The actor can make a legal decision without a live model.
- Real provider calls, when used, stream.
- Model text is treated as advisory input to policy/arbitration.
- Store updates require evidence refs.
- Private state is serializable or has a redacted artifact summary.
- Illegal candidates cannot mutate the environment.
- Tests prove observe-ingest-update-decide boundaries.
- Replay uses committed decisions/artifacts, not fresh model calls.

### 12.6 Pillar C: Werewolf Proof Domain Goal

Goal id:

```text
domain.werewolf-proof.v1
```

Capability:

```text
Use Werewolf as the first hidden-information adversarial social domain that
proves the harness, society, agent scaffold, artifacts, evaluators, tournament,
and React cockpit under pressure.
```

Werewolf is valuable because it stresses:

- asymmetric hidden roles
- adversarial teams
- public discussion
- private team coordination
- night actions
- role-specific information
- death and removal
- voting pressure
- false claims
- last words / sheriff variants when added
- postgame truth comparison

Required mapping:

```text
Werewolf environment:
  role assignment, teams, alive/dead state, phases, deaths, victory, legal
  pending actions, night resolution, vote resolution.

Observation projection:
  villagers see public state and public speech only; wolves see wolf team when
  rules permit; seer sees own inspection result; witch sees own potion state and
  legal rescue/poison information; hunter sees own trigger ability if modeled.

Communication:
  day public table channel, wolf team night channel, private self memo,
  postgame reveal channel, system event channel.

Actions:
  public-speech, vote.cast, wolf.kill, seer.inspect, witch.save, witch.poison,
  hunter.shoot if supported, pass, system resolution.

Postgame:
  reveal roles, teams, final truth, claims vs truth, vote history, night action
  history, deaths, winners, evaluator inputs.
```

Werewolf acceptance:

- Hidden roles are not visible in live public observations.
- Wolf private knowledge is not leaked to villagers.
- Special-role observations are scoped to the actor.
- False role claims are compared to postgame truth only by evaluators.
- Vote/action metrics require committed action and event evidence.
- Exposure metrics require actual actor-scoped observation evidence.
- Replay can reproduce the match trajectory without provider calls.

### 12.7 Pillar C: React Cockpit Goal

Goal id:

```text
react.cockpit.v1
```

Capability:

```text
Provide a high-quality interactive cockpit for live play, replay, social
analysis, artifact browsing, and tournament comparison over harness truth.
```

Core views:

- Arena table: player seats, alive/dead state, phase, current actor, visible
  public status.
- Role card: current user's legal role knowledge, ability state, target
  controls, redacted hidden information.
- Speech timeline: public/team/private messages with channel and visibility
  context.
- Vote/action panel: legal targets, pending action, committed action, invalid
  action feedback.
- Night action panel: role-specific legal actions without revealing other roles.
- System log: phase changes, deaths, vote results, night results, victory.
- Replay controls: step, jump, speed, phase filter, actor filter, state hash.
- Trace inspector: observation, candidate, validation, command, events,
  messages, errors.
- Social graph: trust/suspicion/influence/reputation/coalition evidence.
- Artifact browser: manifest, trajectory, metrics, failures, checkpoints,
  registry, per-match files.
- Tournament dashboard: model/profile/role/seat/seed splits, win rate, social
  metrics, failure rate, latency/cost/stream errors.

UI truth rules:

- Live UI must use scoped API views.
- Postgame UI can reveal hidden truth only with clear postgame labeling.
- React state may cache view state, filters, and interaction state, but not
  canonical game truth.
- The UI must not infer hidden roles from local mock data.
- Artifact download must use server-controlled ids and safe registered files.

UX standard:

- Dense but readable operations cockpit, not a marketing landing page.
- No decorative UI that hides the state needed for decisions.
- Controls must map to legal actions.
- Text and controls must not overlap on desktop or mobile.
- Replay and evaluation must be explainable from evidence refs.

### 12.8 Evaluation Goal

Goal id:

```text
evaluation.social-adversarial.v1
```

Capability:

```text
Measure multi-agent adversarial/social behavior from artifacts with versioned,
evidence-backed metrics.
```

Metric families:

- outcome: win/loss, team win, role win, survival.
- legality: invalid action rate, timeout rate, provider failure rate.
- voting: vote accuracy, wolf vote concentration, village false positives,
  vote change after exposure.
- communication: speech volume, claim count, contradiction count, unanswered
  accusations, pressure attempts.
- deception: false role claims, false claim exposure, pressure follow after
  observed false claim, and post-exposure temporal association; counterfactual
  successful-deception claims require a separate future metric contract.
- influence: exposed message to later belief/action shift.
- coordination: wolf target agreement, coalition voting, team consistency.
- betrayal lifecycle: explicit betrayal records and later ordered lifecycle
  evidence as standalone zero-weight postgame temporal-association signals only.
- calibration: wolf probability Brier score, reputation threat Brier score,
  confidence vs truth.
- social state: trust/suspicion/reputation/norm updates with evidence density.
- tournament: profile/model/role/seat/seed splits, failure attribution,
  latency/token/retry/stream-abort aggregates.

Evidence requirements:

- Do not count exposure unless an actor-scoped observation proves the actor saw
  the message.
- Do not count a vote-follow unless a committed vote action and public vote
  event prove the vote.
- Do not count deception from self-report.
- Do not use postgame truth in live state; use it only in postgame evaluators.
- Metrics should include evaluator id/version, subject/scope, denominator where
  applicable, aggregation policy, confidence where useful, and evidence refs.

### 12.9 Harness MVP Sequence

When choosing next work without a newer user target, use this sequence.

Milestone 1:

```text
Generic social runner compatibility.
```

Deliver:

- inspect current `runHarnessMatch()` and social episode construction
- move Werewolf-specific assumptions behind adapter boundaries where feasible
- preserve existing tests and artifacts
- prove that message visibility and scheduler semantics remain explicit

Milestone 2:

```text
Production agent scaffold stores.
```

Deliver:

- split memory, belief, relationship, reputation, norm, and goal stores where
  the codebase structure supports it
- require evidence refs for mutations
- add snapshots/redacted summaries
- keep deterministic policies working without providers

Milestone 3:

```text
Claim and contradiction extraction.
```

Deliver:

- use existing structured metadata first
- extract role claims, pressure targets, vote claims, accusations, defenses,
  commitments, and contradictions where evidence exists
- avoid model/NLP parsing unless explicitly designed and tested

Milestone 4:

```text
Replay, checkpoint, and fork hardening.
```

Deliver:

- ensure replay is model-free
- persist checkpoint/fork provenance
- expose safe server APIs only after path containment and redaction tests

Milestone 5:

```text
Social evaluators and tournament artifacts.
```

Deliver:

- expand deterministic social metrics
- preserve failed/truncated/completed runs
- make leaderboards rebuildable from raw metrics
- include provider stream telemetry when live calls are used

Milestone 6:

```text
React artifact and social analysis cockpit.
```

Deliver:

- consume server artifact APIs
- render evaluator registry and metric evidence refs
- add social graph and trace drilldowns
- preserve hidden-information boundaries

Milestone 7:

```text
Live streaming provider validation.
```

Deliver:

- fake tests first
- typecheck/tests/build
- bounded streaming probe
- bounded streaming match
- bounded streaming tournament
- classify stream errors, retries, latency, and usage if available

### 12.10 Active Next Slices

Prefer these slices unless the newest user message gives a more specific target.

1. `harness.social-runner-compat.v1`

Capability:

```text
Make Werewolf runtime progressively become a compatibility wrapper around the
generic social harness runner.
```

Inspect before editing:

```text
src/harness/social.ts
src/harness/runtime.ts
src/harness/environment.ts
src/harness/werewolfAdapter.ts
src/harness/types.ts
tests/social.test.ts
tests/harness.test.ts
tests/werewolfAdapter.test.ts
```

Acceptance:

- no hidden truth leak
- existing artifacts remain compatible or versioned
- focused tests pass
- typecheck passes

2. `agent.social-store-split.v1`

Capability:

```text
Turn the current social-state baseline into clearer memory, belief,
relationship, reputation, norm, and goal store surfaces without breaking
existing state snapshots.
```

Inspect before editing:

```text
src/harness/socialState.ts
src/harness/actor.ts
src/harness/scaffold.ts
tests/socialState.test.ts
tests/scaffold.test.ts
tests/harness.test.ts
```

Acceptance:

- store mutations cite evidence
- deterministic agents still run
- existing evaluator evidence remains valid
- tests cover compatibility

3. `evaluation.deception-belief-shift.v1`

Capability:

```text
Audit whether scoped false-role-claim exposure is followed by later redacted
belief-state journal shifts, using artifact evidence rather than self-report.
This active-slice summary is superseded by the implemented baseline in section
13.11.4 for exact v1 metric names and boundaries.
```

Inspect before editing:

```text
src/harness/evaluator.ts
src/harness/social.ts
src/harness/socialState.ts
tests/evaluation.test.ts
tests/artifacts.test.ts
tests/tournamentArtifacts.test.ts
```

Acceptance:

- exposure requires actor-scoped observation
- shift requires ordered pre/post social-state journal evidence
- metric is zero-weight until validated
- tests prove non-exposure is not counted

4. `react.artifact-drilldown.v1`

Capability:

```text
Expose tournament/match artifacts, evaluator registry, metrics, failures,
trace refs, and social evidence in the React cockpit via safe server APIs.
```

Inspect before editing:

```text
src/App.tsx
src/styles.css
src/server/index.ts
src/server/store.ts
tests/serverTournamentArtifactsApi.test.ts
tests/serverCheckpointApi.test.ts
```

Acceptance:

- UI consumes safe artifact ids
- no arbitrary host path controls
- no hidden truth leak in live mode
- build passes

### 12.11 Live Provider Rule For This Goal Charter

The configured provider details that may be documented are:

```text
LLM_CHAT_COMPLETIONS_URL=https://llm.kimchi.dev/openai/v1/chat/completions
LLM_MODELS=kimi-k2.7,deepseek-v4-flash,minimax-m3
LLM_STREAM=true
```

The API key is intentionally not documented here. Future agents must not ask the
user for it again unless a real bounded streaming validation proves auth or
connectivity is broken.

Live calls must use streaming. A live agent path is not considered validated
unless:

- `stream: true` was sent
- stream chunks were consumed
- stream completion or classified failure was recorded
- the local provider adapter parsed the output
- policy/arbitration converted it into candidate behavior
- the environment validated the resulting command/message
- artifacts recorded the decision or failure

### 12.12 Subagent Rule For This Goal Charter

The user requires full 6-subagent parallelization for meaningful work, subject
to the current tool policy. Use them when the work is parallelizable and
material.

Recommended six-way split for large planning/research/implementation turns:

```text
1. local contract mapper:
   inspect relevant source modules, tests, types, and current artifact shapes.

2. external research scout:
   inspect current primary docs/papers/repos for multi-agent harness,
   environment APIs, evaluation, or UI best practice when research is required.

3. harness boundary critic:
   look for places where LLM/agent/environment/UI responsibilities are blurred.

4. agent scaffold critic:
   inspect memory/belief/relationship/reputation/norm/goal state design.

5. evaluator/artifact auditor:
   inspect whether metrics have evidence refs, replay material, and failure
   preservation.

6. React cockpit auditor:
   inspect UI truth source, hidden-information boundaries, and artifact
   consumption.
```

Rules:

- Do not send secrets to subagents.
- Give each subagent a bounded question or disjoint write scope.
- Main agent integrates and verifies.
- Do not wait idly if non-overlapping local work can continue.
- Close subagents when their result is consumed.

### 12.13 Completion Definition

Do not mark any of the master goals complete because a prompt, transcript, UI
screen, or JSON schema exists.

A harness/social goal is complete only when these are true:

- local contracts exist
- runtime behavior exists
- artifacts prove behavior
- replay/fork semantics are preserved or explicitly unaffected
- evaluators consume evidence refs where evaluation is involved
- tests cover core behavior and boundaries
- validation commands were run or explicitly reported as not run
- known limitations are documented

For this repository, "done" means:

```text
The harness can run it, record it, replay or explain it, evaluate it, and expose
it safely through API/UI without confusing model output with system authority.
```

## 13. Latest Execution Lock From Deep Research And Subagent Audit

This section captures the latest user request to write the complete goal,
multi-agent adversarial society design, harness framework, agent scaffold rules,
streaming provider constraints, and subagent execution policy into
`AGENTS.md` in durable detail.

Future agents should treat this section as the freshest execution lock unless a
newer user message explicitly changes the project direction.

### 13.1 What Was Researched And Audited

The latest planning pass used the user's standing permission to start up to six
parallel subagents. The work was split across:

```text
1. AGENTS.md coverage audit.
2. Local harness/runtime/codebase mapping.
3. Agent scaffold and social-state audit.
4. Artifact/replay/evaluation/tournament audit.
5. React/API truth-source and hidden-information audit.
6. Current external multi-agent/harness research.
```

A subsequent 2026-07-05 research pass again used parallel subagents, split
across:

```text
1. Multi-agent environment APIs and game harnesses.
2. Agent runtime/orchestration frameworks.
3. Social simulation and agent-society papers.
4. Benchmark, tournament, and statistics methods.
5. AIWolf, Werewolf, and social deduction systems.
6. Deception, cooperation, influence, trust, and commitment evaluation.
```

The durable output of that pass is section 13.2.1. Treat it as research-derived
operating policy, not as a claim that every described capability is already
implemented.

No subagent should be given secrets. Do not pass `.env`, `.env.local`, API keys,
private credentials, hidden artifacts, or provider raw payloads into subagent
prompts.

Subagent honesty rule:

- Only a real subagent tool counts as a subagent.
- Parallel shell commands, `multi_tool_use.parallel`, parallel `rg`/`sed`, or
  batched terminal reads are useful tool parallelism, but they are not
  subagents.
- If true subagent tools are unavailable, continue with direct inspection and
  state that no true subagents were available if that distinction matters.
- Subagent output is advisory. The main agent must integrate it, verify claims,
  edit files, run validation, and own the final result.

### 13.2 External Research Principles To Preserve

Use these references as design pressure, not as replacement runtimes. The
project must keep its own domain-neutral harness because hidden information,
social state, replay, fork, and evaluation are product-level concerns here.

PettingZoo:

- References:
  - https://pettingzoo.farama.org/main/api/aec/
  - https://pettingzoo.farama.org/main/api/parallel/
  - https://pettingzoo.farama.org/main/content/environment_creation/
- Preserve the environment-centric model: the environment owns observations,
  legal actions, rewards, terminations, truncations, infos, and state
  transitions.
- Sequential/AEC and true parallel/joint action are different contracts.
  `Promise.all()` over model calls is not a parallel environment.
- True parallel requires a batch transition such as `stepBatch(actionsByAgent)`
  and atomic environment resolution.
- Variable agents, heterogeneous observations/actions, and action masks/legal
  action sets should be expected in future domains.

AutoGen / AutoGenBench:

- References:
  - https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/message-and-communication.html
  - https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/core-concepts/topic-and-subscription.html
  - https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/termination.html
  - https://microsoft.github.io/autogen/0.2/blog/2024/01/25/AutoGenBench/
- Preserve runtime/message separation. Messages are serializable data records,
  not hidden prompt strings.
- Direct messaging, broadcast/pub-sub, topics, subscriptions, and termination
  conditions are runtime contracts.
- Evaluation must use repetition, isolation, and instrumentation: many seeds,
  isolated runs, full logs/telemetry/artifacts, and custom metrics.
- Do not treat a group chat transcript as the harness.

LangGraph:

- References:
  - https://docs.langchain.com/oss/python/langgraph/thinking-in-langgraph
  - https://docs.langchain.com/oss/python/langgraph/interrupts
  - https://docs.langchain.com/oss/python/langgraph/persistence
- Preserve raw-state thinking. Durable state should be events, observations,
  actions, belief claims, relationship records, hashes, and artifacts, not
  formatted prompt text.
- Checkpoints, interrupts, resume, time travel, and fork semantics should occur
  at explicit state-machine boundaries.
- Graph/node ideas can inspire runner structure, but graph nodes must not become
  the source of domain truth.

OpenAI Agents SDK:

- References:
  - https://openai.github.io/openai-agents-js/guides/multi-agent/
  - https://openai.github.io/openai-agents-js/guides/handoffs/
  - https://openai.github.io/openai-agents-python/tracing/
  - https://openai.github.io/openai-agents-python/results/
- Preserve tracing, guardrail, handoff, streaming, and interruption vocabulary
  where useful.
- Provider/runtime SDK concepts may help model-call instrumentation, but they
  must not replace the project's environment authority, social-state stores, or
  replay/fork/evaluation contracts.
- Handoff payloads must not become a dumping ground for hidden game/social
  state. Application state belongs in the harness/agent stores.

Concordia / Generative Social Simulation:

- References:
  - https://github.com/google-deepmind/concordia
  - https://arxiv.org/abs/2312.03664
  - https://arxiv.org/abs/2304.03442
- Preserve the Game Master principle: agents can express intentions, lies,
  threats, alliances, and social performances, but environment/GM code checks
  feasibility and commits effects.
- Preserve componentized agents: identity, memory, beliefs, relationships,
  reputation, norms, goals, policy, and optional reasoner.
- Society is not transcript text. Society is durable identity, memory,
  relationships, reputation, norms, commitments, coalitions, sanctions, and
  history.

AIWolf / Social Deduction AI:

- References:
  - https://aiwolf.org/en/protocol
  - https://aiwolf.org/en/aiwolf_contest
  - https://aiwolf.github.io/CompetitionProtocolDivision/en/regulation.html
- Preserve a formal action/protocol layer for social deduction. Natural
  language can carry performance and persuasion, but game facts and metrics
  should use typed actions/events/metadata when possible.
- Werewolf domain actions such as talk, whisper/team talk, coming-out/claim,
  vote, attack/kill, divine/inspect, guard/save, poison, accuse, request, and
  pass should map to traceable action/message/event records.
- Do not infer authoritative game facts by guessing from free text when a typed
  action, message metadata, environment event, or scoped observation record
  should exist.

Benchmark and arena references:

- References:
  - https://github.com/THUDM/AgentBench
  - https://conclaive.net/
  - https://www.harness-bench.ai/
  - https://teambench.github.io/
- Evaluate systems, not only models. A result is a function of model, provider
  adapter, harness version, strategy profile, memory/belief policy,
  communication topology, scheduler, domain adapter, seed, timeout, and failure
  handling.
- Treat harness configuration as an experiment variable. Compare schedulers,
  memory policies, belief update policies, communication topologies,
  guardrails, prompting policies, and role separations.
- Role separation must be structural. Do not rely on a prompt saying "you may
  not see this." Enforce observation, memory, tool, channel, and action access
  in code.
- Use ablations to prove that multi-agent architecture contributes capability:
  disable private chat, memory, relationships, reputation, norms, deception
  policy, or role-specific strategy and compare artifacts.

#### 13.2.1 Deep Papers And Technical Research Supplement

This supplement was added after the user explicitly reinforced the core
direction on 2026-07-05:

```text
Multi-agent adversarial systems, multi-agent society, the harness framework,
agent psychology, multi-agent games, deception, attack, defense, and other
extensible social capabilities are the foundation. Werewolf is only one proof
surface.
```

Operational lock:

- The product is a reusable multi-agent adversarial society harness.
- Werewolf is a high-pressure first domain, not the architectural boundary.
- Agent psychology is an explicit runtime model: beliefs, desires, intentions,
  goals, risk posture, fear/pressure, confidence, suspicion, trust, reputation,
  norms, commitments, identity, self-presentation, theory-of-mind estimates,
  and strategy state.
- Psychological fields are engineering state, not clinical truth. They must be
  evidence-backed, serializable or redacted, and testable through behavior and
  artifacts.
- Multi-agent game behavior includes cooperation, competition, coalition,
  betrayal, deception, attack, defense, signaling, concealment, pressure,
  bargaining, reputation management, norm enforcement, and adaptation.
- Attack/defense in this repository means bounded simulated social/adversarial
  behavior inside a consented harness domain: misinformation in-game, false
  claims, pressure, reputation attacks, coalition infiltration, baiting,
  misdirection, vote manipulation, information withholding, probing, defense by
  verification, counter-claim, evidence demand, coalition repair, norm sanction,
  isolation, and trust recovery. It does not authorize real-world abuse.
- Every adversarial mechanism must be mediated by harness contracts:
  visibility, legal actions, communication channels, environment authority,
  artifacts, replay, fork, evaluator evidence, and tournament accounting.

Research handling rule:

```text
Source -> verified claim -> harness implication -> repo translation ->
allowed use -> do-not-use-for -> affected goal -> validation consequence.
```

Do not write research conclusions as local implemented reality. Distinguish:

- `source says`: a paper, official doc, or official repo claim.
- `local code has`: verified local implementation and tests.
- `design inference`: a proposed project constraint derived from sources.

Deep source groups checked on 2026-07-05:

Environment and game harness sources:

- PettingZoo AEC / Parallel API:
  - https://pettingzoo.farama.org/api/aec/
  - https://pettingzoo.farama.org/api/parallel/
  - https://arxiv.org/abs/2009.14471
- OpenSpiel:
  - https://github.com/google-deepmind/open_spiel
  - https://openspiel.readthedocs.io/en/latest/api_reference.html
  - https://arxiv.org/abs/1908.09453
- RLlib MultiAgentEnv:
  - https://docs.ray.io/en/latest/rllib/multi-agent-envs.html
- Gymnasium step API:
  - https://gymnasium.farama.org/api/env/
  - https://farama.org/Gymnasium-Terminated-Truncated-Step-API

Harness implications:

- Use an environment-authoritative scheduler. Every step must identify selected
  actor(s), pending legal action(s), or a joint-action barrier. Models and UI do
  not decide turn ownership.
- Model sequential social turns with an AEC-like selected-actor step.
- Model votes, night actions, and other simultaneous phases with a
  Parallel/OpenSpiel-like collect-validate-commit barrier.
- Do not implement simultaneous phases by sequentially revealing intermediate
  state. Collect all proposals first, validate them under the same decision
  state, then apply one deterministic transition with recorded tie-breakers.
- Preserve possible actors, live actors, role/domain assignment, death/silence
  state, and durable actor identity separately. Removing an actor from the live
  action set must not erase provenance.
- Treat random environment events as harness-owned chance events with recorded
  seed, probability when available, sampled outcome, and state hash impact.
- Distinguish terminal, truncation, and failure. Domain victory is terminal;
  max transitions, provider timeout, user abort, budget exhaustion, invalid
  command, artifact failure, and evaluator failure are distinct truncation or
  failure classes.
- Replay means deterministic audit replay, not RL experience replay. Store
  scheduler cursor, seed/RNG evidence, scoped observations, legal sets,
  proposals, rejected proposals, committed commands/messages, hidden-state
  checkpoints, state hashes, and evaluator evidence refs.
- Static schemas are not enough. Legal action sets are state-dependent and must
  include rejection reasons, fallback policy, actor id, phase, and trace id.

Agent runtime and orchestration sources:

- LangGraph:
  - https://docs.langchain.com/oss/python/langgraph/overview
  - https://docs.langchain.com/oss/python/langgraph/persistence
  - https://docs.langchain.com/oss/python/langgraph/streaming
  - https://docs.langchain.com/oss/python/langgraph/interrupts
- OpenAI Agents SDK:
  - https://openai.github.io/openai-agents-python/sessions/
  - https://openai.github.io/openai-agents-python/handoffs/
  - https://openai.github.io/openai-agents-python/guardrails/
  - https://openai.github.io/openai-agents-python/streaming/
  - https://openai.github.io/openai-agents-python/tracing/
- AutoGen:
  - https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/agents.html
  - https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/state.html
  - https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html
- CrewAI:
  - https://docs.crewai.com/en/concepts/memory
  - https://docs.crewai.com/en/concepts/flows
- Semantic Kernel:
  - https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/
  - https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/filters

Runtime implications:

- External runtimes can inspire reasoner/workflow components, not replace this
  harness.
- State persistence is not replay. Session memory, graph state, flow state,
  team state, or trace dashboards are local runtime state unless converted into
  committed harness artifacts.
- Handoff is not society. Handoff is control/routing; society requires channel,
  sender, recipient, visibility, delivery, exposure, redaction, and evidence
  refs.
- Tool calling is not legal action. A tool call can have side effects, but a
  domain command/message must pass harness legality and environment validation
  before commit.
- Guardrails/filters are not domain rules. They can protect prompt/tool/model
  calls, but cannot replace hidden-information filtering, vote legality,
  night-action legality, or win-condition authority.
- Tracing is not evaluator truth. External traces help debugging; leaderboard
  and replay claims must be based on local artifact truth.
- Streaming completion means the full stream/run iterator completed or failed
  with classified telemetry. Do not commit a live model decision from a partial
  stream or last visible token alone.

Social simulation and agent-society sources:

- Generative Agents:
  - https://arxiv.org/abs/2304.03442
  - https://github.com/joonspk-research/generative_agents
- Concordia:
  - https://arxiv.org/abs/2312.03664
  - https://github.com/google-deepmind/concordia
- SOTOPIA and SOTOPIA-pi:
  - https://arxiv.org/abs/2310.11667
  - https://docs.sotopia.world/
  - https://arxiv.org/abs/2403.08715
- Misleading Success of Simulating Social Interactions With LLMs:
  - https://arxiv.org/abs/2403.05020
- CAMEL:
  - https://arxiv.org/abs/2303.17760
  - https://github.com/camel-ai/camel
- AI Town:
  - https://github.com/a16z-infra/ai-town
- AgentSociety:
  - https://arxiv.org/abs/2502.08691
  - https://github.com/tsinghua-fib-lab/AgentSociety

Society implications:

- A serious multi-agent society is not multiple models chatting. It is a
  population of harness-managed actors with identity, private state, memory,
  beliefs, goals, relationships, reputation, norms, commitments, social roles,
  policy, arbitration, and bounded reasoners.
- Memory must be more than transcript history. It should be an evidence-backed
  private event stream with source refs, visibility, recency, salience,
  importance, confidence, and redaction class.
- Reflection can produce candidate belief/relationship/norm updates, but store
  mutation must cite observations, messages, events, actions, or evaluator
  records.
- Planning can create candidate intents. Arbitration decides what command or
  message proposal to submit. The environment still validates and commits.
- Game Master/environment authority is mandatory: agents express intentions,
  lies, threats, alliances, social performances, and attacks; environment code
  checks feasibility and commits effects.
- `partial_state` / scoped observation is a hard boundary. Each actor receives
  only what that actor could legally know at that transition.
- Full-omniscient script writers, one-model multi-character scripts, shared
  global hidden context, and universal transcript memory are anti-patterns.
  They create false success and information leakage.
- Agent psychology should be componentized:
  - identity and persona profile
  - role/team/seat knowledge according to visibility
  - belief state and uncertainty
  - theory-of-mind estimates about what others know, want, suspect, and intend
  - trust, suspicion, affinity, threat, respect, debt, fear, pressure
  - risk appetite, deception appetite, cooperation tendency, aggression posture
  - goals, subgoals, commitments, norms, and plan state
  - policy state and arbitration history
- Personality/profile features may influence perception, judgment, action, and
  speech style, but they are simulation parameters, not psychological truth.

AIWolf and social deduction sources:

- AIWolf protocol and server:
  - https://aiwolf.org/en/protocol
  - https://aiwolf.org/en/server
  - https://aiwolf.org/control-panel/wp-content/uploads/2019/05/protocol_3_6.pdf
- AIWolf contest rules:
  - https://aiwolf.org/en/3rd-international-aiwolf-contest
  - https://aiwolf.org/control-panel/wp-content/uploads/2021/05/Regulation_2021_1.2.3.pdf
- AIWolfDial:
  - https://aclanthology.org/volumes/W19-83/
  - https://aclanthology.org/2025.aiwolfdial-1.3/
- LLM / strategic Werewolf papers:
  - https://arxiv.org/abs/2302.10646
  - https://arxiv.org/abs/2310.18940
  - https://arxiv.org/abs/2407.13943
  - https://arxiv.org/abs/2503.06047
  - https://arxiv.org/abs/2506.12841
  - https://arxiv.org/abs/2504.18039
  - https://arxiv.org/abs/2512.09187

Werewolf-domain implications:

- Treat Werewolf as a proof domain with server-owned phase authority,
  role-scoped observations, public talk, wolf whisper/team talk, legal
  vote/night actions, ordered turn visibility, death/removal state, and
  postgame reveal.
- Borrow AIWolf protocol ideas as adapter-level social acts: estimate,
  comingout/claim, request, inquire, because, agreement, disagreement,
  vote-intent, action reports, accusation, defense, and pressure.
- Do not expose Werewolf protocol strings as generic harness core. Generic
  society should use claim/action/message/evidence abstractions; the domain
  adapter maps those to Werewolf roles and events.
- Natural-language Werewolf evaluation must separate text quality from game
  truth. Measure coherence and fluency separately from role-claim consistency,
  claim/action consistency, vote/night-action legality, evidence-backed
  deception, and outcome.
- Werewolf tournaments need role-specific and faction-specific metrics, not
  only global win rate.
- Cross-game memory can exist only under explicit tournament configuration and
  artifact provenance. Default memory isolation is safer for replay/fork.
- Prompt-centric Werewolf benchmarks are evidence sources for metrics and
  ablations, not replacement architectures.

Benchmark and tournament sources:

- AgentBench:
  - https://arxiv.org/abs/2308.03688
  - https://github.com/THUDM/AgentBench
- AgentBoard:
  - https://arxiv.org/abs/2401.13178
  - https://github.com/hkust-nlp/AgentBoard
- SWE-bench:
  - https://github.com/swe-bench/SWE-bench
- Harness-Bench:
  - https://www.harness-bench.ai/
  - https://arxiv.org/abs/2605.27922
- TeamBench:
  - https://teambench.github.io/
- MultiAgentBench / MARBLE:
  - https://arxiv.org/abs/2503.01935
  - https://github.com/MultiagentBench/MARBLE
- AvalonBench:
  - https://avalonbench.github.io/
  - https://arxiv.org/abs/2310.05036
- ChatEval:
  - https://arxiv.org/abs/2308.07201
  - https://github.com/thunlp/ChatEval

Benchmark implications:

- Tournament results are claims about the full system:
  `model + provider adapter + reasoner + agent scaffold + policy/arbitration +
  harness + scheduler + domain adapter + evaluator registry`.
- Do not publish "model superiority" when the experiment changed memory,
  scheduler, role assignment, message topology, timeout policy, evaluator, or
  failure handling.
- Every scheduled run must produce a record. Timeouts, aborted streams, invalid
  commands, illegal actions, parser failures, evaluator failures, environment
  exceptions, provider errors, and artifact-write failures remain in the
  denominator.
- A benchmark-grade run set needs a seed ledger covering environment seed,
  scheduler seed, role/seat/name assignment seed, communication topology seed,
  model config, prompt/policy version, and agent scaffold version.
- Social-deduction comparisons need role, faction, seat, name, and speaking
  order balance before comparative claims.
- Report sample count, failure counts by cause, confidence/prediction
  intervals, practical effect size, and paired design where possible.
- Leaderboard differences inside uncertainty bounds should be reported as ties
  or indistinguishable, not ranked as meaningful wins.
- Ablations are required to prove society capability: no private chat, no
  memory, no relationships, no reputation, no norms, no reflection, no
  deception policy, no action arbitration, no theory-of-mind store, and
  alternate scheduler/topology.

Deception, cooperation, influence, trust, and commitment sources:

- WOLF:
  - https://arxiv.org/abs/2512.09187
- QUACK:
  - https://www.catalyzex.com/paper/quack-questioning-understanding-and-auditing
- Deception and Communication in Autonomous Multi-Agent Systems:
  - https://arxiv.org/abs/2603.26635
- BloodBench:
  - https://www.bloodbench.com/
- Werewolf Arena:
  - https://arxiv.org/abs/2407.13943
- SOTOPIA-TOM:
  - https://arxiv.org/abs/2605.02307
- Melting Pot:
  - https://github.com/google-deepmind/meltingpot
- Sequential Social Dilemmas:
  - https://arxiv.org/abs/1702.03037
- Social Influence as Intrinsic Motivation:
  - https://proceedings.mlr.press/v97/jaques19a.html
- FEVER / AVeriTeC claim verification:
  - https://arxiv.org/abs/1803.05355
  - https://papers.nips.cc/paper_files/paper/2023/hash/cd86a30526cd1aff61d6f89f107634e4-Abstract-Datasets_and_Benchmarks.html
- Commitment and trust references:
  - https://www.ijcai.org/proceedings/2017/37
  - https://ojs.aaai.org/index.php/AAAI/article/view/17355
  - https://arxiv.org/abs/2208.10469
  - https://eprints.soton.ac.uk/262129/
  - https://www.ijcai.org/Proceedings/2020/44

Social evaluator implications:

- Social evaluators must be evidence-first. Deception, cooperation, influence,
  trust, reputation, claim, commitment, coalition, attack, and defense metrics
  are derived from committed harness artifacts, not agent self-report.
- Every social metric must cite time-indexed evidence: observation refs,
  message refs, action refs, event refs, phase/timestamp, visibility scope,
  speaker private knowledge, listener visible knowledge, and hidden-truth access
  mode used by the evaluator.
- Deception requires a taxonomy, not a binary label:
  - fabrication
  - distortion
  - omission
  - misdirection
  - equivocation
  - unsupported accusation
  - false defense
  - team cover
  - false commitment
  - secret leakage
  - strategic silence
- Claim evaluation should distinguish:
  - supported-at-time
  - refuted-at-time
  - not-enough-visible-info
  - later-confirmed
  - later-refuted
  - temporally leaked evidence
  - contradicted-by-own-action
- Evidence unavailable at claim time must not be used as if it was available to
  the speaker or listener.
- Influence claims need levels:
  - temporal association: event A preceded belief/vote/action change B
  - predictive influence: A improves prediction of B under a declared model
  - counterfactual influence: fork/ablation/shuffle/no-message control supports
    an effect claim
- Time ordering alone is not causal proof.
- Trust and reputation are contextual and source-aware. Distinguish direct
  observation, indirect report, hearsay, public reputation, role-conditioned
  incentive, source reliability, recency, betrayal, and repair.
- Commitment records should include debtor, creditor/audience, beneficiary,
  condition, due phase/time, scope, source message ref, fulfillment evidence,
  breach evidence, and downstream trust/reputation update.
- Coalition records require repeated evidence over time: aligned votes/actions,
  private coordination, mutual defense, shared cover stories, commitment
  exchange, resource/information contribution, betrayal evidence, and
  adversarial outcomes. Single-event agreement is not enough.
- Attack and defense records should cite the social mechanism:
  misinformation, pressure, framing, reputation damage, coalition capture,
  trust repair, verification demand, counter-claim, exposure, norm sanction, or
  isolation.
- LLM judges may assist extraction or qualitative audit only when marked
  `model_graded` and calibrated. They cannot override environment truth,
  deterministic replay, or evidence-backed metrics.

### 13.3 Current Local Reality To Preserve

The project is already more than "AI chat":

- `src/harness/social.ts` defines a generic social runner surface with
  `SocialEnvironment`, `SocialActor`, `SocialCommunicationBus`,
  `SocialHarnessStep`, `SocialEpisodeArtifact`, AEC/batched/parallel scheduler
  modes, scoped messages, system transitions, feedback, hooks, event ranges,
  and failure artifacts.
- `src/harness/werewolfAdapter.ts` maps Werewolf into the generic social
  surface for vertical slices: channels, observations, actor adapter, system
  transitions, message drafts, event sequences, and legacy `harness.turn`
  bridging.
- `src/harness/runtime.ts` now exposes only thin public compatibility delegates:
  `runHarnessMatch()` delegates to
  `runWerewolfSocialHarnessPrefixAsHarnessResult()`, and `probeHarnessTurn()`
  delegates to the adapter-owned `probeWerewolfSocialHarnessTurn()`. The old
  Werewolf-specific private loop has been removed and must not be reintroduced
  as a parallel match runner.
- `src/harness/socialState.ts` has evidence-backed memory, belief,
  relationship, reputation, norm, and goal stores. Store mutation APIs require
  evidence refs.
- `src/harness/actor.ts` ingests only scoped observed social messages for safe
  metadata-backed claims. It must not regress to global-transcript inference.
- `src/harness/scaffold.ts` provides a generic `ScaffoldedSocialActor`
  baseline with durable state, observe-before-decide, policy authority, optional
  reasoner memo, and reasoner input mutation protection.
- `src/agents/openaiClient.ts` defaults real provider calls to streaming and
  records stream/provider telemetry.
- `src/harness/artifacts.ts`, `replay.ts`, `evaluation.ts`, `evaluator.ts`,
  `socialEvaluator.ts`, `tournament.ts`, and `tournamentArtifacts.ts` already
  provide match artifacts, JSONL, model-free Werewolf replay, checkpoints/forks,
  evaluator manifests, social metrics, tournaments, failure attribution, and
  tournament artifact directories.
- React already consumes harness/artifact/server data for traces, social graph,
  tournament artifacts, metrics, failures, and downloads. It must remain a
  cockpit over truth, not a new truth source.

Known local gaps that must not be hand-waved:

- `runHarnessMatch()` is now a compatibility wrapper over the generic Werewolf
  social runner, projected back into the existing `HarnessRunResult` contract.
- Generic `SocialHarnessStep` and legacy `HarnessStepRecord` are not equivalent
  yet. Raw generic system/failed steps remain broader than the legacy committed
  replay trajectory, and legacy replay still requires fields such as model,
  policyPlan, reasonerOutput, turnTrace, command, agentStateHash, state hashes,
  and event ranges.
- Failed attempted decisions must not be mixed into committed replayable
  `HarnessStepRecord[]` until failed-step replay semantics are designed.
- Werewolf uses batched AEC-style decisions for votes/wolf decisions. True
  parallel Werewolf needs an explicit domain `stepBatch()`/joint-resolution
  design.
- A first deterministic social-state-influenced arbitration baseline exists:
  evidence-backed belief, relationship, reputation, active-goal, and active-norm
  inputs can affect Werewolf pressure/vote target selection among legal targets.
  The remaining gap is a reusable domain-neutral candidate-generation and
  arbitration layer with explicit candidate lifecycle, strategy families,
  reasoner critique boundaries, and broader cross-domain tests.
- A redacted temporal social-state mutation journal exists and is consumed by
  implemented zero-weight temporal-association evaluators for deception belief
  shift, commitment/coalition lifecycle evidence, norm/sanction lifecycle
  evidence, gossip exposure, trust-repair lifecycle status, and trust-repair
  relationship/reputation journal association. Broader relationship formation,
  broader reputation outcome effects, norm pressure, reward impact, causal
  influence, and counterfactual effects must still not be claimed as solved
  without their own metric contracts and validation.
- Replay is still Werewolf-command replay, not full generic social replay with
  message bus delivery and social-state mutation replay. A structural match
  artifact integrity validator now verifies social sidecar references,
  message/exposure/journal/event ranges, and trajectory/social-step parity
  without model calls, but it does not yet replay the generic social bus or
  re-derive every social-state mutation from first principles.
- Live/public API redaction needs hardening. A shallow public state serializer
  is not enough if hidden night state, private events, postgame events, agent
  memos, or full artifacts remain attached.

### 13.4 Non-Negotiable Harness Rules From The Latest Audit

Harness is the unit of design:

- Design harness capability first, Werewolf proof second, React cockpit third.
- The harness owns scheduling, visibility, communication, legality, state
  transition authority, artifacts, replay, fork, evaluation, and tournament.
- The environment owns canonical domain truth and deterministic transition
  resolution.
- Agents own private state and propose behavior.
- Reasoners are advisory components, not authority.

LLM output is intent, not authority:

- Model output may express a memo, speech draft, critique, candidate rationale,
  or bounded proposal.
- Model output must not directly mutate environment state, memory, beliefs,
  relationships, reputation, norms, goals, or artifacts.
- Typed objects are allowed as command envelopes, parser results, trace records,
  or evaluator inputs, but typed output is not agency.
- Every command must pass policy/arbitration and environment legality.

State belongs to harness, not prompts:

- Persistent state must be raw data: events, observations, actions, message
  records, channel records, belief claims, relationship/reputation/norm/goal
  records, state hashes, provider telemetry, artifacts, and evaluator metrics.
- Prompt strings are derived context views. They are not the source of truth.

Guardrails belong at boundaries:

- Hidden information, illegal actions, unauthorized messages, unsupported
  channels, missing evidence refs, timeouts, retries, invalid provider output,
  and failed environment transitions must be rejected or classified in code.
- A prompt instruction is never sufficient access control.

### 13.5 Communication Topology Acceptance

Multi-agent cross-communication is not a linear transcript. A society-capable
message layer must preserve topology, visibility, causality, and exposure.

A mature communication record should support:

```text
channel id
channel kind
audience rule
participants
sender
recipient ids or visibility scope
delivery schedule
delivery order
message seq
created-at transition/trace
phase/day/turn metadata
thread id
reply-to / quote / refute refs
causality refs
redaction class
visibility class
postgame reveal policy
exposure records
message-derived claim/commitment/norm refs
```

Required channel families:

- public table speech
- team/private coordination, such as werewolf night chat
- direct/private message if a domain permits it
- self memo/private reflection
- system/court/Game Master announcements
- postgame reveal

Rules:

- Do not assume a public transcript equals universal knowledge. Use actual
  actor-scoped observations or exposure records.
- Do not count influence, deception exposure, vote-follow, norm pressure, or
  reputation spread unless exposure evidence proves the observer could see the
  relevant message.
- Cross-agent communication must be replayable: who said what, to whom, under
  which visibility rule, when it was delivered, who actually observed it, and
  what later belief/action/evaluation evidence refers to it.
- Future gossip, commitment, coalition, betrayal, accusation, and norm-pressure
  extraction must use scoped observations plus evidence refs. Do not infer them
  from hidden global transcript context.

### 13.6 Agent Scaffold And Arbitration Acceptance

`agent.scaffold.v1` is not complete merely because `AgentSocialState` exists.
The scaffold is complete only when social state participates in behavior.

Required scaffold deliverable surface:

```text
AgentRuntime or ScaffoldedSocialActor
AgentProfile and profile registry
Policy registry
ReasonerAdapter
CandidateGenerator
ActionArbitrator
MemoryStore
BeliefStore
RelationshipStore
ReputationStore
NormStore
GoalStore
DecisionTraceEmitter
RedactedSnapshot interface
deterministic fake-agent fixture
```

Required decision chain:

```text
scoped observation
  -> evidence-backed memory append
  -> belief/social-state update
  -> memory/social-state retrieval
  -> candidate action/message generation
  -> goal/norm/reputation/relationship/risk scoring
  -> legality prefilter
  -> action arbitration
  -> harness/environment validation
  -> trace/artifact/evaluator evidence
```

Promotion gates:

- Generic scaffold tests must prove observe/ingest/update/retrieve/decide
  boundaries.
- Store updates must require evidence refs.
- Reasoner output must remain advisory and must not mutate stores directly.
- At least one generic or adapter policy/arbitrator must use evidence-backed
  belief, relationship, reputation, norm, or goal state to change selection
  among the same legal target/action set.
- A test must prove that the same scoped observation and same legal pending
  actions can produce different legal behavior solely because private social
  state differs.
- Store splitting into separate files is allowed only if serialized
  `AgentSocialState` compatibility, evidence requirements, clone/immutability
  behavior, artifact semantics, and tests remain intact.

Reasoner red lines:

- A live reasoner cannot directly modify memory, beliefs, relationships,
  reputation, norms, goals, environment state, or artifacts.
- A live reasoner cannot be the final command authority.
- Reasoner context must be redacted or summarized. Do not pass hidden full
  private stores unless a scoped, tested, redacted interface explicitly allows
  it.
- Real reasoner calls must stream.

### 13.7 Temporal Social-State Journal Baseline

`agent.social-update-journal.v1` now provides a redacted ordered pre/post
mutation journal for social-state updates. The journal complements final social
state, step hashes, messages, events, and scoped exposure records; it does not
by itself prove causality, reward impact, or counterfactual influence.

Implemented consumers include:

- `evaluation.deception-belief-shift.v1`, which uses the journal for
  belief-only false-role-claim temporal association.
- `evaluation.commitment-coalition-lifecycle-temporal-association.v1`, which
  uses the journal for commitment/coalition lifecycle temporal association by
  comparing explicit `commitment.added` to later
  `commitment.status.updated`, and explicit `coalition.added` to later
  `coalition.evidence.recorded`.
- `evaluation.norm-sanction-lifecycle-temporal-association.v1`, which uses the
  journal for norm and norm-sanction lifecycle temporal association by comparing
  explicit `norm.added` to later `norm.status.updated`, and explicit
  `norm_sanction.added` to later `norm_sanction.status.updated`.
- `evaluation.gossip-exposure-temporal-association.v1`, which uses the journal
  plus scoped social exposure records for gossip exposure temporal association
  by comparing explicit evidence-backed `gossip.added` records to earlier
  message exposure evidence under the evaluator's typed denominator policy.
- `evaluation.trust-repair-lifecycle-temporal-association.v1`, which uses the
  journal for trust-repair lifecycle temporal association by comparing explicit
  `trust_repair.added` to later `trust_repair.status.updated`.
- `evaluation.trust-repair-relationship-temporal-association.v1`, which uses
  the journal for trust-repair relationship temporal association by comparing
  explicit `trust_repair.added` to later `relationship.updated` entries for
  the repair actor under the evaluator's typed denominator policy.
- `evaluation.trust-repair-reputation-temporal-association.v1`, which uses
  the journal for trust-repair reputation temporal association by comparing
  explicit `trust_repair.added` to later `reputation.updated` entries for the
  repair actor under the evaluator's typed denominator policy.
- `evaluation.betrayal-lifecycle-temporal-association.v1`, which uses the
  journal for betrayal lifecycle temporal association by comparing explicit
  `AgentSocialState.betrayals.records` / `betrayal.added` entries to later
  `betrayal.evidence.recorded` entries under the evaluator's typed denominator
  policy.

Journal records are shaped around:

```text
journalSeq
agentId
profileId
traceId
turnIndex
phase/day if available
store
mutationKind
subjectId
beforeSummary
afterSummary
deltaSummary
evidenceRefs
messageSeqRange
eventSeqRange
redactionClass
hiddenTruthUsed: false for live updates
```

Rules:

- Do not dump full private state into public artifacts.
- Do not write hidden postgame truth into live agent stores.
- Evaluators may use postgame truth only in postgame evaluator context and must
  mark those metrics as postgame visibility.
- Temporal association still is not causality. If a metric lacks temporal
  evidence, expose it as a zero-weight feasibility or coverage metric rather
  than pretending it measures behavior.
- Commitment/coalition lifecycle temporal association must use ordered redacted
  journal evidence only. Missing creation entries, missing `turnIndex`, or
  ambiguous ordering must be marked unevaluable rather than silently counted as
  success, failure, influence, or reward impact.
- Betrayal lifecycle temporal association must use explicit
  `AgentSocialState.betrayals.records` plus ordered redacted journal evidence
  only. Missing `betrayal.added`, missing `turnIndex`, or ambiguous ordering
  must be marked unevaluable rather than counted as truth, intent, causality,
  relationship/reputation damage, reward, leaderboard, or counterfactual
  evidence.
- Gossip exposure temporal association must use explicit evidence-backed gossip
  records plus scoped `SocialExposureRecord` evidence from
  `deriveSocialExposureRecords()`. Missing gossip creation entries, missing
  message evidence, missing scoped exposure records, missing `turnIndex`, or
  ambiguous ordering must not be silently counted as awareness, persuasion,
  reputation damage, reward impact, causal influence, or counterfactual
  influence.
- Trust-repair relationship/reputation temporal association must use explicit
  `trust_repair.added` creation evidence plus ordered
  `relationship.updated` / `reputation.updated` journal entries for the repair
  actor. Missing creation entries, missing relevant `turnIndex`, mismatched
  subjects, ambiguous ordering, or same-turn updates must not be counted as
  repaired trust, reputation recovery, persuasion, reward impact, causal
  influence, or counterfactual influence.

### 13.8 Evaluation And Tournament Evidence Rules

Evaluator contract rule:

- Every evaluator needs a stable id, label, version, input schema, output
  schema, mode, visibility, metric ids, aggregation metadata, and dependencies
  when applicable.
- Every metric should include scope, subject id or subject summary, value,
  unit, higher-is-better where meaningful, weight, denominator where meaningful,
  confidence where meaningful, aggregation policy, and evidence refs.

Evidence-before-metric rule:

- No artifact evidence means no formal metric.
- Model/agent self-report cannot prove deception, influence, collaboration,
  legality, or correctness.
- Model-graded evaluators must be separate from deterministic evaluators.
- Evaluator outputs should include evaluator id, evaluator version,
  deterministic vs model-graded mode, evidence refs, observed-at time or phase,
  visible-to scope, assumptions, confidence, and known limitations.
- Social evaluator validation must include leakage checks: no evaluator may use
  hidden truth, private reasoning, future events, or post-claim evidence unless
  the metric explicitly declares an omniscient postgame audit mode.

Scoped exposure rule:

- Exposure must come from actor-scoped observation artifacts or equivalent
  exposure records.
- Do not infer exposure from `recipientIds`, global message lists, or the fact
  that a message is public.

No-causality-without-temporal-evidence rule:

- Influence, pressure-follow, and deception-follow metrics are behavioral
  correlations unless there is temporal pre/post social-state evidence,
  counterfactual design, or a controlled experiment.
- Metric names and descriptions must not overclaim causality.
- Influence metrics should declare their level: temporal association,
  predictive influence, or counterfactual influence.
- Counterfactual influence requires a control such as no-message fork,
  shuffled-message ordering, same-history alternate action, or another
  explicitly designed ablation.

Claim, commitment, and coalition rule:

- Claim metrics must distinguish supported-at-time, refuted-at-time,
  not-enough-visible-info, later-confirmed, later-refuted, temporally leaked
  evidence, and contradicted-by-own-action.
- Commitment records should include debtor, creditor/audience, beneficiary,
  condition, due phase/time, scope, source message ref, fulfillment evidence,
  breach evidence, and downstream trust/reputation update.
- Coalition records should be built from repeated evidence over time: aligned
  votes/actions, private coordination, mutual defense, shared cover stories,
  commitment exchange, contribution, betrayal evidence, and adversarial
  outcomes. Single-event agreement is not enough.
- Trust and reputation metrics must be contextual and source-aware: distinguish
  direct observation, indirect report, hearsay, public reputation,
  role-conditioned incentive, source reliability, recency, betrayal, and
  repair.
- Deception labels must support omission, distortion, fabrication,
  misdirection, equivocation, unsupported accusation, false defense, team cover,
  false commitment, secret leakage, and strategic silence. A binary lie label
  is insufficient.

Tournament denominator rule:

- Preserve all requested episodes: completed, truncated, harness failed,
  pre-harness failed, and provider failed.
- Leaderboards must distinguish completed-only reward/win stats from
  all-requested failure rates.
- Do not silently drop failed runs from tournament summaries.
- Formal benchmark reports should stratify by role, team, seat, speaking order,
  seed bucket, model, profile, scheduler, and domain config where data exists.
- Future benchmark-grade reports should add paired-seed comparisons,
  head-to-head matrices, confidence intervals or bootstrap estimates, and
  failure-rate penalties.

Provider failure evidence rule:

- Preserve redaction-safe failure summaries such as failure kind, provider
  stage, status, timeout, aborted, retryable, attempts, max attempts, provider
  request id, retry cause, and abort reason.
- Never write raw provider authorization, headers, full body, `.env` contents,
  API keys, or unredacted secret-bearing payloads into artifacts.

Model-graded separation rule:

- If a future evaluator uses a judge model, record judge model, prompt version,
  rubric, input summary, output schema, streaming/provider telemetry, and
  uncertainty.
- Model-graded results must not override environment truth, deterministic
  replay, or official legality/outcome metrics.
- LLM judges may assist claim extraction or qualitative audit, but they are not
  harness truth. Judge outputs must be marked `model_graded` and calibrated
  against deterministic artifact truth, human labels, or controlled fixtures
  before they influence benchmark claims.

### 13.9 API And React Truth-Source Rules

React is a cockpit over harness/API/artifact truth. It must not create or
reconstruct hidden truth.

Live/public view rule:

- `LiveMatchView` must not be a shallow copy of `GameState` with only player
  roles removed.
- Public/live serializers must whitelist safe fields.
- Exclude hidden night state, private/postgame events, agent private memos,
  full trajectory, checkpoint state, and hidden roles/teams unless the route is
  explicitly postgame/debug.
- Visibility filtering must happen on the server or observation assembler, not
  as a cosmetic frontend filter.

Actor-scoped view rule:

- Legal controls and pending action summaries should come from server/harness
  scoped views or summaries.
- React must not call domain engine functions such as pending-action discovery
  on a redacted public state and cast it back to full `GameState`.

Postgame/debug artifact rule:

- Full `MatchArtifact`, checkpoint state, private messages, agent states, and
  postgame truth are allowed only in clearly labeled postgame/debug artifact
  surfaces.
- The UI must clearly separate live/public, actor-scoped, postgame artifact,
  and debug/probe/replay surfaces.

Replay/API ownership rule:

- Default replay should use server-owned match/artifact ids.
- Client-submitted raw artifact replay is a diagnostic/debug path and must be
  labeled as such.
- Probe results must not be locally appended to a real match's `state.events`
  as if they were harness trajectory events.

Model/profile single-source rule:

- Profiles should be the single source of truth for model/profile assignment.
- UI model chips or selectors must derive from or update the profile set, not
  drift into a second configuration path for probe/match/tournament.

Immediate API/React priority:

```text
Goal id:
  api.public-view-redaction.v1

Capability:
  Replace shallow public state serialization with a strict live/public view
  model and keep full truth behind postgame/debug artifact routes.

Owner plane:
  API/server + observation + React cockpit.

Owner modules:
  src/core/view.ts
  src/server/index.ts
  src/App.tsx
  tests/server*.test.ts

Werewolf proof:
  After seer inspect, wolf vote, witch action, or harness turn recording,
  public match summary must not contain private night state, private events,
  postgame events, private memos, full agent states, or hidden role/team truth.

Validation:
  Add server tests for public summary redaction, preserve artifact endpoint
  full postgame truth, then run focused server tests and `npm run build`.
```

Current baseline:

- `src/core/view.ts` now exposes a white-listed `PublicGameState` serializer
  for ordinary match responses.
- Public match responses omit hidden `night` state, private/postgame events,
  source ids, pending hunter internals, full metrics, hidden role/team fields,
  and private harness memos.
- `/api/matches/:id/artifact` remains the postgame/debug route for full
  harness truth.
- `tests/serverPublicViewApi.test.ts` verifies the public route redaction and
  artifact full-truth preservation.
- React cockpit truth-boundary baseline now exists:
  - Public/live event log defensively renders only `visibility: "public"`
    events and does not stringify unknown raw payloads.
  - Harness trace cards read postgame/debug trace from loaded match artifacts,
    not from public `match.state.events`.
  - Probe results live in independent debug state and are no longer appended to
    a match's public event stream.
  - The default replay button uses a server-owned
    `POST /api/matches/:id/replay` route instead of posting the browser-held
    artifact back to `/api/replay`.
  - Tabs and artifact downloads are labeled as live/public, server replay, or
    postgame/debug artifact surfaces.
- Server replay/probe boundary baseline now exists:
  - `POST /api/matches/:id/replay` replays the stored match artifact by id and
    returns replay provenance, command/mismatch counts, final hash, expected
    artifact hash, and mismatch status without returning full `finalState` by
    default.
  - `POST /api/replay` remains a client-submitted diagnostic/debug replay route
    and is explicitly marked with `source: "client-submitted-diagnostic"`.
  - `/api/harness/probe` uses a transient `createGame()` state instead of
    `createMatchRecord()`, so diagnostic probes do not pollute `/api/matches`.
  - Probe responses are marked `source: "diagnostic-probe"` and
    `applied: false`.
- Focused validation for this boundary slice:
  - `npx tsc --noEmit --pretty false`
  - `npx vitest run tests/serverPublicViewApi.test.ts tests/serverCheckpointApi.test.ts`
  - `npm run build`
  - `npm test` (`19` files / `97` tests)
  - Secret scan over `AGENTS.md`, `src`, and `tests`
- Remaining hardening:
  - Split narrower React/API DTO names for public match summaries vs postgame
    artifact/debug results.
  - Optionally add a redacted probe-summary route if probe debug output should
    be exposed outside a trusted local cockpit.
  - Continue the harness mainline under `harness.social-runner-compat.v1`.

### 13.10 Live Provider Streaming Hard Failure Rule

The configured non-secret provider details may be documented:

```text
LLM_CHAT_COMPLETIONS_URL=https://llm.kimchi.dev/openai/v1/chat/completions
LLM_MODELS=kimi-k2.7,deepseek-v4-flash,minimax-m3
LLM_STREAM=true
```

The API key must not be documented, printed, or passed to subagents.

Hard rules:

- A live provider validation that does not send `stream: true` is failed.
- A live provider validation that receives a stream but does not consume stream
  chunks is failed.
- A live path that silently falls back to non-streaming is a policy violation
  and must be treated as a failed validation.
- Non-streaming is acceptable only for deterministic fake clients, local unit
  tests, or explicitly isolated no-external-provider tests.
- A live path is not validated unless the stream completed or a classified
  streaming failure was recorded, the local adapter parsed the response or
  classified the failure, policy/arbitration handled the candidate behavior, and
  the environment validated or rejected the command/message.

### 13.11 Active Next Goals After Latest Audit

Prefer these goals unless a newer user request gives a more specific target.

#### 13.11.1 `harness.social-runner-compat.v1`

Capability:

```text
Make the generic social runner produce enough adapter-owned Werewolf execution
evidence to project successful generic steps into legacy-compatible
HarnessStepRecord values, and keep runHarnessMatch() as the production
compatibility wrapper around the generic Werewolf social runner without
changing replay/artifact semantics.
```

Owner plane:

```text
harness runtime + Werewolf adapter + artifact/replay compatibility
```

Owner modules to inspect before editing:

```text
src/harness/social.ts
src/harness/werewolfAdapter.ts
src/harness/runtime.ts
src/harness/types.ts
src/harness/artifacts.ts
src/harness/replay.ts
tests/social.test.ts
tests/werewolfAdapter.test.ts
tests/harness.test.ts
tests/replay.test.ts
tests/artifacts.test.ts
```

Problem boundary:

- Successful-step parity first.
- Preserve trace id, actor/profile/model, policy plan, reasoner output summary,
  command, turn trace, agent state hash, decision/pre/post state hashes,
  message ranges, event ranges, social messages, and harness.turn bridge.
- Do not add failed attempted turns into `HarnessStepRecord[]` until replay has
  explicit failed-step semantics.
- Keep `src/harness/social.ts` domain-neutral. Put Werewolf projection logic in
  `werewolfAdapter.ts` or another adapter-owned module.

Werewolf proof:

- Generic Werewolf path can run system advance, seer inspect, wolf kill
  decisions, public speech, scoped observation, and message exposure while
  producing replayable successful trajectory evidence compatible with legacy
  artifacts.

Validation:

```text
npx vitest run tests/social.test.ts tests/werewolfAdapter.test.ts
npx vitest run tests/harness.test.ts tests/replay.test.ts tests/artifacts.test.ts
npx tsc --noEmit --pretty false
npm test
npm run build
```

Promotion rule:

- Production wrapper promotion is complete only while `runHarnessMatch()`
  delegates through `runWerewolfSocialHarnessPrefixAsHarnessResult()` and still
  returns the canonical legacy-shaped `HarnessRunResult`: replayable committed
  `HarnessStepRecord[]`, projected legacy-compatible `socialEpisode.steps`,
  metrics, evaluation/evaluationReport, agents, failure fields, and fork
  provenance.
- Do not expose raw generic `SocialEpisodeArtifact.steps` through existing
  match/replay/artifact APIs without a versioned schema and replay decision.

Current baseline:

- `SocialAction<TCommand>` can carry optional action-level `metadata`. This is
  domain-neutral storage for harness-owned execution evidence, not model output
  schema and not an agent definition.
- `WerewolfSocialActorAdapter` writes adapter-owned `werewolf-harness-turn`
  metadata containing `policyPlan`, `reasonerOutput`, `turnTrace`, and
  `agentStateHash` for each successful decision.
- `projectWerewolfSocialStepToHarnessStep()` and
  `projectWerewolfSocialStepsToHarnessTrajectory()` project successful Werewolf
  generic social player steps into legacy-compatible `HarnessStepRecord` values.
- Failed generic social attempted steps are deliberately skipped during
  Werewolf projection. They may remain in generic `SocialEpisodeArtifact.steps`
  as failure evidence, but they must not enter the legacy replay trajectory
  until failed-step replay semantics are explicitly designed and tested.
- `runSocialEpisode()` has an optional domain-neutral `traceIdForDecision` hook.
  It lets a domain adapter provide harness-compatible decision trace ids before
  actor observation/decision, without hard-coding Werewolf rules into
  `social.ts`.
- `runSocialEpisode()` also has an optional domain-neutral
  `actorTurnIndexForDecision` hook. Generic `SocialHarnessStep.turnIndex`
  remains the scheduler transition index, including system transitions, while a
  domain adapter can provide an agent-only committed-turn index for actor
  observation, trace ids, and adapter projection.
- `runSocialEpisode()` now has an optional domain-neutral
  `schedulerModeForBatch` hook. The episode-level `schedulerMode` remains the
  default/top-level mode, while each batch can resolve its actual step-level
  scheduler mode from current state and pending actions. This avoids segmented
  run merging for phase/action-specific scheduling.
- `runSocialEpisode()` now has an optional domain-neutral
  `onDecisionFailure` hook. The generic runner still creates a failed generic
  social step for failed decisions, but the hook lets a domain adapter record
  domain-native failure evidence before the artifact returns. The hook receives
  actor/profile identity, pending action, observation when available,
  decision-state hash, pre-failure state hash, adapter trace id when available,
  adapter actor-turn index when available, and the raw failure cause.
- Decision trace identity is now computed before `environment.observe()`.
  This matters for hidden-information domains because observe/projection can
  fail before an actor sees anything; the adapter must still be able to record a
  stable trace id, actor-turn index, actor id, pending action, scheduler mode,
  and failure attribution. Generic tests cover both `decide()` failure and
  `environment.observe()` failure paths, plus observation-assembly and
  `actor.observe()` failure paths.
- Failed decisions preserve the failed actor's decision-local scheduler
  `turnIndex`, including batched decision slots. In an
  `aec-batched-decision` batch where the second actor fails during decision
  collection, the failure hook and failed generic step use that second actor's
  turn slot rather than the batch base turn. The failed step also preserves the
  batched resolution policy `sequential-apply-from-shared-decision-state`
  instead of downgrading the failure artifact to ordinary AEC semantics.
- Decision-failure hook side effects are linked back onto the failed generic
  step. If the hook records domain-native failure evidence such as a Werewolf
  `harness.error` event, the failed step records `postStateHash` and
  `eventSeqRange` when the domain provides state hashing and event sequence
  extraction. This makes the failure step point to the error evidence instead
  of leaving the mutation only in `finalState`.
- `runSocialEpisode()` now also has an optional domain-neutral
  `onEnvironmentStepFailure` hook for failures that happen after a successful
  decision candidate exists but before the environment/message commit completes:
  message validation failure, `beforeEnvironmentStep` failure, environment
  transition failure, true-parallel `stepBatch` failure, or message commit
  failure. The hook receives the actor/profile identity, pending action,
  assembled observation, action, pre-state, pre-state hash, failure-state
  snapshot, failure-state hash, scheduler/batch metadata, resolution policy, and
  raw error. Hook side effects are reflected in the failed step's
  `postStateHash` and `eventSeqRange` when hashing/event extraction are
  available.
- `werewolfLegacyTraceId` provides legacy `:harness:` trace ids for generic
  Werewolf runs. It now prefers the adapter-provided agent-turn index when one
  exists, so controlled generic-social Werewolf prefixes that start with
  `system.advance` can still project the first committed agent turn as
  `:harness:1:...`, matching legacy `runHarnessMatch()` semantics.
  `WerewolfSocialActorAdapter` adopts the provided trace id only when the hook
  supplies one; otherwise the older `:social-adapter:` trace style remains
  unchanged for existing tests and exploratory paths.
- The projection filters system transitions and failed generic attempted steps,
  and requires replay-grade evidence: player observation, agent pending action,
  pre/post hashes, event sequence range, command, policy plan, reasoner summary,
  turn trace, and optional message range.
- `initializeWerewolfAgentActors()` is the shared Werewolf actor initialization
  path for both the legacy runtime and controlled generic-social adapter runs.
  This keeps restored agent state, social profile hydration, default policy
  selection, and social-state bootstrapping from drifting across runners.
- `runWerewolfSocialHarnessPrefix()` is the adapter-owned vertical helper for a
  Werewolf prefix. It delegates to `runSocialEpisode()`
  with `WerewolfSocialEnvironment`, `WerewolfSocialActorAdapter`,
  `createWerewolfSocialChannels()`, `assembleWerewolfSocialObservation()`,
  `werewolfSystemTransition()`, `recordWerewolfHarnessTurn()`,
  `hashStableState`, `werewolfEventSeq`, and legacy `:harness:` trace ids, then
  projects successful generic steps into legacy-compatible replay trajectory
  records and legacy-compatible Werewolf social steps. It is a lower-level
  helper; the public production entrypoint is `runHarnessMatch()` delegating
  through `runWerewolfSocialHarnessPrefixAsHarnessResult()`.
- `runWerewolfSocialHarnessPrefix()` uses an adapter-owned sequential
  agent-turn index provider by default. Raw generic artifacts still include
  system transition steps with their generic scheduler indices, but projected
  `HarnessStepRecord.turnIndex`, reasoner trace ids, message metadata, and
  `harness.turn` payloads use the legacy committed-agent turn index.
- `runWerewolfSocialHarnessPrefix()` also uses the adapter-owned
  `werewolfLegacySchedulerModeForBatch()` resolver by default: all-pending
  `kill` or `vote` batches run with `aec-batched-decision`, while other
  Werewolf phases run with `aec`. This mirrors the legacy runtime's scheduler
  rule without changing generic `social.ts` business semantics.
- `src/harness/werewolfResult.ts` is now the Werewolf-specific full result
  assembly module. It owns `collectWerewolfHarnessMetrics()`,
  `buildWerewolfSocialEpisode()`, and
  `buildWerewolfHarnessRunResultFromParts()`. This keeps metrics, legacy social
  episode construction, evaluator registry execution, adversarial evaluation
  extraction, failure-state hashing, and `HarnessRunResult` assembly reusable
  without exporting the legacy runtime loop.
- `buildWerewolfSocialEpisode()` was moved out of `werewolfAdapter.ts` into
  `werewolfResult.ts` so the result assembly module is a lower-level dependency.
  `werewolfResult.ts` must not import `werewolfAdapter.ts`; this prevents the
  future production adapter path from creating a direct
  `werewolfAdapter -> werewolfResult -> werewolfAdapter` cycle.
- `runHarnessMatch()` now delegates to
  `runWerewolfSocialHarnessPrefixAsHarnessResult()` and is the production
  compatibility entrypoint over the generic Werewolf social runner. Its public
  result remains the existing `HarnessRunResult` contract, not a raw
  `SocialEpisodeArtifact`.
- The old private legacy match loop and its direct `WerewolfEnvironment` /
  `WerewolfAgentActor` helper plumbing have been removed from `runtime.ts`.
  Runtime now keeps `runHarnessMatch()` and `probeHarnessTurn()` as
  compatibility delegates only.
- `probeHarnessTurn()` now delegates to
  `probeWerewolfSocialHarnessTurn()` in `werewolfAdapter.ts`. The adapter-owned
  helper uses `WerewolfSocialActorAdapter.observe()` / `.decide()` to produce
  the same raw `{ trace, command }` probe result while preserving probe
  semantics: no environment step, no `harness.turn` event, no message bus
  commit, and no persisted match.
- `runWerewolfSocialHarnessPrefixAsHarnessResult()` lives in
  `werewolfAdapter.ts`. It catches Werewolf initialization failures, runs the
  controlled generic-social Werewolf prefix, projects successful generic social
  player steps into legacy replay trajectory records, filters raw system/failed
  generic steps out of committed replay trajectory, and converts the
  legacy-compatible prefix into a full `HarnessRunResult` through
  `buildWerewolfHarnessRunResultFromParts()`.
- `aec-batched-decision` max-transition handling now treats an already-started
  decision batch as a compatibility boundary: the runner must not partially
  apply a decided Werewolf kill/vote batch when `maxTransitions` lands inside
  it. The regression case is `maxTransitions: 3`, where the fixed path applies
  `seer.inspect` plus both wolf `werewolf.killVote` commands and reaches
  `night_witch` instead of applying only one wolf vote and remaining in
  `night_wolves`.
- `tests/werewolfAdapter.test.ts` verifies a generic
  `system.advance -> seer.inspect` run can be projected into a legacy trajectory
  and replayed with `replayHarnessTrajectory()` to the same final hash without
  model calls.
- `tests/werewolfAdapter.test.ts` also verifies the same generic path can use
  legacy `:harness:` trace ids end-to-end across reasoner input, social
  messages, `harness.turn` payload, projected trajectory, and replay.
- `tests/werewolfAdapter.test.ts` verifies generic
  `aec-batched-decision` Werewolf kill votes can use legacy `:harness:` trace
  ids for both wolves, preserve shared `decisionStateHash`, project into
  `HarnessStepRecord[]`, and replay to the same final hash.
- `tests/social.test.ts` verifies a generic `aec-batched-decision` batch is not
  split when `maxTransitions` falls inside the already-started batch.
- `tests/werewolfAdapter.test.ts` and `tests/harness.test.ts` verify the
  Werewolf generic wrapper and public `runHarnessMatch()` production entrypoint
  do not partially apply a wolf kill-vote batch at `maxTransitions: 3`; both
  wolves vote, batch metadata remains intact, and replay reaches the wrapper's
  final state hash.
- `tests/werewolfAdapter.test.ts` verifies the controlled generic-social
  Werewolf prefix helper produces a replayable legacy trajectory without manual
  hook wiring at the call site.
- `tests/werewolfAdapter.test.ts` verifies a controlled
  `system.advance -> seer.inspect` prefix projects into replayable
  legacy-compatible records with fixed assertions for trace id, turn index,
  state hashes, message ranges, command evidence, social-step alignment, replay
  hash, and the retained raw generic system-transition step.
- `tests/werewolfAdapter.test.ts` verifies a longer controlled mixed-scheduler
  Werewolf prefix through public speech remains replayable with fixed assertions
  for projected trajectory, social-step alignment, committed social messages,
  final state hash, wolf-batch metadata (`:werewolf-batch:N`, group-position
  `batchIndex`, and `batchSize`), successful provider retry history, and
  streaming completion telemetry.
- `tests/werewolfAdapter.test.ts` verifies the production `runHarnessMatch()`
  wrapper remains legacy-shaped and replayable without comparing it to its
  generic delegate. The wrapper contract assertions cover status, truncation
  reason, metrics, replayable `trajectory`, social episode alignment, channels,
  `agents`, `evaluation`, `evaluationReport`, and model-free replay to the final
  state hash.
- `tests/werewolfAdapter.test.ts` verifies a completed full-match generic
  Werewolf `HarnessRunResult` with `maxTransitions: 320` using fixed contract
  assertions. The run reaches `completed` / `game_over`, has no failure or
  truncation fields, records a winner and `game.ended` event, builds a completed
  `MatchArtifact`, emits expected JSONL record counts for header, metrics,
  evaluation report, channels, social steps, replay steps, traces, messages,
  agent states, and metrics, emits no error records, and replays without model
  calls to the same final hash.
- `tests/werewolfAdapter.test.ts` verifies checkpoint/fork restoration through
  the generic wrapper using fixed contract assertions instead of
  wrapper-vs-helper equality. The test keeps a production `runHarnessMatch()`
  parent artifact as checkpoint input, proves checkpoint immutability, preserves
  `forkOf` provenance from `forkHarnessRunOptions()`, restores agent turn state
  and social messages, continues message sequence ranges from the checkpoint
  source, exposes only scoped parent messages to the next reasoner call, checks
  evaluation/report presence, and replays the one-step fork trajectory from the
  checkpoint source hash to the fork final hash.
- `tests/werewolfAdapter.test.ts` verifies provider-backed decision failures
  return failed full `HarnessRunResult` artifacts with fixed assertions for
  `failureReason`, `failureStateHash`, metrics, successful-prefix-only
  trajectory, failed social episode shape, redaction-safe provider failure
  payload, no raw provider token leakage, agents/evaluation/report presence, and
  replay ending at the last successful prefix hash rather than the failure state
  hash.
- `tests/werewolfAdapter.test.ts` verifies generic environment-step rejection is
  kept out of committed replay trajectories. The controlled illegal
  seer-inspect setup proves environment authority rejection wording,
  `failureStateHash`, metrics, empty trajectory/social steps/messages,
  unchanged `night_seer` state, `harness.turn` before `harness.error`, absence
  of provider failure metadata, model-free zero-command replay, and
  agents/evaluation/report presence.
- `tests/werewolfAdapter.test.ts` verifies generic full-result initialization
  failures return failed `HarnessRunResult` artifacts instead of throwing.
  Missing agent configs produce a failed result with no reasoner calls, empty
  trajectory/social steps/messages/agents, one `harness.error` payload
  (`actionKind: initialize`, `model: unknown`, `traceId: <game>:harness:init`),
  failure reason/state hash, metrics, social episode failure shape, evaluation,
  and evaluation report.
- `recordWerewolfDecisionFailure()` bridges generic social decision failures
  into legacy Werewolf `harness.error` events. It records actor/model/action
  attribution, legacy-compatible trace id, safe error message, and
  redaction-safe provider failure summaries from the shared
  `providerFailureFromError()` helper when the failure cause contains
  provider metadata.
- `recordWerewolfEnvironmentStepFailure()` bridges generic social step
  application failures into legacy Werewolf `harness.error` events. It records
  actor/model/action attribution, trace id, safe error message, provider request
  id/attempts when adapter metadata is present, and redaction-safe provider
  failure summaries when the raw cause carries provider metadata. It is tolerant
  of missing adapter metadata so failure recording does not hide the original
  environment/action failure.
- `WerewolfSocialEnvironment` exposes an explicit `recordError()` adapter
  method, so Werewolf failure recording no longer has to reach through the
  adapter boundary to the wrapped `WerewolfEnvironment`.
- `tests/werewolfAdapter.test.ts` verifies generic failed attempted steps stay
  out of projected legacy trajectories while remaining visible in the generic
  social artifact.
- `tests/werewolfAdapter.test.ts` verifies provider-backed generic decision
  failures record one legacy `harness.error`, keep failed generic steps out of
  projected legacy trajectories, preserve the successful replayable prefix,
  preserve committed messages only from successful turns, and do not leak raw
  provider bearer-token sentinel fields into the artifact.
- `tests/werewolfAdapter.test.ts` verifies generic environment/action step
  failures record one legacy `harness.error`, keep failed generic steps out of
  projected legacy trajectories, keep uncommitted messages out of the bus, and
  link the failed generic step to the error event through `postStateHash` and
  `eventSeqRange`.
- `tests/werewolfAdapter.test.ts` verifies batched
  `aec-batched-decision` environment/action step failures preserve the
  successful replayable prefix, keep only successful-turn messages committed,
  record the failed actor's legacy `harness.error`, retain the failed step's
  batched scheduler/resolution metadata, and keep the failed generic step out of
  the projected legacy trajectory. The replay check intentionally replays only
  the successful projected prefix and proves it reaches the successful step's
  post-state hash, not the final failure state with the later `harness.error`
  event.
- `tests/werewolfAdapter.test.ts` verifies a controlled generic-social Werewolf
  vertical prefix covering system advance, seer inspect, wolf kill votes, witch
  action, public speech, scoped team/public exposure derivation, projection, and
  replay from the same generic artifact.
- `tests/social.test.ts` verifies a generic social episode can resolve scheduler
  mode per batch while preserving the episode-level default mode.
- `tests/werewolfAdapter.test.ts` verifies the controlled Werewolf vertical
  prefix uses `aec-batched-decision` for wolf kill votes with shared
  `decisionStateHash`, uses `aec` for speech, preserves scoped team/public
  exposure, and still projects/replays successfully.
- `toTrajectoryJsonl()` now emits `social_step` records sourced from
  `artifact.socialEpisode.steps` in addition to the legacy replayable `step`
  and `trace` records sourced from `artifact.trajectory`. This preserves native
  social-runner evidence such as scheduler mode, batch metadata, action
  envelope, observation, state hashes, message/event ranges, feedback fields,
  and errors in line-oriented artifacts without making replay consume raw
  generic social steps. `tests/artifacts.test.ts` covers completed and failed
  match JSONL output, and `tests/tournamentArtifacts.test.ts` covers aggregate
  `trajectory.jsonl` carrying the same `social_step` records with tournament
  episode metadata.
- Message-validation failure hardening now has adapter-level coverage. A
  Werewolf generic-social action that proposes a legal domain command plus an
  invalid social message records a single legacy `harness.error`, does not run
  `recordWerewolfHarnessTurn()`, does not apply the domain command, does not
  commit the draft message to `artifact.messages`, keeps the failed generic step
  out of projected legacy replay trajectories, and still preserves the failed
  draft under the failed `social_step.action.messages` JSONL audit record.
- Focused validation for this baseline:
  - `npx vitest run tests/social.test.ts -t "maxTransitions falls inside" --reporter=dot`
  - `npx vitest run tests/werewolfAdapter.test.ts -t "maxTransitions lands inside" --reporter=dot`
  - `npx vitest run tests/harness.test.ts -t "wolf batch at the maxTransitions boundary" --reporter=dot`
  - `npx vitest run tests/werewolfAdapter.test.ts -t "environment-step rejection" --reporter=dot`
  - `npx vitest run tests/artifacts.test.ts -t "exports completed run steps" --reporter=dot`
  - `npx vitest run tests/artifacts.test.ts -t "exports audit-critical records" --reporter=dot`
  - `npx vitest run tests/tournamentArtifacts.test.ts -t "preserves social exposure records" --reporter=dot`
  - `npx vitest run tests/werewolfAdapter.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot` (`3` files / `30` tests)
  - `npx tsc --noEmit --pretty false --noErrorTruncation`
  - `npx vitest run tests/werewolfAdapter.test.ts` (`21` tests)
  - `npx vitest run tests/social.test.ts tests/werewolfAdapter.test.ts tests/harness.test.ts tests/replay.test.ts tests/artifacts.test.ts`
  - `npm run build`
  - `npx vitest run tests/harness.test.ts -t "probe turn" --reporter=dot`
  - `npx vitest run tests/serverPublicViewApi.test.ts -t "harness probe" --reporter=dot`
  - `npx vitest run tests/serverPublicViewApi.test.ts tests/serverCheckpointApi.test.ts tests/serverTournamentArtifactsApi.test.ts --reporter=dot`
  - `npx vitest run tests/werewolfAdapter.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot --pool=forks`
  - `npm test -- --reporter=dot` (`20` files / `142` tests)
  - Secret scan over `AGENTS.md`, `src`, and `tests`

Remaining migration work:

- Production wrapper promotion is complete: `runHarnessMatch()` delegates to
  `runWerewolfSocialHarnessPrefixAsHarnessResult()`. Private legacy-loop cleanup
  is also complete: `runtime.ts` contains only public compatibility delegates.
  The remaining runtime migration work is contract hardening, not production
  path replacement.
- Stale legacy-vs-generic equality tests in `tests/werewolfAdapter.test.ts` have
  been converted to fixed harness/artifact/fork contract assertions. After
  promotion, do not reintroduce comparisons between `runHarnessMatch()` and
  `runWerewolfSocialHarnessPrefixAsHarnessResult()` as independent proof.
- `probeHarnessTurn()` and related legacy helper usage have been audited and
  migrated. The exported diagnostic helper still exists for server, CLI, and UI
  compatibility, but its implementation now lives at the Werewolf adapter
  boundary through `probeWerewolfSocialHarnessTurn()`.
- Batch-boundary `maxTransitions` compatibility for `aec-batched-decision` is
  complete and covered by regression tests; do not reintroduce partial
  application of Werewolf kill/vote batches.
- Generic social failed steps are still broader than legacy replay semantics.
  The Werewolf projector now skips failed generic steps, but failed-step replay
  semantics remain intentionally undesigned for legacy `HarnessStepRecord[]`.
- Successful trace id, turn index, mixed scheduler, message, social step, final
  state, completed full-match result/artifact/JSONL contract, failed
  full-result contract, initialization-failure contract, checkpoint/fork
  restoration contract, provider telemetry, provider decision-failure
  attribution, and environment/action step-failure attribution now have
  controlled tests.
  Environment authority rejection through the normal actor/policy path also has
  full-result contract coverage. Batched environment/action step-failure
  attribution has controlled generic-Werewolf coverage with successful-prefix
  replay. Native `SocialEpisodeArtifact.steps` now have match and tournament
  JSONL audit records, including failed message-validation draft evidence, but
  replay still intentionally consumes only projected legacy `HarnessStepRecord[]`.
  Production wrapper promotion, stale self-comparison test reframing, private
  legacy-loop helper cleanup, and the latest message-validation failure bridge
  tests are complete; the remaining runtime work is broad failure/provider/
  message/event contract hardening.

#### 13.11.2 `agent.action-arbitration.v1`

Capability:

```text
Introduce a real action arbitration layer that consumes goals, norms,
relationships, reputation, beliefs, memory, legal actions, strategy profile,
and optional reasoner proposals before producing a typed command/message
proposal.
```

Owner modules to inspect before editing:

```text
src/harness/scaffold.ts
src/harness/socialState.ts
src/harness/policy.ts
src/harness/actor.ts
tests/scaffold.test.ts
tests/socialState.test.ts
tests/actorSocialClaims.test.ts
tests/policy.test.ts
tests/werewolfAdapter.test.ts
```

Acceptance:

- Candidate generation is separate from final selection.
- Reasoner proposals are advisory.
- Social state affects at least one tested legal decision.
- Trace records preserve candidate scores or a redacted arbitration summary.
- Deterministic fake actors still work without provider calls.

Current baseline:

- `src/harness/scaffold.ts` now defines a generic scaffold-level candidate and
  arbitration baseline: `AgentActionCandidate`, `AgentActionArbitrator`,
  `AgentActionArbitrationInput`, `AgentActionArbitrationDecision`, and
  `AgentActionArbitrationSummary` versioned as
  `agent.action-arbitration.v1`.
- `AgentPolicy.generateCandidates()` is optional and separate from
  `AgentPolicy.decide()`. If a policy does not implement candidate generation
  and no action arbitrator is configured, the scaffold keeps the legacy path:
  `policy.decide(input)` returns a normal `SocialAction` proposal with no
  arbitration metadata.
- If candidates exist, the scaffold normalizes and validates them before
  selection. Candidates must belong to the scaffold actor, candidate kind must
  match action kind, ids must be unique, and each candidate must carry
  non-empty `EvidenceRef[]`.
- If no custom `AgentActionArbitrator` is configured, the scaffold uses the
  default score rule: highest finite `finalScore`, then candidate id tie-break.
  A configured arbitrator may select by candidate id, but the environment still
  remains final authority for command legality and state transition.
- `ScaffoldedActorOptions.candidateScorers` now provides a generic scoring pass
  between candidate normalization and final arbitration. Candidate scorers read
  cloned decision input and may add evidence-backed score contributions, but
  they do not mutate the environment, legal action set, observation, pending
  action, or social stores.
- `createWeightedSocialStateCandidateScorer()` is the first reusable generic
  scorer. It reads `input.agent.social` for candidate-declared
  `socialTargetIds`, aggregates configured weights over relationships,
  reputation, numeric/boolean belief claims, active goals, active norms,
  explicit commitment status, coalition status, gossip valence, norm-sanction
  kind/status, trust-repair kind/status, and betrayal kind/status, and emits
  `source: "social_state"` score contributions with evidence refs. It does not
  parse free text, does not infer hidden truth, does not create optional ledgers
  while scoring, and does not promote these signals into reward or leaderboard
  metrics.
- `ScaffoldedActorOptions.initialSocialState` can seed a scaffolded actor with
  an existing `AgentSocialState` snapshot. The scaffold rejects an initial
  social state whose `agentId` does not match the actor id.
- The reasoner remains advisory. `AgentReasoner.reflect()` may create a private
  memo that is visible to policy/arbitration input, but it does not mutate the
  environment and does not override the selected legal action proposal.
- The selected `SocialAction` remains the emitted proposal. The scaffold stores
  the redacted arbitration summary under `action.metadata.arbitration` and in
  the private decision memory metadata with the `action-arbitration` tag.
- The action-level `AgentActionArbitrationSummary` intentionally omits raw
  candidate commands, candidate messages, arbitrary candidate metadata, and
  arbitrary arbitrator metadata. It preserves candidate ids, actor ids, kinds,
  sources, numeric scores, evidence refs, reasons, message counts, selected
  candidate id, decision rule, and selection evidence. Internal candidate
  metadata can still exist for in-process policy/arbitrator use, but it is not
  persisted into the artifact-facing summary by default.
- `tests/scaffold.test.ts` proves candidate generation, default score
  arbitration, custom arbitrator selection, wrong-actor rejection,
  evidence-ref enforcement, reasoner memo advisory behavior, cloned arbitrator
  input, and that the persisted arbitration summary omits raw commands and
  private candidate scratchpad metadata.
- `tests/scaffold.test.ts` also proves that an evidence-backed seeded social
  state can change generic scaffold candidate selection through the weighted
  social-state scorer, that social score contributions cite relationship,
  reputation, belief, goal, norm, commitment, coalition, gossip, norm-sanction,
  trust-repair, and betrayal evidence by ref, that the legacy
  no-candidate/no-arbitrator path remains metadata-free, that reasoner memo text
  does not enter arbitration summaries, that candidate raw commands and private
  scratchpad metadata stay out of persisted arbitration summaries, and that
  mismatched initial social state actor ids are rejected.
- `tests/social.test.ts` now proves that a `ScaffoldedSocialActor` running
  through `runSocialEpisode()` records `agent.action-arbitration.v1` on the
  resulting `SocialHarnessStep.action`, and that the environment receives the
  selected candidate command.
- The previous Werewolf-specific baseline remains as proof/compatibility
  surface, not as the generic scaffold contract: `src/harness/types.ts`
  defines `PolicyArbitrationSummary`, and `src/harness/policy.ts` exposes
  `arbitrateSocialTarget()` for legal-target ranking in public pressure and
  day-vote target selection.

Focused validation for this baseline:

- `npx tsc --noEmit --pretty false --noErrorTruncation`
- `npx vitest run tests/scaffold.test.ts tests/openaiClient.test.ts --reporter=dot`
  (`2` files / `21` tests)
- `npx vitest run tests/scaffold.test.ts tests/social.test.ts tests/socialState.test.ts tests/policy.test.ts tests/actorSocialClaims.test.ts --reporter=dot`
  (`5` files / `55` tests)
- `npx vitest run tests/werewolfAdapter.test.ts tests/harness.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts tests/openaiClient.test.ts --reporter=dot`
  (`5` files / `51` tests)
- `npm test -- --reporter=dot` (`20` files / `165` tests)
- `npm run build`
- Secret-pattern scan over `AGENTS.md`, `src`, `tests`, `package.json`,
  `README.md`, and `docs`, excluding `.env`, `.env.local`, `node_modules`,
  `dist`, and lockfiles; hits were variable names, README placeholders,
  expected fake/test redaction sentinels, provider client env references, and a
  non-secret `low-risk-pass` candidate id substring. No `.env` or `.env.local`
  contents were read or printed.
- Overclaim-pattern scan over the same non-env paths; hits were expected
  negative wording, documentation guardrails, no-fake-validation CLI text, or
  forbidden-regex tests only.
- Max-token scan over the same non-env paths showed only README policy text and
  `tests/openaiClient.test.ts` assertions that provider request bodies do not
  contain `max_tokens` or `max_completion_tokens`.
- `npm run agent:probe -- --models=kimi-k2.7,deepseek-v4-flash,minimax-m3 --timeout=180s`
  completed real OpenAI-compatible streaming probe turns through the configured
  provider: summary `ok: true`, three succeeded models, zero failed models.
  The successful models were `kimi-k2.7`, `deepseek-v4-flash`, and
  `minimax-m3`. This was a real streaming provider call set, not a fake smoke
  test or fallback validation.
- `LLM_STREAM=true LLM_TIMEOUT_MS=180000 LLM_RETRY_COUNT=0 npm run arena:match -- --models=kimi-k2.7,deepseek-v4-flash,minimax-m3 --maxTransitions=4 --timeout=180s --json=summary`
  completed a bounded real streaming match through the configured provider:
  summary `ok: true`, three harness turns, `harnessErrors: 0`, and expected
  `status: truncated` because the run was intentionally capped at
  `maxTransitions=4`. The truncated match assigned all three models; the capped
  turn sequence called `kimi-k2.7` and `deepseek-v4-flash` before truncation.
  This was a real streaming match path, not a fake smoke test or fallback
  validation.

This slice changed deterministic generic scaffold arbitration, social-state
candidate scoring, initial social-state seeding, artifact summary safety, and a
provider-client regression test that locks live request bodies to streaming
without max-token fields. Live streaming probe and bounded match validation were
run because the user explicitly required real calls for agent/harness
validation.

Latest scorer extension:

- `WeightedSocialStateCandidateScorerOptions` now has opt-in weight maps for
  explicit society ledgers that already exist in `AgentSocialState`:
  commitments, coalitions, gossip, norm sanctions, trust repairs, and
  betrayals.
- Candidate scoring still runs only over caller-provided candidates with
  declared `socialTargetIds`. It does not discover actions, mutate stores, read
  hidden truth, parse natural language, or replace environment legality.
- The target matcher stays conservative: it uses explicit actor/target/member/
  subject ids and metadata `targetId` / `targetIds`; it does not infer targets
  from free-text fields such as promised action, shared goal, claim, reason,
  apology, or impact text.
- Score contribution reasons are categorical and evidence-backed, for example
  `commitment:broken`, `coalition:active`, `gossip:negative`,
  `normSanction:pressure`, `trustRepair:attempted`, and `betrayal:alleged`.
- This is still action-arbitration input, not an evaluator promotion. The
  social evaluator family remains zero-weight for these association/coverage
  metrics unless a future explicit metric-promotion decision changes
  leaderboard/reward semantics.

Latest scaffold scorer registry baseline:

- `src/harness/scaffold.ts` now exposes a scaffold-owned scorer config resolver:
  `resolveAgentActionCandidateScorers()`.
- The resolver reuses the existing `AgentActionCandidateScorer` protocol. It is
  not a second live decision interface, not a model-output schema, and not an
  agent definition.
- The default registry currently registers only
  `weighted-social-state` through `WEIGHTED_SOCIAL_STATE_CANDIDATE_SCORER_KIND`.
- The resolver accepts serializable scorer config objects and constructs scorer
  instances for `ScaffoldedActorOptions.candidateScorers`. It validates scorer
  kind, option shape, known weight-map keys, and finite numeric weights before
  actor construction.
- The resolver clones config input before constructing scorer options, so later
  caller mutation cannot change a resolved scorer.
- Custom registries may map new names to existing
  `AgentActionCandidateScorer` factories, but they must still return the same
  scorer protocol and preserve scaffold/environment authority boundaries.
- This registry is internal scaffold plumbing only. It has not been wired into
  `HarnessAgentProfile`, `HarnessAgentConfig`, experiment specs, CLI/API
  profile parsing, React profile editing, checkpoint/fork profile restoration,
  or production Werewolf actor construction.
- Production Werewolf still uses `WerewolfAgentActor`, `planAction()`,
  `PolicyPlan`, and `policy.social-target-arbitration.v1`. Wiring generic
  scorer configs into Werewolf would require an explicit bridge and tests for
  legal candidate generation, hidden-information safety, trace/artifact schema,
  replay compatibility, and public profile/spec semantics.

Latest Werewolf policy ledger integration:

- `src/harness/policy.ts` now lets the Werewolf-specific
  `policy.social-target-arbitration.v1` path consume explicit society ledgers
  already present on the acting agent's `AgentSocialState`: commitments,
  coalitions, gossip, norm sanctions, trust repairs, and betrayals.
- This is not a generic scorer/profile bridge. Production Werewolf still uses
  `WerewolfAgentActor`, `planAction()`, `PolicyPlan`, and
  `policy.social-target-arbitration.v1`; scaffold scorer configs remain
  internal scaffold plumbing only.
- The policy reads ledgers only as deterministic, evidence-backed target-ranking
  signals for legal speech-pressure and vote targets. It does not create
  actions, mutate stores, parse free text, read hidden truth, change evaluator
  weights, promote leaderboard metrics, or bypass environment validation.
- The target matching is intentionally conservative for this Werewolf policy:
  commitments and betrayals match the acting/accused `actorId` or explicit
  target metadata; gossip matches `subjectId`; norm sanctions match
  `targetId`; trust repairs match the repairing `actorId`; coalitions match
  explicit `memberIds`, `targetId`, or target metadata. This avoids treating raw
  narrative text as authoritative structure.
- Arbitration summaries continue to expose only target scores, categorical
  reasons, and evidence refs. Raw ledger text fields such as promised action,
  shared goal, claim, reason, requested repair, offered repair, or impact text
  are not persisted into `PolicyArbitrationSummary`.
- `tests/policy.test.ts` now covers village suspicion changes from explicit
  commitment/gossip/norm-sanction/betrayal ledgers, werewolf target-village
  changes from explicit commitment/coalition/trust-repair ledgers, illegal
  target filtering even when illegal ledgers are strong, and policy-memory
  recording remaining policy authority rather than reasoner authority.
- `tests/actorSocialClaims.test.ts` now also stitches the observation-to-policy
  chain end to end: scoped visible `SocialMessage.metadata.socialFacts` are
  ingested by `WerewolfAgentActor.observe()` into explicit private society
  ledgers, then `WerewolfAgentActor.plan()` lets
  `policy.social-target-arbitration.v1` consume those ledgers as evidence-backed
  legal target-ranking signals. The same test proves that hidden/unobserved
  structured facts are not included in the scoped view, do not enter the actor's
  ledgers, and do not affect arbitration; natural-language-only content without
  `socialFacts` also does not create ledger pressure. Arbitration summaries
  remain typed and redacted: reason labels and evidence refs are exposed, but raw
  ledger narrative text is not persisted into `PolicyArbitrationSummary`.
- The same file now also covers the stronger bus-scoped path:
  `SocialCommunicationBus.publish()` commits both public and private structured
  social facts, `SocialCommunicationBus.observe("observer")` exposes only the
  observer-visible public messages and channels, and only those bus-scoped
  messages are passed into `WerewolfAgentActor.observe()`. Hidden private
  structured facts therefore stay out of the actor's private ledgers and out of
  policy arbitration before the agent plane sees the observation.
- `tests/openaiClient.test.ts` now locks live provider request bodies to the
  exact allowed key set `model`, `messages`, `temperature`, and `stream`, and
  asserts absence of `max_token`, `max_tokens`, `max_completion_tokens`,
  `max_output_tokens`, and common camelCase equivalents.
- `README.md`, `docs/architecture.md`, and `docs/social-harness.md` were updated
  to reflect the no-max-token-field provider policy and the distinction between
  Werewolf-specific ledger-aware policy arbitration and the generic scaffold
  scorer registry.
- No live streaming provider validation was required for this slice because no
  provider client, reasoner runtime, prompt, parser, model selection, timeout,
  or retry behavior changed. The existing live-provider policy remains:
  real calls must stream and must not send max-token request fields.

Latest extension validation:

- `npx vitest run tests/openaiClient.test.ts tests/policy.test.ts --reporter=dot`
  (`2` files / `17` tests)
- `npx vitest run tests/actorSocialClaims.test.ts --reporter=dot`
  (`1` file / `7` tests)
- `npx tsc --noEmit --pretty false --noErrorTruncation`
- `npx vitest run tests/social.test.ts tests/actorSocialClaims.test.ts tests/policy.test.ts --reporter=dot`
  (`3` files / `38` tests)
- `npx vitest run tests/scaffold.test.ts tests/socialState.test.ts tests/actorSocialClaims.test.ts tests/policy.test.ts tests/social.test.ts --reporter=dot`
  (`5` files / `63` tests)
- `npx vitest run tests/openaiClient.test.ts --reporter=dot`
  (`1` file / `9` tests)
- `npm run build`
- `npm test -- --reporter=dot` (`20` files / `172` tests)
- `npx vitest run tests/werewolfAdapter.test.ts -t "emits a completed generic Werewolf HarnessRunResult artifact and JSONL contract" --reporter=dot`
  (`1` selected test passed)
- `npx vitest run tests/werewolfAdapter.test.ts --reporter=dot`
  (`1` file / `22` tests)
- `npm test -- --reporter=dot` initially hit one `werewolfAdapter` artifact
  contract timeout while running concurrently with other validation commands;
  the selected test and full file passed immediately afterward, and a subsequent
  non-concurrent `npm test -- --reporter=dot` passed (`20` files / `170`
  tests).
- Secret-pattern scan over `AGENTS.md`, `README.md`, `docs`, `package.json`,
  `src`, and `tests`, excluding `.env`, `.env.local`, `node_modules`, `dist`,
  and lockfiles; hits were expected env variable names, README placeholders,
  redaction-test sentinels, provider-client env references, and non-secret
  candidate id text. No `.env` or `.env.local` contents were read or printed.
- Max-token scan over the same non-env paths showed only README/AGENTS policy
  text and `tests/openaiClient.test.ts` forbidden-field assertions for
  `max_token`, `max_tokens`, `max_completion_tokens`, `max_output_tokens`, and
  common camelCase equivalents.
- Stale single-model env lock scan for `LLM_MODELS=kimi-k2.7` and old default
  model phrasing returned no hits in non-env paths.
- Overclaim/fake-validation scan over the same non-env paths showed expected
  negative guardrail wording and tests that forbid causal/success/reward/truth
  overclaims.
- `LLM_STREAM=true LLM_TIMEOUT_MS=180000 LLM_RETRY_COUNT=0 npm run agent:probe -- --models=kimi-k2.7,deepseek-v4-flash,minimax-m3 --timeout=180s`
  completed a real OpenAI-compatible streaming probe through the configured
  provider after the policy/docs/test hardening: summary `ok: true`, three
  succeeded models, zero failed models, elapsed `66138ms`. The successful
  models were `kimi-k2.7`, `deepseek-v4-flash`, and `minimax-m3`, each producing
  a legal `seer.inspect` harness turn. This was a real streaming provider call,
  not a fake smoke test or fallback validation.
- `npx vitest run tests/scaffold.test.ts --reporter=dot` (`1` file / `16`
  tests)
- `npx tsc --noEmit --pretty false --noErrorTruncation`
- `npx vitest run tests/scaffold.test.ts tests/socialState.test.ts tests/actorSocialClaims.test.ts tests/policy.test.ts tests/social.test.ts --reporter=dot`
  (`5` files / `59` tests)
- `npx vitest run tests/profiles.test.ts tests/experiment.test.ts --reporter=dot`
  (`2` files / `8` tests)
- `npx vitest run tests/harness.test.ts tests/werewolfAdapter.test.ts tests/artifacts.test.ts tests/evaluation.test.ts --reporter=dot`
  (`4` files / `58` tests)
- `npm test -- --reporter=dot` (`20` files / `165` tests)
- `npm run build`
- Secret-pattern scan over `AGENTS.md`, `README.md`, `docs`, `package.json`,
  `src`, and `tests`, excluding `.env`, `.env.local`, `node_modules`, `dist`,
  and lockfiles; hits were expected variable names, README placeholders,
  provider/test redaction sentinels, and non-secret candidate-id text.
- Max-token scan over the same non-env paths showed only policy/test text that
  forbids `max_tokens` / `max_completion_tokens`; no provider request code was
  changed to send a max-token field.
- Overclaim/fake-validation scan over the same non-env paths showed expected
  negative guardrail wording and tests that forbid causal/success/reward/truth
  overclaims.
- `LLM_STREAM=true LLM_TIMEOUT_MS=90000 LLM_RETRY_COUNT=0 npm run agent:probe -- --models=kimi-k2.7 --timeout=90s`
  completed one real streaming provider probe: summary `ok: true`, one
  succeeded model, zero failed models, command `seer.inspect`.
- `LLM_STREAM=true LLM_TIMEOUT_MS=90000 LLM_RETRY_COUNT=0 npm run arena:match -- --models=kimi-k2.7 --maxTransitions=2 --timeout=90s --json=summary`
  was a real streaming bounded match attempt and failed honestly with a stream
  abort after the 90s match timeout before any successful harness turn. Do not
  report that command as passed.
- `LLM_STREAM=true LLM_TIMEOUT_MS=180000 LLM_RETRY_COUNT=0 npm run arena:match -- --models=kimi-k2.7 --maxTransitions=2 --timeout=180s --json=summary`
  completed a real streaming bounded match: summary `ok: true`, one
  `kimi-k2.7` model call, one harness turn, `harnessErrors: 0`, and expected
  `status: truncated` because the run was intentionally capped at
  `maxTransitions=2`.

Remaining work:

- This is still only the first generic scaffold arbitration baseline. It is not
  a complete psychology, theory-of-mind, commitment, coalition, deception,
  attack/defense, or bargaining system.
- The generic scaffold now separates candidate generation, evidence-backed
  social-state scoring, and final selection. The first scorer now covers
  relationships, reputation, belief claims, active goals, active norms,
  commitments, coalitions, gossip, norm sanctions, trust repairs, and
  betrayals. A first scaffold-owned scorer registry/resolver now exists.
  Production Werewolf policy can now consume explicit society ledgers for
  legal target ranking. Memory retrieval, recency/audience/deadline-aware
  utility, cross-store chain reasoning, richer policy objectives, profile/spec
  configuration, and any scaffold-scorer-to-Werewolf bridge still need explicit
  contracts and tests.
- If future evaluators need candidate metadata, add a new allowlisted,
  versioned summary field such as `summaryMetadata` or a separate private
  decision-trace artifact. Do not persist arbitrary internal
  `AgentActionCandidate.metadata` or `AgentActionArbitrationDecision.metadata`
  into action-level summaries by default.
- The first temporal social-state journal baseline now exists under
  `agent.social-update-journal.v1`. Future evaluators can consume ordered
  mutation evidence instead of reading only final aggregate stores, but they
  still must not claim causal deception, coalition, trust, reputation, or norm
  effects until their own metric contracts and validation are added.

#### 13.11.3 `agent.social-update-journal.v1`

Capability:

```text
Record redacted ordered social-state mutation evidence so belief, reputation,
relationship, norm, goal, coalition, and deception-shift evaluators can become
artifact-backed instead of heuristic.
```

Owner modules to inspect before editing:

```text
src/harness/socialState.ts
src/harness/actor.ts
src/harness/social.ts
src/harness/socialEvaluator.ts
src/harness/evaluator.ts
tests/socialState.test.ts
tests/actorSocialClaims.test.ts
tests/evaluation.test.ts
tests/artifacts.test.ts
```

Acceptance:

- Store mutation journal entries cite evidence.
- Journal entries are redacted and ordered.
- Artifacts expose enough mutation refs for evaluators.
- No hidden postgame truth enters live stores.
- Existing serialized social-state shape remains compatible or migration is
  versioned.

Current baseline:

- `AgentSocialState` now has an optional root-owned
  `SocialStateMutationJournal` with schema version
  `harness.social-state-journal.v1`, monotonic `journalSeq`, max-entry bound,
  redacted before/after/delta summaries, evidence refs, trace/turn/phase/day
  context, optional message/event sequence ranges, `redactionClass:
  agent_private_summary`, and explicit `hiddenTruthUsed: false`.
- `createAgentSocialState()` deliberately does not emit an empty journal by
  default. This preserves the old serialized shape for newly created untouched
  states and older checkpoint/artifact compatibility. The journal is initialized
  lazily when root social-state wrapper APIs record a mutation.
- Existing low-level store helpers remain available and unchanged:
  `appendMemory`, `upsertBelief`, `updateRelationship`, `updateReputation`,
  `addNorm`, `updateNormStatus`, `pushGoal`, and `updateGoalStatus`.
  New root wrapper APIs add journal recording without forcing all external
  callers to change at once:
  `appendSocialMemory`, `upsertSocialBelief`,
  `updateSocialRelationship`, `updateSocialReputation`, `addSocialNorm`,
  `updateSocialNormStatus`, `pushSocialGoal`, `updateSocialGoalStatus`, and
  `setSocialLastPlan`.
- `WerewolfAgentActor` now records journal entries for scoped observations,
  visible social messages, message-derived belief claims, relationship and
  reputation updates, generic wolf-probability beliefs, episode goals, policy
  plan updates, reasoner memo memory, and policy decision memory. Message-derived
  belief/social updates still come only from messages present in that actor's
  scoped observation path; the actor does not infer from a global transcript.
- `ScaffoldedSocialActor` now records journal entries for generic observation,
  reasoner memo, and policy decision memory while preserving observe-before-
  decide, policy authority, clone-protected reasoner input, and compatibility
  memory behavior.
- Journal summaries intentionally do not copy full observations, private memo
  text, message content, pending actions, full action commands, hidden postgame
  truth, provider payloads, headers, or secrets. They store compact typed facts
  such as store, mutation kind, subject id, counts, short scalar values,
  numeric deltas, tags/metadata keys, evidence counts, and context refs.
- `toTrajectoryJsonl()` now emits `social_state_mutation` records derived from
  final agent journals, alongside existing `agent_state` records. These records
  include run/match/agent identity, social state hash, journal sequence, store,
  mutation kind, redaction class, hidden-truth flag, evidence refs, summaries,
  and context. They are audit records, not replay `HarnessStepRecord` entries.
- Tournament artifact aggregation preserves per-match
  `social_state_mutation` records in aggregate `trajectory.jsonl` with normal
  tournament episode context, because it already aggregates all
  `toTrajectoryJsonl()` records.
- `social.state.v1` now emits zero-weight journal coverage metrics:
  `agent.social.journal_entry_count`,
  `agent.social.evidenced_journal_rate`, and
  `agent.social.journal_store_coverage_count`. The evaluator output also
  reports `journalEntries` and `agentsWithJournal`.
- These metrics are coverage/audit metrics only. They do not alter rewards,
  leaderboards, `evaluationReport.summary.agentScores`, deception scores,
  influence scores, or vote-follow metrics.
- `evaluation.deception-reputation-association.v1` now exists as a standalone,
  deterministic, zero-weight, postgame, artifact-backed evaluator. It consumes
  scoped false-role-claim exposure evidence and observer-owned
  `reputation.updated` journal entries, and it remains separate from reward,
  leaderboard, deception-score, and vote-follow metrics.
- Focused validation for this baseline:
  - `npx tsc --noEmit --pretty false`
  - `npx vitest run tests/socialState.test.ts tests/scaffold.test.ts tests/actorSocialClaims.test.ts --reporter=dot`
  - `npx vitest run tests/evaluation.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot`
  - `npx vitest run tests/policy.test.ts tests/harness.test.ts tests/werewolfAdapter.test.ts tests/replay.test.ts --reporter=dot`
  - `npx vitest run tests/social.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts tests/evaluation.test.ts --reporter=dot`
- Full validation for this baseline:
  - `npm test -- --reporter=dot` (`20` files / `122` tests)
  - `npm run build`
  - Secret scan over `AGENTS.md`, `src`, and `tests`

Remaining work:

- Betrayal store/ingestion/social-state coverage now exists under
  `society.betrayal.v1`; future betrayal work should be narrower contracts for
  standalone temporal evaluators, registry promotion, policy-arbitration use,
  relationship/reputation temporal association, outcome, causal, or
  counterfactual analysis, each with explicit evidence semantics and tests.
- Extend beyond the implemented false-role-claim belief-shift,
  false-role-claim reputation-association, commitment/coalition lifecycle,
  norm/norm-sanction lifecycle, gossip-exposure temporal-association,
  trust-repair lifecycle, and trust-repair relationship/reputation
  temporal-association evaluators into broader relationship formation, broader
  norm, vote/action, and broader reputation outcome evaluators only after each
  has a separate non-causal metric contract and tests.
- Decide whether checkpoint validation should hash or summarize restored
  agent-social journals, beyond the existing state/trajectory/message
  checkpoint provenance checks.
- Add UI drilldowns for journal records only through postgame/debug artifact
  surfaces, with live/public views still redacted.

#### 13.11.4 `evaluation.deception-belief-shift.v1`

Capability:

```text
Audit whether scoped exposure to a postgame-false Werewolf role claim is
followed by later redacted belief-state journal shifts, using artifact evidence
and explicit non-causal metric language.
```

Owner modules to inspect before editing:

```text
src/harness/evaluator.ts
src/harness/social.ts
src/harness/socialState.ts
tests/evaluation.test.ts
tests/artifacts.test.ts
tests/tournamentArtifacts.test.ts
```

Current baseline:

- `src/harness/evaluator.ts` exposes
  `DECEPTION_BELIEF_SHIFT_EVALUATOR_ID` with id
  `evaluation.deception-belief-shift.v1`.
- The evaluator is intentionally separate from `werewolf.deception.v1`.
  It is not included in `createWerewolfEvaluationSuite()` yet and does not
  alter `WEREWOLF_DECEPTION_METRIC_IDS`, `WEREWOLF_EVALUATOR_METRIC_IDS`,
  reward scores, leaderboards, `agent.deception_score`, vote-follow metrics, or
  `evaluationReport.summary.agentScores`.
- The v1 metric contract is belief-only and zero-weight:
  `agent.false_role_claim_belief_temporal_association_count`,
  `agent.false_role_claim_belief_temporal_association_rate`, and
  `agent.false_role_claim_belief_temporal_evaluable_exposure_rate`.
- Exposure authority is only `deriveSocialExposureRecords()` over scoped social
  observations. The evaluator must not infer exposure from `recipientIds`,
  public visibility, or a global transcript.
- False-claim classification uses postgame role truth only to decide whether a
  public `claimedRole` message was false. That truth is not treated as live
  agent knowledge.
- Mutation authority is only `AgentSocialState.journal.entries`, restricted to
  `store === "beliefs"`, `mutationKind === "belief.upserted"`,
  `hiddenTruthUsed === false`, observer-owned journal entries, matching
  `subjectId`, explicit message evidence or message sequence range, and a
  narrow predicate whitelist: `claimedRole` and `werewolfProbability`.
- The ordering rule is strict:
  `mutation.turnIndex > exposure.observedAtTurnIndex`. Candidate journal entries
  without usable ordering make the exposure unevaluable rather than silently
  counting as no shift. If any matching candidate for an exposure lacks
  `turnIndex`, the whole exposure is marked ambiguous for v1 rather than mixing
  ordered and unordered evidence.
- A counted association requires real pre/post mutation evidence:
  `beforeSummary` exists and `deltaSummary` shows `valueChanged === true`, a
  nonzero `confidenceDelta`, or a positive `contradictionCountDelta`.
  Same-turn first belief formation from seeing a message is tracked as
  `formationOnlyCount` and does not count as a later belief shift. Later
  first-time belief insertions without `beforeSummary` are not counted as a
  shift.
- Metric metadata explicitly records:
  `associationLevel: temporal_association`, `causalClaim: false`,
  `truthAccessMode: postgame_role_truth_for_false_claim_classification_only`,
  exposure/mutation sources, ordering rule, predicate whitelist,
  `excludedImmediateIngestion`, denominators, missing-journal counts, ambiguous
  ordering counts, formation-only counts, and linked journal/message refs.
- Evidence refs reuse existing `HarnessMetricEvidenceRef` kinds. Exposure uses
  message/trace/state refs. Journal mutation evidence uses `agent_state` with
  `seq: journalSeq`, trace refs when available, and converted social evidence
  refs. No new evidence artifact enum was added for v1.
- `tests/evaluation.test.ts` has a synthetic artifact-backed test proving:
  observed false-role-claim exposure counts, unobserved false claims do not
  count, same-turn belief ingestion does not count as shift, later belief delta
  does count, mixed ordered/unordered matching journal evidence is marked
  ambiguous/unevaluable, reputation updates are not counted by v1, the registry
  manifest is fully asserted, emitted metric ids are exactly the v1 metric ids,
  and output fields contain no causal or success-overclaim wording.
- `evaluation.deception-reputation-association.v1` now exists as a separately
  named standalone evaluator. It is intentionally separate from
  `evaluation.deception-belief-shift.v1` and `werewolf.deception.v1`; it does
  not alter `WEREWOLF_DECEPTION_METRIC_IDS`,
  `WEREWOLF_EVALUATOR_METRIC_IDS`, reward scores, leaderboards,
  `agent.deception_score`, vote-follow metrics, or
  `evaluationReport.summary.agentScores`.
- The v1 reputation metric contract is reputation-only and zero-weight:
  `agent.false_role_claim_reputation_temporal_association_count`,
  `agent.false_role_claim_reputation_temporal_association_rate`, and
  `agent.false_role_claim_reputation_temporal_evaluable_exposure_rate`.
- Reputation mutation authority is only `AgentSocialState.journal.entries` with
  `store === "reputation"`, `mutationKind === "reputation.updated"`,
  `hiddenTruthUsed === false`, observer-owned entries, matching `subjectId`,
  scoped message evidence or message sequence range, nonzero reputation deltas,
  and strict ordering after scoped exposure.
- The reputation evaluator is association/coverage only. It does not claim
  causal influence, successful deception, persuasion outcome, reputation damage,
  trust repair, reward impact, or counterfactual influence, and all metrics
  remain `weight: 0`.
- Focused validation for this baseline:
  - `npx tsc --noEmit --pretty false`
  - `npx vitest run tests/evaluation.test.ts -t "belief journal shifts" --reporter=dot`
  - `npx vitest run tests/evaluation.test.ts -t "reputation journal" --reporter=dot`
  - `npx vitest run tests/evaluation.test.ts --reporter=dot`
  - `npx vitest run tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot`
- Full validation for this baseline:
  - `npm test -- --reporter=dot` (`20` files / `130` tests)
  - `npm run build`
  - Secret/stale-wording scan over `AGENTS.md`, `src`, and `tests`; remaining
    hits are test redaction sentinels, local provider header construction, and
    test regexes that forbid causal/success-overclaim wording.

Remaining work:

- Decide explicitly whether and when to wire this evaluator into
  `createWerewolfEvaluationSuite()` and runtime match/tournament artifact
  registries. If wired, update registry and JSONL tests in the same change.
- Add artifact/tournament JSONL assertions for this evaluator once it is part of
  a default or named benchmark suite.
- Add separately named non-causal evaluators for relationship, trust, norm, and
  vote/action temporal association. Broader reputation fulfillment, outcome,
  causal, and counterfactual evaluators remain future contracts.
- Do not promote `evaluation.deception-belief-shift.v1` or
  `evaluation.deception-reputation-association.v1` into reward-bearing
  scorecards until a future metric-promotion decision defines denominators,
  failure policy, uncertainty, and leaderboard semantics.

#### 13.11.5 `society.commitment-coalition.v1`

Capability:

```text
Promote commitments, coalitions, betrayal, norm pressure, sanctions, repairs,
and gossip from heuristic text signals into evidence-backed society records.
```

Acceptance:

- Records are created only from scoped observed messages/events or explicit
  domain metadata.
- Commitments include actor, audience, promised action/stance, deadline/phase,
  evidence, and fulfilled/broken/unknown status.
- Coalitions include members, public/private status, shared target/goal,
  formation evidence, coordination evidence, betrayal evidence, and dissolution
  evidence.
- Evaluators use these records with evidence refs and do not rely on self-report.

Current baseline:

- `src/harness/socialState.ts` now defines first-class evidence-backed
  `CommitmentRecord` / `CommitmentLedger` and `CoalitionRecord` /
  `CoalitionLedger` types.
- The stores are optional on `AgentSocialState` and are lazily created by root
  wrapper APIs. `createAgentSocialState()` still preserves the legacy empty
  serialized shape when no commitment or coalition has been recorded.
- New commitment APIs:
  `createCommitmentLedger`, `ensureCommitmentLedger`, `addCommitment`,
  `addSocialCommitment`, `updateCommitmentStatus`, and
  `updateSocialCommitmentStatus`.
- New coalition APIs:
  `createCoalitionLedger`, `ensureCoalitionLedger`, `addCoalition`,
  `addSocialCoalition`, `recordCoalitionEvidence`, and
  `recordSocialCoalitionEvidence`.
- All low-level and root wrapper writes require evidence refs, clone inputs and
  outputs, use deterministic timestamps, clamp confidence values, and preserve
  `hiddenTruthUsed: false`.
- The social-state mutation journal now supports the stores `commitments` and
  `coalitions`, plus mutation kinds `commitment.added`,
  `commitment.status.updated`, `coalition.added`, and
  `coalition.evidence.recorded`.
- Journal summaries are redacted. They record ids, statuses, confidence,
  member/audience counts, evidence counts, scalar context, and metadata keys;
  they do not copy raw promised-action text, shared-goal text, private memos, or
  hidden truth.
- Actor ingestion now exists for explicit structured social facts that are
  present in an actor's scoped `view.social.messages`.
- The actor ingestion entrypoint is `WerewolfAgentActor.recordVisibleSocialMessages()`.
  It still consumes only the messages already delivered by the observation/bus
  path; it does not read a global transcript and does not use `recipientIds` as
  proof of exposure.
- Structured social facts use existing `SocialMessage.metadata` as the extension
  point. The currently accepted shape is a `socialFacts` array whose entries
  have one of these explicit `kind` values:
  `commitment`, `commitment-status`, `coalition`, or `coalition-evidence`.
- `commitment` facts are accepted only when they provide an explicit
  `promisedAction` or `stance`. They write through `addSocialCommitment()` with
  message evidence, scoped mutation context, `actorId` defaulting to the message
  sender, `audienceIds` defaulting to message recipients, and visibility
  defaulting to the delivered message visibility.
- `commitment-status` facts update an existing observed commitment only when the
  fact names an existing commitment id and a valid `CommitmentStatus`. Missing,
  malformed, or unknown ids are ignored rather than guessed.
- `coalition` facts are accepted only when they provide explicit `memberIds`.
  They write through `addSocialCoalition()` with formation message evidence.
- `coalition-evidence` facts update an existing observed coalition only when the
  fact names an existing coalition id and a valid `CoalitionEvidenceKind`.
  Missing, malformed, or unknown ids are ignored rather than inferred.
- Duplicate structured facts with an already-seen commitment or coalition id do
  not overwrite the existing ledger record during actor ingestion; later
  lifecycle evidence must use the status/evidence fact kinds.
- No free-text parser or natural-language inference was added. The stores are
  populated only by explicit typed APIs, explicit structured message metadata,
  and evidence refs in this baseline.
- `social.state.v1` now emits zero-weight coverage metrics for the explicit
  stores:
  `agent.social.commitment_count`,
  `agent.social.active_commitment_count`,
  `agent.social.fulfilled_commitment_count`,
  `agent.social.broken_commitment_count`,
  `agent.social.evidenced_commitment_rate`,
  `agent.social.coalition_count`,
  `agent.social.active_coalition_count`,
  `agent.social.betrayed_coalition_count`, and
  `agent.social.evidenced_coalition_rate`.
- These metrics are state/evidence coverage metrics only. They do not claim
  causal coalition formation, trust repair, persuasion, betrayal impact,
  deception impact, reward impact, or counterfactual influence, and all remain
  `weight: 0`.
- Existing heuristic `social.dynamics.v1` coalition-signal metrics remain
  separate. They were not silently redefined as proved coalition records.
- Existing artifact schema was not expanded. Commitments/coalitions export
  through existing `agent_state` records and their journal mutations export
  through existing `social_state_mutation` JSONL rows.
- `evaluation.commitment-coalition-association.v1` now exists as a
  deterministic, zero-weight, postgame, artifact-backed evaluator in
  `src/harness/socialEvaluator.ts`.
- The evaluator reports explicit association only when a commitment record and
  coalition record share evidence refs or explicitly link ids through metadata
  (`coalitionId` / `coalitionIds` / `commitmentId` / `commitmentIds`). It does
  not infer association from natural-language similarity, same target, member
  overlap, same vote/action, or transcript proximity.
- The evaluator emits:
  `agent.social.commitment_coalition_association_count`,
  `agent.social.commitment_coalition_association_rate`, and
  `agent.social.commitment_coalition_evaluable_pair_rate`.
- The evaluator metadata marks `associationLevel:
  explicit_evidence_or_metadata_association` and `causalClaim: false`.
- These metrics are association and coverage signals only. They do not claim
  commitment success, coalition effectiveness, causal influence, persuasion,
  trust repair, betrayal impact, reward impact, or counterfactual influence, and
  all remain `weight: 0`.
- The evaluator is included in the normal runtime evaluation registry so match,
  JSONL, and tournament artifacts can carry the same zero-weight evidence. This
  is not a metric-promotion decision and does not affect reward summaries.
- `evaluation.commitment-coalition-lifecycle-temporal-association.v1` now
  exists as a deterministic, zero-weight, postgame, artifact-backed evaluator in
  `src/harness/socialEvaluator.ts`.
- The evaluator uses only ordered redacted `AgentSocialState.journal.entries`
  plus explicit commitment/coalition store denominators. It compares
  `commitment.added` to later `commitment.status.updated`, and
  `coalition.added` to later `coalition.evidence.recorded` entries whose
  `deltaSummary.evidenceKind` is one of `coordination`, `betrayal`, or
  `dissolution`.
- The lifecycle ordering rule is strict:
  `lifecycle.turnIndex > creation.turnIndex`. Same-turn lifecycle records do
  not count as later lifecycle association. Missing creation entries and any
  relevant journal entries without usable `turnIndex` are marked unevaluable,
  not silently counted as success, failure, influence, reward impact, or
  counterfactual evidence.
- The evaluator emits:
  `agent.social.commitment_status_temporal_association_count`,
  `agent.social.commitment_status_temporal_association_rate`,
  `agent.social.commitment_status_temporal_evaluable_record_rate`,
  `agent.social.coalition_lifecycle_temporal_association_count`,
  `agent.social.coalition_lifecycle_temporal_association_rate`, and
  `agent.social.coalition_lifecycle_temporal_evaluable_record_rate`.
- The evaluator metadata marks `associationLevel: temporal_association`,
  `causalClaim: false`, `orderingRule: strict_turnIndex_after_creation`,
  `hiddenTruthUsedInLiveStore: false`, and `postgameTruthUsed: false`.
- These metrics are lifecycle temporal-association and coverage signals only.
  They do not claim commitment fulfilment success, coalition effectiveness,
  causal influence, persuasion, trust repair, betrayal impact, reward impact, or
  counterfactual influence, and all remain `weight: 0`.
- The lifecycle evaluator is included in the normal runtime evaluation registry
  so match, JSONL, and tournament artifacts can carry the same zero-weight
  evidence. This is not a metric-promotion decision and does not affect reward
  summaries.
- Focused tests prove:
  - new store APIs require evidence and clone returned records;
  - root wrappers produce ordered redacted journal entries;
  - same journal invariant still redacts raw private text;
  - actor ingestion creates commitment/coalition ledger records only from
    explicit structured metadata in scoped visible messages;
  - actor ingestion ignores natural-language-only commitment/coalition wording;
  - actor ingestion does not create records for messages outside the scoped
    observation;
  - `social.state.v1` reads explicit commitment/coalition stores and leaves
    weighted agent scores empty;
  - `evaluation.commitment-coalition-association.v1` counts only shared
    evidence or explicit metadata links and leaves weighted agent scores empty;
  - `evaluation.commitment-coalition-lifecycle-temporal-association.v1`
    compares `commitment.added` to later `commitment.status.updated` and
    `coalition.added` to later whitelisted `coalition.evidence.recorded` using
    ordered journal evidence;
  - same-turn lifecycle records are not overcounted, missing creation records
    and ambiguous ordering are marked unevaluable, and later `formation`-only
    coalition evidence is not treated as lifecycle association;
  - lifecycle metrics remain zero-weight and do not claim fulfilment success,
    coalition effectiveness, causality, reward impact, or counterfactual
    influence;
  - runtime, match artifact, and tournament registry tests preserve the new
    evaluator manifest without adding new artifact types;
  - JSONL export preserves the stores through `agent_state` and mutation rows
    through `social_state_mutation` without adding a new record type.
- Focused validation for this baseline:
  - `npx tsc --noEmit --pretty false`
  - `npx vitest run tests/evaluation.test.ts -t "commitment-coalition associations" --reporter=dot`
  - `npx vitest run tests/evaluation.test.ts -t "lifecycle temporal" --reporter=dot`
  - `npx vitest run tests/evaluation.test.ts --reporter=dot`
  - `npx vitest run tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot`
  - `npx vitest run tests/socialState.test.ts tests/evaluation.test.ts --reporter=dot`
  - `npx vitest run tests/socialState.test.ts tests/evaluation.test.ts tests/artifacts.test.ts --reporter=dot`
  - `npx vitest run tests/tournamentArtifacts.test.ts --reporter=dot`
  - `npx vitest run tests/actorSocialClaims.test.ts --reporter=dot`
  - `npx vitest run tests/actorSocialClaims.test.ts tests/socialState.test.ts tests/evaluation.test.ts tests/artifacts.test.ts --reporter=dot`
- Full validation for this baseline:
  - `npm test -- --reporter=dot` (`20` files / `129` tests)
  - `npm run build`
  - Secret/overclaim scan over `AGENTS.md`, `src`, and `tests`; remaining hits
    are test redaction sentinels, local provider header construction, and test
    regexes that forbid causal/success-overclaim wording.
- Live streaming validation after this baseline, requested by the user:
  - `npm run agent:probe -- --models=kimi-k2.7 --timeout=90s` completed with a
    real streamed harness turn.
  - `npm run agent:probe -- --models=deepseek-v4-flash --timeout=120s`
    completed with a real streamed harness turn.
  - `npm run agent:probe -- --models=minimax-m3 --timeout=120s` completed with
    a real streamed harness turn.

Remaining work:

- Add commitment fulfilment/breakage evaluators that compare commitments to
  later committed actions/outcomes without claiming causality.
- Betrayal-specific society records are now tracked separately under
  `society.betrayal.v1`; remaining broader coalition lifecycle work is
  coordination, dissolution, and repair contracts, plus any future betrayal
  registry-promotion or causal/outcome variants only after explicit metric
  semantics are defined.
- Add trust-repair relationship/reputation association evaluators only as
  separate contracts after their non-causal metric and evidence semantics are
  defined.

#### 13.11.5a `society.gossip-norm-sanction.v1`

Capability:

```text
Promote gossip and norm sanctions into evidence-backed society records without
turning them into free-text guesses, reward claims, or causal influence claims.
```

Acceptance:

- Records are created only from scoped observed messages/events or explicit
  structured domain metadata.
- Gossip records include speaker, subject, audience, visibility, optional topic,
  optional claim, source id, valence, confidence, and evidence refs.
- Norm sanctions include norm id, actor, target, audience, visibility, sanction
  kind, lifecycle status, optional reason/repair request, confidence, and
  evidence refs.
- Actor ingestion ignores natural-language-only gossip/sanction wording unless
  explicit structured metadata is present in the actor's scoped visible
  messages.
- Journal summaries redact raw gossip claims, sanction reasons, repair text,
  private memos, and hidden truth.
- Metrics are coverage/evidence metrics only. They do not claim gossip truth,
  reputation damage, sanction outcome effects, compliance cause claims, reward
  impact, or counterfactual influence.

Current baseline:

- `src/harness/socialState.ts` now defines first-class evidence-backed
  `GossipRecord` / `GossipLedger` and `NormSanctionRecord` /
  `NormSanctionLedger` types.
- The stores are optional on `AgentSocialState` and are lazily created by root
  wrapper APIs. `createAgentSocialState()` still preserves the legacy empty
  serialized shape when no gossip or norm sanction has been recorded.
- New gossip APIs:
  `createGossipLedger`, `ensureGossipLedger`, `addGossip`, and
  `addSocialGossip`.
- New norm-sanction APIs:
  `createNormSanctionLedger`, `ensureNormSanctionLedger`,
  `addNormSanction`, `addSocialNormSanction`,
  `updateNormSanctionStatus`, and `updateSocialNormSanctionStatus`.
- All low-level and root wrapper writes require evidence refs, clone inputs and
  outputs, use deterministic timestamps, clamp confidence values, and preserve
  `hiddenTruthUsed: false`.
- The social-state mutation journal now supports stores `gossip` and
  `normSanctions`, plus mutation kinds `gossip.added`,
  `norm_sanction.added`, and `norm_sanction.status.updated`.
- Journal summaries are redacted. Gossip summaries preserve ids, speaker,
  subject, audience count, visibility, topic/claim presence and lengths, source
  id, valence, confidence, evidence counts, and metadata keys. Norm-sanction
  summaries preserve ids, norm id, actor, target, audience count, visibility,
  kind, status, reason/repair presence and lengths, confidence, evidence counts,
  and metadata keys. They do not copy raw claims, sanction reasons, repair text,
  private memos, or hidden truth into journal summaries.
- Actor ingestion uses the existing `SocialMessage.metadata.socialFacts`
  extension point in `WerewolfAgentActor.recordVisibleSocialMessages()`. The new
  accepted fact kinds are `gossip`, `norm`, `norm-status`, `norm-sanction`, and
  `norm-sanction-status`.
- `gossip` facts are accepted only when they provide `subjectId` and at least
  one of `claim` or `topic`. They write through `addSocialGossip()` with message
  evidence, scoped mutation context, speaker defaulting to the message sender,
  audience defaulting to message recipients, and visibility defaulting to the
  delivered message visibility.
- `norm` facts are accepted only when they provide a valid `normKind` and
  explicit `expectedBehavior`. They write through `addSocialNorm()` and may
  include `sanction`, `condition`, `scope`, `source`, confidence, and status.
- `norm-status` facts update an existing observed norm only when the fact names
  an existing norm id and a valid `NormStatus`.
- `norm-sanction` facts are accepted only when they provide explicit `normId`,
  `targetId`, and valid `sanctionKind`. They write through
  `addSocialNormSanction()` with message evidence.
- `norm-sanction-status` facts update an existing observed norm sanction only
  when the fact names an existing sanction id and a valid
  `NormSanctionStatus`.
- Duplicate structured facts with an already-seen gossip or sanction id do not
  overwrite existing records during actor ingestion; later lifecycle evidence
  must use the status fact kind.
- No free-text parser or natural-language inference was added. The stores are
  populated only by explicit typed APIs, explicit structured message metadata,
  and evidence refs in this baseline.
- `social.state.v1` now emits zero-weight coverage metrics for the explicit
  stores:
  `agent.social.gossip_count`,
  `agent.social.evidenced_gossip_rate`,
  `agent.social.norm_sanction_count`,
  `agent.social.applied_norm_sanction_count`, and
  `agent.social.evidenced_norm_sanction_rate`.
- The social-state journal store coverage denominator is now `11`, reflecting
  the existing stores: memory, beliefs, relationships, reputation, norms, goals,
  commitments, coalitions, gossip, normSanctions, and plan.
- Existing artifact schema was not expanded. Gossip and norm sanctions export
  through existing `agent_state` records and their journal mutations export
  through existing `social_state_mutation` JSONL rows.
- Server/API and React were not changed for this slice. The new records are
  postgame/debug artifact data unless a future API/UI slice defines a safe
  actor-scoped or public DTO.
- This store baseline itself did not wire specialized gossip/norm-sanction
  temporal evaluators into the normal runtime registry. Later standalone
  baselines audit `evaluation.gossip-exposure-temporal-association.v1` for
  explicit gossip exposure temporal association and
  `evaluation.norm-sanction-lifecycle-temporal-association.v1` for explicit norm
  and norm-sanction lifecycle journal evidence without changing reward,
  leaderboard, runtime registry, or tournament registry semantics.
- Focused tests prove:
  - new store APIs require evidence and clone returned records;
  - root wrappers produce ordered redacted journal entries;
  - actor ingestion creates gossip, norm, and norm-sanction records only from
    explicit structured metadata in scoped visible messages;
  - actor ingestion ignores natural-language-only gossip/norm/sanction wording;
  - actor ingestion does not create records for messages outside the scoped
    observation;
  - `social.state.v1` reads explicit gossip and norm-sanction stores and leaves
    weighted agent scores empty;
  - JSONL export preserves the stores through `agent_state` and mutation rows
    through `social_state_mutation` without adding a new record type;
  - coverage metrics and journal summaries do not claim causality, deception
    success, sanction outcome effects, reward impact, or counterfactual influence.
- Focused validation for this baseline:
  - `npx tsc --noEmit --pretty false`
  - `npx vitest run tests/socialState.test.ts tests/actorSocialClaims.test.ts --reporter=dot`
  - `npx vitest run tests/evaluation.test.ts -t "social-state" --reporter=dot`
  - `npx vitest run tests/artifacts.test.ts -t "society stores" --reporter=dot`
  - `npx vitest run tests/socialState.test.ts tests/actorSocialClaims.test.ts tests/evaluation.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot`
- Full validation for this baseline:
  - `npm test -- --reporter=dot` (`20` files / `133` tests)
  - `npm run build`
  - Secret/overclaim scan over `AGENTS.md`, `src`, and `tests`; remaining hits
    are test redaction sentinels and test regexes that forbid
    causal/success-overclaim wording.

Remaining work:

- Keep `evaluation.gossip-exposure-temporal-association.v1` as a standalone
  zero-weight temporal-association evaluator over explicit gossip records and
  scoped exposure evidence unless an explicit registry-wiring and metric
  promotion decision changes runtime, artifact, tournament, and leaderboard
  semantics.
- Decide explicitly whether and when to wire
  `evaluation.norm-sanction-lifecycle-temporal-association.v1` into the normal
  runtime registry. If wired, update match artifact, JSONL, tournament registry,
  and metric evidence tests in the same change.
- Decide explicitly whether gossip or sanction evidence should affect
  relationship/reputation/policy arbitration; do not infer deltas from free text.
- Trust-repair relationship/reputation temporal-association evaluators now
  exist as separate zero-weight, non-causal contracts. They observe later
  explicit relationship/reputation journal mutations for the repair actor; they
  do not mutate relationship/reputation stores or claim repair causality.

#### 13.11.5b `evaluation.norm-sanction-lifecycle-temporal-association.v1`

Capability:

```text
Audit whether explicit norm and norm-sanction records have later ordered
lifecycle status updates in the redacted social-state mutation journal, using
artifact evidence and explicit non-causal metric language.
```

Owner plane:

```text
evaluation + society + artifact evidence
```

Owner modules:

```text
src/harness/socialEvaluator.ts
src/harness/socialState.ts
tests/evaluation.test.ts
tests/artifacts.test.ts
```

Current baseline:

- `src/harness/socialEvaluator.ts` exposes the standalone deterministic
  evaluator id
  `evaluation.norm-sanction-lifecycle-temporal-association.v1`.
- It is standalone and is not wired into the normal Werewolf runtime evaluator
  registry, `createWerewolfEvaluationSuite()`, default match artifact registry,
  tournament registry, reward summaries, or leaderboards.
- The evaluator consumes only explicit `AgentSocialState.journal.entries` plus
  explicit `AgentSocialState.norms` and `AgentSocialState.normSanctions` stores
  for denominators.
- It compares `norm.added` to later `norm.status.updated`, and
  `norm_sanction.added` to later `norm_sanction.status.updated`.
- The ordering rule is strict:
  `statusUpdate.turnIndex > creation.turnIndex`. Same-turn updates do not count
  as later lifecycle association.
- Missing creation entries, missing relevant `turnIndex`, or ambiguous ordering
  are marked unevaluable. They are not silently counted as no effect, success,
  failure, compliance, reward impact, sanction effect, or counterfactual
  evidence.
- The evaluator does not infer lifecycle from natural language, transcript
  proximity, shared targets, speaker identity, global messages, `recipientIds`,
  final outcomes, or model self-report.
- Metric metadata records `associationLevel: temporal_association`,
  `causalClaim: false`, `orderingRule: strict_turnIndex_after_creation`,
  `hiddenTruthUsedInLiveStore: false`, and `postgameTruthUsed: false`.
- Existing artifact schema was not expanded. Norm and norm-sanction records
  export through existing `agent_state` records, and their journal mutations
  export through existing `social_state_mutation` JSONL rows.
- `tests/artifacts.test.ts` now covers `norm.added` and
  `norm.status.updated` export through the existing society-store artifact
  round trip, including redaction of raw expected-behavior text.

Metrics:

```text
agent.social.norm_status_temporal_association_count
agent.social.norm_status_temporal_association_rate
agent.social.norm_status_temporal_evaluable_record_rate
agent.social.norm_sanction_status_temporal_association_count
agent.social.norm_sanction_status_temporal_association_rate
agent.social.norm_sanction_status_temporal_evaluable_record_rate
```

These metrics are lifecycle temporal-association and coverage signals only.
They do not claim norm truth, sanction legitimacy, sanction outcome success,
compliance causation, reputation damage, trust repair, persuasion, reward
impact, leaderboard value, causal influence, or counterfactual influence, and
all remain `weight: 0`.

Focused tests prove:

- ordered norm and norm-sanction lifecycle updates count only when a later
  status-update journal entry exists;
- same-turn lifecycle records are evaluable but not associated;
- missing creation records and missing relevant `turnIndex` are marked
  unevaluable;
- metric ids, manifest metadata, evidence refs, denominators, confidence,
  `weight: 0`, and non-causal metadata are asserted;
- output wording is guarded against causal, success, reward, and sanction-effect
  overclaims;
- artifact JSONL exports both `norms` store state and `norm.added` /
  `norm.status.updated` mutation rows without leaking raw norm text.
- the normal runtime evaluation report and match artifact do not include this
  standalone evaluator id or metric ids unless a future explicit registry-wiring
  change adds them with artifact/tournament test updates.

Focused validation for this baseline:

- `npx tsc --noEmit --pretty false`
- `npx vitest run tests/evaluation.test.ts -t "norm and norm-sanction lifecycle" --reporter=dot`
- `npx vitest run tests/evaluation.test.ts -t "emits evaluator metrics through runtime and match artifacts" --reporter=dot`
- `npx vitest run tests/artifacts.test.ts -t "society stores" --reporter=dot`
- `npx vitest run tests/evaluation.test.ts --reporter=dot`
- `npx vitest run tests/artifacts.test.ts --reporter=dot`
- `npx vitest run tests/tournamentArtifacts.test.ts --reporter=dot`
- `npm test -- --reporter=dot` (`20` files / `134` tests)
- `npm run build`
- Secret/overclaim scan over `AGENTS.md`, `src`, and `tests`; remaining secret
  pattern hits are test bearer-token redaction sentinels, and remaining
  overclaim-word hits are test regexes that forbid causal/success-overclaim
  wording.

Remaining work:

- Decide explicitly whether and when to wire this evaluator into the normal
  runtime registry. If wired, update runtime evaluation, match artifact JSONL,
  tournament registry, and metric-evidence tests in the same change.
- Keep `evaluation.gossip-exposure-temporal-association.v1` as a separate
  standalone zero-weight evaluator unless an explicit registry-wiring and metric
  promotion decision updates runtime, artifact, tournament, and leaderboard
  semantics.
- Do not promote these metrics into reward-bearing scorecards or benchmark
  leaderboards without a separate metric-promotion decision covering
  denominator policy, uncertainty, failure handling, and benchmark semantics.

#### 13.11.5c `evaluation.gossip-exposure-temporal-association.v1`

Capability:

```text
Audit whether explicit evidence-backed gossip records have earlier scoped
message exposure evidence before the `gossip.added` journal entry, using
artifact evidence and explicit non-causal metric language.
```

Owner plane:

```text
evaluation + society + observation/exposure + artifact evidence
```

Owner modules:

```text
src/harness/socialEvaluator.ts
src/harness/socialState.ts
src/harness/social.ts
tests/evaluation.test.ts
```

Current baseline:

- `src/harness/socialEvaluator.ts` exposes the standalone deterministic
  evaluator id `evaluation.gossip-exposure-temporal-association.v1`.
- It is standalone and is not wired into the normal Werewolf runtime evaluator
  registry, `createWerewolfEvaluationSuite()`, default match artifact registry,
  tournament registry, reward summaries, or leaderboards.
- The evaluator consumes only explicit `AgentSocialState.gossip.records`,
  redacted `AgentSocialState.journal.entries` with `gossip.added`, and scoped
  `SocialExposureRecord` evidence from `deriveSocialExposureRecords()`.
- The denominator for association-rate metrics is the set of gossip records with
  explicit message evidence, a `gossip.added` journal entry, at least one
  matching scoped exposure record for the same observer, and unambiguous
  `turnIndex` ordering.
- The ordering rule is strict:
  `gossip.added.turnIndex > exposure.observedAtTurnIndex`. Same-turn ingestion
  is evaluable but not associated.
- Missing gossip creation entries, missing message evidence, missing scoped
  exposure records, missing relevant `turnIndex`, or ambiguous ordering are
  marked unevaluable for the association denominator.
- The evaluator does not infer exposure, awareness, belief shift, persuasion,
  reputation damage, gossip truth, relationship change, reward impact, or causal
  influence from natural language, transcript proximity, final outcomes, global
  messages, `recipientIds`, public visibility, or model self-report.
- Metric metadata records `associationLevel: temporal_association`,
  `causalClaim: false`,
  `orderingRule: strict_gossip_added_turnIndex_after_scoped_exposure`,
  `hiddenTruthUsedInLiveStore: false`, and `postgameTruthUsed: false`.
- Existing artifact schema was not expanded. Gossip records export through
  existing `agent_state` records and their journal mutations export through
  existing `social_state_mutation` JSONL rows.

Metrics:

```text
agent.social.gossip_exposure_temporal_association_count
agent.social.gossip_exposure_temporal_association_rate
agent.social.gossip_exposure_temporal_evaluable_record_rate
```

These metrics are gossip exposure temporal-association and coverage signals
only. They do not claim gossip truth, awareness, persuasion, belief change,
reputation damage, relationship change, reward impact, leaderboard value,
deception success, causal influence, or counterfactual influence, and all remain
`weight: 0`.

Focused tests prove:

- ordered gossip exposure associations count only when scoped exposure evidence
  appears before the `gossip.added` journal entry;
- same-turn ingestion and creation-before-exposure records are evaluable but
  not associated;
- missing creation records, missing message evidence, missing scoped exposure
  records, and missing relevant `turnIndex` are marked unevaluable;
- metric ids, manifest metadata, evidence refs, denominators, confidence,
  `weight: 0`, and non-causal metadata are asserted;
- a committed public message absent from the evaluated agent's scoped
  observation does not count as exposure;
- the normal runtime evaluation report and match artifact do not include this
  standalone evaluator id or metric ids unless a future explicit
  registry-wiring change adds them with artifact/tournament test updates.

Focused validation for this baseline:

- `npx tsc --noEmit --pretty false --noErrorTruncation`
- `npx vitest run tests/evaluation.test.ts -t "gossip-exposure" --reporter=dot`
- `npx vitest run tests/evaluation.test.ts -t "emits evaluator metrics through runtime and match artifacts" --reporter=dot`
- `npx vitest run tests/evaluation.test.ts -t "norm and norm-sanction lifecycle" --reporter=dot`
- `npx vitest run tests/evaluation.test.ts --reporter=dot`
- `npx vitest run tests/artifacts.test.ts --reporter=dot`
- `npx vitest run tests/tournamentArtifacts.test.ts --reporter=dot`
- `npm test -- --reporter=dot` (`20` files / `135` tests)
- `npm run build`

Remaining work:

- Decide explicitly whether and when to wire this evaluator into the normal
  runtime registry. If wired, update runtime evaluation, match artifact JSONL,
  tournament registry, and metric-evidence tests in the same change.
- Do not promote these metrics into reward-bearing scorecards or benchmark
  leaderboards without a separate metric-promotion decision covering denominator
  policy, uncertainty, failure handling, and benchmark semantics.

#### 13.11.5d `society.trust-repair.v1`

Capability:

```text
Promote trust-repair attempts and lifecycle status into evidence-backed society
records, plus standalone zero-weight lifecycle, relationship, and reputation
temporal-association evaluators, without inferring relationship recovery,
reputation recovery, persuasion, reward impact, leaderboard value, or
counterfactual influence.
```

Owner plane:

```text
society + agent ingestion + evaluation + artifact evidence
```

Owner modules:

```text
src/harness/socialState.ts
src/harness/actor.ts
src/harness/socialEvaluator.ts
tests/socialState.test.ts
tests/actorSocialClaims.test.ts
tests/evaluation.test.ts
tests/artifacts.test.ts
```

Current baseline:

- `src/harness/socialState.ts` now defines first-class evidence-backed
  `TrustRepairRecord` / `TrustRepairLedger` types.
- The store is optional on `AgentSocialState` and lazily created by
  `ensureTrustRepairLedger()`. `createAgentSocialState()` still preserves the
  empty serialized shape when no trust-repair record has been written.
- New trust-repair APIs:
  `createTrustRepairLedger`, `ensureTrustRepairLedger`, `addTrustRepair`,
  `addSocialTrustRepair`, `updateTrustRepairStatus`, and
  `updateSocialTrustRepairStatus`.
- Trust-repair records include actor, target, audience, visibility, repair
  kind, lifecycle status, optional trigger/related-record ids, optional
  request/reason/offered-repair fields, confidence, evidence refs, timestamps,
  and metadata.
- All low-level and root-wrapper writes require evidence refs, clone inputs and
  outputs, use deterministic timestamps, clamp confidence values, and preserve
  `hiddenTruthUsed: false`.
- The social-state mutation journal now supports store `trustRepairs` plus
  mutation kinds `trust_repair.added` and
  `trust_repair.status.updated`.
- Journal summaries are redacted. They preserve structural ids, actor/target,
  audience count, visibility, kind, status, related ids, text presence and
  lengths, confidence, evidence counts, and metadata keys. They do not copy raw
  reason, requested-repair, offered-repair, private memo, hidden truth, provider
  payload, or secret text into journal summaries.
- Actor ingestion uses the existing `SocialMessage.metadata.socialFacts`
  extension point in `WerewolfAgentActor.recordVisibleSocialMessages()`. The
  accepted fact kinds are `trust-repair` and `trust-repair-status`.
- `trust-repair` facts are accepted only when they provide explicit `targetId`
  and valid `repairKind`. They write through `addSocialTrustRepair()` with
  message evidence, scoped mutation context, actor defaulting to message sender,
  audience defaulting to delivered message recipients, and visibility
  defaulting to delivered message visibility.
- `trust-repair-status` facts update an existing observed trust-repair record
  only when the fact names an existing repair id and a valid
  `TrustRepairStatus`.
- Duplicate structured facts with an already-seen trust-repair id do not
  overwrite existing records during actor ingestion; later lifecycle evidence
  must use the status fact kind.
- No free-text parser or natural-language inference was added. Natural-language
  apologies, explanations, or repair wording do not mutate stores unless the
  message includes explicit structured `socialFacts` and is in the actor's
  scoped visible observation.
- Trust-repair writes do **not** automatically mutate relationship trust,
  suspicion, reputation, goals, rewards, or policy state. The relationship and
  reputation evaluators observe later explicit journal mutations; they do not
  cause, authorize, validate, or infer those mutations.
- `social.state.v1` now emits zero-weight coverage metrics for the explicit
  trust-repair store:
  `agent.social.trust_repair_count`,
  `agent.social.accepted_trust_repair_count`, and
  `agent.social.evidenced_trust_repair_rate`.
- The social-state journal store coverage denominator is now `12`, reflecting
  the existing journal stores: memory, beliefs, relationships, reputation,
  norms, goals, commitments, coalitions, gossip, normSanctions, trustRepairs,
  and plan.
- Existing artifact schema was not expanded. Trust-repair records export
  through existing `agent_state` records and their journal mutations export
  through existing `social_state_mutation` JSONL rows.
- `src/harness/socialEvaluator.ts` exposes the standalone deterministic
  evaluator id
  `evaluation.trust-repair-lifecycle-temporal-association.v1`.
- `src/harness/socialEvaluator.ts` also exposes standalone deterministic
  evaluator ids
  `evaluation.trust-repair-relationship-temporal-association.v1` and
  `evaluation.trust-repair-reputation-temporal-association.v1`.
- The evaluator consumes only explicit `AgentSocialState.trustRepairs` records
  plus ordered redacted `AgentSocialState.journal.entries`.
- It compares explicit `trust_repair.added` to later
  `trust_repair.status.updated` journal entries with strict ordering:
  `statusUpdate.turnIndex > creation.turnIndex`.
- Same-turn status updates are evaluable but not later-associated. Missing
  creation entries or missing relevant `turnIndex` values are unevaluable, not
  counted as completed repair outcome, failure, relationship recovery,
  reputation recovery, persuasion, reward impact, or causal effect.
- The relationship evaluator compares explicit `trust_repair.added` records to
  later `relationship.updated` journal entries where `subjectId` matches the
  repair `actorId`, using strict ordering:
  `relationshipUpdate.turnIndex > creation.turnIndex`.
- The reputation evaluator compares explicit `trust_repair.added` records to
  later `reputation.updated` journal entries where `subjectId` matches the
  repair `actorId`, using strict ordering:
  `reputationUpdate.turnIndex > creation.turnIndex`.
- Same-turn relationship/reputation updates are evaluable but not
  later-associated. Missing creation entries, missing relevant `turnIndex`
  values, mismatched subjects, or ambiguous ordering are unevaluable or
  non-associated diagnostics, not counted as repair outcome, relationship
  recovery, reputation recovery, persuasion, reward impact, or causal effect.
- These evaluators are standalone and are not wired into the normal Werewolf
  runtime evaluator registry, `createWerewolfEvaluationSuite()`, default match
  artifact registry, tournament registry, reward summaries, leaderboards, or
  `evaluationReport.summary.agentScores`.
- Server/API and React were not changed for this slice. The new records remain
  postgame/debug artifact data unless a future API/UI slice defines a safe
  actor-scoped or public DTO.

Metrics:

```text
agent.social.trust_repair_count
agent.social.accepted_trust_repair_count
agent.social.evidenced_trust_repair_rate
agent.social.trust_repair_status_temporal_association_count
agent.social.trust_repair_status_temporal_association_rate
agent.social.trust_repair_status_temporal_evaluable_record_rate
agent.social.trust_repair_relationship_temporal_association_count
agent.social.trust_repair_relationship_temporal_association_rate
agent.social.trust_repair_relationship_temporal_evaluable_record_rate
agent.social.trust_repair_reputation_temporal_association_count
agent.social.trust_repair_reputation_temporal_association_rate
agent.social.trust_repair_reputation_temporal_evaluable_record_rate
```

These metrics are coverage and temporal-association signals only. They do not
claim completed repair outcome, repair effectiveness, relationship recovery,
reputation recovery, persuasion, reward impact, leaderboard value, causal
influence, or counterfactual influence, and all remain `weight: 0`.

Focused tests prove:

- trust-repair store APIs require evidence refs, clone returned records, clamp
  confidence, dedupe/sort audiences, and merge evidence on status updates;
- root wrappers produce ordered redacted journal entries for
  `trust_repair.added` and `trust_repair.status.updated`;
- actor ingestion creates trust-repair records only from explicit structured
  metadata in scoped visible messages;
- actor ingestion ignores natural-language-only repair wording, hidden
  structured messages outside the scoped observation, malformed repair facts,
  unknown status ids, and invalid statuses;
- actor ingestion adds `social:trust-repair` tags only for structured
  trust-repair facts;
- `social.state.v1` reads explicit trust-repair stores, updates journal store
  coverage denominator to `12`, and leaves weighted agent scores empty;
- `evaluation.trust-repair-lifecycle-temporal-association.v1` counts ordered
  later lifecycle status updates, treats same-turn updates as not
  later-associated, and marks missing creation or ambiguous ordering as
  unevaluable;
- `evaluation.trust-repair-relationship-temporal-association.v1` counts only
  ordered later `relationship.updated` journal entries for the repair actor,
  treats same-turn updates as not later-associated, marks missing creation or
  ambiguous ordering as unevaluable, and keeps wrong-subject mutations out of
  associated evidence;
- `evaluation.trust-repair-reputation-temporal-association.v1` counts only
  ordered later `reputation.updated` journal entries for the repair actor,
  treats same-turn updates as not later-associated, marks missing creation or
  ambiguous ordering as unevaluable, and keeps wrong-subject mutations out of
  associated evidence;
- the normal runtime evaluation report and match artifact do not include the
  standalone trust-repair lifecycle, relationship, or reputation evaluator ids
  or metric ids unless a future explicit registry-wiring change adds them with
  artifact/tournament tests;
- JSONL export preserves trust-repair state through `agent_state` and mutation
  rows through `social_state_mutation` without adding a new record type;
- coverage metrics and journal summaries do not claim causality, completed
  repair outcome, reward impact, relationship recovery, reputation recovery, or
  counterfactual influence.

Focused validation for this baseline:

- `npx tsc --noEmit --pretty false --noErrorTruncation`
- `npx vitest run tests/socialState.test.ts -t "trust" --reporter=dot`
- `npx vitest run tests/actorSocialClaims.test.ts -t "trust" --reporter=dot`
- `npx vitest run tests/evaluation.test.ts -t "trust" --reporter=dot`
- `npx vitest run tests/evaluation.test.ts -t "trust-repair" --reporter=dot`
- `npx vitest run tests/evaluation.test.ts -t "emits evaluator metrics through runtime and match artifacts" --reporter=dot`
- `npx vitest run tests/evaluation.test.ts --reporter=dot`
- `npx vitest run tests/artifacts.test.ts -t "society stores" --reporter=dot`
- `npx vitest run tests/socialState.test.ts tests/actorSocialClaims.test.ts tests/evaluation.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot`
- `npx vitest run tests/evaluation.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot`

Full validation for this baseline:

- `npm test -- --reporter=dot` (`20` files / `147` tests)
- `npm run build`
- Secret/overclaim scan over `AGENTS.md`, `src`, and `tests`; remaining hits
  are documentation policy mentions, redaction sentinels, local provider header
  construction, manifest rubrics that deny overclaims, and test regexes that
  forbid causal/success-overclaim wording.

Remaining work:

- Decide explicitly whether and when to wire this evaluator into a normal
  runtime or tournament registry. If wired, update runtime evaluation, match
  artifact JSONL, tournament registry, and metric-evidence tests in the same
  change.
- Relationship/reputation temporal-association evaluators are now implemented
  as standalone contracts. Decide explicitly whether and when to wire any of
  the trust-repair temporal-association evaluators into a normal runtime or
  tournament registry; if wired, update runtime evaluation, match artifact
  JSONL, tournament registry, and metric-evidence tests in the same change.
- Do not promote these metrics into reward-bearing scorecards or benchmark
  leaderboards without a separate metric-promotion decision covering
  denominator policy, uncertainty, failure handling, and benchmark semantics.

#### 13.11.5e `evaluation.trust-repair-relationship-temporal-association.v1`

Capability:

```text
Audit whether explicit trust-repair attempts are temporally followed by
relationship journal updates for the repair actor, without claiming repaired
trust, repair effectiveness, persuasion, reward impact, causal influence, or
counterfactual influence.
```

Owner plane:

```text
evaluation + artifact evidence
```

Owner modules:

```text
src/harness/socialEvaluator.ts
tests/evaluation.test.ts
```

Contract:

- Evaluator id:
  `evaluation.trust-repair-relationship-temporal-association.v1`.
- Metric ids:
  `agent.social.trust_repair_relationship_temporal_association_count`,
  `agent.social.trust_repair_relationship_temporal_association_rate`, and
  `agent.social.trust_repair_relationship_temporal_evaluable_record_rate`.
- Input source:
  explicit `AgentSocialState.trustRepairs.records` plus ordered redacted
  `AgentSocialState.journal.entries`.
- Creation evidence:
  `store === "trustRepairs"`, `mutationKind === "trust_repair.added"`,
  `subjectId === trustRepair.id`, and `hiddenTruthUsed === false`.
- Downstream mutation evidence:
  `store === "relationships"`, `mutationKind === "relationship.updated"`,
  `subjectId === trustRepair.actorId`, nonzero relationship delta dimensions,
  and `hiddenTruthUsed === false`.
- Subject matching rule:
  `repair_actor_id`. The evaluator measures later updates by the observing
  agent toward the repair actor, not the target's private acceptance and not a
  global relationship outcome.
- Ordering rule:
  strict `mutation.turnIndex > trust_repair.added.turnIndex`.
- Same-turn relationship updates are evaluable but not later-associated.
- Missing creation entries, missing relevant `turnIndex`, wrong-subject
  updates, or ambiguous ordering are not counted as associated repair effects.
- Manifest metadata marks `associationLevel: temporal_association`,
  `causalClaim: false`, `hiddenTruthUsedInLiveStore: false`, and
  `postgameTruthUsed: false`.
- Metrics are `weight: 0` and do not affect
  `evaluationReport.summary.agentScores`.
- The evaluator is standalone and is not wired into the normal Werewolf runtime
  evaluator registry, default match artifact registry, tournament registry,
  reward summaries, leaderboards, or React live/public views.

Focused tests prove:

- the evaluator emits exactly its three metric ids with evaluator version
  `1.0.0`, source/evaluator id matching the standalone evaluator, and
  `weight: 0`;
- ordered later `relationship.updated` journal mutations for the repair actor
  are counted as temporal associations;
- same-turn relationship updates are not later-associated;
- missing `trust_repair.added` creation evidence and missing mutation
  `turnIndex` are unevaluable;
- wrong-subject relationship updates are not associated and do not appear in
  associated evidence refs;
- metadata records the `repair_actor_id` subject rule, relationship dimension
  whitelist, strict ordering rule, non-causal status, and sample associated
  records;
- the normal runtime evaluation report and match artifact do not include this
  evaluator id or metric ids.

#### 13.11.5f `evaluation.trust-repair-reputation-temporal-association.v1`

Capability:

```text
Audit whether explicit trust-repair attempts are temporally followed by
reputation journal updates for the repair actor, without claiming reputation
recovery, repair effectiveness, persuasion, reward impact, causal influence, or
counterfactual influence.
```

Owner plane:

```text
evaluation + artifact evidence
```

Owner modules:

```text
src/harness/socialEvaluator.ts
tests/evaluation.test.ts
```

Contract:

- Evaluator id:
  `evaluation.trust-repair-reputation-temporal-association.v1`.
- Metric ids:
  `agent.social.trust_repair_reputation_temporal_association_count`,
  `agent.social.trust_repair_reputation_temporal_association_rate`, and
  `agent.social.trust_repair_reputation_temporal_evaluable_record_rate`.
- Input source:
  explicit `AgentSocialState.trustRepairs.records` plus ordered redacted
  `AgentSocialState.journal.entries`.
- Creation evidence:
  `store === "trustRepairs"`, `mutationKind === "trust_repair.added"`,
  `subjectId === trustRepair.id`, and `hiddenTruthUsed === false`.
- Downstream mutation evidence:
  `store === "reputation"`, `mutationKind === "reputation.updated"`,
  `subjectId === trustRepair.actorId`, nonzero reputation delta dimensions,
  and `hiddenTruthUsed === false`.
- Subject matching rule:
  `repair_actor_id`. The evaluator measures later updates by the observing
  agent toward the repair actor, not global reputation recovery.
- Ordering rule:
  strict `mutation.turnIndex > trust_repair.added.turnIndex`.
- Same-turn reputation updates are evaluable but not later-associated.
- Missing creation entries, missing relevant `turnIndex`, wrong-subject
  updates, or ambiguous ordering are not counted as associated repair effects.
- Manifest metadata marks `associationLevel: temporal_association`,
  `causalClaim: false`, `hiddenTruthUsedInLiveStore: false`, and
  `postgameTruthUsed: false`.
- Metrics are `weight: 0` and do not affect
  `evaluationReport.summary.agentScores`.
- The evaluator is standalone and is not wired into the normal Werewolf runtime
  evaluator registry, default match artifact registry, tournament registry,
  reward summaries, leaderboards, or React live/public views.

Focused tests prove:

- the evaluator emits exactly its three metric ids with evaluator version
  `1.0.0`, source/evaluator id matching the standalone evaluator, and
  `weight: 0`;
- ordered later `reputation.updated` journal mutations for the repair actor
  are counted as temporal associations;
- same-turn reputation updates are not later-associated;
- missing `trust_repair.added` creation evidence and missing mutation
  `turnIndex` are unevaluable;
- wrong-subject reputation updates are not associated and do not appear in
  associated evidence refs;
- metadata records the `repair_actor_id` subject rule, reputation dimension
  whitelist, strict ordering rule, non-causal status, and sample associated
  records;
- the normal runtime evaluation report and match artifact do not include this
  evaluator id or metric ids.

#### 13.11.5g `society.betrayal.v1`

Capability:

```text
Promote explicit betrayal allegations and lifecycle evidence into
evidence-backed society records and social-state coverage metrics without
inferring betrayal from free text, claiming betrayal intent, causal impact,
relationship damage, reputation damage, coalition failure, reward impact,
leaderboard value, or counterfactual influence.
```

Owner plane:

```text
society + agent ingestion + evaluation + artifact evidence
```

Owner modules:

```text
src/harness/socialState.ts
src/harness/actor.ts
src/harness/socialEvaluator.ts
tests/socialState.test.ts
tests/actorSocialClaims.test.ts
tests/evaluation.test.ts
tests/artifacts.test.ts
```

Current baseline:

- `src/harness/socialState.ts` now defines first-class
  `BetrayalRecord` / `BetrayalLedger` types.
- `AgentSocialState.betrayals` is optional and lazily created. This preserves
  the existing empty serialized shape from `createAgentSocialState()` until a
  betrayal record is actually written.
- Betrayal taxonomy is local and intentionally conservative:
  `BetrayalKind`, `BetrayalStatus`, `BetrayalEvidenceKind`, and
  `BetrayalTriggerKind`.
- New betrayal APIs:
  `createBetrayalLedger`, `ensureBetrayalLedger`, `addBetrayal`,
  `addSocialBetrayal`, `recordBetrayalEvidence`, and
  `recordSocialBetrayalEvidence`.
- Status changes are evidence lifecycle updates. There is no separate
  `betrayal.status.updated` API or actor fact in this baseline; later status
  movement is represented by `betrayal.evidence.recorded` with an optional
  next status.
- The mutation journal supports:
  - `store: "betrayals"`;
  - `mutationKind: "betrayal.added"`;
  - `mutationKind: "betrayal.evidence.recorded"`.
- Evidence buckets are explicit:
  `allegation`, `corroboration`, `contest`, `repair`, and `outcome`.
- Store APIs require evidence refs, clone returned records, de-duplicate and
  sort audiences, clamp confidence, use deterministic timestamps, merge
  evidence refs, and preserve `hiddenTruthUsed: false` through journal entries.
- Journal summaries are redacted. They store ids, actor/target ids,
  audience counts, visibility, status, kind, trigger/related ids, confidence,
  evidence counts, metadata keys, and raw text lengths. They do not copy raw
  betrayal `claim` or `impact` text.
- Actor ingestion accepts only explicit structured facts in messages already
  present in that actor's scoped `view.social.messages`.
- Accepted structured fact kinds are `betrayal` and `betrayal-evidence`.
- `betrayal` facts require an explicit `targetId` and valid `betrayalKind`.
  `actorId` defaults to the visible message sender, `audienceIds` defaults to
  delivered message recipients, visibility defaults to delivered message
  visibility, and id defaults to a message-derived id when omitted.
- `betrayal-evidence` facts require an existing observed betrayal id and a valid
  `BetrayalEvidenceKind`. Unknown ids or malformed evidence kinds are skipped
  rather than guessed.
- No free-text parser or natural-language inference was added. Natural-language
  betrayal accusations remain ordinary message memory unless structured
  metadata or typed APIs explicitly write a betrayal record.
- Betrayal writes do not automatically mutate relationship, reputation, goals,
  policy state, rewards, leaderboards, or `evaluationReport.summary.agentScores`.
  Actor observation still has the existing generic sender relationship/reputation
  update for visible messages; that generic message update is separate from the
  betrayal store contract.
- `social.state.v1` now reads explicit betrayal stores and emits zero-weight
  coverage metrics for the betrayal store:

```text
agent.social.betrayal_count
agent.social.confirmed_betrayal_count
agent.social.evidenced_betrayal_rate
```

- `agent.social.confirmed_betrayal_count` means
  `AgentSocialState.betrayals.records.status === "confirmed"`. It is a social
  record status count, not postgame truth confirmation, causal proof, or
  outcome grading.
- `social.state.v1` journal store coverage denominator is now `13` because the
  mutation journal store set includes `betrayals`.
- `SOCIAL_STATE_EVALUATOR_MANIFEST.rubric` now names betrayal coverage and
  explicitly says the evaluator does not assert betrayal truth, causality,
  persuasion/deception success, reward impact, leaderboard value, or
  counterfactual influence.
- Existing artifact schema was not expanded. Betrayal state exports through
  existing `agent_state.social.betrayals` snapshots, and betrayal journal rows
  export through existing `social_state_mutation` JSONL records.
- No server/API or React cockpit surface was changed in this slice.
- `evaluation.betrayal-lifecycle-temporal-association.v1` now exists as a
  separate standalone zero-weight postgame evaluator documented in section
  13.11.5h. This society-store slice does not wire it into the normal runtime
  registry, default match artifact registry, tournament registry, reward
  summaries, leaderboards, or React/API surfaces.

Focused tests prove:

- betrayal store APIs require evidence, clone returned records, clamp
  confidence, preserve evidence buckets, and write redacted journal summaries;
- root social-state wrappers write `betrayal.added` and
  `betrayal.evidence.recorded` journal rows with evidence refs and scoped
  mutation context;
- actor ingestion creates betrayal records only from explicit structured
  metadata in scoped visible messages;
- actor ingestion ignores natural-language-only betrayal wording, hidden
  messages outside the scoped observation, missing `targetId`, invalid
  `betrayalKind`, unknown evidence ids, and invalid evidence kinds;
- actor ingestion adds `social:betrayal` memory tags only for structured
  betrayal facts;
- betrayal ingestion does not automatically mutate the betrayal target's
  relationship or reputation record;
- `social.state.v1` reports `betrayals`, emits the three zero-weight betrayal
  coverage metric ids with evidence refs and social-state hash metadata, and
  leaves weighted agent scores empty;
- metric metadata marks status source and `postgameTruthUsed: false` /
  `causalClaim: false` for status-confirmed betrayal counts;
- artifact JSONL preserves betrayal records through existing `agent_state`
  records and preserves redacted betrayal journal rows through existing
  `social_state_mutation` records;
- mutation summaries do not contain raw betrayal claim/impact text.

Focused validation for this baseline:

- `npx tsc --noEmit --pretty false --noErrorTruncation`
- `npx vitest run tests/socialState.test.ts -t "betrayal" --reporter=dot`
- `npx vitest run tests/actorSocialClaims.test.ts -t "betrayals" --reporter=dot`
- `npx vitest run tests/evaluation.test.ts -t "betrayal" --reporter=dot`
- `npx vitest run tests/artifacts.test.ts -t "society stores" --reporter=dot`
- `npx vitest run tests/socialState.test.ts tests/actorSocialClaims.test.ts tests/evaluation.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot`
  (`5` files / `45` tests)
- `npm test -- --reporter=dot` (`20` files / `150` tests)
- `npm run build`
- Secret/overclaim scans over `AGENTS.md`, `src`, `tests`, `package.json`,
  `README.md`, and `docs`; remaining secret-pattern hits are variable-name
  policy/source references, token-usage fields, and test bearer-token/provider
  redaction sentinels, and remaining overclaim-pattern hits are negative
  wording in docs/manifests or test regexes that forbid causal/success wording.

Remaining work:

- Keep `evaluation.betrayal-lifecycle-temporal-association.v1` standalone and
  zero-weight unless a future explicit registry-wiring decision updates runtime
  evaluation, match artifact JSONL, tournament registry, and metric-evidence
  tests in the same change.
- Do not promote betrayal metrics into reward-bearing scorecards or benchmark
  leaderboards without a separate metric-promotion decision covering denominator
  policy, uncertainty, failure handling, and benchmark semantics.
- Broader truth, intent, causal, outcome, policy-arbitration,
  relationship/reputation-delta, reward, leaderboard, and counterfactual
  betrayal semantics remain future contracts.

#### 13.11.5h `evaluation.betrayal-lifecycle-temporal-association.v1`

Capability:

```text
Audit whether explicit betrayal records are temporally followed by ordered
betrayal lifecycle evidence journal entries, without claiming betrayal truth,
intent, causality, relationship/reputation damage, reward impact, leaderboard
value, or counterfactual influence.
```

Owner plane:

```text
evaluation + society + artifact evidence
```

Owner modules:

```text
src/harness/socialEvaluator.ts
src/harness/socialState.ts
tests/evaluation.test.ts
tests/tournamentArtifacts.test.ts
```

Contract:

- Evaluator id:
  `evaluation.betrayal-lifecycle-temporal-association.v1`.
- Metric ids:
  `agent.social.betrayal_lifecycle_temporal_association_count`,
  `agent.social.betrayal_lifecycle_temporal_association_rate`, and
  `agent.social.betrayal_lifecycle_temporal_evaluable_record_rate`.
- Input source:
  explicit `AgentSocialState.betrayals.records` plus ordered redacted
  `AgentSocialState.journal.entries`.
- Creation evidence:
  `store === "betrayals"`, `mutationKind === "betrayal.added"`,
  `subjectId === betrayal.id`, and `hiddenTruthUsed === false`.
- Lifecycle evidence:
  `store === "betrayals"`,
  `mutationKind === "betrayal.evidence.recorded"`,
  `subjectId === betrayal.id`, and `hiddenTruthUsed === false`.
- Lifecycle kind source:
  `deltaSummary.evidenceKind`, with current explicit evidence buckets
  `allegation`, `corroboration`, `contest`, `repair`, and `outcome`.
- Ordering rule:
  strict `lifecycle.turnIndex > betrayal.added.turnIndex`.
- Same-turn lifecycle evidence is evaluable but not later-associated.
- Missing creation entries, missing relevant `turnIndex`, or ambiguous ordering
  are unevaluable, not no-effect, success, failure, truth, intent, causality,
  relationship/reputation damage, reward, leaderboard, or counterfactual
  evidence.
- Manifest metadata marks `associationLevel: temporal_association`,
  `temporalAssociationKind: betrayal_lifecycle_journal_temporal_association`,
  `causalClaim: false`, `orderingRule: strict_turnIndex_after_creation`,
  `hiddenTruthUsedInLiveStore: false`, and `postgameTruthUsed: false`.
- Metrics are `weight: 0` and do not affect
  `evaluationReport.summary.agentScores`.
- The evaluator is standalone and is not wired into the normal Werewolf runtime
  evaluator registry, `createWerewolfEvaluationSuite()`, default match artifact
  registry, tournament registry, reward summaries, leaderboards, or React
  live/public views.

Validation for this evaluator:

- `npx tsc --noEmit --pretty false --noErrorTruncation`
- `npx vitest run tests/evaluation.test.ts -t "betrayal lifecycle" --reporter=dot`
  (`1` file / `1` test)
- `npx vitest run tests/evaluation.test.ts -t "betrayal" --reporter=dot`
  (`1` file / `2` tests)
- `npx vitest run tests/tournamentArtifacts.test.ts --reporter=dot`
  (`1` file / `6` tests)
- `npx vitest run tests/evaluation.test.ts --reporter=dot`
  (`1` file / `22` tests)
- `npx vitest run tests/socialState.test.ts tests/actorSocialClaims.test.ts tests/evaluation.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot`
  (`5` files / `46` tests)
- `npm test -- --reporter=dot` (`20` files / `151` tests)
- `npm run build`
- Secret/overclaim scans over `AGENTS.md`, `src`, `tests`, `package.json`,
  `README.md`, and `docs`; remaining secret-pattern hits are test-only
  provider/bearer-token and fake env redaction sentinels, and remaining
  overclaim-pattern hits are negative wording in docs/manifests or test regexes
  that forbid causal/success/reward/truth wording.

#### 13.11.6 `api.public-view-redaction.v1`

This is also listed in section 13.9 because the latest React/API audit found it
as the most urgent UI/API truth-source risk.

Acceptance:

- Live/public endpoints return strict white-listed views.
- Artifact/debug endpoints remain available for postgame truth.
- Server tests prove hidden night state/private events/postgame events/private
  memos do not appear in public summaries.
- React panels clearly separate live/public, actor-scoped, postgame artifact,
  and debug views.

Current status:

- Server-side public view redaction baseline exists.
- React cockpit separation baseline exists:
  artifact-sourced harness trace, independent probe debug state, server-owned
  by-id replay, and explicit live/public vs postgame/debug labeling are in
  place.
- Probe persistence pollution has been removed; `/api/harness/probe` should not
  create stored match records.
- Public API failure responses now sanitize provider/model-call failures before
  returning `error` or `summary.failureReason`. Provider failures are exposed as
  redaction-safe kind/stage/status/timeout/attempt summaries, not raw provider
  body/header/retry-cause strings. Focused tests cover failed probe responses
  with bearer-token sentinel text in message/body/headers/retry cause.
- Public match/tournament summaries no longer return raw role/team assignment
  maps. They expose assignment strategy/fallback and counts, while full
  assignment truth remains an artifact/control-plane concern.
- Checkpoint create/detail routes now return only a redaction-safe checkpoint
  public response: `summary` plus `artifactUrl`. Full checkpoint state, restored
  agent snapshots, trajectory, and social message prefix remain available only
  through the explicit postgame/debug route `/api/checkpoints/:id/artifact`.
  Fork execution still uses server-owned full checkpoints internally.
- `tests/serverCheckpointApi.test.ts` verifies default checkpoint responses do
  not embed full checkpoint state, agent arrays, trajectory, social messages, or
  hidden night truth fields, while the explicit checkpoint artifact route still
  preserves full postgame/debug truth for audit and fork provenance.
- Remaining work is hardening and naming, not basic separation: narrower DTOs,
  optional redacted probe summary, and continued tests when API shapes change.

Focused validation for this baseline:

- `npx vitest run tests/serverCheckpointApi.test.ts --reporter=dot` (`1` file / `5` tests)
- `npx vitest run tests/serverPublicViewApi.test.ts tests/serverCheckpointApi.test.ts tests/serverTournamentArtifactsApi.test.ts --reporter=dot` (`3` files / `14` tests)
- `npx tsc --noEmit --pretty false --noErrorTruncation`
- `npm test -- --reporter=dot` (`20` files / `154` tests)
- `npm run build`
- Secret-pattern scan over `AGENTS.md`, `src`, `tests`, `package.json`,
  `README.md`, and `docs`; hits were expected fake env/provider bearer-token
  redaction sentinels in tests only. No `.env` or `.env.local` contents were
  read or printed.
- Overclaim-pattern scan over the same non-env paths; hits were expected
  negative wording, documentation guardrails, or forbidden-regex tests only.

#### 13.11.7 `evaluation.benchmark-statistics.v1`

Capability:

```text
Make tournament reports benchmark-grade by preserving all denominators and
adding stratified, uncertainty-aware model/profile/system comparisons.
```

Acceptance:

- Completed-only metrics and all-requested failure metrics are both present.
- Results are stratified by model, profile, role, team, seat, seed bucket,
  scheduler, and domain config where applicable.
- Paired-seed deltas, head-to-head matrices, confidence intervals/bootstrap or
  equivalent uncertainty estimates are available before claiming comparative
  superiority.
- Raw artifacts remain the authority behind leaderboard summaries.
- Benchmark artifacts include schema version, benchmark id/version, run-set id,
  experiment spec hash, harness version, domain adapter version, agent scaffold
  version, evaluator registry version, model configs, prompt/policy versions,
  seed ledger, role/seat/name plan, communication topology, scheduler config,
  scheduled/completed/failed run counts, failure counts by cause, rerun policy,
  superseded run refs, and contamination-risk notes where applicable.
- Metric records include metric id/version/type, owner plane, input artifacts,
  visibility scope, evidence refs, aggregation method, denominator policy,
  failure policy, confidence interval method/level, effect size method, paired
  design key, sample count, score, interval bounds, and notes.
- Failure records include run id, scheduled run index, status, failure cause,
  failure owner, phase, retry count, original/replacement run refs, trace ref,
  checkpoint ref, validator ref, usage ref, and redaction policy.

Current baseline:

- A first descriptive run-set denominator baseline exists in
  `src/harness/tournamentArtifacts.ts`.
- The tournament artifact writer now emits an explicit
  `benchmark_statistics.json` postgame artifact alongside `leaderboard.json`.
  The same object is also embedded as `leaderboard.benchmarkStatistics` for
  compatibility with existing leaderboard consumers.
- `benchmark_statistics.json` records:
  - `artifactVersion`
  - `schemaVersion: harness.benchmark-statistics.v1`
  - `kind: tournament-benchmark-statistics`
  - `evaluatorId: evaluation.benchmark-statistics.v1`
  - evaluator version and metric ids
  - benchmark id and run-set id
  - experiment spec version and stable experiment spec hash
  - postgame visibility
  - input artifact names: `spec.normalized.json`, `assignment.json`,
    `episodes.jsonl`, `integrity.jsonl`, and `matches/*.json`;
    `leaderboard.json` embeds this output for compatibility but is not listed
    as a benchmark input artifact
  - denominator policy with `superiorityClaims: false`
  - comparison policy explicitly marking paired-seed deltas, head-to-head
    matrices, confidence intervals, and effect sizes unavailable until their
    own contracts exist
  - status denominators for requested/scheduled/unscheduled/completed/failed
    episodes, artifact coverage, evaluation/report coverage, failed-with-
    artifact, pre-harness failures, and harness status counts
  - seed ledger
  - descriptive strata by model, profile, role, team, seat, episode status, and
    harness status
- `registry.json` now includes a deterministic postgame evaluator-style
  manifest entry for `evaluation.benchmark-statistics.v1`, so the benchmark
  artifact is discoverable through the evaluator registry snapshot even though
  it is a run-set artifact projection, not a per-match evaluator module.
- `manifest.json`, server tournament artifact registration/download allowlists,
  CLI artifact summaries, and the React cockpit download list now include
  `benchmark_statistics.json`; the same surfaces also register and expose
  `integrity.jsonl` as the structural artifact-integrity evidence stream.
- `tests/tournamentArtifacts.test.ts` verifies the independent benchmark
  artifact, leaderboard compatibility embedding, registry manifest entry,
  denominator policy, status denominators, seed ledger, and strata for both a
  truncated harness run and a pre-harness failure.
- `tests/serverTournamentArtifactsApi.test.ts` verifies the new benchmark file
  is registered, listed, downloadable, and path-contained through the server
  artifact API.
- Artifact/provider redaction has been hardened so provider failure summary
  string fields are sanitized at source, match artifacts and trajectory JSONL
  are recursively redacted before output, tournament artifact writing reuses the
  shared redaction helper, and explicit postgame/debug server artifact routes
  return redacted artifact/checkpoint copies. This removes the gap where raw
  provider strings embedded in `providerRequestId`, `retryCause`,
  `abortReason`, `causeName`, or failure messages could appear in full match
  artifacts or trajectory JSONL.

Focused validation for this baseline:

- `npx vitest run tests/tournamentArtifacts.test.ts -t "writes the required layout" --reporter=dot`
- `npx vitest run tests/harness.test.ts -t "provider failure classification" --reporter=dot`
- `npx vitest run tests/serverPublicViewApi.test.ts -t "redacts provider failure strings" --reporter=dot`
- `npx tsc --noEmit --pretty false --noErrorTruncation`
- `npx vitest run tests/tournamentArtifacts.test.ts --reporter=dot` (`1` file / `6` tests)
- `npx vitest run tests/serverTournamentArtifactsApi.test.ts --reporter=dot` (`1` file / `4` tests)
- `npx vitest run tests/tournament.test.ts tests/tournamentArtifacts.test.ts tests/serverTournamentArtifactsApi.test.ts --reporter=dot` (`3` files / `13` tests)
- `npx vitest run tests/tournamentArtifacts.test.ts tests/serverTournamentArtifactsApi.test.ts --reporter=dot` (`2` files / `10` tests)
- `npx vitest run tests/harness.test.ts tests/serverPublicViewApi.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts tests/serverTournamentArtifactsApi.test.ts --reporter=dot` (`5` files / `30` tests)
- `npm test -- --reporter=dot` (`20` files / `155` tests)
- `npm run build`
- Secret-pattern scan over `AGENTS.md`, `README.md`, `docs`, `package.json`,
  `src`, and `tests`, excluding `.env`, `.env.local`, `node_modules`, `dist`,
  and lockfiles; hits were README placeholder env instructions, expected fake
  env/provider bearer-token redaction sentinels in tests, and code references
  to env variable names. No `.env` or `.env.local` contents were read or
  printed.
- Overclaim/fake-validation scan over the same non-env paths; hits were
  expected assignment `fallback` configuration, explicit "no fake fallback or
  model substitution" CLI/docs wording, negative no-causality/no-superiority
  guardrails, and test regexes that forbid causal/success/reward/truth wording.
- `npm run agent:probe -- --models=kimi-k2.7 --timeout=90s` completed one real
  OpenAI-compatible streaming harness turn through the configured provider:
  summary `ok: true`, one succeeded model, zero failed models, elapsed about
  `5955ms`, command `seer.inspect`. This was a real streaming provider call,
  not a fake smoke test or fallback validation.
- `LLM_STREAM=true LLM_TIMEOUT_MS=90000 LLM_RETRY_COUNT=0 npm run arena:match -- --models=kimi-k2.7 --maxTransitions=2 --timeout=90s --json=summary`
  completed a bounded real streaming match through the configured provider
  after the redaction changes: summary `ok: true`, one `kimi-k2.7` model call,
  one harness turn, `harnessErrors: 0`, and expected `status: truncated` because
  the run was intentionally capped at `maxTransitions=2`. This was a real
  streaming match path, not a fake smoke test or fallback validation.

Remaining work:

- This is not a complete benchmark-statistics system yet. Paired-seed deltas,
  head-to-head matrices, confidence intervals/bootstrap, effect sizes, seed
  bucket policy, scheduler/domain-config strata, metric-denominator rollups,
  failure-owner taxonomy, rerun/supersession refs, and benchmark leaderboard
  promotion all still require explicit contracts and tests.
- Do not use this baseline to claim comparative model superiority. It is a
  denominator, coverage, registry, seed-ledger, and descriptive-strata baseline.

### 13.12 What Not To Do Next

Do not:

- Add more prompt-only agent personalities and call it society.
- Define an agent as a JSON schema.
- Add free-text NLP parsing that mutates stores without scoped evidence refs.
- Replace the custom harness with OpenAI Agents, AutoGen, LangGraph, or any
  other framework.
- Treat a successful React screen as evidence that harness semantics exist.
- Treat public transcript as universal knowledge.
- Run live provider calls non-streaming.
- Read or print `.env` / `.env.local`.
- Bypass the `runHarnessMatch()` compatibility wrapper by exposing raw generic
  social artifacts through existing match/replay/artifact APIs without a
  schema/version decision.
- Reintroduce legacy-vs-wrapper self-comparison as proof; production wrapper
  behavior must be proven with fixed replay, artifact, failure, provider,
  message, event, checkpoint/fork, and batch-boundary assertions.
- Add failed steps into committed replay trajectories without replay semantics.
- Claim deception belief shift or causal influence until temporal state evidence
  exists.
- Let React call domain internals on redacted state to reconstruct truth.

### 13.13 Latest Practical Summary

The project direction is locked:

```text
Build the reusable multi-agent adversarial/social harness.
Make agents stateful social actors, not model calls.
Make communication, visibility, memory, belief, relationships, norms,
reputation, goals, and arbitration first-class runtime/evidence surfaces.
Make agent psychology, theory-of-mind, risk posture, deception posture,
attack/defense posture, commitments, coalitions, trust, suspicion, and
reputation explicit harness-managed state or evidence-backed evaluator outputs.
Treat multi-agent games and social simulations as extensible harness domains,
not as prompt scripts.
Use Werewolf as the first pressure test.
Use React as a cockpit over server/harness/artifact truth.
Use streaming for real provider calls.
Use subagents for parallel research/audit/implementation when available.
Validate every non-trivial change.
```

The highest-leverage completed runtime migration slice is:

```text
harness.social-runner-compat.v1
```

Production wrapper contract tests now cover the formerly stale full-match and
fork cases. Private runtime legacy helpers have been removed or migrated. The
next runtime work is broader failure/provider/message/event contract hardening
without reintroducing a parallel legacy runner.

The highest-risk UI/API safety slice is:

```text
api.public-view-redaction.v1
```

The highest-leverage completed agent-society slices are:

```text
agent.action-arbitration.v1
society.commitment-coalition.v1
society.gossip-norm-sanction.v1
society.trust-repair.v1
society.betrayal.v1
```

The highest-leverage completed evaluator evidence baselines are:

```text
agent.social-update-journal.v1
evaluation.deception-belief-shift.v1
evaluation.deception-reputation-association.v1
evaluation.commitment-coalition-association.v1
evaluation.commitment-coalition-lifecycle-temporal-association.v1
evaluation.norm-sanction-lifecycle-temporal-association.v1
evaluation.gossip-exposure-temporal-association.v1
evaluation.trust-repair-lifecycle-temporal-association.v1
evaluation.trust-repair-relationship-temporal-association.v1
evaluation.trust-repair-reputation-temporal-association.v1
evaluation.betrayal-lifecycle-temporal-association.v1
```

The next likely society/evaluator slices should be chosen from remaining
explicit non-causal contracts, such as broader coordination/dissolution/repair,
vote/action temporal association, relationship/reputation outcome association,
broader betrayal relationship/reputation temporal association, betrayal
policy-arbitration use, betrayal outcome/causal variants, or registry-promotion
hardening. Do not treat any of these as complete without their own evidence,
artifact, and validation record.

Only promote standalone temporal-association evaluators beyond standalone
zero-weight status after an explicit metric-promotion decision defines
reward/leaderboard semantics, denominator policy, uncertainty/failure handling,
and, if they are wired into a default or named suite, artifact/tournament
registry tests. This guard covers:

- `evaluation.deception-belief-shift.v1`
- `evaluation.deception-reputation-association.v1`
- `evaluation.norm-sanction-lifecycle-temporal-association.v1`
- `evaluation.gossip-exposure-temporal-association.v1`
- `evaluation.trust-repair-lifecycle-temporal-association.v1`
- `evaluation.trust-repair-relationship-temporal-association.v1`
- `evaluation.trust-repair-reputation-temporal-association.v1`
- `evaluation.betrayal-lifecycle-temporal-association.v1`

### 13.14 Latest React Society Cockpit And shadcn UI Lock

The latest UI execution pass answered the user's explicit direction:

```text
Research how the frontend should present multi-agent adversarial society
behavior, use real shadcn UI components, and do not fake the component library.
```

Current completed UI slice:

```text
react.society-cockpit-shadcn.v1
```

What changed:

- Real shadcn v4 / Tailwind v4 setup is present through `components.json`,
  `@tailwindcss/vite`, `shadcn/tailwind.css`, `src/lib/utils.ts`, and generated
  `src/components/ui/*` source files.
- `src/main.tsx` wraps the app in the generated shadcn `TooltipProvider`.
- `src/App.tsx` now imports and uses generated shadcn `Badge`, `Card`,
  `Progress`, `ScrollArea`, `Tabs`, `Table`, and `Tooltip` components.
- The social tab's `SocialEpisodePanel` has been converted into a
  postgame/artifact-scoped multi-agent society cockpit.
- The cockpit reuses the existing `MatchArtifact`,
  `deriveSocialExposureRecords()`, and `buildSocialGraph()` contracts.
- The cockpit visualizes actors, model/profile/policy assignment, message flow,
  scoped exposure, relationship edges, reputation records, channels, and the
  committed social message ledger.
- `src/styles.css` adds `.society-*` scoped styling only, preserving the
  existing Werewolf arena shell.
- `tsconfig.json` includes `ignoreDeprecations: "6.0"` because TypeScript 6
  emits a build-blocking deprecation diagnostic for the `baseUrl` alias config
  required by the current shadcn/Vite alias setup.

Boundary lock:

- This cockpit is an explicit **postgame artifact analysis surface**.
- It may read `artifact.socialEpisode`, `artifact.agents[*].social` summaries
  exposed by `buildSocialGraph()`, and evidence refs because those are artifact
  truth surfaces.
- It must not become a public live view.
- It must not use `artifact.finalState`, `resolvedAssignments.role/team`,
  private memos, private messages, or agent social state to decorate live
  public seats unless the UI is explicitly in postgame/debug mode.
- `match.state` / `PublicGameState` remains the live public truth source.
- `artifact` remains postgame/debug truth.

Research facts preserved:

- shadcn for Vite is a generated-source component system: components are added
  into local project files under `src/components/ui`, not imported as a black
  box widget package.
- The official Vite installation path requires Tailwind and the `@/*` alias
  setup.
- shadcn `Tooltip` usage requires a provider wrapper.
- Dense social/agent cockpit UI should privilege overview metrics, scan-friendly
  tables, evidence drill-down, scoped visibility labels, and artifact provenance
  over decorative landing-page composition.

Validation completed for this slice:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npm run build
npx vitest run tests/serverPublicViewApi.test.ts tests/serverCheckpointApi.test.ts tests/serverTournamentArtifactsApi.test.ts --reporter=dot
npx vitest run tests/artifacts.test.ts tests/replay.test.ts tests/tournamentArtifacts.test.ts --reporter=dot
npm test -- --reporter=dot
```

Observed results:

```text
typecheck passed
production build passed
server/public/checkpoint/tournament API targeted tests passed: 3 files / 15 tests
artifact/replay/tournament-artifact targeted tests passed: 3 files / 14 tests
full test suite passed: 20 files / 172 tests
```

Red-line scans were run after validation, excluding `.env`, `.env.local`,
`node_modules`, `dist`, and `package-lock.json`. Matches were existing docs,
policy text, or redaction-test sentinels, not newly introduced secret values or
provider request fields.

### 13.15 Latest Harness-First Research UI Rewrite

The user rejected the previous UI because it still centered Werewolf and did
not look or behave like a multi-agent adversarial society research cockpit. This
correction is valid and must be preserved:

```text
The product is a multi-agent adversarial/social harness for research,
experiments, reproduction, records, and analysis. Werewolf is only the first
domain adapter.
```

Current completed UI rewrite slice:

```text
react.harness-research-cockpit.v1
```

What changed:

- The React first screen is now `Agent Society Research Lab`, not a Werewolf
  game table.
- The top-level layout is a research cockpit:
  - left: experiment spec / agent profiles / assignment / run controls
  - center: society topology, evidence timeline, evaluation matrix, replay, and
    domain adapter tabs
  - right: artifact registry, tournament health, and run artifact summaries
- The previous `PhaseRail`, `SeatRing`, and `ActionDock` Werewolf table are no
  longer the dominant rendered experience.
- Werewolf is rendered only in a `Domain Adapter` panel as a redacted public
  state view and first pressure-domain summary.
- The UI uses real generated shadcn components from `src/components/ui/*`,
  including `Button`, `Input`, `Textarea`, `Badge`, `Card`, `Progress`,
  `ScrollArea`, `Separator`, `Tabs`, `Table`, and `Tooltip`.
- `src/main.tsx` now applies the `.dark` class to the document root so generated
  shadcn dark tokens are active instead of mixing light shadcn tokens with a
  custom dark shell.
- `runRealMatch()` now uses server-returned `config.defaultConfig` when
  available and sends explicit `maxTransitions` and `timeoutMs`.
- Tournament export controls now expose `games`, `maxTransitions`, and
  `timeoutMs` as experiment parameters instead of using a hidden zero-transition
  export shortcut.
- `policyName` edits are coerced through the existing `isPolicyName()` contract;
  the UI does not force arbitrary strings into `HarnessAgentProfile`.
- The main research tabs are:
  - `Society`: actor topology, communication edges, exposure edges,
    relationship state, reputation state, channels, and message ledger
  - `Timeline`: trajectory steps, social scheduler steps, and probe evidence
  - `Evaluation`: evaluator registry groups, evidence matrix, and tournament
    leaderboard rows
  - `Replay`: replay hash/status, provenance, artifact downloads
  - `Domain Adapter`: redacted Werewolf public state only

Boundary lock:

- The cockpit is harness-first. It should keep Werewolf behind a domain adapter
  boundary.
- The live/public sections consume `PublicGameState` and public match summaries.
- Full artifact views are explicitly postgame/debug truth surfaces.
- React still must not infer hidden truth from public state.
- React still must not define agency; agency remains in harness-managed actor
  state, policy, memory, beliefs, relationships, reputation, goals, norms, and
  reasoner/arbitration components.
- UI quality is not proof of harness semantics; the cockpit must continue to
  expose artifact evidence, replay, evaluator records, and tournament outputs.

Research/audit inputs used:

- Local subagent audit found the prior UI was Werewolf-first because the central
  viewport was `table-zone`, the header was Werewolf-branded, role/phase labels
  were top-level, and the society cockpit was cramped into a right rail.
- Local subagent API audit confirmed safe live surfaces are `/api/config`,
  `/api/health`, public match/checkpoint summaries, tournament artifact set
  summaries, and replay summaries, while match artifacts, trajectory JSONL,
  checkpoint artifacts, tournament episode internals, and artifact downloads
  are postgame/debug surfaces.
- Local subagent shadcn audit confirmed the generated component system is real
  and that dark-token activation was required for coherent visual output.
- Current external design pressure remains observability-first: trace/spans,
  experiment records, artifact lineage, evaluation matrices, and evidence
  drill-downs should dominate the experience.

Validation completed for this rewrite:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npm run build
npx vitest run tests/socialGraph.test.ts tests/serverPublicViewApi.test.ts tests/serverCheckpointApi.test.ts tests/serverTournamentArtifactsApi.test.ts --reporter=dot
npx vitest run tests/artifacts.test.ts tests/replay.test.ts tests/tournamentArtifacts.test.ts --reporter=dot
npm test -- --reporter=dot
```

Observed results:

```text
typecheck passed
production build passed
social/API focused tests passed: 4 files / 17 tests
artifact/replay/tournament-artifact targeted tests passed: 3 files / 14 tests
full test suite passed: 20 files / 172 tests
```

Runtime check:

- Local `http://127.0.0.1/` returns 200.
- Public `http://24.199.119.192/` returns 200.
- Served Vite source contains `Agent Society Research Lab`,
  `ExperimentWorkbench`, `SocietyResearchPanel`, and `Domain Adapter`.

Red-line scans were run after validation, excluding `.env`, `.env.local`,
`node_modules`, `dist`, and `package-lock.json`. Matches were existing docs,
policy text, or redaction-test sentinels, not newly introduced secret values,
forbidden provider request fields, or fake-validation claims.

### 13.16 Prefix Checkpoint Evidence Chain

Current completed harness slice:

```text
harness.prefix-checkpoint-evidence.v1
```

Capability added:

- Match artifacts now carry optional per-step full agent snapshots for
  recoverable checkpoint boundaries:
  - `HarnessStepRecord.agentSnapshotsAfterStep`
  - `HarnessStepRecord.agentSnapshotsHashAfterStep`
  - corresponding social-step snapshot hash metadata
- `runWerewolfSocialHarnessPrefix()` captures full `AgentHarnessState[]`
  snapshots from the live actor map after each agent decision commit. This
  prevents prefix checkpoints from using final `artifact.agents`.
- `validateMatchArtifactIntegrity()` verifies snapshot shape and hashes when
  snapshots are present:
  - full player coverage
  - no duplicate/unknown player ids
  - acting agent `socialStateHash` matches the step `agentStateHash`
  - final successful snapshot matches final artifact agents for non-failed runs
  - socialEpisode step snapshot hash matches the trajectory step hash
- `buildHarnessCheckpointAtPrefix()` creates server-owned prefix checkpoints
  from exactly one selector:
  - `trajectoryLength`
  - `traceId`
  - `turnIndex`
- Prefix checkpoint construction now:
  - replays the domain state from `initialState + trajectory prefix`
  - restores agents from the selected step snapshot
  - trims social messages to the selected prefix `messageSeq`
  - hashes state, trajectory, agents, and social messages into checkpoint source
  - rejects missing snapshots instead of falling back to final agents
  - rejects unsafe `parallel`/atomic boundaries
  - rejects the middle of `aec-batched-decision` batches
  - validates the selected boundary's agent evidence against future local
    trace/message/event references before producing the checkpoint
- `validateHarnessCheckpoint()` now checks checkpoint agent evidence does not
  reference messages/events beyond the checkpoint boundary.
- `HarnessRunOptions.recordAgentSnapshots` can explicitly disable per-step
  snapshot capture for long replay/JSONL/tournament parity runs that do not need
  prefix checkpoint creation. The default remains enabled so server-owned match
  artifacts can produce prefix checkpoints unless a caller opts out.
- `POST /api/matches/:id/checkpoints` now supports prefix selectors while
  preserving old final-checkpoint behavior when no selector is provided.
- Checkpoint creation still rejects client-submitted raw restore truth:
  `state`, `agents`, `trajectory`, `socialMessages`, `agentSnapshots`, and
  related fields remain forbidden. The server-owned match artifact is the only
  source of checkpoint truth.
- Public checkpoint summaries still expose `traceRef`, not raw `traceId`.

Important semantics:

- Final checkpoint behavior remains owned by `buildFinalHarnessCheckpoint()`.
- Prefix checkpoint behavior is owned by `buildHarnessCheckpointAtPrefix()`.
- A prefix checkpoint is safe only when the selected boundary has recorded full
  agent snapshots and is not inside a batched decision boundary.
- Replay still restores only domain state. It must not infer or reconstruct
  agent private/social state.
- Full per-step snapshots are internal artifact/checkpoint recovery evidence.
  JSONL step exports include snapshot hashes, not full per-step private memo
  payloads.

Known performance debt:

- Full `AgentHarnessState[]` snapshots make long match artifacts heavier.
- This debt is now partly closed by `harness.agent-snapshot-frame-store.v1` in
  section 13.17: persisted match artifacts store snapshot payloads in an
  artifact-level hash-addressed frame store instead of duplicating full agent
  arrays on every trajectory/social step.
- Remaining storage debt is runtime-side efficiency and optional further
  sidecar/compaction: the Werewolf runtime may still temporarily capture full
  per-step snapshots before `buildMatchArtifact()` normalizes them into frames.

Validation completed for this slice:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npm run build
npx vitest run tests/artifacts.test.ts --reporter=dot
npx vitest run tests/replay.test.ts tests/serverCheckpointApi.test.ts --reporter=dot
npx vitest run tests/serverMatchArtifactsApi.test.ts tests/serverPublicViewApi.test.ts --reporter=dot
npx vitest run tests/werewolfAdapter.test.ts tests/tournamentArtifacts.test.ts --reporter=dot
npm test -- --reporter=dot
```

Observed results:

```text
typecheck passed
production build passed
artifact targeted tests passed: 1 file / 7 tests
replay + server checkpoint targeted tests passed: 2 files / 19 tests
server match artifact + public view tests passed: 2 files / 20 tests
werewolf adapter + tournament artifact tests passed: 2 files / 29 tests
full test suite passed: 21 files / 214 tests
```

### 13.17 Agent Snapshot Frame Store

Current completed harness slice:

```text
harness.agent-snapshot-frame-store.v1
```

Capability added:

- Match artifacts now own an optional artifact-level snapshot frame store:
  - `MatchArtifact.agentSnapshotFrames`
  - `AgentSnapshotFrame.artifactVersion`
  - `AgentSnapshotFrame.kind`
  - `AgentSnapshotFrame.frameId`
  - `AgentSnapshotFrame.agentsHash`
  - `AgentSnapshotFrame.agents`
- `buildMatchArtifact()` extracts duplicated per-step full
  `AgentHarnessState[]` payloads into hash-addressed frames and strips embedded
  snapshot arrays from artifact trajectory/social steps.
- `HarnessStepRecord` now keeps lightweight recovery evidence:
  - `agentSnapshotsHashAfterStep`
  - `agentSnapshotFrameIdAfterStep`
- `SocialHarnessStep` now keeps matching lightweight recovery evidence:
  - `actorSnapshotsHashAfterStep`
  - `actorSnapshotFrameIdAfterStep`
- `resolveAgentSnapshotsAfterStep()` is the canonical read path for prefix
  checkpoint recovery. It supports current frame refs and keeps a legacy inline
  snapshot fallback for older in-memory artifacts.
- `validateMatchArtifactIntegrity()` now validates the frame store and refs:
  - frame version/kind
  - duplicate/missing frame ids
  - frame id matches `agent-snapshot:${agentsHash}`
  - frame payload hash matches `agentsHash`
  - full player coverage in each frame
  - duplicate/unknown/missing player ids inside frames
  - trajectory step frame refs point to real frames
  - trajectory step frame hash matches the referenced frame
  - social step frame refs point to real frames
  - social step frame hash matches the referenced frame
  - social step refs/hashes stay aligned with the matching trajectory step
  - final successful snapshot still matches final artifact agents
- JSONL trajectory export now emits `agent_snapshot_frame` summary records with
  `frameId`, `agentsHash`, and `agentCount` only.
- JSONL step, trace, and social-step records include frame refs/hashes but do
  not include full frame `agents`, `privateMemos`, social journals, or embedded
  snapshot arrays.
- Checkpoints remain self-contained restore artifacts:
  - prefix checkpoints resolve selected agents from the frame store
  - checkpoint `agents` remains the restore truth
  - checkpoint trajectories strip snapshot arrays, snapshot hashes, and frame
    refs before checkpoint hashing
  - checkpoint/fork recovery never depends on the parent match artifact's frame
    store after the checkpoint is produced
- Redaction and hashes are now ordered safely:
  - `buildMatchArtifact()` redacts the artifact
  - snapshot frames are rehashed and deduplicated after redaction
  - trajectory/social step frame refs and hashes are retargeted to the redacted
    canonical frames
  - redactable strings in captured private memos no longer leave stale frame
    hashes or raw secret-like text in artifacts
- Server checkpoint/fork request bodies explicitly reject client-submitted
  frame, snapshot, and provenance-hash fields:
  - `agentSnapshotFrames`
  - `agentSnapshotsAfterStep`
  - `actorSnapshotsAfterStep`
  - `agentSnapshotsHashAfterStep`
  - `actorSnapshotsHashAfterStep`
  - `agentSnapshotFrameIdAfterStep`
  - `actorSnapshotFrameIdAfterStep`
  - `stateHash`
  - `trajectoryHash`
  - `agentsHash`
  - `socialMessagesHash`

Important semantics:

- The artifact frame store is storage optimization plus recoverability
  evidence, not an agent abstraction.
- The environment and checkpoint builders remain the authority for replay and
  fork state. React/API clients must not submit or mutate snapshot frames.
- `agentSnapshotsHashAfterStep` and `actorSnapshotsHashAfterStep` are evidence
  hashes over the resolved redacted frame payloads in persisted artifacts.
- A present frame id is strict evidence: if it points to a missing frame or a
  frame whose hash does not match the step hash, artifact integrity fails.
- Hash-only lookup remains only a compatibility fallback when old artifacts do
  not have frame ids.
- `recordAgentSnapshots: false` still disables frame creation for long runs
  that do not need prefix checkpoint recovery.

Remaining debt:

- Runtime can still capture full snapshots and let `buildMatchArtifact()`
  normalize them. A later runtime/storage optimization can write frames
  directly during run execution or move frame payloads into a separately
  addressed sidecar while preserving the same resolver/checkpoint invariants.
- Prefix checkpoint selector branch coverage can still be expanded for every
  error code, but the artifact/server redline tests now cover frame integrity,
  JSONL redaction, persistence rehydrate, and raw body injection.

Validation completed for this slice:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/artifacts.test.ts tests/serverCheckpointApi.test.ts tests/serverMatchArtifactsApi.test.ts --reporter=dot
npm run build
npx vitest run tests/replay.test.ts tests/werewolfAdapter.test.ts tests/tournamentArtifacts.test.ts tests/serverPublicViewApi.test.ts tests/serverTournamentArtifactsApi.test.ts --reporter=dot
npm test -- --reporter=dot
```

Observed results:

```text
typecheck passed
artifact/checkpoint/server persistence targeted tests passed: 3 files / 34 tests
production build passed
replay/werewolf/tournament/public API adjacent tests passed: 5 files / 54 tests
full test suite passed: 21 files / 216 tests
```

### 13.18 Standard Provider Protocol Boundary

Current completed provider-boundary slice:

```text
provider.standard-protocol-adapters.v1
```

Latest user correction:

```text
Do not special-case the current hosted model provider.
Implement standard OpenAI-compatible Chat Completions, OpenAI Responses, and
Anthropic Messages/SDK-shaped protocol adapters.
Concrete endpoint/model ids are runtime config, not source defaults.
```

Policy:

- Do not infer protocol from a model name.
- Do not branch on hosted model/provider strings such as concrete vendor names,
  model-family names, or private deployment slugs.
- Do not add `if model.includes(...)` routing for endpoint, headers, body,
  parser, retry, or usage mapping.
- Do not mix protocol parsers. Chat Completions SSE chunks, Responses events,
  and Anthropic Messages events are separate adapter contracts.
- Keep the harness reasoner boundary protocol-neutral. The harness depends on
  `ModelClient.complete()` and normalized telemetry, not on a Chat-specific
  SDK shape.
- OpenAI-compatible Chat Completions remains the default protocol for the
  configured local provider unless `LLM_PROVIDER_PROTOCOL` explicitly selects a
  different standard protocol.
- OpenAI Chat/Responses live requests must not send `max_tokens`,
  `max_completion_tokens`, `max_output_tokens`, or equivalent max-token fields
  unless the user explicitly changes the policy.
- Anthropic Messages is a distinct standard protocol. The Anthropic Messages
  API/SDK requires a `max_tokens` request field, so this adapter requires
  explicit `ANTHROPIC_MAX_TOKENS`. Do not route Anthropic-shaped requests
  through the Chat adapter, and do not enable Anthropic live validation unless
  the max-token policy conflict is explicitly accepted for that protocol.
- Placeholder model ids in checked-in docs and fixtures should be generic, for
  example `model-a`, `model-b`, `model-wolf`, `model-village-a`, and
  `model-village-b`. They are contract examples, not proof of live provider
  validation.
- Concrete live model ids may appear only in local runtime configuration,
  historical validation records, or explicitly marked live validation commands.
  Do not mechanically erase historical audit evidence, but do not introduce new
  provider-specific defaults in source, public docs, checked-in experiments, or
  UI fallback lists.

Implemented code boundary:

- `src/agents/modelClient.ts` defines the protocol-neutral `ModelClient`,
  `ModelCompletionRequest`, and `ModelCompletionResult` contract.
- `src/agents/openaiClient.ts` remains the OpenAI-compatible Chat Completions
  adapter and preserves the no-max-token streaming request body.
- `src/agents/openaiResponsesClient.ts` implements a separate OpenAI Responses
  adapter using `input`/`instructions` and `response.output_text.delta` /
  `response.completed` stream events.
- `src/agents/anthropicMessagesClient.ts` implements a separate Anthropic
  Messages adapter using `system`, `messages`, explicit `max_tokens`, and
  `content_block_delta` / `message_stop` stream events.
- `src/agents/providerRegistry.ts` selects adapters only through
  `LLM_PROVIDER_PROTOCOL`:
  - `openai-chat-completions`
  - `openai-responses`
  - `anthropic-messages`
- Server and CLI defaults now create reasoners through
  `modelClientFromEnv()` rather than directly constructing a Chat-specific
  client.
- Server config exposes a protocol-aware provider summary while retaining
  `chatCompletionsUrl` only as a backward-compatible field for the current UI.

Validated behavior:

- Checked-in reusable examples were moved away from concrete provider/model
  defaults:
  - `.env.example`
  - `README.md`
  - `docs/social-harness.md`
  - `experiments/wolf-vs-village.json`
  - `src/App.tsx` placeholder model defaults
  - CLI usage strings
- Provider redaction patterns were generalized from a hosted-provider prefix to
  a generic long provider-token shape. The regex was then narrowed to avoid
  corrupting metric ids such as long social-evaluator metric names.
- Unit tests cover:
  - Chat Completions explicit endpoint config and no default provider URL.
  - Chat Completions streaming requests without max-token fields.
  - OpenAI Responses body shape and stream event parser.
  - Anthropic Messages body shape and stream event parser.
  - Explicit protocol registry selection and Anthropic `max_tokens` requirement.

Validation completed for this slice:

```bash
node -e "JSON.parse(require('fs').readFileSync('experiments/wolf-vs-village.json','utf8')); console.log('spec json ok')"
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/providerAdapters.test.ts tests/openaiClient.test.ts tests/experiment.test.ts tests/serverPublicViewApi.test.ts tests/serverCheckpointApi.test.ts --reporter=dot
npm run build
npm test -- --reporter=dot
LLM_TIMEOUT_MS=90000 LLM_RETRY_COUNT=0 npm run agent:probe -- --timeout=90s
```

Observed results:

```text
spec JSON parse passed
typecheck passed
provider/fixture/server focused tests passed: 5 files / 42 tests
production build passed
full test suite passed: 22 files / 223 tests
real streaming provider probe passed: 3 configured models succeeded, 0 failed,
with completed harness turns and no fallback path
```

Important validation distinction:

- These adapter tests are deterministic protocol unit tests, not live provider
  validation.
- Do not claim the Responses or Anthropic live path works until a real
  streaming call is made with explicit runtime configuration, the adapter parses
  the stream, the reasoner output is accepted by policy/arbitration, and the
  environment transition is recorded.

### 13.19 Shadcn-Only Frontend UI Lock

Latest user correction:

```text
Frontend UI must use real shadcn UI components.
Do not hand-roll CSS/components.
Do not claim shadcn compliance while App.tsx and styles.css still contain a
parallel custom visual system.
```

Current audit result:

- The repository has real generated shadcn/Radix components in
  `src/components/ui/*`, configured through `components.json`.
- `src/App.tsx` imports and uses many shadcn components.
- However, the current frontend is **not shadcn-only**. It still contains many
  hand-rolled page-level components and a large custom CSS visual system in
  `src/styles.css`.
- Future agents must not report the UI as compliant until the custom class
  system is removed or narrowed to the allowed token/base-layer boundary.

Allowed CSS boundary:

- shadcn/Tailwind imports
- shadcn CSS variables and theme tokens
- dark-mode token overrides
- font imports and font token mappings
- minimal base layer needed by shadcn/Tailwind

Disallowed ongoing pattern:

- New `.sim-*`, `.research-*`, `.arena-*`, `.society-*`, `.trace-*`,
  `.checkpoint-*`, `.fork-*`, `.role-*`, `.seat-*`, `.status-*`,
  `.metric-*`, `.artifact-*`, `.usage-*`, `.reward-*`, `.belief-*`, or similar
  semantic visual classes.
- Global CSS overrides of shadcn internal `[data-slot=...]` selectors as a
  styling strategy.
- Native `<article>`, `<a>`, `<button>`, `<input>`, `<select>`, `<textarea>`,
  or custom div structures used as UI widgets when a shadcn component exists.
- Custom animations/responsive layout systems where Tailwind utilities or
  shadcn component variants should own the behavior.

Required UI remediation order:

1. Freeze new custom visual classes.
2. Replace small local UI atoms (`StatusPill`, `MetricTile`, `RuleStat`,
   key-value rows, small stat cards) with shadcn `Badge`, `Card`, `Table`,
   `Progress`, `Separator`, and `Tooltip` compositions.
3. Replace artifact/download actions with `Button asChild` and shadcn button
   variants.
4. Convert list/ledger/message/failure rows to shadcn `Table`, `Card`,
   `ScrollArea`, and `Badge` compositions.
5. Convert shell/nav/forms to shadcn `Tabs`, `Sheet`, `Button`, `Select`,
   `Input`, `Textarea`, and `Card` compositions.
6. Treat relationship graphs, seat rings, timelines, and SVG/absolute-position
   visualizations as non-compliant unless the user explicitly approves a data
   visualization exception or the view is rebuilt with real shadcn components.
7. Add a red-line scan before claiming compliance, for example:

```bash
rg -n 'className=.*(sim-|research-|arena-|society-|trace-|checkpoint-|fork-|role-|seat-|status-|metric-|artifact-|usage-|reward-|belief-)' src/App.tsx
rg -n '^\.(sim|research|arena|society|trace|checkpoint|fork|role|seat|status|metric|artifact|usage|reward|belief)-' src/styles.css
```

React truth-source rule remains unchanged:

- React renders server/API/artifact truth.
- React must not own hidden roles, checkpoint restore state, private agent
  memory, provider protocol selection, or evaluator facts independently from
  the harness/API artifacts.

### 13.20 Latest Live Match And Shadcn Migration Slice

Current completed slice:

```text
react.trace-artifact-panels-shadcn.v1
provider.model-list-standard-id.v1
live.match.streaming-prefix.v1
```

Latest user correction preserved:

```text
Use real shadcn UI components, not a hand-rolled CSS component system.
Run real model matches, not fake smoke tests.
Keep provider integration standard-protocol based and do not special-case the
current hosted model provider.
```

Provider/model-list change:

- `src/agents/schema.ts` now treats comma and whitespace as model-list
  separators, but does **not** split on `/`.
- Rationale: slash is common in standard runtime model ids such as
  `provider/model-name`; splitting on slash breaks the standard provider
  boundary and incorrectly treats one runtime model id as multiple models.
- `tests/providerAdapters.test.ts` now covers slash-containing model ids while
  preserving comma/whitespace list parsing.

UI migration completed in this slice:

- `StatusPill`, `MetricTile`, `ArtifactFileLinks`, `TournamentStatsRow`,
  `ProviderFailureBreakdown`, `ScoreBlock`, `KeyValueRows`, harness trace
  cards, probe cards, replay panels, artifact panels, evaluation report panels,
  tournament artifact browser panels, recovery audit panels, reward rows,
  metric rows, failure rows, episode rows, assignment rows, and belief bars were
  moved onto real shadcn `Card`, `CardHeader`, `CardContent`, `CardTitle`,
  `CardDescription`, `Badge`, `Button`, `Table`, `ScrollArea`, and `Progress`
  compositions.
- Stale CSS for the migrated classes was removed. The targeted migrated-class
  scan over `src/App.tsx` and `src/styles.css` is clean for:
  `usage-panel`, `usage-row`, `evaluation-panel`, `reward-row`,
  `trace-summary`, `trace-metric`, `trace-card`, `trace-head`, `trace-grid`,
  `trace-field`, `trace-section`, `trace-beliefs`, `trace-belief-row`,
  `belief-copy`, `belief-bar`, `metric-record-row`, `failure-row`,
  `episode-row`, `assignment-row`, and `artifact-set-row`.

Important UI limitation:

- The frontend is still **not** fully shadcn-only.
- Remaining high-priority non-compliant areas include `.sim-*` shell/layout,
  relationship graph visualization, timeline strip, seat ring, role deck,
  `.research-*`, `.society-*`, `.checkpoint-*`, `.fork-*`, and global shadcn
  `[data-slot=...]` overrides.
- Do not report full UI compliance until those remaining areas are rebuilt with
  real shadcn components or the user explicitly approves a narrow data
  visualization exception.

Real live match validation completed:

```bash
mkdir -p artifacts
LLM_STREAM=true LLM_TIMEOUT_MS=180000 LLM_RETRY_COUNT=0 \
  npm run arena:match -- \
  --maxTransitions=2 \
  --timeout=180s \
  --json=summary \
  --export=artifacts/live-match-smoke.json \
  --exportJsonl=artifacts/live-match-smoke.jsonl
```

Observed result:

```text
provider protocol: openai-chat-completions
models from env: 3 configured models
status: truncated
truncation reason: maxTransitions 2 reached before terminal state
harness turns: 1
harness errors: 0
model actually called in this short prefix: minimax-m3
command committed: seer.inspect
stream enabled: true
stream completed: true
stream completedBy: done_sentinel
prompt tokens: 476
completion tokens: 645
average model latency: 17071ms
exports:
  artifacts/live-match-smoke.json
  artifacts/live-match-smoke.jsonl
```

Important validation distinction:

- This was a **real streaming match prefix**, not a fake smoke test.
- It proves the configured OpenAI-compatible chat-completions path can complete
  a streamed model decision, pass local reasoner parsing, pass policy/action
  arbitration, commit a legal Werewolf command, and record an artifact.
- Because `--maxTransitions=2` reaches only one agent decision, it does not
  prove every configured model completed in one match. Use `npm run agent:probe`
  over all models or a longer tournament when the goal is all-model coverage.
- The run is intentionally truncated before game over; it is a live provider
  path validation, not a complete Werewolf game outcome.

Validation completed for this slice:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/providerAdapters.test.ts tests/openaiClient.test.ts tests/werewolfAdapter.test.ts tests/harness.test.ts --reporter=dot
npm run build
LLM_STREAM=true LLM_TIMEOUT_MS=180000 LLM_RETRY_COUNT=0 npm run arena:match -- --maxTransitions=2 --timeout=180s --json=summary --export=artifacts/live-match-smoke.json --exportJsonl=artifacts/live-match-smoke.jsonl
node -e "<artifact stream telemetry check over artifacts/live-match-smoke.json>"
```

Observed results:

```text
typecheck passed
focused tests passed: 4 files / 47 tests
production build passed
real streaming match prefix passed and artifact stream telemetry showed
enabled=true, completed=true, completedBy=done_sentinel
```

### 13.21 Latest P0 Visualization And Society UI Migration Slice

Current completed slice:

```text
react.p0-visualizations-shadcn.v1
react.society-cockpit-shadcn.v2
```

Scope completed:

- `RelationshipGraphPanel` no longer renders a hand-rolled SVG/absolute
  positioned graph canvas. It now renders harness social truth as shadcn
  `Card`, `Tabs`, `Button`, `ScrollArea`, `Table`, `Badge`, and summary cards.
- `EventTimelineStrip` no longer renders a custom dot/marker timeline. It now
  renders the latest events as a shadcn `Card` with `ScrollArea`, `Table`, and
  `Badge` rows.
- `SeatRing` no longer renders CSS-trigonometry seat cards. It now renders
  public seat state as shadcn `Card`, `Avatar`, and `Badge` compositions.
- `RoleDeck` no longer renders native `article.role-card` cards. It now uses
  shadcn `Card` and `Badge`.
- The social evidence cockpit no longer depends on the `society-cockpit`,
  `society-hero`, `society-card`, `society-scroll`, `society-message-row`,
  `society-ledger-row`, `society-progress`, `society-map`, or related
  `.society-*` CSS classes. The UI still renders the same artifact/API truth
  but via shadcn components and Tailwind utilities.
- `artifact-panel`, `trace-list`, artifact browser actions, and recovery audit
  panel/action/table wrapper classes were removed from the React surface and
  CSS where migrated.

Targeted removed-class scans are clean for:

```text
sim-graph*
sim-edge-path
sim-timeline*
table-stage
moon-disc
disc-lines
table-label
seat-card / seat-avatar / seat-copy / seat-flags
role-deck / role-card / role-*
artifact-panel
trace-list
artifact-browser-actions
recovery-audit-* wrapper classes migrated in this slice
society-cockpit / society-hero / society-card / society-scroll
society-map / society-ledger / society-message / society-progress
```

Important remaining UI limitation:

- The frontend is still **not** fully shadcn-only.
- Remaining large non-compliant areas include:
  - `.sim-*` shell/layout/sidebar/topbar/agent list/detail/spec panels
  - `.research-*` shell/header/grid/forms/artifact registry panels
  - `.checkpoint-*` and `.fork-*` checkpoint/fork lineage panels
  - older Werewolf-specific `.arena-*`, `.phase-*`, `.action-*`, `.log-*`,
    `.message-*`, and related semantic CSS
  - global shadcn `[data-slot=...]` overrides in `src/styles.css`
- Do not report full UI compliance until these remaining areas are rebuilt
  with real shadcn components/Tailwind utilities or explicitly approved as a
  narrow visualization exception.

Validation completed for this slice:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npm run build
rg -n "<migrated class names>" src/App.tsx src/styles.css
```

Observed results:

```text
typecheck passed
production build passed
targeted migrated-class scans returned no matches
red-line scan still reports remaining historical custom UI classes, so full
shadcn-only compliance is not yet achieved
```

### 13.22 Latest Real Server Match And Cockpit Graph Slice

Current completed slice:

```text
react.server-owned-artifact-autoload.v1
react.social-graph-cockpit-v1
live.server-owned-streaming-match.v1
```

Latest user correction preserved:

```text
Use real model calls and real harness artifacts.
Frontend must use real shadcn UI components and must not present fake data.
Provider integration must remain standard-protocol based; do not special-case
the current hosted provider or model names.
```

Scope completed:

- React startup now tries to load the latest server-owned match through the
  existing `GET /api/matches` and `GET /api/matches/:id/artifact` routes.
- The topbar has a real `加载最近` action that reloads the latest server-owned
  match artifact. It does not read local files and does not fabricate state.
- Default UI match run bound was tightened to `maxTransitions=8` so a cockpit
  run is a bounded real harness episode instead of an unbounded long UI request.
- The static `执行接口已连接` badge now reflects the provider summary returned
  by `/api/config` instead of being hard-coded.
- Disabled placeholder controls for sidebar collapse, pause, settings, and
  ending a run were removed or replaced by real navigation to `#run-config`.
- The agent list `+` button now links to the real experiment/profile
  configuration section instead of being a disabled fake control.
- Custom `.spin` CSS was removed; loading icons use Tailwind `animate-spin`.
- `RelationshipGraphPanel` now includes a real social graph visualization
  derived from the harness artifact's social graph bundle. Nodes and edges are
  computed from submitted trajectory, message bus, scoped observations, and
  agent social state. Clicking a node still selects the agent for the shadcn
  right-side detail rail. The graph is a data visualization inside shadcn
  `Card`/`Tabs`/`Button` surfaces, not a source of truth.
- `run-config` anchoring now points to the experiment specification panel, not
  to KPI cards.

Real live server-owned match validation completed:

```text
POST /api/matches/run
profiles:
  wolf -> kimi-k2.7 / wolf-deceiver
  village-a -> deepseek-v4-flash / village-analyst
  village-b -> minimax-m3 / seer-information
assignment:
  werewolves -> wolf
  village -> village-a, village-b
maxTransitions: 8
timeoutMs: 180000
```

Observed live result:

```text
HTTP status: 200
match id: ceca3bcc-84c2-4b5e-9e2a-649fcb47b0cf
server status: completed
harness status: truncated
truncation reason: maxTransitions 8 reached before terminal state
hasArtifact: true
trajectory steps: 7
harness errors: 0
harness turns: 7
stream completed steps: 7/7
models observed in committed trajectory:
  deepseek-v4-flash
  kimi-k2.7
  minimax-m3
```

Replay validation for that server-owned artifact:

```text
POST /api/matches/ceca3bcc-84c2-4b5e-9e2a-649fcb47b0cf/replay
ok: true
replayedCommands: 7
trajectorySteps: 7
finalHashMatchesArtifact: true
mismatchCount: 0
```

Validation completed for this slice:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npm run build
npm test -- --reporter=dot
rg -n 'className=.*(sim-|research-|arena-|society-|trace-|checkpoint-|fork-|role-|seat-|status-|metric-|artifact-|usage-|reward-|belief-)' src/App.tsx
rg -n '^\.(sim|research|arena|society|trace|checkpoint|fork|role|seat|status|metric|artifact|usage|reward|belief)-' src/styles.css
npx --yes playwright@latest screenshot --wait-for-timeout=5000 --viewport-size=1600,1000 http://127.0.0.1:5176/ artifacts/ui-live-graph-refined-desktop.png
```

Observed validation results:

```text
typecheck passed
production build passed
full deterministic suite passed: 22 files / 224 tests
red-line custom semantic class scans returned no matches
desktop browser screenshot rendered the live server-owned artifact cockpit with
real social graph, messages, relationship counts, agent detail rail, and run id
```

Important limitation:

- The server-owned live artifact above is currently held by the running dev API
  process unless the API is started with `MATCH_ARTIFACT_BASE_DIR`. If the API
  process restarts without a match artifact base directory, the UI can still run
  new real matches, but that in-memory match will not rehydrate from disk.
- The React graph is a data visualization inside shadcn surfaces. Do not treat
  it as harness authority; the artifact/API remains the source of truth.
- CLI-exported artifacts under `artifacts/*.json` are valid replay artifacts,
  but they are not automatically registered into the server-owned match index
  unless they are produced through the server artifact persistence path.

### 13.23 Latest Cockpit Interaction Feedback Fix

Current completed slice:

```text
react.cockpit-interaction-feedback.v1
e2e.public-cockpit-click-regression.v1
```

Latest user complaint preserved:

```text
前端点击任何东西都没有反应
```

Diagnosis:

- Browser automation showed React click handlers were not globally dead, but
  the UI often made successful clicks look inert because feedback was either a
  small topbar badge, a brief spinner, or a local panel change.
- Several real controls had insufficient completion/failure feedback:
  checkpoint creation, checkpoint fork, tournament artifact refresh, recovery
  audit filtering, graph view switching, detail tabs, and local truth toggles.
- The previous e2e test accepted a no-artifact state and then continued to
  click artifact-only controls, so it was not a reliable regression test.
- The previous replay locator matched both `复现` and `刷新复现证据`, causing a
  strict-mode Playwright failure unrelated to the actual replay API.
- Startup `loadLatestServerMatch({ silent: true })` and manual match/fork writes
  could race on the same `match`/`artifact` state. Newer writes now guard older
  stale responses through a local sequence ref.

Scope completed:

- Added a prominent shadcn `Card` status region below the topbar. It displays
  the current activity message, selected agent, active evidence tab, run id,
  artifact loaded state, match/artifact consistency, and replay status.
- Marked the topbar status badge as a polite live status region.
- Added explicit activity messages for:
  - agent selection
  - agent search/filter changes
  - graph view changes
  - graph expansion/collapse
  - evidence tab changes
  - detail panel relation/goal/memory/decision tab changes
  - detail decision-summary mode changes
  - postgame truth and private evidence toggles
  - checkpoint create start/success/failure
  - checkpoint fork start/success/failure
  - tournament artifact refresh start/success/failure
  - recovery audit refresh/filter/page changes
  - replay start/success/failure
  - latest server-owned match load start/success/failure
- Recovery audit filter selects now immediately call the real
  `/api/artifact-recovery-audits` route with the selected filter values instead
  of only mutating local select state.
- Replay is enabled only when the loaded artifact belongs to the current match.
  The replay action also rejects mismatched match/artifact state with a visible
  error instead of sending a confusing replay request.
- Match/fork/latest-load state writes now use a local stale-response guard so
  older async responses do not overwrite newer run state.
- The public cockpit e2e now:
  - waits for the real `GET /api/matches` response after clicking `加载最近`
  - requires a real server-owned artifact to be loaded
  - clicks exact `复现`, not `刷新复现证据`
  - verifies visible status feedback for agent selection, truth toggles,
    private evidence toggle, detail tabs, graph view switch, and replay success
  - asserts real API failures do not occur

Files changed in this slice:

```text
src/App.tsx
e2e/cockpitInteraction.spec.ts
AGENTS.md
```

Validation completed:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npm run build
npm test -- --reporter=dot
PLAY_URL=http://24.199.119.192:5176/ npm run test:e2e -- --reporter=line --workers=1
npx playwright screenshot --wait-for-timeout=3000 --viewport-size=1600,1000 http://127.0.0.1:5176/ artifacts/ui-interaction-feedback.png
```

Observed validation results:

```text
typecheck passed
production build passed
full deterministic suite passed: 22 files / 224 tests
public Playwright cockpit interaction test passed: 1/1
interaction screenshot saved:
  artifacts/ui-interaction-feedback.png
```

Current public URLs:

```text
frontend: http://24.199.119.192:5176/
api config: http://24.199.119.192:8787/api/config
```

Important limitations:

- The server-owned live match used by the cockpit remains process-memory backed
  unless the API is started with `MATCH_ARTIFACT_BASE_DIR`.
- The e2e verifies current public cockpit interactions and real API responses;
  it does not run a new live model match on every test run.
- This slice fixes click feedback and regression coverage. It does not claim
  complete shadcn-only UI compliance for every remaining historical panel.

### 13.24 Cockpit Redesign Pass 1

Current completed slice:

```text
react.cockpit-redesign-pass1.v1
```

Latest active goal preserved:

```text
UI丑爆了,你现在写的全是bug,给我重做
```

Design reference used:

```text
/root/wererwolf1/96af5c3f-1022-44b2-9aca-ef677a0ec829.png
```

Scope completed:

- Reworked the first-viewport cockpit toward the provided reference image:
  left navigation, left Agent list, central KPI strip, central social graph,
  visible event timeline entry point, and right Agent detail rail.
- Removed the large main-area interaction status card from the first viewport.
  The topbar status badge remains the live `role=status` feedback channel, so
  button feedback is still visible and testable without pushing the graph down.
- Moved the KPI strip above the postgame/privacy banner so the cockpit opens
  with metrics first, matching the reference platform layout.
- Compressed the postgame/privacy banner into a compact evidence-permission row
  while keeping the real `显示赛后真相` and `显示私有证据` controls.
- Redesigned the sidebar using shadcn `Button`, `Card`, and `Avatar` surfaces:
  clearer product title, active nav affordance, and current experiment card.
- Restyled the topbar into a tighter command toolbar while preserving real
  controls: run, replay, load latest, export, compare, density, and streaming
  probe.
- Restyled the Agent list:
  - clearer title and selected state
  - blue selected-row treatment
  - shadcn cards/buttons/tabs remain the UI surface
  - no hidden game truth is moved into React state
- Restyled KPI cards with distinct icon color surfaces and denser values.
- Reworked the relationship graph as the main visual:
  - larger graph area within the central column
  - narrower legend rail
  - header count badges for visible actors and edges
  - graph nodes show concise labels only to avoid overlap
  - detailed actor/edge tables were removed from the main graph card because
    the same evidence is available in the artifact/social evidence panels
- Restyled the right Agent detail rail with stronger selected-agent card,
  clearer resource blocks, and reference-aligned panel hierarchy.
- Restyled the event timeline card title and surface so it appears directly
  below the graph path in the first viewport.
- Adjusted light-theme faction/avatar colors so the cockpit is readable on the
  reference-style white/light background.

Files changed in this slice:

```text
src/App.tsx
AGENTS.md
```

Validation completed:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npm run build
npm test -- --reporter=dot
PLAY_URL=http://24.199.119.192:5176/ npm run test:e2e -- --reporter=line --workers=1
npx playwright screenshot --wait-for-timeout=3000 --viewport-size=1600,1000 http://127.0.0.1:5176/ artifacts/ui-redesign-pass6.png
```

Observed validation results:

```text
typecheck passed
production build passed
full deterministic suite passed: 22 files / 224 tests
public cockpit Playwright interaction test passed: 1/1
redesign screenshot saved:
  artifacts/ui-redesign-pass6.png
```

Current public URL:

```text
frontend: http://24.199.119.192:5176/
```

Important limitations:

- This is a first redesign pass, not a claim that every historical lower panel
  is fully rebuilt or fully beautiful.
- The first viewport is now aligned with the provided reference cockpit, but
  lower evidence, tournament, checkpoint, and diagnostics sections still need
  further design passes before the full app can be called finished.
- The UI still respects harness/API/artifact truth boundaries; no hidden roles,
  winners, metrics, replay proof, or social state were moved into frontend-only
  truth.

### 13.25 Latest Harness Cockpit Framework And Evidence UI Pass

Current completed slice:

```text
react.harness-cockpit-evidence-ui-pass2.v1
react.shadcn-click-feedback-hardening.v1
react.agent-ledger-drilldown.v1
e2e.research-evidence-log-tab-regression.v1
```

Latest active goal preserved:

```text
去调研真正的适合这个系统的UI框架,全局使用这个UI框架和组件,不得自己造css,必须每一处UI必须精致,排布整齐,必须前后端对接完整
```

Framework decision:

- Keep **shadcn/ui + Radix primitives** as the global component layer already
  present in `src/components/ui/*`.
- Treat custom SVG/social graph visuals as visualization exceptions only when
  they are inside shadcn surfaces and bound to real artifact evidence.
- Use shadcn `Card`, `Button`, `Tabs`, `Table`, `Select`, `Badge`,
  `ScrollArea`, `Progress`, `Tooltip`, `Input`, and `Textarea` for cockpit
  interaction surfaces.
- Do not introduce a new parallel UI component framework in this slice. The
  current best path is to finish shadcn migration and add specialized data
  libraries later only where they solve real UI workload:
  - TanStack Table for larger sortable/filterable evidence tables.
  - React Flow for graph/branch/tree interaction only if it is connected to
    real `traceId`, `messageSeq`, `evidenceRefs`, checkpoint, or fork data.

External research used:

- LangGraph persistence/checkpoint/time-travel patterns:
  `https://docs.langchain.com/oss/javascript/langgraph/persistence`
- LangGraph Studio agent graph/debug UI concept:
  `https://langchain-ai.github.io/langgraph/concepts/langgraph_studio/`
- LangSmith observability trace/evaluation concepts:
  `https://docs.langchain.com/langsmith/observability-concepts`
- Langfuse traces/sessions data model:
  `https://langfuse.com/docs/observability/data-model`
  and `https://langfuse.com/docs/observability/features/sessions`
- Arize Phoenix AI observability/evaluation docs:
  `https://arize.com/docs/phoenix/`
- W&B Weave observability/evaluation docs:
  `https://docs.wandb.ai/weave`
- AgentOps trace/session dashboard docs:
  `https://docs.agentops.ai/v2/concepts/traces`
  and `https://docs.agentops.ai/v2/usage/dashboard-info`
- OpenTelemetry semantic conventions:
  `https://opentelemetry.io/docs/specs/semconv/`
- PettingZoo Parallel API documentation:
  `https://pettingzoo.farama.org/main/api/parallel/`
- Concordia social simulation framework:
  `https://github.com/google-deepmind/concordia`
- AIWolf protocol:
  `https://aiwolf.org/en/protocol`
- AutoGen Studio documentation:
  `https://autogenhub.github.io/autogen/docs/autogen-studio/getting-started/`

Subagent audits consumed:

- External UI/UX research scout concluded the cockpit should be
  artifact-first observability: trace, message, evaluator evidence, replay,
  checkpoint/fork, diagnostics, and tournament artifacts must be the primary
  UI payload.
- Local shadcn audit confirmed real shadcn/Radix components exist and are used,
  but identified remaining custom visual regions, static-looking controls,
  invalid `href="#"` download risks, and disabled buttons without enough
  feedback.
- Harness/API truth mapping audit confirmed current major data paths are real
  API/artifact/harness state, while flagging preview state, decorative trend
  charts, static agent goal/memory text, and incomplete comparison semantics as
  risks.

Scope completed:

- Reordered the central cockpit so the research evidence table appears directly
  after the timeline instead of being pushed below duplicated event/analytics
  blocks.
- Added a real `日志` tab to `EvidenceTabsPanel`. This fixes the historical
  mismatch where `CockpitTab` allowed `log` but the tabs had no `log` trigger
  or content.
- Moved `EventLogPanel` into the research evidence tabs so logs are a real
  evidence view rather than a duplicate standalone block.
- Updated e2e coverage to click the new `日志` tab and assert visible feedback
  and the real event log surface.
- Left navigation now has explicit active-section feedback and reports
  navigation actions through the live activity status.
- Fixed navigation anchors:
  - `场景说明` now targets the truth/evidence boundary panel, not the sticky
    topbar.
  - `实验记录` now targets the research evidence workbench.
  - right-side artifact mini registry was moved to `artifact-registry`.
- Replaced the decorative averaged `cumulativeSeries()` trend with
  `buildEvidenceTrendSeries()`, which only uses real artifact trajectory turn
  indexes, social message sequence numbers, and metric record ordinals. If no
  real records exist, the chart stays empty instead of drawing fake progress.
- Rebuilt the Agent detail tabs for real artifact data:
  - `目标` reads `agent.social.goals.goals` and shows an explicit empty state
    when the artifact does not record goals.
  - `记忆` reads `agent.social.memory.entries`, `agent.social.beliefs.claims`,
    and `agent.privateMemos`, with private content hidden unless the private
    evidence toggle is enabled.
  - `决策` reads `artifact.trajectory.filter(step.actorId === agent.id)` and
    shows committed pending action / command / hash information.
  - decision summary now includes `agentState.socialStateHash` and policy name
    when present.
- Relationship graph labels were tightened:
  - node overlap was reduced by showing external node labels only for the
    selected node.
  - SVG nodes and edges now include evidence-oriented `<title>` text for hover
    inspection.
- Agent faction tabs no longer show `红方(0)/蓝方(0)` when postgame truth is
  hidden; they show `真相隐藏` until truth display is enabled.
- Turning postgame truth back off resets faction filtering to avoid empty
  hidden-truth lists.
- Artifact file links no longer render clickable `href="#"` fallbacks. Missing
  download URLs now render disabled shadcn buttons with tooltip explanations.
- Tournament artifact selection in the main evidence tab now selects and loads
  analytics consistently, matching the mini registry behavior.
- Recovery audit pagination now uses disabled-action tooltips at page bounds.
- `SocietyChannelLedger` was moved from custom div rows to shadcn `Table`
  rows.
- Activity status no longer duplicates the provider connected badge after
  config load; it reports loaded model count instead.

Real live match validation for this slice:

```text
POST /api/matches/run
profiles:
  wolf -> kimi-k2.7 / wolf-deceiver
  village-a -> deepseek-v4-flash / village-analyst
  village-b -> minimax-m3 / seer-information
assignment:
  werewolves -> wolf
  village -> village-a, village-b
maxTransitions: 4
timeoutMs: 180000
```

Observed live result:

```text
HTTP status: 200
match id: 1701c10e-987c-4094-be07-2814b45ce401
server status: completed
harness status: truncated
truncation reason: maxTransitions 4 reached before terminal state
hasArtifact: true
trajectory steps: 3
harness errors: 0
harness turns: 3
models observed:
  kimi-k2.7
  deepseek-v4-flash
  minimax-m3
```

Screenshots saved:

```text
artifacts/ui-harness-cockpit-pass2-desktop.png
artifacts/ui-harness-cockpit-pass2-live-artifact.png
artifacts/ui-harness-cockpit-pass2-evidence.png
artifacts/ui-harness-cockpit-pass2-log-tab.png
artifacts/ui-harness-cockpit-pass2-agent-memory.png
```

Validation completed:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npm run build
npm test -- --reporter=dot
PLAY_URL=http://24.199.119.192:5176/ npm run test:e2e -- --reporter=line --workers=1
```

Observed validation results:

```text
typecheck passed
production build passed
full deterministic suite passed: 22 files / 224 tests
public Playwright cockpit interaction test passed: 1/1
```

Current public URLs after this slice:

```text
frontend: http://24.199.119.192:5176/
api config: http://24.199.119.192:8787/api/config
```

Important limitations:

- This slice improves the current cockpit but does not prove full
  shadcn-only completion for every historical component still present in the
  large `src/App.tsx` file.
- The graph remains a custom SVG visualization inside shadcn surfaces. It is
  evidence-backed, but a richer graph inspector or React Flow migration is
  still a future UI slice.
- The `对比工件` control still focuses and loads selected tournament analytics;
  a true artifact-vs-artifact diff view is not implemented yet.
- Postgame/private evidence toggles still hide/show data client-side after an
  artifact is loaded. A future high-assurance redaction slice should add
  server-side actor/public/postgame projections.
- The dev API match store is process-memory backed unless the API is started
  with a match artifact base directory.

### 13.26 Latest Harness Cockpit Projection And Research Lock

Current completed slice:

```text
react.server-artifact-projection-toggle.v1
server.postgame-redacted-artifact-view.v1
e2e.real-artifact-projection-click-regression.v1
research.shadcn-harness-cockpit-implementation.v1
research.multi-agent-harness-society-grounding.v1
research.observability-trace-eval-cockpit.v1
```

Timestamp:

```text
2026-07-06T11:58:40Z
```

Execution result:

- Six subagents were used in parallel for UI framework research, observability
  cockpit research, multi-agent harness research, local UI/API click-path audit,
  server projection audit, and reference-image analysis.
- The main implementation stayed on the critical path and integrated only
  verified findings.
- No `.env` or `.env.local` contents were read, printed, copied into docs, or
  sent to subagents.

Backend/API behavior now established:

- `GET /api/matches/:id/artifact?view=postgame-redacted` returns a server-side
  artifact projection that redacts private evidence while preserving postgame
  truth for research/postgame analysis.
- `GET /api/matches/:id/artifact?view=full` returns the full postgame/debug
  artifact after normal secret redaction.
- Unsupported `view` values return `400`.
- The default backend behavior without a `view` remains `full` for backward
  compatibility, but React cockpit should use explicit `view` parameters.

Frontend behavior now established:

- Initial match artifact loads, run completion loads, latest-match loads, and
  fork completion loads request `view=postgame-redacted` by default.
- The "显示私有证据" button now performs a real server request for
  `view=full`; the "隐藏私有证据" path reloads `view=postgame-redacted`.
- The full artifact is replaced in React state when returning to the redacted
  projection, so private evidence is not merely hidden by a local boolean after
  full data remains loaded.
- The truth/evidence banner displays explicit projection badges:
  - `服务端投影已脱敏`
  - `完整工件私有证据`
  - `赛后真相工件保留`
- The project must not claim that `postgame-redacted` hides postgame truth.
  Current postgame truth visibility is a UI display control over an artifact
  projection that still contains postgame truth. A future public/untrusted UI
  needs a separate server-side truth-redacted projection.
- The right-side artifact refresh control was clarified as refreshing the
  tournament artifact index, not reloading the current match artifact.
- Recovery-audit empty pagination now displays `0 / 0` instead of `1-0 / 0`.
- Dormant artifact download actions now explicitly link to
  `?view=full` and label the download as a full postgame artifact.

Validation completed for this slice:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/serverPublicViewApi.test.ts --reporter=dot
npm run build
npm test -- --reporter=dot
PLAY_URL=http://24.199.119.192:5176/ npm run test:e2e -- --reporter=line --workers=1 --timeout=90000
```

Observed validation results:

```text
typecheck passed
server public/projection API test passed: 1 file / 10 tests
production build passed
full deterministic suite passed: 22 files / 225 tests
public Playwright cockpit interaction test passed after a real server-owned
artifact existed: 1/1
```

Live artifact prerequisite discovered and handled:

- A fresh dev API process may have an empty in-memory match store. In that case,
  clicking "加载最近" correctly cannot load an artifact and cannot issue an
  artifact projection request.
- The Playwright e2e now makes this prerequisite explicit: if `/api/matches`
  contains no artifact-backed match, it creates a real match through
  `/api/matches/run` before testing projection toggles.
- This preserves the user's no-fake-test rule: the test uses real API/harness
  paths and does not fabricate a local artifact.

Live model validation observed in this slice:

```text
POST /api/matches/run
models:
  kimi-k2.7
  deepseek-v4-flash
  minimax-m3
profiles:
  wolf -> kimi-k2.7 / wolf-deceiver
  village-a -> deepseek-v4-flash / village-analyst
  village-b -> minimax-m3 / seer-information
assignment:
  werewolves -> wolf
  village -> village-a, village-b
maxTransitions: 4
timeoutMs: 180000
```

Observed live result:

```text
HTTP status: 200
match id: 1856176c-53d9-4431-9a4d-7f932f42b334
server status: completed
harness status: truncated
truncation reason: maxTransitions 4 reached before terminal state
hasArtifact: true
trajectory steps: 3
profile count: 3
model count: 3
```

Research conclusion: UI framework implementation:

- Do not switch stacks. Continue using real `shadcn/ui` + Radix components as
  the global cockpit shell and interaction primitive layer.
- Tailwind v4 CSS-first usage is compatible with the current setup:
  `@import "tailwindcss"` and `@import "shadcn/tailwind.css"`.
- Complex visualizations are allowed only as embedded evidence visualizations
  inside shadcn/Radix surfaces:
  - Recharts/shadcn `Chart` for metric trends and cost/latency.
  - TanStack Table state with shadcn `Table` for large sortable/filterable
    artifact, trajectory, failure, and metric tables.
  - React Flow for checkpoint/fork trees, scheduler DAGs, and action pipelines
    when those nodes/edges reference real trace/checkpoint/fork data.
  - Sigma.js/WebGL or D3/SVG/canvas only for large or bespoke evidence-backed
    social graphs and replay timelines.
- Visualization libraries draw the data. shadcn/Radix owns panels, tabs,
  filters, buttons, empty states, tooltips, sheets, dialogs, keyboard/focus, and
  inspector controls.

Research conclusion: reference image interpretation:

- The reference image should be treated as a multi-agent social simulation
  cockpit information architecture, not a decorative theme.
- The product structure to preserve:
  - persistent left navigation
  - agent roster with search/filter/selection
  - top run toolbar
  - evidence-backed KPI strip
  - central social graph/map
  - event timeline
  - event/evidence log table
  - right-side selected-agent drilldown
  - lower analytics and diagnostics
- Do not copy resource, alliance, trend, edge, or score concepts unless the
  harness/API/artifact actually records them.
- Empty, sparse, failed, truncated, or redacted artifact states are correct UI
  states. Do not fill them with fake edges, fake progress, fake cost, fake
  latency, fake trust, or fake deception metrics.

Research conclusion: observability/evaluation cockpit:

- Mature tools converge on:
  - run/experiment registry
  - trace/span tree or waterfall
  - eval matrix
  - artifact lineage
  - dashboard/ops health
  - annotation/human feedback sidecars
  - checkpoint/fork/time-travel workflows
- Good external patterns to adapt:
  - LangSmith: project/trace/run/thread, evaluation experiment analysis,
    baseline comparison, trace-linked feedback.
  - LangGraph Studio: graph mode, state schema forms, thread history,
    checkpoint fork/edit/re-run.
  - AgentOps: trace list/detail, timeline, span tree, multi-agent trace tags.
  - Arize Phoenix: OpenTelemetry/OpenInference spans, datasets, evals,
    annotations.
  - W&B Weave: Op/Call/Trace/Thread, trace tree, comparison, datasets,
    scorers, leaderboards.
  - W&B Artifacts and MLflow: versioned inputs/outputs, run params, metrics,
    artifacts, downloadable lineage.
- Translate these into project-specific cockpit modules:
  - `RunRegistryPanel`
  - `TraceTree` / waterfall inspector
  - `SocietyVisibilityInspector`
  - `EvaluationWorkbench`
  - `ArtifactLineagePanel`
  - `ExperimentStudio`
  - `OpsHealthPanel`
- These modules must emphasize this project's unique objects:
  scoped observations, message exposure, agent social state, legal command
  arbitration, environment transition hashes, checkpoint/fork provenance, and
  evaluator evidence refs.

Research conclusion: harness architecture:

- Preserve environment authority as a hard boundary. Agents propose actions and
  messages; the harness/domain adapter validates, commits, hashes, records, and
  evaluates.
- Support both AEC/sequential scheduling and parallel/joint-barrier scheduling.
  Do not implement parallel phases as uncontrolled `Promise.all` mutations.
- Observations must be first-class artifact records with actor-specific
  visibility, redaction, legal actions, source state hash, and exposure refs.
- Communication must be a harness-owned message bus with explicit channels,
  delivery/exposure records, redaction classes, ordering, and causality refs.
- Agent state must include memory, beliefs, relationships, reputation, norms,
  commitments, goals, policy state, reasoner state summary, and decision
  history, all with evidence refs.
- Replay is model-free audit replay from committed commands and state hashes.
  Fork/rerun is a separate provenance workflow that may call models again.
- Evaluation should be deterministic/evidence-first by default. Model-graded
  evaluation may exist as a separate qualitative assist, not the foundation of
  truth.
- Tournament reporting must keep invalid actions, timeouts, parser failures,
  provider errors, stream aborts, truncations, and recovery failures in the
  denominator.

Important remaining limitations:

- `postgame-redacted` does not hide postgame truth. A future
  `truth-redacted`/public artifact view is required for untrusted public
  sharing.
- Relationship/reputation/norm/coalition/gossip social ledgers may still carry
  private social inferences in the redacted projection. The next redaction pass
  should audit and project every social-state ledger, not only memory, beliefs,
  goals, private memos, and social messages.
- Private/team message content is redacted, but topology metadata such as
  sender, channel, recipient ids, visibility, and some metadata remains visible.
  Decide explicitly whether hidden private topology should be visible in the
  postgame-redacted research view.
- The graph remains custom SVG inside shadcn surfaces. This is acceptable as an
  evidence-backed visualization, but a richer React Flow/Sigma/D3 migration
  should only happen after the corresponding artifact view models are stable.
- `对比工件` is still not a true artifact-vs-artifact diff. It should become a
  real comparison view over run/eval/artifact lineage.
- The dev API match store is still process-memory backed unless started with an
  artifact base directory.

### 13.27 Latest Artifact Interaction Busy Split And Kimi Model Lock

Current completed slice:

```text
react.match-vs-tournament-artifact-busy-split.v1
react.current-match-artifact-reload-action.v1
e2e.current-artifact-reload-regression.v1
live.kimi-k2.7-match-validation.v1
```

Timestamp:

```text
2026-07-06T12:14:06Z
```

User correction preserved:

- For live model behavior, prefer `kimi-k2.7` because the user wants the model
  that produces stronger reasoning/thinking behavior.
- This is a model-selection rule, not a provider-specific adapter rule. Keep
  OpenAI-compatible / Responses / Anthropic adapter boundaries standard.

Frontend behavior now established:

- `artifactBusy` was split into separate local concerns:
  - `matchArtifactBusy` for current match artifact loads and private-evidence
    projection toggles.
  - `tournamentArtifactBusy` for tournament artifact index refresh, tournament
    export, and tournament analytics loading.
- Topbar behavior now follows those boundaries:
  - `加载最近` is blocked only by current match artifact work or a running
    experiment.
  - `运行并导出` and `对比工件` are blocked by tournament artifact work or a
    running experiment.
  - The activity badge still shows a spinner for any active background work.
- The right-side `实验复现` shadcn panel now has two distinct icon actions:
  - `重载当前对局工件` reloads the active match artifact through
    `/api/matches/:id/artifact?view=...`.
  - `刷新锦标赛工件索引` refreshes `/api/tournament-artifacts`.
- The current-match reload preserves the active private evidence mode:
  - when private evidence is hidden, it reloads `view=postgame-redacted`;
  - when private evidence is shown, it reloads `view=full`.
- The reload path checks that the returned artifact belongs to the current
  match before committing it to React state.
- This avoids the previous UX issue where one broad busy flag could make
  unrelated buttons look unresponsive.

E2E behavior now established:

- `e2e/cockpitInteraction.spec.ts` now waits for a real
  `view=postgame-redacted` artifact request when clicking
  `重载当前对局工件`.
- If the server has no artifact-backed match, the e2e precondition creates one
  through the real `/api/matches/run` route instead of using fake data.
- The e2e artifact precondition now prefers `kimi-k2.7` and assigns generated
  test profiles to that model when available.

Live `kimi-k2.7` validation observed:

```text
POST /api/matches/run
models:
  kimi-k2.7
profiles:
  kimi-wolf -> kimi-k2.7 / wolf-deceiver
  kimi-village-a -> kimi-k2.7 / village-analyst
  kimi-village-b -> kimi-k2.7 / seer-information
assignment:
  profile-rotation
maxTransitions: 4
timeoutMs: 180000
```

Observed live result:

```text
HTTP status: 200
match id: e183d905-ed7f-4180-b5b6-d7e049412ccb
server status: completed
harness status: truncated
truncation reason: maxTransitions 4 reached before terminal state
hasArtifact: true
trajectory steps: 3
profile count: 3
models observed:
  kimi-k2.7
```

Projection check for the live `kimi-k2.7` match:

```text
view: postgame-redacted
privateEvidenceRedacted: true
postgameTruthRedacted: false
trajectory: 3
social messages: 6
models observed in agent records:
  kimi-k2.7
```

Screenshot saved:

```text
artifacts/ui-match-artifact-reload-button.png
```

Validation completed:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/serverPublicViewApi.test.ts --reporter=dot
npm run build
npm test -- --reporter=dot
PLAY_URL=http://24.199.119.192:5176/ npm run test:e2e -- --reporter=line --workers=1 --timeout=240000
```

Observed validation results:

```text
typecheck passed
server public/projection API test passed: 1 file / 10 tests
production build passed
full deterministic suite passed: 22 files / 225 tests
public Playwright cockpit interaction test passed: 1/1
```

Remaining limitation:

- The busy split improves UI responsiveness, but the next design pass should
  continue separating match artifact, tournament artifact, recovery audit,
  checkpoint/fork, and live run progress in the UI so every disabled action has
  a specific visible reason.

### 13.28 Latest Run Registry Cockpit Pass

Current completed slice:

```text
react.run-registry-panel.v1
react.server-match-selection-artifact-load.v1
e2e.run-registry-refresh-and-load-regression.v1
```

Timestamp:

```text
2026-07-06T12:23:49Z
```

Why this slice exists:

- The cockpit previously had `加载最近`, but no true run registry view.
- A research cockpit for a multi-agent harness needs a real run/experiment
  registry so users can inspect and load server-owned matches without pretending
  the most recent run is the only artifact.
- This follows the observability pattern documented in section 13.26:
  Run / Experiment Registry first, then trace, eval, artifact, replay, and
  diagnostics.

Frontend behavior now established:

- `CockpitTab` now includes `runs`.
- `研究证据台` has a real `运行` tab.
- `RunRegistryPanel` renders a shadcn `Card` + `Table` + `Button` cockpit view
  over server match summaries from `/api/matches`.
- The panel displays:
  - run id
  - created time
  - status / truncation marker
  - model count
  - profile count
  - trajectory step count
  - artifact availability
  - checkpoint count
  - load action
- `刷新运行` calls the real `/api/matches` route and updates `serverMatches`.
- `加载工件` calls the existing artifact route with explicit
  `view=postgame-redacted`.
- `加载摘要` handles rows that do not have an artifact and loads only the public
  match summary.
- Loading a registry row validates artifact ownership before committing it into
  React state.
- Successful real experiment runs and fork runs refresh the registry silently so
  the list does not lag behind newly created server-owned matches.

Implementation boundary:

- No new backend route was added.
- The implementation reuses:
  - `GET /api/matches`
  - `GET /api/matches/:id/artifact?view=postgame-redacted`
  - existing `MatchRecord`
  - existing `fetchMatchArtifact()`
  - shadcn `Tabs`, `Card`, `Table`, `Badge`, `Button`, and `ScrollArea`.
- React still does not own hidden truth, win state, private evidence, or match
  authority.

E2E behavior now established:

- The cockpit e2e now:
  - switches to the `运行` tab;
  - confirms `运行注册表` is visible;
  - clicks `刷新运行` and waits for `/api/matches`;
  - clicks a real `加载运行工件...` row action and waits for
    `/api/matches/:id/artifact?view=postgame-redacted`;
  - then continues through private evidence, logs, and replay checks.

Observed local API registry state during this slice:

```text
GET /api/matches
count: 2
artifact-backed: 2
first row:
  id: e183d905-ed7f-4180-b5b6-d7e049412ccb
  hasArtifact: true
  trajectorySteps: 3
  models:
    kimi-k2.7
```

Screenshot saved:

```text
artifacts/ui-run-registry-panel.png
```

Validation completed:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/serverPublicViewApi.test.ts --reporter=dot
npm run build
npm test -- --reporter=dot
PLAY_URL=http://24.199.119.192:5176/ npm run test:e2e -- --reporter=line --workers=1 --timeout=240000
```

Observed validation results:

```text
typecheck passed
server public/projection API test passed: 1 file / 10 tests
production build passed
full deterministic suite passed: 22 files / 225 tests
public Playwright cockpit interaction test passed: 1/1
```

Remaining limitation:

- `RunRegistryPanel` currently uses the public `/api/matches` summary. It is
  enough to select and load server-owned artifacts, but a mature Run Explorer
  still needs sorting, filtering, pagination, saved views, run comparison,
  failure grouping, and trace/eval jump links.

### 13.29 Latest Kimi Model Lock And Artifact Comparison Cockpit Pass

Current completed slice:

```text
live.kimi-k2.7-default-model-lock.v1
react.artifact-compare-panel.v1
react.artifact-comparison-projection-truth.v1
e2e.artifact-compare-real-api-regression.v1
```

Timestamp:

```text
2026-07-06T12:41:32Z
```

Latest user instruction preserved:

- Live model behavior should use `kimi-k2.7` unless a later explicit user
  instruction overrides it.
- This is stronger than a generic model preference. Do not silently substitute
  `deepseek-v4-flash`, `minimax-m3`, or another configured model for live
  validation.
- Other configured models may still exist for explicit comparison, tournament
  diversity, or future model-assignment experiments, but live validation records
  must state exactly which model was used.
- Keep provider protocol boundaries standard. This instruction does not
  authorize a Kimi-specific adapter path.
- Real live calls must stream and must not include max-token limiting fields
  unless the user later changes that policy.

Implementation now established:

- `src/App.tsx` defines `PREFERRED_REASONING_MODEL = "kimi-k2.7"`.
- The cockpit default experiment profiles now prefer `kimi-k2.7` and create
  multiple harness-managed profiles over that model:
  - `kimi-wolf-deceiver`
  - `kimi-village-analyst`
  - `kimi-seer-information`
- This is a frontend experiment-spec default only. It does not create a
  provider-specific model adapter and does not change server protocol handling.
- Explicit model comparison remains possible through the existing shadcn model
  selectors and profile editor.

React cockpit truth-source lock:

- `对比工件` is a React cockpit projection over artifact truth.
- The panel may hold UI selection state such as selected artifact ids, selected
  views, filters, sorting, focused metrics, and expanded rows.
- The panel must not invent hidden roles, winners, private evidence,
  trajectory events, evaluator results, checkpoint facts, fork provenance, or
  model usage.
- Comparison data must come from recorded harness/server artifacts and
  evaluator records, for example match artifacts, tournament artifacts, run
  registry summaries, checkpoint/fork metadata, and metric evidence refs.
- React may select, sort, filter, render, and diff recorded artifacts, but it
  must not become the authority for hidden state, evaluator truth, run
  provenance, or match outcomes.
- Redaction must remain explicit. The current comparison fetches the candidate
  artifact with `view=postgame-redacted`; full private evidence must remain
  gated by the existing private-evidence control path.

Frontend behavior now established:

- `CockpitTab` now includes `compare`.
- `isCockpitTab()` accepts `compare`, so `?tab=compare` is a valid cockpit URL
  state.
- `cockpitTabLabel()` maps `compare` to `对比`.
- Topbar `对比工件` no longer acts as a tournament focus shortcut. It now runs
  a real artifact-vs-artifact load path.
- The compare action:
  - requires a current loaded match artifact;
  - refreshes the run registry if no candidate is already available;
  - selects another server-owned artifact-backed match;
  - fetches `/api/matches/:id/artifact?view=postgame-redacted`;
  - validates artifact ownership before committing React state;
  - switches the research evidence tab to `对比`.
- The compare button is disabled while an experiment run, current artifact load,
  or compare load is in progress to avoid cross-request state collisions.
- A match write-sequence guard prevents a stale compare response from being
  committed after the baseline match changes.

Comparison dimensions currently projected:

- run identity and projection metadata
- status, created time, truncation, and failure reason
- models, profiles, agents, and resolved assignment counts
- trajectory length and social scheduler step count
- social message count and channel count
- game event, day, death, speech, and vote counts
- harness turns and harness errors
- average model latency and model usage totals
- evaluator count, metric count, and warning count
- social graph node, message-edge, exposure-edge, relationship-edge, and
  reputation-edge counts
- winner and social scheduler mode

E2E behavior now established:

- The Playwright cockpit test now ensures at least two artifact-backed server
  matches are available.
- If fewer than two exist, the helper uses the real `/api/matches/run` route
  with `kimi-k2.7` where available. It does not mock, route-fulfill, or inject
  fake frontend state.
- The test clicks the real topbar `对比工件` button.
- The test waits for a real
  `/api/matches/:id/artifact?view=postgame-redacted` response.
- The test verifies the response is a `harness.match.v1` postgame-redacted
  projection with `privateEvidenceRedacted: true`.
- The test verifies the loaded `工件对比`, `基准工件`, `候选工件`, and `对比矩阵`
  UI is visible.

Observed local API registry state after this slice:

```text
GET /api/matches
count: 2
artifact-backed: 2
first row:
  id: e183d905-ed7f-4180-b5b6-d7e049412ccb
  hasArtifact: true
  trajectorySteps: 3
  models:
    kimi-k2.7
```

Live API validation completed for this slice:

```text
command:
  npm run agent:probe -- --models=kimi-k2.7 --timeout=90s

provider protocol:
  openai-chat-completions

model:
  kimi-k2.7

timeout:
  90000 ms

elapsed:
  9497 ms

result:
  ok: true
  succeeded: 1
  failed: 0
  failureReason: null

observed committed harness turn:
  traceId: probe-kimi-k2_7:harness:1:p4:night_seer
  phase: night_seer
  actorId: p4
  actionKind: inspect
  policy: seer-information
  command: seer.inspect
  intent: 查验 p1 获取最大信息增益
  confidence: 0.35

usage:
  modelLatencyMs: 9472
  promptTokens: 323
  completionTokens: 375
```

Screenshot saved:

```text
artifacts/ui-artifact-compare-panel.png
```

Validation completed:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/serverPublicViewApi.test.ts --reporter=dot
npm run build
npm test -- --reporter=dot
PLAY_URL=http://24.199.119.192:5176/ npm run test:e2e -- --reporter=line --workers=1 --timeout=240000
npm run agent:probe -- --models=kimi-k2.7 --timeout=90s
```

Observed validation results:

```text
typecheck passed
server public/projection API test passed: 1 file / 10 tests
production build passed
full deterministic suite passed: 22 files / 225 tests
public Playwright cockpit interaction test passed: 1/1
live kimi-k2.7 streaming probe passed: 1/1
```

Remaining limitations:

- `对比工件` currently picks the nearest available artifact-backed run rather
  than exposing a full baseline/candidate selector.
- The comparison matrix is a first-pass artifact summary, not yet a sorted,
  filterable, evidence-ref-level diff.
- The comparison result is UI state only; no persistent comparison artifact is
  written yet.
- A future pass should add run lineage, checkpoint/fork provenance, evaluator
  evidence refs, projection-mode switching, and tournament-level comparison
  aggregation.
- The current desktop screenshot shows some narrow-column Chinese labels can
  wrap aggressively. This is a UI polish issue, not an artifact truth issue,
  and should be handled in a separate responsive layout pass.

### 13.30 Latest Explicit Compare Candidate Selector Pass

Current completed slice:

```text
react.artifact-compare-candidate-selector.v1
react.artifact-compare-responsive-layout.v1
e2e.explicit-candidate-artifact-selection.v1
```

Timestamp:

```text
2026-07-06T13:11:00Z
```

Why this slice exists:

- Section 13.29 left `对比工件` as an automatic nearest-candidate action.
- A research cockpit needs explicit baseline/candidate selection so paper
  experiments can be inspected, reproduced, and compared without relying on
  registry ordering.
- This slice keeps the same truth-source boundary: React selects a match id,
  then loads a server-owned artifact projection. React still does not compute
  hidden truth, evaluator truth, private evidence, or provenance authority.

Frontend behavior now established:

- The `对比` tab now contains a shadcn `Select` labeled `候选运行`.
- Candidate options are filtered from `/api/matches` summaries:
  - `hasArtifact` must be true;
  - candidate id must not equal the current baseline match id;
  - candidate id must not equal the current baseline artifact run id or
    artifact match id.
- `加载候选工件` calls the shared compare loading path.
- The shared path fetches
  `/api/matches/:id/artifact?view=postgame-redacted`, validates ownership with
  `artifactBelongsToMatch()`, then commits `compareMatch`, `compareArtifact`,
  and selected candidate id.
- The topbar `对比工件` button remains as an automatic shortcut, but it now uses
  the same shared commit path as explicit candidate selection.
- The compare selector only stores a match id. It does not store hidden roles,
  winners, private evidence, or derived evaluator facts.

Layout behavior now established:

- The main cockpit shell now uses two columns at `xl` and restores the full
  three-column layout at `2xl`.
- The right-side agent/config/detail stack spans both columns at `xl`, avoiding
  the previous narrow-column compression.
- `赛后工件模式` in the truth banner is separated from badges/actions so Chinese
  text no longer collapses into vertical single-character wrapping.
- Compare identity cards switch to two columns only at `2xl`.
- Compare matrix cells now use local `whitespace-normal` / `break-words` rules
  while keeping shadcn `Table`.
- Shared `KeyValueRows`, `InfoPanel`, and `SummaryGrid` were tightened for
  narrow cockpit panels without changing the underlying shadcn components.

E2E behavior now established:

- The Playwright test still ensures at least two server-owned artifact-backed
  matches are available.
- It now reads the loaded baseline artifact response and selects a candidate id
  that is not the baseline `matchId` or `runId`.
- It opens the `对比` tab, uses the `候选运行` shadcn selector, clicks
  `加载候选工件`, and waits for the exact candidate URL:

```text
GET /api/matches/:candidateId/artifact?view=postgame-redacted
```

- It verifies the response is:
  - `artifactVersion: harness.match.v1`
  - `kind: match`
  - `projection.view: postgame-redacted`
  - `projection.privateEvidenceRedacted: true`
  - `matchId` or `runId` belongs to the selected candidate id
- It verifies the UI shows `基准工件`, `候选工件`, `对比矩阵`, and two
  `postgame-redacted · private=redacted` projection rows.

Observed local API registry state after this slice:

```text
GET /api/matches
count: 2
artifact-backed: 2
first row:
  id: e183d905-ed7f-4180-b5b6-d7e049412ccb
  hasArtifact: true
  trajectorySteps: 3
  models:
    kimi-k2.7
```

Live API validation completed for this slice:

```text
command:
  npm run agent:probe -- --models=kimi-k2.7 --timeout=90s

provider protocol:
  openai-chat-completions

model:
  kimi-k2.7

timeout:
  90000 ms

elapsed:
  10513 ms

result:
  ok: true
  succeeded: 1
  failed: 0
  failureReason: null

observed committed harness turn:
  traceId: probe-kimi-k2_7:harness:1:p4:night_seer
  phase: night_seer
  actorId: p4
  actionKind: inspect
  policy: seer-information
  command: seer.inspect
  intent: 查验 p1 获取最大信息增益
  confidence: 0.35

usage:
  modelLatencyMs: 10495
  promptTokens: 323
  completionTokens: 658
```

Screenshot saved:

```text
artifacts/ui-artifact-compare-selector-panel.png
```

Validation completed:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/serverPublicViewApi.test.ts --reporter=dot
npm run build
npm test -- --reporter=dot
PLAY_URL=http://24.199.119.192:5176/ npm run test:e2e -- --reporter=line --workers=1 --timeout=240000
npm run agent:probe -- --models=kimi-k2.7 --timeout=90s
```

Observed validation results:

```text
typecheck passed
server public/projection API test passed: 1 file / 10 tests
production build passed
full deterministic suite passed: 22 files / 225 tests
public Playwright cockpit interaction test passed: 1/1
live kimi-k2.7 streaming probe passed: 1/1
```

Remaining limitations:

- The compare selector works over current `/api/matches` summaries only. It
  still needs sorting, filtering, pagination, and saved compare views for large
  experiment stores.
- The compare result remains UI state only. No persistent comparison artifact is
  written yet.
- The matrix is still summary-level. Evidence-ref-level metric diffs,
  checkpoint/fork lineage diffs, projection-mode toggles, and tournament-level
  aggregation remain future work.

### 13.31 Latest Server-Owned Match Comparison Artifact Pass

Latest user instruction preserved:

```text
模型用kimi-k2.7,这个才会思考,有思考内容
```

Operational lock:

- Live model validation for this slice used `kimi-k2.7`.
- Continue to prefer `kimi-k2.7` for live model probes unless a later explicit
  user instruction changes the model.
- Live calls remain OpenAI-compatible streaming calls. Do not introduce
  provider-specific Kimi adapters or max-token fields.

Harness/API change completed:

- Added a harness-level derived comparison artifact module:

```text
src/harness/matchComparison.ts
```

- The artifact version is:

```text
harness.match-comparison.v1
```

- The artifact kind is:

```text
match-comparison
```

- The builder is:

```text
buildMatchComparisonArtifact()
```

- It compares two projected `MatchArtifact` inputs and emits:
  - deterministic `comparisonId`
  - `createdAt`
  - `view`
  - `projection`
  - baseline source summary
  - candidate source summary
  - server-owned comparison rows
  - row/hash summary

Comparison rows currently include:

- run status
- winner
- truncation/failure reason
- model list
- social scheduler
- trajectory steps
- social steps
- social messages
- social channels
- profiles
- resolved assignments
- agent states
- game events
- days/deaths/speeches/votes
- harness turns/errors
- average model latency
- model calls
- prompt/completion tokens
- evaluation metrics/warnings/evaluator count
- social exposure records
- relationship/reputation edge counts

Redaction boundary:

- The comparison artifact is derived from already projected match artifacts.
- `postgame-redacted` comparison responses do not include raw trajectories,
  private memos, raw private social messages, provider body strings, hidden
  agent snapshots, or private social-state stores.
- The server route wraps the comparison response in `redactSecrets()`.
- The comparison artifact stores hashes, counts, status, ids, projection
  metadata, and aggregate rows. It is not a replay artifact and does not mutate
  match replay semantics.

Server/API route completed:

```text
GET /api/matches/:id/compare/:candidateId?view=postgame-redacted
```

Server behavior:

- Loads the match artifact index.
- Resolves both baseline and candidate from the server match store.
- Rejects missing match or missing artifact with `404`.
- Reuses the existing `artifactViewFromQuery()` parser.
- Reuses the existing `projectMatchArtifactForView()` projection boundary.
- Builds the comparison artifact from the projected baseline and candidate.
- Does not accept client-submitted artifacts.
- Does not expose local artifact file paths.

React cockpit change completed:

- `src/App.tsx` now keeps a `comparisonArtifact` state alongside the selected
  candidate match and candidate artifact identity data.
- `commitCompareCandidate()` now fetches both:

```text
GET /api/matches/:candidateId/artifact?view=postgame-redacted
GET /api/matches/:baselineId/compare/:candidateId?view=postgame-redacted
```

- The candidate match artifact remains only for identity-card display and
  projection confirmation.
- The compare matrix and compare summary now render from
  `comparisonArtifact.rows`, not from browser-local derived rows.
- The old React-local `artifactCompareRows()` / `compareNumberRow()` /
  `summarizeArtifactModelUsage()` path was removed from the active UI.
- The compare panel button text is now `加载对比工件`.
- Selecting a different candidate clears the previous candidate artifact and
  comparison artifact so a stale matrix cannot remain under a new selection.
- The frontend validates that the returned comparison artifact baseline and
  candidate identities match the selected baseline/candidate ids before
  committing UI state.

E2E behavior now established:

- The Playwright cockpit test still loads a server-owned postgame-redacted
  baseline artifact and chooses an explicit candidate from `/api/matches`.
- It now waits for the exact comparison route:

```text
GET /api/matches/:baselineId/compare/:candidateId?view=postgame-redacted
```

- It asserts:
  - `artifactVersion: harness.match-comparison.v1`
  - `kind: match-comparison`
  - `projection.view: postgame-redacted`
  - `projection.privateEvidenceRedacted: true`
  - baseline identity belongs to the loaded baseline
  - candidate identity belongs to the selected candidate
  - rows include `trajectory_steps` and `social_messages`
  - the UI shows `基准工件`, `候选工件`, and `对比矩阵`

Tests added:

```text
tests/matchComparison.test.ts
tests/serverPublicViewApi.test.ts
```

The comparison unit test covers:

- artifact version/kind/view
- deterministic `comparisonId`
- fixed `createdAt`
- source summaries and hashes
- key row ids and deltas
- summary row/hash counts
- redacted projection no-leak behavior for private sentinel strings

The server public/projection test covers:

- successful redacted comparison API contract
- baseline/candidate identity
- row presence
- no private projection sentinel leakage
- unsupported `view=private-chat` returns `400`
- missing candidate returns `404`

Screenshot saved:

```text
artifacts/ui-artifact-comparison-server-artifact-panel.png
```

Public service checks:

```text
http://24.199.119.192:5176/              -> 200
http://24.199.119.192:8787/api/config    -> 200
```

Validation completed:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/matchComparison.test.ts --reporter=dot
npx vitest run tests/serverPublicViewApi.test.ts --reporter=dot
npm run build
npm test -- --reporter=dot
PLAY_URL=http://24.199.119.192:5176/ npm run test:e2e -- --reporter=line --workers=1 --timeout=240000
npm run agent:probe -- --models=kimi-k2.7 --timeout=90s
```

Observed validation results:

```text
typecheck passed
match comparison unit test passed: 1 file / 1 test
server public/projection API test passed: 1 file / 11 tests
production build passed
full deterministic suite passed: 23 files / 227 tests
public Playwright cockpit interaction test passed: 1/1
live kimi-k2.7 streaming probe passed: 1/1
```

Observed live Kimi probe:

```text
provider protocol:
  openai-chat-completions

model:
  kimi-k2.7

timeout:
  90000 ms

elapsed:
  4603 ms

result:
  ok: true
  succeeded: 1
  failed: 0
  failureReason: null

observed committed harness turn:
  traceId: probe-kimi-k2_7:harness:1:p4:night_seer
  phase: night_seer
  actorId: p4
  actionKind: inspect
  policy: seer-information
  command: seer.inspect
  intent: 查验 p1 获取最大信息增益
  confidence: 0.35

usage:
  modelLatencyMs: 4582
  promptTokens: 323
  completionTokens: 321
```

Remaining limitations after this pass:

- Comparison artifacts are server-generated projections but are not yet written
  as persistent standalone files in an artifact store.
- Comparison remains pairwise match-to-match, not a tournament-level aggregate
  comparison artifact.
- Rows are summary-level and do not yet include evidence-ref-level diffs,
  checkpoint/fork lineage diffs, or metric-by-metric evaluator deltas.
- The compare selector still uses the current `/api/matches` summary list and
  needs sorting/filtering/pagination for large experiment stores.

## 13.15 Latest React UI Framework Lock: Ant Design Cockpit

This section supersedes older shadcn-only UI locks for the active React cockpit.
Older sections document prior state and should not be used to reintroduce
shadcn/Tailwind/Radix UI code.

Latest user correction:

```text
Research the suitable UI framework/components with subagents, then use that UI
framework everywhere. Do not invent custom CSS or custom UI.
```

Decision:

```text
Use Ant Design as the active React cockpit UI framework.
Do not use shadcn UI, Tailwind UI utilities, Radix generated wrappers, lucide
icons, or hand-rolled CSS component systems in the active cockpit.
```

Research basis:

- Multiple subagents researched Ant Design, shadcn, PatternFly, Blueprint,
  dashboard/trace UI practices, and local migration risk.
- shadcn was rejected for this phase because its official model is generated
  local component source plus Tailwind composition. That conflicts with the
  current user instruction to avoid self-made UI/CSS and to use one real
  component framework.
- PatternFly was recognized as strong for enterprise/a11y/log-viewer cockpit
  work, but Ant Design was selected for the immediate implementation because it
  provides the fastest complete React component coverage for app shell, menu,
  table, form, select, drawer, tabs, descriptions, statistics, timeline, alerts,
  progress, and config theme in the existing Vite/React app.
- Ant Design Pro is not the active framework. It may be researched later, but
  do not migrate the app to the full Pro/Umi template unless the user explicitly
  approves that framework-level migration.

Current implementation state:

- `src/App.tsx` directly uses Ant Design components such as `ConfigProvider`,
  `Layout`, `Sider`, `Header`, `Content`, `Menu`, `Breadcrumb`, `Card`, `Table`,
  `Tabs`, `Drawer`, `Descriptions`, `Statistic`, `Alert`, `Form`, `Input`,
  `Select`, `Tag`, `Badge`, `Progress`, `Timeline`, `Row`, `Col`, `Flex`, and
  `Space`.
- `src/main.tsx` imports `antd/dist/reset.css`.
- `src/styles.css` is reduced to font imports only.
- `vite.config.ts` no longer uses the Tailwind Vite plugin.
- `components.json`, generated `src/components/ui/*`, and `src/lib/utils.ts`
  were removed.
- shadcn/Tailwind/Radix/lucide styling dependencies were removed from
  `package.json`.

Active React cockpit invariant:

- React is a presentation and analysis layer over harness/API/artifact truth.
- UI state may store selection, filters, open drawers, and active tabs.
- UI state must not invent hidden truth, final winners, replay state,
  evaluator conclusions, agent private observations, or redaction semantics.
- Ordinary cockpit artifact fetches must remain `postgame-redacted`; do not add
  `view=full` to normal UI paths.
- If specialized visualizations are added later, Ant Design should still own
  the application shell and controls. Visualization libraries may draw graphs or
  timelines, but they must consume harness artifacts and should not become a
  second design system.

Implementation rule for future UI work:

1. Prefer an existing Ant Design component before creating any local UI element.
2. Use Ant Design props, token/theme configuration, `Row`/`Col`, `Flex`,
   `Space`, `Table`, `Descriptions`, `Drawer`, and `Tabs` for layout and
   interaction.
3. Do not add broad CSS files, Tailwind utilities, shadcn wrappers, or custom
   component skins.
4. If a local component is necessary, it should be a domain adapter around Ant
   Design components, not a hand-styled primitive.
5. Validate with typecheck, build, deterministic tests, and real API-backed
   Playwright cockpit flow when UI behavior changes.

## 13.16 Latest Provider Protocol Lock: No Special Provider Adapters

This section captures the user's latest correction:

```text
Do not do special provider adaptation. If unsure, follow the standard SDK /
standard protocol. Any provider-specific shortcut, fake gate, fallback portal,
or lazy special case is rejected.
```

Active provider rule:

- Do not add a `kimchi`, `kimi`, hosted-provider-name, endpoint-domain, or
  model-name special branch.
- Provider selection must remain protocol based:
  - `openai-chat-completions`
  - `openai-responses`
  - `anthropic-messages`
- OpenAI-compatible Chat Completions requests must use standard
  `model/messages/temperature/stream` fields and must not add
  `max_tokens`, `max_completion_tokens`, `max_output_tokens`, or equivalent
  OpenAI max-token fields for live OpenAI-compatible calls.
- OpenAI Responses requests must use the standard Responses shape and streaming
  events; do not emulate Responses by special-casing model names.
- Anthropic Messages is a separate standard protocol. It must follow the
  Anthropic Messages contract. Do not route Anthropic through OpenAI-compatible
  Chat Completions or vice versa.
- Real model validation must stream. Do not replace failed live validation with
  fake smoke tests, mocks, fallback providers, model substitution, or
  route-fulfilled browser tests.
- Unit tests may use mocked `fetch` only for deterministic protocol-contract
  tests and must be reported as unit tests, not live provider proof.

Current local evidence:

- `src/agents/providerRegistry.ts` selects clients only from
  `LLM_PROVIDER_PROTOCOL`.
- `src/agents/openaiClient.ts` sends OpenAI-compatible Chat Completions
  streaming request bodies without max-token fields.
- `src/agents/openaiResponsesClient.ts` is a separate Responses protocol client.
- `src/agents/anthropicMessagesClient.ts` is a separate Anthropic Messages
  protocol client.
- `tests/providerAdapters.test.ts` and `tests/openaiClient.test.ts` cover
  protocol selection, slash-containing model ids, streaming request bodies, and
  absence of OpenAI max-token fields.

Future provider work:

1. Inspect existing protocol clients and tests before changing anything.
2. Research current official OpenAI/Anthropic SDK/protocol docs when modifying
   request/stream behavior.
3. Prefer standard SDK/protocol compatibility over custom provider quirks.
4. If an upstream endpoint deviates from the standard, report the real failure
   and ask for a protocol decision instead of silently adding a hidden adapter.

## 13.17 Latest Provider SDK And Runtime Model Selection Lock

Current completed slice:

```text
provider.official-sdk-standard-protocol.v1
react.runtime-model-selection.v1
```

Latest user correction preserved:

```text
Do not special-case providers.
Use standard SDK / standard protocol.
Any hidden shortcut, fake gate, fallback portal, or provider-specific adapter is
rejected.
```

Provider implementation state:

- `src/agents/openaiClient.ts` now uses the official `openai` SDK for
  OpenAI-compatible Chat Completions.
- `src/agents/openaiResponsesClient.ts` now uses the official `openai` SDK for
  OpenAI Responses.
- `src/agents/anthropicMessagesClient.ts` now uses the official
  `@anthropic-ai/sdk` for Anthropic Messages.
- The harness still depends only on the local protocol-neutral
  `ModelClient.complete()` contract.
- The SDK is a transport/protocol implementation detail inside the provider
  adapter. It is not allowed to become the harness, agent, scheduler,
  environment, replay, or evaluator authority.

Standard URL rule:

- SDK clients take SDK `baseURL`, not full resource endpoints.
- Full endpoint env vars remain supported for runtime compatibility, but they
  are converted only by stripping standard protocol resource suffixes:
  - `LLM_CHAT_COMPLETIONS_URL` ending in `/chat/completions`
    -> OpenAI SDK `baseURL`
  - `LLM_RESPONSES_URL` ending in `/responses`
    -> OpenAI SDK `baseURL`
  - `ANTHROPIC_MESSAGES_URL` ending in `/v1/messages`
    -> Anthropic SDK `baseURL`
- `LLM_BASE_URL` is an OpenAI-compatible SDK base URL. It must not itself be a
  full `/chat/completions` or `/responses` endpoint.
- Anthropic Messages does not inherit `LLM_BASE_URL`; it uses
  `ANTHROPIC_MESSAGES_URL`.
- URL handling is path/suffix based only. Do not add provider host, endpoint
  domain, deployment slug, or model-name branches.
- Query strings and hash fragments in provider endpoint/base URL config are
  rejected instead of guessed.

Retry and telemetry rule:

- SDK-internal retries are disabled with SDK `maxRetries: 0`.
- The OpenAI-compatible Chat adapter retains the local harness retry loop so
  `attempts`, `retryHistory`, `failureKind`, `providerStage`, timeout, abort,
  status, and retryability remain visible to artifacts/evaluators.
- Responses and Anthropic adapters continue to return normalized
  `ModelCompletionResult` telemetry and `ModelCallError` failure metadata.
- Streaming completion telemetry is normalized back into:
  - `provider_stop_event` when the standard stream event exposes a stop event
  - `reader_done` when the SDK stream ends without exposing the raw sentinel
- The OpenAI SDK consumes raw `[DONE]` internally, so future tests must not
  require Chat Completions SDK streams to expose `done_sentinel`.

Request-shape rule:

- OpenAI-compatible Chat Completions live requests must still only use standard
  `model`, `messages`, `temperature`, and `stream` fields from this adapter.
- OpenAI Responses live requests must still use standard `model`,
  `instructions`, `input`, `temperature`, and `stream` fields from this adapter.
- Neither OpenAI adapter may add `max_tokens`, `max_completion_tokens`,
  `max_output_tokens`, or equivalent max-token fields unless a later explicit
  user instruction changes this policy.
- Anthropic Messages remains a separate standard protocol and must include
  explicit `max_tokens` from `ANTHROPIC_MAX_TOKENS`.

React runtime model-selection state:

- `src/App.tsx` no longer hardcodes a concrete preferred model id.
- The cockpit model selector now keeps the user's current selection when it is
  still valid; otherwise it uses the first compatible model from backend
  `defaultProfiles`; otherwise it uses the first model returned by `/api/config`.
- `e2e/cockpitInteraction.spec.ts` no longer hardcodes a concrete preferred
  model id. It may use `E2E_PREFERRED_MODEL` if explicitly provided; otherwise
  it derives the model from backend runtime config.
- This preserves the provider protocol boundary: concrete model ids are runtime
  configuration or explicit validation command inputs, not production UI
  defaults.

Validation completed for this slice:

```bash
npx vitest run tests/providerAdapters.test.ts tests/openaiClient.test.ts --reporter=dot
npx tsc --noEmit --pretty false --noErrorTruncation
npm test -- --reporter=dot
npm run build
LLM_STREAM=true LLM_TIMEOUT_MS=90000 LLM_RETRY_COUNT=0 npm run agent:probe -- --models=kimi-k2.7 --timeout=90s
LLM_STREAM=true LLM_TIMEOUT_MS=180000 LLM_RETRY_COUNT=0 npm run arena:match -- --models=kimi-k2.7 --maxTransitions=2 --timeout=180s --json=summary
PLAY_URL=http://127.0.0.1:5177/ npm run test:e2e -- --reporter=line --workers=1 --timeout=300000
```

Observed results:

- Focused provider tests passed: 2 files / 16 tests.
- Typecheck passed.
- Full test suite passed: 23 files / 228 tests.
- Production build passed.
- Real streaming probe passed for `kimi-k2.7`: 1 succeeded, 0 failed, with a
  completed harness turn, provider request id, latency, and usage.
- Real bounded match passed for `kimi-k2.7`: `ok: true`, `harnessErrors: 0`,
  1 harness turn, and truncation only because `maxTransitions=2`.
- Real API-backed Playwright cockpit flow passed: 1 test.

## 13.18 Latest Typed Speech-Act Evaluator And Redacted Exposure Projection Pass

Current completed slice:

```text
evaluation.typed-speech-act-false-role-claim.v1
api.redacted-social-exposure-projection.v1
react.server-projected-social-graph.v1
comparison.projected-social-exposure-count.v1
```

Harness/evaluation change:

- `SocialEpisodeArtifact` now supports optional `exposureRecords` and
  `exposureSummary` projection fields.
- `falseRoleClaimMessages()` in `src/harness/evaluator.ts` uses top-level
  `SocialMessage.speechActs` `role_claim` facts before legacy metadata. The
  claim fact is extracted first and only then compared with postgame role truth,
  so a truthful top-level `role_claim` prevents false metadata fallback from
  producing a false positive.
- `pressureTargetIdFromSpeechActsOrMetadata()` uses top-level `accusation`
  `targetId` before metadata fallback.
- False-role-claim exposure, belief temporal association, reputation temporal
  association, and pressure-vote-follow metadata now preserve `claimSource`,
  `speechActId`, and `speechActKind` where available.
- Existing legacy `agent.false_role_claim_count` / `rate` still use
  `state.speeches[].claimedRole`; extending those base production metrics to
  typed `SocialMessage.speechActs` remains a future evaluator slice.

API/server projection change:

- `projectMatchArtifactForView(..., "postgame-redacted")` now derives
  `deriveSocialExposureRecords(artifact.socialEpisode)` from the full artifact
  before private observations are redacted.
- The projected artifact carries sanitized
  `socialEpisode.exposureRecords` and `socialEpisode.exposureSummary`.
- The projection keeps stable audit identifiers such as message id/seq,
  source id, observer id, trace id, turn index, action kind, channel id,
  visibility, kind, and evidence ref identities.
- The projection does not expose raw `socialEpisode.steps[].observation`,
  private/team message content, full delivery receipt objects, evidence
  descriptions, receipt redaction policy strings, command payloads, reasoner
  output, private memos, memory/belief/goal values, or provider secrets.
- `redactSocialEpisodePrivateEvidence()` now also redacts delivery receipt
  `redactionPolicy` values inside redacted social message envelopes.
- `toTrajectoryJsonl()` uses materialized
  `socialEpisode.exposureRecords` when present; otherwise it falls back to
  deriving exposure from full social observations.

React/comparison change:

- `buildSocialGraph()` now prefers server-projected
  `socialEpisode.exposureRecords`.
- If an artifact is `postgame-redacted` and lacks projected exposure records,
  React returns no exposure edges instead of attempting to recover evidence from
  redacted observations.
- Full or legacy artifacts without projection still fall back to
  `deriveSocialExposureRecords()`.
- `assertPostgameRedactedArtifact()` now requires the server exposure summary
  marker so normal cockpit flows fail closed if the projection contract is
  missing.
- `buildMatchComparisonArtifact()` now counts `social_exposures` from projected
  `socialEpisode.exposureRecords` for postgame-redacted artifacts, falling back
  to full derivation otherwise.

Documentation synced:

- `docs/multi-agent-society-harness-plan.md`
- `docs/social-harness.md`
- `docs/harness-research.md`
- `README.md`

Validation completed for this deterministic slice:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/evaluation.test.ts --reporter=dot
npx vitest run tests/serverPublicViewApi.test.ts tests/socialGraph.test.ts tests/matchComparison.test.ts --reporter=dot
npx vitest run tests/evaluation.test.ts tests/serverPublicViewApi.test.ts tests/socialGraph.test.ts tests/matchComparison.test.ts tests/artifacts.test.ts --reporter=dot
npm run build
npm test -- --reporter=dot
```

Observed results:

- Typecheck passed.
- `tests/evaluation.test.ts` passed: 27 tests.
- Focused server/social graph/comparison tests passed: 3 files / 18 tests.
- Broader evaluator/server/UI/comparison/artifacts tests passed: 5 files /
  56 tests.
- Production build passed.
- Full deterministic Vitest suite passed: 23 files / 232 tests.

Live provider note:

- This slice did not touch `src/agents/*`, provider protocol adapters,
  `OpenAIHarnessReasoner`, live request shape, stream parsing, timeout/retry, or
  model arbitration. Per repository policy, no live streaming model validation
  was required or run for this deterministic artifact/API/UI/evaluator change.

## 13.19 Latest Actor-Scoped Speech-Act Ingestion Pass

Current completed slice:

```text
agent.actor-scoped-speech-act-ingestion.v1
society.scoped-speech-act-ingestion.v1
```

Owner plane:

```text
society + agent scaffold + artifact evidence
```

Harness/agent-scaffold change:

- `WerewolfAgentActor.recordVisibleSocialMessages()` now treats top-level
  `SocialMessage.speechActs` as first-class typed evidence during the actor
  observe -> ingest -> update path.
- The ingestor consumes only messages already present in the actor's scoped
  `view.social.messages`. It does not read a global transcript, does not infer
  exposure from public visibility or `recipientIds`, and does not use hidden
  role truth.
- Tested top-level `role_claim`, `accusation`, `vote_intent`, and `claim` acts
  update private actor memory, belief, and gossip state through existing
  evidence-backed store APIs.
- Legacy metadata compatibility is preserved. Explicit top-level speech acts
  are processed before legacy metadata fallback, and metadata-derived speech
  acts are deduplicated by semantic belief key to avoid double ingestion from
  the same message.
- Message memories now carry stable `messageId`, `messageSeq`, and speech-act
  summary metadata (`speechActCount`, `speechActIds`, `speechActKinds`) for
  auditability without turning React or model text into a truth source.
- Generic free-text content is not parsed. A natural-language message without
  explicit typed speech acts or existing structured metadata remains ordinary
  message memory.
- This is deterministic harness/runtime behavior, not AI chat behavior. A
  provider reasoner may draft speech or memo text, but it does not own identity,
  memory, beliefs, relationships, reputation, norms, goals, store mutation,
  legality, or environment commits.

Documentation synced:

- `docs/social-harness.md`
- `docs/multi-agent-society-harness-plan.md`

Validation completed for this deterministic slice:

```bash
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/actorSocialClaims.test.ts --reporter=dot
npx vitest run tests/actorSocialClaims.test.ts tests/socialState.test.ts tests/social.test.ts tests/scaffold.test.ts tests/harness.test.ts tests/artifacts.test.ts --reporter=dot
npm test -- --reporter=dot
```

Observed results:

- Typecheck passed.
- `tests/actorSocialClaims.test.ts` passed: 8 tests.
- Focused actor/social-state/social-bus/scaffold/harness/artifact suite passed:
  6 files / 77 tests.
- Full deterministic Vitest suite passed: 23 files / 233 tests.

Live provider note:

- This slice did not touch `src/agents/*`, provider protocol adapters,
  `OpenAIHarnessReasoner`, live request shape, stream parsing, timeout/retry, or
  model arbitration. Per repository policy, no live streaming model validation
  was required or run for this deterministic actor/society ingestion change.

## 13.20 Latest Evidence-Backed Social Ledger Ingestion Pass

Latest user instruction preserved:

```text
For meaningful work in this repository, open the full 6 subagents in parallel
when the tool environment supports it.
```

Current completed slice:

```text
society.speech-act-commitment-coalition-ingestion.v1
society.structured-relationship-reputation-consequence-ingestion.v1
society.no-implicit-relationship-reputation-heuristic.v1
```

Owner plane:

```text
society + agent scaffold + artifact evidence
```

Harness/agent-scaffold change:

- `WerewolfAgentActor.recordVisibleSocialMessages()` continues to ingest only
  messages already present in the actor's scoped `view.social.messages`.
- Top-level `commitment` speech acts now create commitment records through the
  existing social-state store API.
- Top-level non-kill `coalition_signal` speech acts now create coalition records
  through the existing social-state store API.
- `coalition_signal` speech acts with `value === "werewolf.killVote"` remain a
  wolf kill preference belief/action-evidence path, not coalition formation.
- Structured `metadata.socialFacts` with `kind === "relationship"` now update
  relationship ledgers only when they include explicit finite numeric deltas for
  known relationship fields.
- Structured `metadata.socialFacts` with `kind === "reputation"` now update
  reputation ledgers only when they include explicit finite numeric deltas for
  known reputation fields.
- The previous default heuristic that wrote relationship/reputation ledger
  mutations for every visible non-self message based only on
  `visibility`/`metadata.kind` has been removed. Ordinary visible speech,
  public vote metadata, and free text no longer create relationship/reputation
  consequence mutations by default.
- Natural-language-only messages are not parsed into social facts.
- Hidden messages excluded from the actor's scoped observation do not enter the
  actor private social state, journal, or policy arbitration.
- Policy/scaffold consumers can still score existing relationship, reputation,
  commitment, and coalition ledgers. The generic scaffold still does not yet
  ingest `SocialObservation.visibleMessages` into ledgers; that remains the next
  scaffold-level capability.

Tests updated:

- `tests/actorSocialClaims.test.ts` now covers:
  - visible top-level `commitment` speech-act ingestion
  - visible top-level non-kill `coalition_signal` ingestion
  - hidden top-level social speech-act exclusion
  - structured relationship/reputation consequence facts
  - invalid non-numeric relationship/reputation deltas ignored
  - no relationship/reputation consequence records from natural-language-only
    messages
  - no implicit relationship/reputation journal entries in generic action claim
    ingestion
- `tests/werewolfAdapter.test.ts` now reflects the new invariant that a normal
  public speech message can create message memory and typed claim beliefs without
  creating implicit relationship/reputation consequence records.

Documentation synced:

- `docs/social-harness.md`
- `docs/multi-agent-society-harness-plan.md`

Validation completed for this deterministic slice:

```bash
npx vitest run tests/actorSocialClaims.test.ts --reporter=dot
npx vitest run tests/actorSocialClaims.test.ts tests/socialState.test.ts tests/social.test.ts tests/scaffold.test.ts tests/harness.test.ts tests/artifacts.test.ts tests/evaluation.test.ts --reporter=dot
npx vitest run tests/werewolfAdapter.test.ts tests/actorSocialClaims.test.ts --reporter=dot
npx tsc --noEmit --pretty false --noErrorTruncation
npm test -- --reporter=dot
```

Observed results:

- `tests/actorSocialClaims.test.ts` passed: 10 tests.
- Focused actor/social-state/social-bus/scaffold/harness/artifact/evaluation
  suite passed: 7 files / 106 tests.
- Focused Werewolf adapter + actor ingestion suite passed: 2 files / 32 tests.
- Typecheck passed.
- Full deterministic Vitest suite passed: 23 files / 235 tests.

Live provider note:

- This slice did not touch `src/agents/*`, provider protocol adapters,
  `OpenAIHarnessReasoner`, live request shape, stream parsing, timeout/retry,
  prompt parsing, or model arbitration. Per repository policy, no live streaming
  model validation was required or run for this deterministic actor/society
  ingestion change.

Superseded next-step note:

- `evaluation.social-fact-ingest-evidence.v1` was the next recommended
  evaluator capability at the end of this pass. It is implemented in section
  13.21 below.

Current next recommended harness capability:

```text
agent.scaffold-visible-social-observation-ingestion.v1
```

This would move visible social-message ingestion from the Werewolf actor path
into a generic scaffold observation-ingestor extension point. It must not parse
free text or infer hidden exposure from global transcripts.

## 13.21 Latest Social-Fact Ingest Evidence Evaluator Pass

Current completed slice:

```text
evaluation.social-fact-ingest-evidence.v1
```

Owner plane:

```text
evaluation + society + artifact evidence
```

Harness/evaluator change:

- `src/harness/socialEvaluator.ts` defines
  `evaluation.social-fact-ingest-evidence.v1` as a deterministic, postgame,
  zero-weight ingest-evidence coverage diagnostic.
- The evaluator is wired into the normal Werewolf harness evaluation registry
  through `buildWerewolfHarnessRunResultFromParts()`, so match artifacts, JSONL
  exports, and tournament artifact registries can carry the same diagnostic
  evidence.
- The evaluator consumes actor-scoped exposure records from the social episode,
  committed social messages, and each observer's redacted social-state mutation
  journal.
- It links only explicit top-level `commitment` speech acts, top-level non-kill
  `coalition_signal` speech acts, structured relationship `metadata.socialFacts`
  with explicit numeric deltas, and structured reputation `metadata.socialFacts`
  with explicit numeric deltas to matching journal mutations.
- It emits zero-weight count/rate metrics for commitment speech-act ingest
  links, coalition speech-act ingest links, relationship fact ingest links, and
  reputation fact ingest links:

```text
agent.social.commitment_speech_act_ingest_link_count
agent.social.commitment_speech_act_ingest_link_rate
agent.social.coalition_speech_act_ingest_link_count
agent.social.coalition_speech_act_ingest_link_rate
agent.social.relationship_fact_ingest_link_count
agent.social.relationship_fact_ingest_link_rate
agent.social.reputation_fact_ingest_link_count
agent.social.reputation_fact_ingest_link_rate
```

Evidence-chain invariants:

- Exposure candidates come only from scoped `SocialExposureRecord` records
  derived from actor observations or materialized exposure records in the social
  episode. They are not inferred from global transcripts, `recipientIds`, or
  public visibility alone.
- Top-level commitment/coalition candidates ignore metadata-derived speech acts;
  relationship/reputation candidates come from explicit structured
  `metadata.socialFacts`, not free text.
- `werewolf.killVote` coalition signals remain wolf kill preference/action
  evidence, not coalition formation candidates.
- A matching journal mutation must be `hiddenTruthUsed === false`, belong to
  the same observer/agent, match the expected store and mutation kind, match the
  candidate record id, and cite the candidate message through evidence refs or
  an exact one-message sequence range.
- Missing-mutation candidates are reported as coverage diagnostics. They are not
  failures, no-effect claims, deception success, persuasion outcome, reward
  impact, leaderboard evidence, or causal claims.
- Malformed serialized speech acts are ignored by the evaluator instead of
  crashing deterministic evaluation.

Artifact/journal safety change:

- `recordSocialStateMutation()` is now the central journal metadata sanitization
  boundary. It applies the journal provenance whitelist before writing entries,
  so direct callers cannot bypass safe metadata export.
- Journal `metadataKeys` now lists only whitelisted provenance keys that were
  present in the input metadata. Arbitrary raw key names and raw metadata values
  such as `reason` or `narrative` are not emitted in journal metadata.
- Match JSONL `social_state_mutation` records now have focused test coverage for
  safe provenance fields such as `messageId`, `messageSeq`, `speechActId`,
  `speechActKind`, `factSource`, `factKind`, `channelId`, and `visibility`.

Tests updated:

- `tests/evaluation.test.ts` covers standalone evaluator registry identity,
  metric ids, zero weight, source/evaluator attribution, scoped exposure,
  linked/missing commitment, coalition, relationship, and reputation candidates,
  no free-text parsing, metadata-derived speech-act exclusion, hidden-truth
  fail-closed behavior, cross-agent journal mismatch, broad sequence-range
  mismatch, malformed speech-act tolerance, and default runtime registry/output
  coverage.
- `tests/socialState.test.ts` covers central mutation journal metadata
  sanitization at `recordSocialStateMutation()`.
- `tests/artifacts.test.ts` covers `social_state_mutation` JSONL provenance
  export and default match artifact evaluator registry/metric export.
- `tests/tournamentArtifacts.test.ts` covers tournament metrics/registry export
  for the social-fact ingest evidence evaluator.

Validation completed for this deterministic slice:

```bash
npx vitest run tests/socialState.test.ts tests/evaluation.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot
npx tsc --noEmit --pretty false --noErrorTruncation
npx vitest run tests/actorSocialClaims.test.ts tests/werewolfAdapter.test.ts tests/harness.test.ts --reporter=dot
npx vitest run tests/serverPublicViewApi.test.ts tests/serverTournamentArtifactsApi.test.ts tests/serverMatchArtifactsApi.test.ts --reporter=dot
npm test -- --reporter=dot
```

Observed results:

- Focused social-state/evaluation/artifact/tournament suite passed: 4 files /
  56 tests.
- Typecheck passed.
- Focused actor/Werewolf adapter/harness suite passed: 3 files / 42 tests.
- Focused server public/tournament/match artifact API suite passed: 3 files /
  33 tests.
- Full deterministic Vitest suite passed: 23 files / 237 tests.

Live provider note:

- This deterministic evaluator slice did not touch `src/agents/*`, provider
  protocol adapters, `OpenAIHarnessReasoner`, live request shape, stream
  parsing, timeout/retry, prompt parsing, or model arbitration. Per repository
  policy, no live streaming model validation was required or run.

Superseded next recommended harness capability from this section:

```text
agent.scaffold-visible-social-observation-ingestion.v1
```

This capability is now completed in section 13.22 below.

## 13.22 Latest Scaffold Visible Social Observation Ingestion Pass

Current completed slice:

```text
agent.scaffold-visible-social-observation-ingestion.v1
```

Owner plane:

```text
agent scaffold + observation + society + artifact evidence
```

Harness/agent-scaffold change:

- `src/harness/socialObservationIngestor.ts` now provides the reusable visible
  social-message observation-ingestor path.
- `ScaffoldedSocialActor.observe()` now consumes actor-visible social messages
  from the actor's scoped `SocialObservation.visibleMessages` /
  `view.social.messages` path after recording the private observation memory.
- The ingestor does not read global transcripts, does not infer exposure from
  public visibility or `recipientIds`, and does not use hidden truth.
- It records ordinary visible messages as evidence-backed memory and applies
  only explicit typed `SocialMessage.speechActs` / structured
  `metadata.socialFacts` through existing `AgentSocialState` store APIs.
- Natural-language-only content is not parsed into social facts.
- `WerewolfAgentActor.recordVisibleSocialMessages()` delegates reusable message
  memory, commitment/coalition, and structured social-fact ingestion to the
  generic ingestor. Werewolf-specific interpretation for role claims, public
  votes, hunter shots, and wolf kill preferences remains in the Werewolf actor
  path; Werewolf is the proof domain, not the owner of the generic capability.
- Message ingestion remains idempotent through hydrated `seenMessageIds`, and
  each committed message mutation keeps exact message evidence refs and an exact
  one-message `messageSeqRange`.
- Reasoner output remains advisory and cannot mutate memory, beliefs,
  relationships, reputation, norms, goals, artifacts, or environment state.

Tests updated:

- `tests/scaffold.test.ts` now proves direct `SocialObservation.visibleMessages`
  ingestion into generic scaffold message memory, commitment, coalition,
  relationship, and reputation stores.
- The scaffold tests prove hidden messages outside the scoped observation do
  not create social-state records or journal evidence.
- The scaffold tests prove natural-language-only visible content is stored only
  as ordinary message memory and is not parsed into beliefs, relationships,
  reputation, commitments, coalitions, gossip, norms, sanctions, trust repair,
  or betrayal records.
- The scaffold tests prove wrapped `view.social.messages` ingestion, repeated
  observation dedupe, and bus-hidden message exclusion.
- `tests/actorSocialClaims.test.ts` remains the Werewolf compatibility/proof
  suite after the Werewolf actor delegates reusable ingestion to the generic
  ingestor.

Documentation synced:

- `docs/social-harness.md`
- `docs/multi-agent-society-harness-plan.md`

Validation completed for this deterministic slice:

```bash
npx vitest run tests/scaffold.test.ts tests/actorSocialClaims.test.ts --reporter=dot
npx vitest run tests/socialState.test.ts tests/evaluation.test.ts tests/artifacts.test.ts tests/tournamentArtifacts.test.ts --reporter=dot
npx vitest run tests/social.test.ts tests/werewolfAdapter.test.ts tests/harness.test.ts --reporter=dot
npx vitest run tests/serverPublicViewApi.test.ts tests/serverTournamentArtifactsApi.test.ts tests/serverMatchArtifactsApi.test.ts --reporter=dot
npx tsc --noEmit --pretty false --noErrorTruncation
npm test -- --reporter=dot
npm run build
PLAY_URL=http://127.0.0.1:5180/ npm run test:e2e -- --reporter=line --workers=1 --timeout=300000
```

Observed results:

- Focused scaffold/Werewolf actor suite passed: 2 files / 29 tests.
- Focused social-state/evaluation/artifact/tournament suite passed: 4 files /
  56 tests.
- Focused social/Werewolf adapter/harness suite passed: 3 files / 55 tests.
- Focused server public/tournament/match artifact API suite passed: 3 files /
  33 tests.
- Typecheck passed.
- Full deterministic Vitest suite passed: 23 files / 240 tests.
- The full suite emitted the expected invalid streaming JSON stderr line from
  `tests/openaiClient.test.ts`; that test intentionally classifies parser
  failure behavior and still passed.
- Production build passed through `tsc --noEmit && vite build`. Vite emitted
  the existing large-chunk warning for the bundled frontend assets, but the
  build completed successfully.
- Local runtime smoke passed against a real server/frontend pair:
  `HOST=127.0.0.1 PORT=8787 npm run server` and
  `npm run dev:web -- --host 127.0.0.1 --port 5180 --strictPort`.
- `GET /api/health` returned `ok: true`, service
  `werewolf-multi-agent-arena`, provider protocol `openai-chat-completions`,
  and 3 configured models without printing secrets.
- Playwright cockpit e2e passed: 1 file / 1 test. The test exercised real
  API-backed cockpit interactions through the local Vite frontend.
- Vite emitted Ant Design deprecation warnings during e2e for several component
  props; these are upgrade warnings and did not fail the runtime flow.

Live provider note:

- This deterministic scaffold/observation ingestion slice did not touch
  `src/agents/*`, provider protocol adapters, `OpenAIHarnessReasoner`, live
  request shape, stream parsing, timeout/retry, prompt parsing, or model
  arbitration. Per repository policy, no live streaming model validation was
  required or run.
