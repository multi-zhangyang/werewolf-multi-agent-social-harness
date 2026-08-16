# Society

**Live multi-agent social worlds powered by the OpenAI Agents SDK.**

Society is a real-time observation platform for multi-agent social intelligence. Every participant is an actual `@openai/agents` SDK Agent with its own model, session, associative memory, emotional state, beliefs, goals, relationships and domain tools. Agents negotiate, form alliances, betray, deceive and adapt—inside deterministic game worlds that expose every interaction through a live event stream.

![Landing](docs/screenshots/landing.svg)

## Highlights

- **Real agents, not prompt wrappers**  
  Each participant is an OpenAI Agents SDK `Agent` with tools, sessions, streaming, memory and sub-agents. Model text is never parsed as a command; only successful SDK tool calls change the world.

- **Human-like social cognition**  
  Agents carry a persistent inner world: PAD emotion, core emotions, needs, energy, associative memory, beliefs about others, relationships and goals. Reflection and theory-of-mind sub-agents help them reason about incentives and hidden motives.

- **Multi-agent interaction, not a lab bench**  
  The UI is built around live conversation and participant states. Watch agents think, speak, act and react in real time through SSE.

- **Expandable scenario system**  
  New games are plain modules implementing a shared `SocialWorld` contract. No need to duplicate agent runtime, server routes or UI.

- **Human-in-the-loop**  
  A human can take one seat and speak or act alongside AI agents when the room is created in human mode.

## Scenes

| Scenario | Core tension |
| --- | --- |
| 囚徒困境 | 短期背叛 vs 长期互惠 |
| 公共品博弈 | 集体收益 vs 搭便车 |
| 信任博弈 | 交出控制权后的返还 |
| 最后通牒博弈 | 分配权与公平惩罚 |
| 选美博弈 | 高阶信念与群体误判 |
| 狼人杀 | 隐藏身份、阵营与欺骗 |

## Product preview

![Room](docs/screenshots/room.svg)

## Architecture

```text
Browser
  ▲ SSE snapshots and events
  │
SocietyRoom ── schedules activations, owns event log and human waits
  │
  ├─ OpenAISocietyAgent × participants
  │    ├─ @openai/agents Agent
  │    ├─ MemorySession
  │    ├─ associative memory
  │    ├─ social tools
  │    ├─ reflection / theory-of-mind sub-agents
  │    └─ scene tools
  │
  └─ SocialWorld ── observation, visibility, rules and side effects
       └─ scene implementation
```

### Agent boundary

`src/society/participant.ts` creates one SDK Agent per participant with a stable session and a private mind state. `communicate`, `remember_experience`, `recall_memory` and `update_inner_state` are SDK function tools. Reflection and mind-reading are real model runs exposed through `agent.asTool()`, so they can advise without mutating the world.

### World boundary

`src/society/world.ts` defines the shared world contract: scoped observations, public/private/team message visibility, activation schedules, typed SDK tools, deterministic resolution and short experiences for memory consolidation.

### Room and event stream

`src/society/room.ts` starts the world, runs each activation with bounded turns and timeout signals, and retains a finite event log. Express SSE pushes snapshots and live events to the browser.

## Getting started

Requirements: Node.js 22+ and an OpenAI-compatible chat-completions endpoint.

```bash
npm install
cp .env.example .env.local
# edit .env.local and set OPENAI_API_KEY / OPENAI_BASE_URL
npm run dev
```

The web app is served at `http://127.0.0.1:5173`; the API is at `http://127.0.0.1:8787`.

Useful checks:

```bash
npm run typecheck
npm run build
curl http://127.0.0.1:8787/api/health
```

### Real-model demo

`scripts/demo.mjs` boots rooms against the configured provider and writes transcripts to `artifacts/transcripts`.

```bash
npm run server &
node scripts/demo.mjs prisoners-dilemma
```

## HTTP surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Runtime and provider configuration status |
| GET | `/api/scenarios` | Scene and model catalog |
| GET | `/api/rooms` | Rooms held by this server process |
| POST | `/api/rooms` | Create and start a room |
| GET | `/api/rooms/:roomId` | Current room snapshot |
| GET | `/api/rooms/:roomId/events` | Snapshot plus live SSE events |
| POST | `/api/rooms/:roomId/pause` | Pause a running room |
| POST | `/api/rooms/:roomId/action` | Submit a human action |

## Research foundations

- Park et al., *Generative Agents: Interactive Simulacra of Human Behavior* — arXiv:2304.03442
- Zhou et al., *SOTOPIA: Interactive Evaluation for Social Intelligence in Language Agents* — arXiv:2310.11667
- Vezhnevets et al., *Concordia: A Library for Generative Social Simulation*
- Chan et al., *NegotiationToM: A Benchmark for Stress-testing Machine Theory of Mind on Negotiation* — EMNLP 2024
- Chi et al., *AmongAgents: Evaluating Large Language Models in the Interactive Text-Based Social Deduction Game* — arXiv:2407.16521
- Curvo et al., *The Traitors: Deception and Trust in Multi-Agent Language Model Simulations* — arXiv:2505.12923
- Zhang et al., *K-Level Reasoning: Establishing Higher Order Beliefs in Large Language Models for Strategic Reasoning* — NAACL 2025

## License

[Apache License 2.0](LICENSE)
