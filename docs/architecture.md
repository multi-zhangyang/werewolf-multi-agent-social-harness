# Architecture

Society is organized around four boundaries: an SDK Agent, a deterministic
social world, a conversation director, and a room that connects them to the
observer UI.

```text
browser
  ▲ SSE snapshots and events
  │
SocietyRoom ── schedules activations, settles social accounts
  │
  ├─ AutonomousSocietyAgent × participants
  │    ├─ @openai/agents Agent
  │    ├─ MemorySession
  │    ├─ associative memory
  │    ├─ appraisal engine (event → emotion/relationship/memory)
  │    ├─ internal cognition passes (reflection / mind-read / plan)
  │    ├─ social tools
  │    └─ scene tools
  │
  ├─ DiscussionDirector ── dynamic turn-taking for conversation phases
  │
  └─ SocialWorld ── observation, visibility, rules and side effects
       └─ scene implementation
```

## Agent boundary

`src/society/participant.ts` creates one SDK `Agent` per participant — and only
one. The participant has a stable session, a private mind state and an
associative memory store. `communicate`, `remember_experience`, `recall_memory`
and `update_inner_state` are SDK function tools. Reflection, theory-of-mind and
planning are internal cognitive passes of this same identity: the agent performs
them inside its own session through private tools (`reflect_on_social_situation`,
`read_the_room`, `plan_social_strategy`), writes the results into its own mind
and emits a structured `ThoughtBeat` for observers. There are no specialist
sub-agents and no `Agent.asTool()` delegation — the participant stays one peer
agent from start to finish.

The runner streams model and tool events to the room. A model's final text is a
decision note for the observer; it is not an action protocol. World changes can
only happen inside a successful domain tool call.

Model switching (§12.4) keeps this boundary: while the room (or that one seat)
is paused, `AutonomousSocietyAgent.switchModel` rebuilds the engine on a new
provider/model binding and recomputes the context budget, but the session, mind,
memory and world role are carried over verbatim — and when the new window is
smaller, the session history is compacted first so the first post-switch turn
starts below its pressure thresholds. The switch is broadcast as
`agent.model.switched`.

## Appraisal boundary

`src/society/appraisal.ts` turns world events into inner state. The world
emits structured, observer-scoped events — *"林默 voted against you"*, *"苏遥
stood up for you"*, *"you were eliminated"* — and the appraisal engine maps them
to PAD / core emotion / social emotion / need / relationship deltas, modulated
by the character's Big Five profile and its stable judgment biases (§4.2.7):
betrayal-hypervigilance deepens trust drops, loss-aversion amplifies negative
affect and recency-weighting raises the salience of fresh memories. Salient
events become memories with valence and salience, so a betrayal surfaces again
later. Emotions are event-driven, never self-reported.

## Context boundary (one character = one agent)

Each participant is a fully isolated SDK agent: its own `Agent` instance, its
own `MemorySession` (id = room + actor), its own mind, its own associative
memory store and its own context object. The isolation is structural rather
than asserted: sessions, minds and memory stores are constructed per actor in
`participant.ts`, and every tool is bound to one actor — `scopedContext` raises
`CROSS_AGENT_CONTEXT_DETECTED` if the SDK ever hands it another agent's run
context, so a tool can never act as someone else.

Context is also budgeted per agent (`src/society/context-manager.ts`): the
model's context window is resolved by model id (`SOCIETY_MODEL_CONTEXTS`,
default 256k), and once a turn's estimated input crosses
`SOCIETY_CONTEXT_COMPACT_RATIO` (default 0.75) of that window, the SDK's
`sessionInputCallback` compresses the older history into a structured digest
via the agent's own model, keeping recent exchanges verbatim. The digest is
persisted by the SDK, so history stays bounded across a long game — and
different models (1M vs 256k) compact at their own limits.

An SDK input guardrail (`injection-shield`) scans every turn's input for
manipulation attempts hidden in other players' speech; it never halts a turn,
but flags the attempt for observers and stores it in the character's memory.

## Character boundary

Four concepts stay decoupled (§7.1): the **character** is a persistent person
(persona, values, voice, stable judgment biases, autobiographical anchors), the
**agent** is how they perceive and act, the **model** is the engine, and the
**role** is this game's temporary identity. `src/society/profiles.ts` ships 25
built-in characters; the local library (`src/server/characters.ts`,
`data/characters.json`, gitignored, no secrets) adds user-defined ones with
create / edit / copy / delete / import / export, and the room creator can cast
any character to any seat. Autobiographical anchors are seeded as high-salience
identity memories so echoing situations can surface why this person reacts this
way, and season dossiers carry table history without duplicating them.

## Suspicion boundary

`src/society/suspicion.ts` tracks the room's public opinion climate. Every
public accusation, vote and quest outcome raises the suspicion score of the
people it concerns — this is public knowledge by construction, so it can be
computed deterministically and injected into every agent's observation
("the table is currently leaning against X") and rendered for observers as
live suspicion bars and an accusation feed.

## Conversation boundary

`src/society/conversation.ts` implements turn-taking as response pressure
(adjacency pairs, Sacks/Schegloff/Jefferson). Every public utterance raises the
urgency of the people it concerns — the accused, the asked, the challenged.
The director opens with a full round, then activates only those with real
pressure, wave after wave, until nobody has anything to say. Silence is a
legitimate move. Personality (extraversion, dominance, neuroticism) modulates
urgency so talkative characters hold the floor.

## World boundary

`src/society/world.ts` defines the shared world contract. A world provides:

- scoped observations for each participant;
- public, private and team message visibility;
- an activation schedule, either sequential or simultaneous;
- typed SDK tools that validate and commit domain actions;
- deterministic resolution and a public snapshot;
- structured appraisal events per participant (`eventsFor`);
- short experiences that agents can store after each resolution.

Scenario code never needs to know how an Agent is hosted or how the UI renders
events. It only owns the rules of its own world.

## Spectator boundary

`src/society/spectator/` hosts the presentation-only layer: a deterministic
`TensionEngine` (calm / warm / tense / climax from real event impacts with
decay) and the `CinematicDirector`, which derives camera cues (speaker, duel,
vote-board, role-reveal, endgame…) from public facts only — world beats,
eliminations, vote tallies, role actions and emotional spikes. The director
never reads hidden identity counts, never advises agents and never modifies
world state; its outputs (`tension.changed`, `cinematic.cue`) are
presentational events on the same stream. The room UI renders them as a
tension meter, a cue banner and a unified timeline tab (thought / tool /
message / action / cue / memory).

## Room and event stream

`src/society/room.ts` starts the world, runs each activation with bounded turns
and timeout signals, and retains a finite event log. After every resolved
activation it settles social accounts: agents appraise their queued events and
store the round's outcome. Speaking turns are optional — an agent that fails a
turn stays quiet instead of sinking the room; binding domain actions stay
strict. Single agents can be paused and resumed individually: a paused agent is
silent in discussion waves, and binding activations wait for its resume instead
of substituting a decision. While paused, a seat's model can be switched through
`/api/rooms/:roomId/agents/:actorId/model` (§12.4 — see Agent boundary). The
Express route `/api/rooms/:roomId/events` sends an initial snapshot followed by
SSE envelopes. The browser reduces those envelopes into the current room view
while retaining the event sequence for the activity panels and Agent inspector.

Events deliberately describe observable execution:

- agent status, streamed text deltas, hidden reasoning deltas and decision notes;
- structured `ThoughtBeat` events produced by the agent's own cognition passes;
- SDK tool traces (start / success) with stable ids;
- multi-level context pressure and compaction events;
- per-agent pause / resume events;
- messages with channel and recipients;
- committed world actions;
- tension changes and cinematic cues from the spectator director;
- world snapshots and room lifecycle changes.

The model registry (`src/society/models/`) resolves each agent's final model
configuration; `/api/model-config/probe` runs bounded capability probes against
a model profile and stores three-state (yes / no / unknown) results. Provider
keys and raw provider diagnostics never enter a snapshot or event.

## Adding a scene

1. Add a `ScenarioSummary` in `src/society/scenarios/metadata.ts`.
2. Implement `SocialWorld` in a focused module under
   `src/society/scenarios/`.
3. Expose every state-changing choice as a typed SDK tool.
4. Return actor-scoped observations and hide facts that actor should not know.
5. Emit appraisal events for socially meaningful resolutions (votes, betrayals,
   eliminations, wins) via `pushEvent`.
6. Use `DiscussionDirector` for any phase that should feel like a conversation.
7. Register the world in `src/society/scenarios/index.ts`.

The UI and room API then discover the scene through the catalog. This makes it
possible to add negotiation, bluffing, coalition and trust games beyond
Werewolf — Avalon, Centipede, Chicken and Stag Hunt ship today — without
creating another runtime.
