# Sealed-bid auction: second domain proof

`src/domains/sealedBidAuction.ts` is a deliberately small, real second domain
adapter for the generic harness. It is not a Werewolf variant and it does not
construct a model client.

The domain has two durable actors and two first-price sealed-bid rounds. Each
actor sees only its own current private value. Both bids are collected under
the existing `parallel` scheduler and committed by one atomic `stepBatch`.
Committed bid announcements become public social messages and are visible in
the next round. The environment, not either policy actor, validates commands,
selects the winner, calculates utility, and advances canonical state.

The actors are explicitly marked `policy-only`:

- `alpha` uses `auction.policy.truthful.v1`;
- `beta` uses `auction.policy.shade-one.v1`;
- neither actor implements a reasoner-call reporter;
- the experiment has no model assignment;
- a zero-call policy run is not presented as live-provider evidence.

Run the developer example with:

```bash
npm run arena:auction -- --output=/tmp/sealed-bid-auction-proof --seed=review-seed
```

The command deliberately does not load `.env`. It uses the existing generic
experiment orchestrator and durable stores to publish:

- the canonical episode artifact and trajectory;
- deterministic evaluation output;
- the experiment run record;
- checkpoints at complete parallel batch boundaries.

After publication it runs deterministic replay from the recorded commands. The
focused test also restores the first-round checkpoint through the generic fork
runtime and completes the second round without a provider call.

The architectural boundary demonstrated here is:

```text
sealed-bid domain
  owns private values, observation projection, bid legality, joint resolution,
  deterministic policies, actor snapshot semantics, and outcome evaluator

generic harness
  owns scheduling, scoped social delivery, trace/artifact recording,
  deterministic replay, checkpoint/fork provenance, experiment orchestration,
  evaluation registry execution, and durable publication
```
