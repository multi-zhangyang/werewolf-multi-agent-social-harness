# Contributing

Society keeps the model, the social world and the observer UI as separate
contracts. Read [the architecture note](docs/architecture.md) before changing
the runtime, and [the scenario guide](docs/scenarios.md) before adding a game.

## Local setup

```bash
npm ci
cp .env.example .env.local
npm run typecheck
npm run build
```

Credentials belong only in `.env.local` or the process environment. Never add a
key, raw provider response, private observation or model reasoning to source,
logs, screenshots or commits.

## Runtime changes

- Keep world rules and state transitions inside `src/society/scenarios`.
- Keep model interaction inside an SDK `Agent` and its tools; do not parse final
  text into actions.
- Emit observable speech, tool calls, domain actions and world updates through
  the room event stream so the UI can render what happened.
- Preserve visibility boundaries for public, private and team messages.
- Prefer a small typed contract over a second parallel abstraction.

Run `npm run typecheck` and `npm run build` for every change. If a change needs a
live model call, use a short local run and keep its credentials and transcript
outside the repository.
