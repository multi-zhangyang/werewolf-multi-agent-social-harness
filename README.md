# Society

**Live Multi-Agent Social Worlds · Built on the OpenAI Agents SDK**

Society is a real-time arena where fully autonomous AI agents negotiate, form alliances, deceive, betray and rebuild trust — in Werewolf, Avalon, the Prisoner's Dilemma, and a growing catalog of game-theory and social-deduction worlds. Every participant is a first-class OpenAI Agents SDK `Agent` with its own model, session, memory, emotional state, beliefs, goals, relationships and domain tools. You watch it all happen live, on a premium broadcast-style interface — or take a seat and play against the agents yourself.

<p align="center">
  <img src="docs/screenshots/landing.png" width="820" alt="Society landing page" />
</p>

## Why Society

Most "multi-agent" demos are prompt wrappers or JSON parsers in disguise. Society is built the way the OpenAI Agents SDK intends:

- **Real agents, not scripts** — each participant is an SDK `Agent` run by the SDK `Runner` with a private `MemorySession`, function tools and nested specialist agents. Model text is never parsed as a command; only successful SDK tool calls change the world.
- **True multi-agent cognition** — every participant commands a private council of three SDK sub-agents: *reflection*, *theory-of-mind*, and *planning*, reached through `Agent.asTool()` nested runs. Each specialist works in an isolated context and returns a distilled brief that only its owner can read.
- **Human-like social state** — agents carry a PAD mood model, core emotions, needs, energy, associative memory, beliefs about others, relationships and goals. Personality is anchored in Big Five (OCEAN) profiles that measurably shift negotiation and conflict behavior.
- **Live reasoning on display** — the arena streams everything: hidden chain-of-thought from reasoning models, specialist deliberations, tool activity, spoken messages and world mutations — as a watchable performance, not a log console.
- **A broadcast, not a lab bench** — a cinematic three-column stage: participant presence rail, live conversation stage, and world panel with scoreboard, activity and history. Role reveals and eliminations land as dramatic beats.
- **Expandable world catalog** — every game is a plain module implementing the shared `SocialWorld` contract. Adding a new game means zero changes to the agent runtime, server or UI.

## Worlds

| World | Core tension |
| --- | --- |
| 狼人杀 Werewolf | Hidden roles, public accusations, night kills and a third faction |
| 阿瓦隆 Avalon | Loyal servants vs. hidden minions; secret quest votes and the final Merlin assassination |
| 囚徒困境 Prisoner's Dilemma | Short-term betrayal vs. long-term reciprocity |
| 蜈蚣博弈 Centipede Game | A pot that doubles with every pass — and the temptation to grab it |
| 胆小鬼博弈 Chicken | Bluffing on a collision course: swerve or drive straight |
| 猎鹿博弈 Stag Hunt | Trust pays double, but only if both hunters commit |
| 信任博弈 Trust Game | Handing over control, then waiting for the return |
| 最后通牒博弈 Ultimatum Game | Fairness, leverage and the power to burn everything down |
| 公共品博弈 Public Goods | Collective gain vs. free-riding |
| 选美博弈 Beauty Contest | Higher-order beliefs and crowd misjudgment |
| 密封拍卖 Sealed-Bid Auction | Private valuations, strategic misdirection, second-price settlement |

## Screenshots

### Landing

<p align="center"><img src="docs/screenshots/landing.png" width="820" alt="Landing page" /></p>

### Create a world

<p align="center"><img src="docs/screenshots/create-room.png" width="820" alt="Create room dialog" /></p>

### Live room — agents thinking

<p align="center"><img src="docs/screenshots/room-running.png" width="820" alt="Live room with agents thinking" /></p>

### Live room — negotiation in full flow

<p align="center"><img src="docs/screenshots/room-live.png" width="820" alt="Live negotiation" /></p>

### Avalon — a quest in progress

<p align="center"><img src="docs/screenshots/room-avalon.png" width="820" alt="Avalon quest" /></p>

### Agent Mind Inspector

<p align="center"><img src="docs/screenshots/agent-mind.png" width="820" alt="Agent mind inspector" /></p>

### Finished room

<p align="center"><img src="docs/screenshots/room-finished.png" width="820" alt="Finished room" /></p>

### Provider settings

<p align="center"><img src="docs/screenshots/settings.png" width="820" alt="Provider settings dialog" /></p>

## Architecture

```text
Browser
  ▲ SSE snapshots and live events (status · reasoning · thoughts · speech · world)
  │
SocietyRoom ── schedules activations, owns the event log and human waits
  │
  ├─ OpenAISocietyAgent × participants
  │    ├─ @openai/agents Agent + Runner (per participant)
  │    ├─ MemorySession + associative memory stream
  │    ├─ social tools (communicate / remember / recall / inner state)
  │    ├─ reflection / theory-of-mind / planning SDK Agents via asTool()
  │    └─ scenario tools (typed, validated, committed)
  │
  └─ SocialWorld ── observation, visibility, rules and deterministic resolution
       └─ scene implementation (werewolf, avalon, centipede, …)
```

- **Agent boundary** (`src/society/participant.ts`) — one SDK `Agent` per participant with a stable session and a private mind. Cognitive specialists are real SDK Agents run as nested tools, so the participant keeps ownership of every world-changing action.
- **World boundary** (`src/society/world.ts`) — scoped observations, public/private/team channels, activation schedules, typed SDK tools, deterministic resolution and per-round experiences for memory consolidation.
- **Room & event stream** (`src/society/room.ts`) — schedules activations with bounded turns and timeout signals, and pushes snapshots + live events to the browser over SSE. Provider keys and raw provider diagnostics never enter a snapshot or event.

## Getting started

Requirements: Node.js 22+ and any OpenAI-compatible chat-completions endpoint.

```bash
npm install
cp .env.example .env.local
# edit .env.local: set OPENAI_API_KEY, OPENAI_BASE_URL and SOCIETY_MODELS
npm run dev
```

The web app is served at `http://127.0.0.1:5173`; the API is at `http://127.0.0.1:8787` (production-style: `npm run build && npm run server`, then open `http://127.0.0.1:8787`).

`SOCIETY_MODELS` is a comma-separated list of model IDs accepted by your endpoint; agents are assigned models from this list when you create a room. No provider credentials or model IDs live in this repository — they are read exclusively from your local environment.

You can also configure everything from the web app: click the settings icon in the header to set the provider base URL, API key and model list, and to test the connection. Settings are written to your local `.env.local` (gitignored) only — the UI never displays and the API never returns the full key.

Useful checks:

```bash
npm run typecheck
npm run build
curl http://127.0.0.1:8787/api/health
```

### Real-model demo

```bash
npm run server &
node scripts/demo.mjs prisoners-dilemma   # or: node scripts/demo.mjs avalon
```

The demo boots live rooms against your configured provider and writes transcripts to `artifacts/transcripts`.

## HTTP surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Runtime and provider configuration status |
| GET | `/api/settings` | Current provider settings (key masked) |
| PUT | `/api/settings` | Update provider base URL, key or model list |
| POST | `/api/settings/test` | Test provider connectivity and discover models |
| GET | `/api/scenarios` | World and model catalog |
| GET | `/api/rooms` | Rooms held by this server process |
| POST | `/api/rooms` | Create and start a room |
| GET | `/api/rooms/:roomId` | Current room snapshot |
| GET | `/api/rooms/:roomId/events` | Snapshot plus live SSE events |
| POST | `/api/rooms/:roomId/pause` | Pause a running room |
| POST | `/api/rooms/:roomId/action` | Submit a human action |

## Tech stack

- **Frontend**: React 19, Vite, Tailwind CSS 4, shadcn/ui, Radix, lucide-react, Geist
- **Backend**: Express 5, Server-Sent Events
- **AI runtime**: OpenAI Agents SDK (`@openai/agents`)
- **Validation**: Zod

## Research foundations

Every design decision is grounded in peer-reviewed work — see `docs/research/agent-social-runtime.md` and the implementation playbook in `docs/research/llm-social-agents-sota.md`:

- Park et al., *Generative Agents* — [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)
- Zhou et al., *SOTOPIA* — [arXiv:2310.11667](https://arxiv.org/abs/2310.11667)
- Bakhtin et al., *Cicero (Diplomacy)* — [arXiv:2210.05492](https://arxiv.org/abs/2210.05492)
- Xu et al., *LLMs for Communication Games: Werewolf* — [arXiv:2309.04658](https://arxiv.org/abs/2309.04658)
- Chi et al., *AMONGAGENTS* — [arXiv:2407.16521](https://arxiv.org/abs/2407.16521)
- Guo et al., *Suspicion-Agent* — [arXiv:2309.17277](https://arxiv.org/abs/2309.17277)
- Kosinski, *Evaluating LLMs in Theory of Mind Tasks* — [arXiv:2302.02083](https://arxiv.org/abs/2302.02083)
- Street et al., *Higher-order Theory of Mind* — [arXiv:2405.18870](https://arxiv.org/abs/2405.18870)
- Pan et al., *MACHIAVELLI Benchmark* — [arXiv:2304.03279](https://arxiv.org/abs/2304.03279)
- Fontana et al., *Nicer Than Humans (Prisoner's Dilemma)* — [arXiv:2406.13605](https://arxiv.org/abs/2406.13605)
- Taylor & Bergen, *Spontaneous Rational Deception* — [arXiv:2504.00285](https://arxiv.org/abs/2504.00285)
- Ou et al., *LLMs in Economic Trust Games* — [arXiv:2505.17053](https://arxiv.org/abs/2505.17053)
- Zhao et al., *CompeteAI* — [arXiv:2310.17512](https://arxiv.org/abs/2310.17512)
- Bianchi et al., *NegotiationArena* — [arXiv:2402.05863](https://arxiv.org/abs/2402.05863)
- Noh & Chang, *LLMs with Personalities in Negotiation* — [arXiv:2405.05248](https://arxiv.org/abs/2405.05248)
- Huang et al., *PsychoBench* — [arXiv:2310.01386](https://arxiv.org/abs/2310.01386)
- Lee et al., *TRAIT* — [arXiv:2406.14703](https://arxiv.org/abs/2406.14703)
- Bhattacharyya et al., *Fragile Emotion Reasoning* — [arXiv:2508.05880](https://arxiv.org/abs/2508.05880)
- Manning et al., *Automated Social Science* — [arXiv:2404.11794](https://arxiv.org/abs/2404.11794)
- Lupu et al., *Decrypto Benchmark* — [arXiv:2506.20664](https://arxiv.org/abs/2506.20664)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). New worlds follow the five-step guide in `docs/architecture.md`.

## License

[Apache License 2.0](LICENSE)