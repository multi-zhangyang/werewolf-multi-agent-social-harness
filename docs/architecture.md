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
  ├─ OpenAISocietyAgent × participants
  │    ├─ @openai/agents Agent
  │    ├─ MemorySession
  │    ├─ associative memory
  │    ├─ appraisal engine (event → emotion/relationship/memory)
  │    ├─ social tools
  │    └─ scene tools
  │
  ├─ DiscussionDirector ── dynamic turn-taking for conversation phases
  │
  └─ SocialWorld ── observation, visibility, rules and side effects
       └─ scene implementation
```

## Agent boundary

`src/society/participant.ts` creates one SDK `Agent` per participant. The
participant has a stable session, a private mind state and an associative
memory store. `communicate`, `remember_experience`, `recall_memory` and
`update_inner_state` are SDK function tools. Reflection, theory-of-mind and
planning are real SDK Agents reached through `Agent.asTool()`; they return
control to the participant after private analysis.

The runner streams model and tool events to the room. A model's final text is a
decision note for the observer; it is not an action protocol. World changes can
only happen inside a successful domain tool call.

## Appraisal boundary

`src/society/appraisal.ts` turns world events into inner state. The world
emits structured, observer-scoped events — *"林默 voted against you"*, *"苏遥
stood up for you"*, *"you were eliminated"* — and the appraisal engine maps them
to PAD / core emotion / social emotion / need / relationship deltas, modulated
by the character's Big Five profile. Salient events become memories with
valence and salience, so a betrayal surfaces again later. Emotions are
event-driven, never self-reported.

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

## Room and event stream

`src/society/room.ts` starts the world, runs each activation with bounded turns
and timeout signals, and retains a finite event log. After every resolved
activation it settles social accounts: agents appraise their queued events and
store the round's outcome. Speaking turns are optional — an agent that fails a
turn stays quiet instead of sinking the room; binding domain actions stay
strict. The Express route `/api/rooms/:roomId/events` sends an initial snapshot
followed by SSE envelopes. The browser reduces those envelopes into the current
room view while retaining the event sequence for the activity panels and Agent
inspector.

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
5. Emit appraisal events for socially meaningful resolutions (votes, betrayals,
   eliminations, wins) via `pushEvent`.
6. Use `DiscussionDirector` for any phase that should feel like a conversation.
7. Register the world in `src/society/scenarios/index.ts`.

The UI and room API then discover the scene through the catalog. This makes it
possible to add negotiation, bluffing, coalition and trust games beyond
Werewolf — Avalon, Centipede, Chicken and Stag Hunt ship today — without
creating another runtime.
