# Architecture

Society is organized around four boundaries: an SDK Agent, a deterministic social world,
a conversation director, and a room that connects them to the observer UI. Everything
runs in process memory — the runtime writes nothing to disk.

```text
browser
  ▲ SSE snapshots and events
  │
SocietyRoom ── schedules activations, settles social accounts
  │
  ├─ AutonomousSocietyAgent × participants
  │    ├─ @openai/agents Agent + MemorySession (in-memory)
  │    ├─ appraisal engine (event → emotion/relationship/mind)
  │    ├─ cognition tools (update_inner_state / read_the_room / log_deception_plan)
  │    ├─ social tools (communicate)
  │    └─ scene tools (flat binding actions)
  │
  ├─ DiscussionDirector ── dynamic turn-taking for conversation phases
  │
  └─ SocialWorld ── observation, visibility, rules and side effects
       └─ scene implementation
```

## Agent boundary

`src/society/participant.ts` creates one SDK `Agent` per participant — and only one. The
participant holds an SDK `MemorySession` (in-memory only) and a private mind whose memory
list is display-only. Binding tools are FLAT: a vote is `{ targetId, reason }`, never a
deliberation form. Thinking happens inside the agent loop (model → tools → model, up to
`maxTurns` iterations per activation); actions commit results only. There are no
specialist sub-agents and no `Agent.asTool()` delegation.

The runner streams model and tool events to the room. A model's final text is a decision
note for the observer; it is not an action protocol. World changes can only happen inside
a successful domain tool call.

Model switching keeps this boundary: while the room (or that one seat) is paused,
`AutonomousSocietyAgent.switchModel` rebuilds the engine on a new provider/model binding
and recomputes the context budget; the session and mind are carried over verbatim.

## Appraisal boundary

`src/society/appraisal.ts` turns world events into inner state: PAD / core emotion /
social emotion / need / relationship deltas, modulated by the character's Big Five
profile and stable judgment biases, and by relationship history: the same event does not
land the same way from a warm ally and from a cold rival — hostile acts from an ally cost
more trust, a rival's cooperation is more diagnostic, and both intensity and repair scale
with directed warmth. Settlement outcomes become display-only memory
notes for the spectator MindSheet; the model's own session history carries what the
character actually remembers. Emotions are event-driven, never self-reported.

## Context boundary (one character = one agent)

Each participant is a fully isolated SDK agent: its own `Agent`, its own in-memory
session, its own mind and its own context object. Every tool is bound to one actor —
`scopedContext` raises `CROSS_AGENT_CONTEXT_DETECTED` if the SDK ever hands it another
agent's run context.

Context is budgeted per agent (`src/society/context-manager.ts`): once a turn's estimated
input crosses the compaction threshold, the manager rewrites session history through the
SDK's `sessionInputCallback`, compressing older turns into a pinned-facts + digest block
and keeping recent exchanges verbatim. The pinned block carries identity, the current
role context, active deceptions and the agent's own last few bounded conclusions
verbatim, so the thinking layer survives compression deterministically.

An SDK input guardrail (`injection-shield`) scans every turn's input for manipulation
attempts hidden in other players' speech; it never halts a turn, but flags the attempt
for observers.

## Character boundary

The **character** is a persistent person (persona, values, voice, biases, autobiographical
anchors); the **agent** is how they perceive and act; the **model** is the engine; the
**role** is this game's temporary identity. Every game starts the person fresh — there is
no cross-game carry-over. The local character library (`src/server/characters.ts`,
`data/characters.json`, gitignored, no secrets) supports create / edit / copy / delete /
import / export.

## Suspicion boundary

`src/society/suspicion.ts` tracks the room's public opinion climate. Every public
accusation, vote and quest outcome raises the suspicion score of the people it concerns —
public knowledge by construction, injected into every agent's observation and rendered
for observers as live suspicion bars.

## Conversation boundary

`src/society/conversation.ts` implements turn-taking as response pressure (adjacency
pairs). Every public utterance raises the urgency of the people it concerns; the director
opens with a full round, then activates only those with real pressure, wave after wave.
Silence is a legitimate move. Personality modulates urgency — talkativeness, dominance and
sensitivity are computed from the adapted temperament plus the character's live PAD mood
(a world-side mirror each participant pushes after appraisal; it never enters another
agent's observations), so an energized character speaks up sooner and presses harder.

## World boundary

`src/society/world.ts` defines the shared world contract: scoped observations, message
visibility, an activation schedule, typed flat tools that validate and commit domain
actions, deterministic resolution, structured appraisal events, and in-memory command
gateway counters exposed via `/api/rooms/:id/metrics`.

## Social causality ledger (in-memory)

`src/society/social/ledger.ts` records propositions, social acts, evidence, belief
updates, actor models, directed relationships, commitments, deception episodes and
outcome reconciliations — all with provenance. Belief updates fuse instead of overwrite:
a self-reported probability moves the prior by trust = confidence × evidence backing ×
recency damping (Jeffrey conditioning), where backing comes only from newly-cited
evidence and stale repetitions decay geometrically, with the result clamped to
[0.02, 0.98] so no testimony alone ever reaches certainty. Commitment reconciliation
(fulfilled / violated / void) is the settlement backbone for the causality page. Message
sidecar extraction annotates every persisted message with structured social acts
(`model-extracted`), strictly serialized off the send path. High-confidence extractions
(≥ 0.7, not duplicating the speaker's own declaration) feed the same perception stack a
declared act feeds — appraisal events, the scenario's suspicion hook and conversation
response pressure — so an undeclared accusation still lands.

## Spectator boundary

`src/society/spectator/` hosts the presentation-only layer: a deterministic
`TensionEngine` and the `CinematicDirector`, which derives camera cues from public facts
only. Its outputs never modify world state. The room UI renders them as a tension meter,
a cue banner and the three-pane workbench (participants / live stream / causality page).

## Room and event stream

`src/society/room.ts` starts the world, runs each activation with bounded turns and
timeout signals, and retains a finite in-memory event window (count + bytes). Speaking
turns are optional; binding domain actions stay strict. Single agents can be paused and
resumed individually, and a paused seat's model can be switched. The Express route
`/api/rooms/:roomId/events` sends an initial snapshot followed by SSE envelopes; the
browser reduces those envelopes into the current room view.

## Zero-disk invariant

The runtime never writes to disk by default. The permitted writes are the model configuration
(`data/model-settings.json`, user data), the `SOCIETY_DEBUG_PROVIDER=1` failure-exchange
dump (explicit debugging switch), and — only when a room's creator opts in at creation —
one archive file per finished game under `data/archives/` (opt-in postgame persistence;
contains the omniscient end state and opens only for its owner or the operator).
Room state, session history, minds, the ledger and checkpoint-style recovery all exist in
process memory only.

## Adding a scene

1. Add a `ScenarioSummary` in `src/society/scenarios/metadata.ts`.
2. Implement `SocialWorld` in a focused module under `src/society/scenarios/`.
3. Expose every state-changing choice as a typed FLAT tool (target/choice/amount + reason).
4. Return actor-scoped observations and hide facts that actor should not know.
5. Emit appraisal events for socially meaningful resolutions via `pushEvent`.
6. Use `DiscussionDirector` for any phase that should feel like a conversation.
7. Register the world in `src/society/scenarios/index.ts`.

All thirteen scenarios ship this way without creating another runtime.