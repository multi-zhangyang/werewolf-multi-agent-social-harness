# Multi-Agent Harness Research Notes

Checked on 2026-07-04. Refreshed on 2026-07-06. This file records the external references that define the harness vocabulary used by this project.

This project treats provider-backed model adapters as pluggable reasoners, not as Agents themselves.

Current applied synthesis lives in
[multi-agent-society-harness-plan.md](multi-agent-society-harness-plan.md).
That document maps these references to concrete project invariants, current
local modules, backlog items, and validation gates.

## Working Definitions

- **Multi-agent system**: multiple agent entities operate in a shared environment, receive observations, select actions from a legal action space, and affect a shared state transition. This matches the PettingZoo AEC framing: one selected agent acts, then the environment advances.
- **Agent**: a stateful actor with identity, private state, observation handling, policy/strategy, action selection, and optional model/tool calls. In this project, a provider-backed model adapter is only one possible reasoner inside an Agent.
- **Harness**: the execution shell around an experiment. It sets up episodes, injects configurations, drives the environment-agent loop, records trajectories, computes metrics, and makes runs reproducible. It is not a prompt and not a UI.
- **Trajectory**: the ordered, replayable record of observations, plans, commands, reasoner output, model usage, and resulting environment events.

## Authoritative Sources And Conclusions

### OpenAI Agents SDK Multi-Agent

Sources:

- OpenAI Agents SDK agents: https://openai.github.io/openai-agents-python/agents/
- OpenAI Agents SDK multi-agent orchestration: https://openai.github.io/openai-agents-python/multi_agent/
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-python/tracing/

Relevant guidance:

- The SDK describes an Agent as a configured runtime component with instructions, model selection, tools, handoffs, guardrails, and related execution settings, not as a bare chat completion call.
- The SDK supports two main multi-agent patterns: an LLM can decide when to hand off, or the application can orchestrate agents in code.
- The tracing model treats runs, agent steps, model generations, tool calls, and handoffs as structured spans, which makes postgame inspection and eval possible.

Project conclusion:

- Keep code-driven orchestration in the harness. The Werewolf rules, pending actions, legal targets, role policies, and command arbitration must remain deterministic project logic.
- Use provider-backed model calls only as `HarnessReasoner` components: they may generate private tactical memo text and public speech text, but they must not directly own `GameCommand`.
- Preserve per-turn trace records that include model usage, latency, policy, command type, public speech, and private memo. This is the local equivalent of an agent trace.

### LangGraph Multi-Agent And Persistence

Sources:

- LangGraph multi-agent systems: https://docs.langchain.com/oss/python/langgraph/multi-agent
- LangGraph persistence: https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph time travel: https://docs.langchain.com/oss/python/langgraph/time-travel

Relevant guidance:

- LangGraph models multi-agent systems as graph topologies such as network, supervisor, supervisor with tool-calling, and hierarchical teams.
- A supervisor or graph node can decide control flow, while each agent receives only the state subset needed for its role.
- Persistence checkpoints graph state after execution steps. Threads, checkpoints, replay, and time travel are first-class concepts.

Project conclusion:

- Treat the harness loop as a domain-specific graph even though it is implemented directly in TypeScript: environment -> observation -> belief update -> policy plan -> reasoner -> command -> state transition -> trace.
- Keep observations scoped. `PlayerView` is the state projection for one agent, and private role information must enter only through that projection.
- Replay should be based on `GameState.seed`, initial config, event history, and recorded `GameCommand`/`HarnessTurnTrace` data, not on re-prompting an LLM and hoping for the same output.

### PettingZoo AEC API

Source:

- PettingZoo Agent Environment Cycle API: https://pettingzoo.farama.org/api/aec/

Relevant guidance:

- The AEC model is a sequential multi-agent contract: the environment exposes the selected agent, the agent receives an observation and legal-action metadata, then `step(action)` advances the environment.
- The API separates environment state from agent action choice and includes explicit termination/truncation handling.

Project conclusion:

- `WerewolfEnvironment`, `getPendingActions()`, and `applyCommand()` are the local AEC-style boundary. The harness may decide which pending action to service, but the environment remains the authority for phase transitions and legality.
- `PendingAction` is the legal action envelope. `PolicyPlan.command` must stay inside that legal envelope; the engine remains the final validator.
- Parallel vote/kill collection is an implementation optimization. The resulting commands still enter the environment as explicit state transitions.

### OpenAI Evals And Eval Harnesses

Sources:

- OpenAI agent evals guide: https://developers.openai.com/api/docs/guides/agent-evals
- OpenAI Evals repository: https://github.com/openai/evals
- OpenAI Evals deprecation notice: https://platform.openai.com/docs/guides/evals

Relevant guidance:

- OpenAI's current agent eval guidance centers on traces, datasets, graders, and eval runs: collect structured workflow data, grade behavior, and compare runs.
- The open-source OpenAI Evals repository is useful historical reference for eval registries and reproducible benchmark runners.
- The OpenAI Platform Evals docs state that legacy Evals API access ends on October 31, 2026 and stored data is deleted on November 30, 2026.

Project conclusion:

- Keep this project's eval harness local and provider-independent. The authoritative artifacts are deterministic match state, `harness.turn` events, errors, typed `SocialMessage.speechActs`, delivery/exposure records from scoped observations, evaluator metric records with evidence refs, and computed `MatchMetrics`.
- External eval systems may consume exported trajectories or datasets, but they must not become the source of truth for game state or replay.
- Metrics should combine outcome metrics, behavioral metrics, model usage, latency, and error count. Any future LLM-as-grader evaluation should read recorded trajectories and produce an additional metric layer.

## Architecture Consequence

The harness owns:

- Environment reset, current pending actions, observations, and state transitions.
- Agent identity, private belief state, role policy, and memory.
- Action arbitration through legal `GameCommand` values.
- Model calls for tactical memo and public speech only.
- Trajectory records, typed speech-act facts, scoped delivery/exposure records, model usage, win-rate, deception, reasoning, latency, and error metrics.
- Replay inputs: seed/config, event stream, harness traces, and applied commands.

The model does not directly issue the authoritative game command. It can influence speech and private tactical text, but the harness validates and applies all commands.
