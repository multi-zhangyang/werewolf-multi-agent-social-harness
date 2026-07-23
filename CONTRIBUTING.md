# Contributing

Thank you for helping improve the Werewolf Multi-Agent Social Harness.

## Before you start

Read the repository contracts in this order:

1. [AGENTS.md](AGENTS.md)
2. [Architecture](docs/architecture.md)
3. [Social harness](docs/social-harness.md)

The central boundary is non-negotiable: the harness owns orchestration,
visibility, communication, legality, deterministic environment transitions,
artifacts, replay, checkpoint/fork provenance, and evaluation. A language model
is an optional component inside an agent and cannot mutate environment state
directly.

## Development setup

```bash
npm ci
cp .env.example .env.local
npm run typecheck
npm test
```

Live provider credentials are not required for deterministic tests. Never add a
fake fallback to make a live-provider test appear successful.

## Change workflow

1. Search for the existing owner module and contract before adding a new
   interface.
2. Keep generic harness behavior out of the Werewolf adapter and Werewolf rules
   out of generic harness modules.
3. Add focused tests for the changed invariant.
4. Run the narrow test first, then the broader validation appropriate to the
   risk.
5. Update architecture or usage documentation when a public contract changes.

Recommended validation:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Use a bounded streaming probe only when provider/reasoner behavior changed and
you have configured credentials locally.

## Pull requests

Pull requests should explain:

- the harness or domain invariant being changed;
- the existing contracts inspected;
- replay, visibility, checkpoint/fork, evaluation, and API/UI implications;
- the exact validation commands that passed;
- any behavior deliberately left out of scope.

Do not include API keys, provider endpoints, raw provider responses, private
artifacts, hidden observations, or model reasoning in commits, issues, or pull
requests.

## Coding guidelines

- Prefer existing contracts over parallel abstractions.
- Use typed commands and deterministic environment validation.
- Treat public projections as derived views, never canonical authority.
- Preserve model-free replay.
- Keep lifecycle denominators explicit; truncated and failed episodes are not
  completed outcomes.
- Do not branch behavior on a concrete model identifier.
- Do not invent Werewolf table rules without a versioned ruleset decision.
