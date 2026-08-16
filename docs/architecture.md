# Architecture

Society is organized around three boundaries: an SDK Agent, a deterministic
social world, and a room that connects them to the observer UI.

```text
browser
  ▲ SSE snapshots and events
  │
SocietyRoom ── schedules activations and owns the event log
  │
  ├─ OpenAISocietyAgent × participants
  │    ├─ @openai/agents Agent
  │    ├─ MemorySession
  │    ├─ associative memory
  │    ├─ social tools
  │    └─ scene tools
  │
  └─ SocialWorld ── observation, visibility, rules and side effects
       └─ scene implementation
```

## Agent boundary

`src/society/participant.ts` creates one SDK `Agent` per participant. The
participant has a stable session, a private mind state and an associative
memory store. `communicate`, `remember_experience`, `recall_memory` and
`update_inner_state` are SDK function tools. Reflection, theory-of-mind and
planning are real SDK Agents reached through handoffs; they return control to
the participant after private analysis.

The runner streams model and tool events to the room. A model's final text is a
decision note for the observer; it is not an action protocol. World changes can
only happen inside a successful domain tool call.

## World boundary

`src/society/world.ts` defines the shared world contract. A world provides:

- scoped observations for each participant;
- public, private and team message visibility;
- an activation schedule, either sequential or simultaneous;
- typed SDK tools that validate and commit domain actions;
- deterministic resolution and a public snapshot;
- short experiences that agents can store after each resolution.

Scenario code never needs to know how an Agent is hosted or how the UI renders
events. It only owns the rules of its own world.

## Room and event stream

`src/society/room.ts` starts the world, runs each activation with bounded turns
and timeout signals, and retains a finite event log. The Express route
`/api/rooms/:roomId/events` sends an initial snapshot followed by SSE envelopes.
The browser reduces those envelopes into the current room view while retaining
the event sequence for the activity panels and Agent inspector.

Events deliberately describe observable execution:

- agent status, streamed text deltas, hidden reasoning deltas and decision notes;
- private specialist output (reflection / theory-of-mind / planning);
- SDK tool start/completion;
- messages with channel and recipients;
- committed world actions;
- world snapshots and room lifecycle changes.

Provider keys and raw provider diagnostics never enter a snapshot or event.

## Adding a scene

1. Add a `ScenarioSummary` in `src/society/scenarios/metadata.ts`.
2. Implement `SocialWorld` in a focused module under
   `src/society/scenarios/`.
3. Expose every state-changing choice as a typed SDK tool.
4. Return actor-scoped observations and hide facts that actor should not know.
5. Register the world in `src/society/scenarios/index.ts`.

The UI and room API then discover the scene through the catalog. This makes it
possible to add negotiation, bluffing, coalition and trust games beyond
Werewolf — Avalon, Centipede, Chicken and Stag Hunt ship today — without
creating another runtime.
