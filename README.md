# Society

Society is a live space for multi-agent social worlds. Each participant is a
real `@openai/agents` SDK `Agent` with its own model, session, associative
memory, goals, beliefs, relationships and domain tools.

The world owns rules and side effects. Agents own speech, reflection and
decisions. A domain action is committed only when its SDK tool succeeds; final
model text is never parsed as a command.

## Scenes

- 囚徒困境：多回合谈判、承诺与同时选择
- 公共品博弈：群体协商、搭便车与公共池
- 信任博弈：投资、返还与角色交换
- 狼人杀：隐藏身份、公开讨论、阵营私聊、查验与第三阵营

Scenes are ordinary modules under `src/society/scenarios`. A new scene supplies
its observation, phases, domain tools and deterministic resolution while the
same Agent runtime, room event stream and UI continue to work.

## Run locally

Requirements: Node.js 22+ and an OpenAI-compatible chat-completions endpoint.

```bash
npm install
cp .env.example .env.local
# edit .env.local and set OPENAI_API_KEY
npm run dev
```

The example endpoint is yourprovider:

```text
OPENAI_BASE_URL=https://your-endpoint.example.com/v1
SOCIETY_MODELS=your-model,your-model
```

The web app is served at `http://127.0.0.1:5173`; the API is at
`http://127.0.0.1:8787`.

Useful checks:

```bash
npm run typecheck
npm run build
curl http://127.0.0.1:8787/api/health
```

## Observable runtime

```text
SDK Agent
  ├─ model + dynamic instructions
  ├─ MemorySession + associative memory
  ├─ social tools: communicate / recall / remember / update
  ├─ scene tools: choose / invest / vote / investigate ...
  └─ reflection Agent exposed through agent.asTool()
             │
             ▼
SocialWorld
  ├─ scoped observations and visibility
  ├─ phases and sequential or simultaneous activations
  ├─ deterministic rules and side effects
  └─ room events delivered to the observer UI through SSE
```

The UI exposes the public conversation, private and team channels, tool calls,
domain actions, world changes, decision summaries, memories, beliefs and
relationships. It is an observer view: it does not invent state that the world
has not emitted.

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

## Research references

- OpenAI Agents SDK: [define agents](https://developers.openai.com/api/docs/guides/agents/define-agents), [run agents](https://developers.openai.com/api/docs/guides/agents/running-agents), [orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)
- *Generative Agents* — [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)
- *Concordia* — [arXiv:2312.03664](https://arxiv.org/abs/2312.03664)
- *SOTOPIA* — [arXiv:2310.11667](https://arxiv.org/abs/2310.11667)
- *MultiMind* — [arXiv:2504.18039](https://arxiv.org/abs/2504.18039)
- *Triadic Werewolf* — [arXiv:2606.27909](https://arxiv.org/abs/2606.27909)
- *Even More Deception* — [arXiv:2607.26120](https://arxiv.org/abs/2607.26120)

## License

[Apache License 2.0](LICENSE)
