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

- Keep general world rules and state transitions inside `src/runtime/scenarios`;
  the partner environment has its own adapter in `src/partners`.
- Keep the shared model executor in `src/agents/sdk.ts` and persistent cognition
  in `src/agents/cognition.ts`. Use the official Agents SDK and native Responses.
- Keep model interaction inside an SDK `Agent` and its tools; do not parse final
  text into actions.
- Stage tool effects, then commit the complete activation atomically. Emit
  speech, domain actions and world updates through the authorized event stream.
- Preserve visibility boundaries for public, private and team messages.
- Prefer a small typed contract over a second parallel abstraction.
- Do not set output token caps. Archived cases retain their original request;
  a replay removes its old cap without executing returned tools.

Run `npm run typecheck` and `npm run build` for every change. If a change needs a
live model call, use a short local run and keep its credentials and transcript
outside the repository.
