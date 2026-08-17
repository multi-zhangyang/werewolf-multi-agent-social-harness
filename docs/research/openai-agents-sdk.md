# OpenAI Agents SDK for JS/TS — Reference & Society Refactor Guide

> **Research basis**: inspected `openai/openai-agents-js` at `main` (commit `b93163b`, release **0.16.0**) and npm (`latest` = `0.16.0`). Every snippet below reflects the **0.16.x** surface. Anything that only works on the **Responses API** is marked `[Responses-only]`; anything that works on **Chat Completions** (and therefore on OpenAI-compatible endpoints) is marked `[ChatCompletions]`.

---

## 0. Versioning & package layout

The SDK is **still `0.Y.Z`** — there is **no `0.2.x` release**. Recent top-of-tree sequence:
`… 0.13.x → 0.14.3 → 0.15.0 → 0.16.0`.

Versioning is "modified semver": **minor (`Y`) bumps are breaking**; patch (`Z`) bumps are non-breaking. Pin to a patch line (e.g. `~0.16.0`) for stability.

The large recent structural change was the **package split**:

| Package | Purpose |
|---|---|
| `@openai/agents` | Umbrella — re-exports everything + installs a default `OpenAIProvider` and tracing exporter. **Import from here.** |
| `@openai/agents-core` | Provider-agnostic runtime (`Agent`, `Runner`, `tool`, `handoff`, guardrails, `Session`, …) |
| `@openai/agents-openai` | OpenAI provider (`OpenAIProvider`, Responses/ChatCompletions models, `setOpenAIAPI`, tracing exporter) |
| `@openai/agents-extensions` | AI SDK adapter, etc. |
| `@openai/agents-realtime` | Realtime/voice (`realtime` namespace) |

**Current import convention** — one entry point:

```ts
import {
  Agent, Runner, run, tool, handoff, MemorySession,
  OpenAIProvider, RunContext, setOpenAIAPI, setTracingDisabled,
  retryPolicies,
  type RunConfig, type RunStreamEvent, type StreamedRunResult, type Tool,
} from "@openai/agents";
```

`@openai/agents` does `export * from '@openai/agents-core'` and `export * from '@openai/agents-openai'`, so it is equivalent to the older flat import path. Deep subpaths you may need: `@openai/agents/testing`, `@openai/agents/realtime`.

⚠️ **Deprecated / renamed names to watch:**

- Agent structured output is configured via **`outputType`**, **not** `structuredOutput` (that string appears nowhere in 0.16 source).
- `maxTurns`, `context`, `session`, `stream`, `signal` are **per-run option fields** on `runner.run()` — they are *not* `RunConfig` fields (see §1).
- `retry.backoff` uses `initialDelayMs`, **not** `initialMs` (see §Type fixes below).

---

## 1. Core API

### 1.1 Agent construction

```ts
import { Agent } from "@openai/agents";
import { z } from "zod";

const agent = new Agent<MyContext, z.infer<typeof MyOutput>>({
  name: "participant",
  instructions: "You are a participant in a social simulation.",  // string OR fn(runContext, agent) => string
  handoffDescription: "A participant in the werewolf society simulation", // used by handoffs / asTool
  model: "example-model",              // string name (resolved via provider) OR a Model instance
  modelSettings: {
    temperature: 0.7,
    parallelToolCalls: true,           // provider-side parallel tool calls
    reasoning: { effort: "medium" },   // see §1.6
  },
  tools: [communicateTool, rememberTool, updateStateTool],   // Tool<TContext>[]
  handoffs: [],                                               // Agent[] | Handoff[]
  outputType: MyOutput,  // z.object(...) | Standard Schema | raw JSON Schema | 'text' (default)
  inputGuardrails: [],
  outputGuardrails: [],
});
```

- `outputType` accepts a **Zod object**, a **Standard-Schema** value (must expose `~standard.jsonSchema`), a **raw JSON Schema**, or `'text'` (default).
- `agent.clone({ instructions: "…" })` returns a modified copy — cheap per-participant variants of a shared template.
- `instructions` may be a **function** `(runContext, agent) => string` for dynamic per-run prompts (this is the idiomatic replacement for the Python SDK's optional `context_provider` — this JS SDK has **no `context_provider` class**).
- There is also a `prompt` prompt-template option, but it is `[Responses-only]`. Ignore it on chat-completions endpoints.

### 1.2 Handoffs vs `Agent.asTool()`

Two deliberately different primitives:

| | `handoff(agent, …)` | `agent.asTool(…)` |
|---|---|---|
| Conversation history | full history passed to new agent | sub-agent gets only generated input |
| Who finishes the turn | sub-agent **takes over** | original agent **stays in control** |
| Result | new agent's final output (typed union) | **string** returned to the parent as tool result |
| Use | routing / specialist speaks for itself | manager keeps ownership; synthesizes specialists |

```ts
import { handoff } from "@openai/agents";

// Handoff — specialist takes over:
const reflectionAgent = new Agent({ name: "reflection", instructions: "…" });
const planner = new Agent({
  name: "participant",
  handoffs: [handoff(reflectionAgent, { onHandoff: (ctx, input) => {} })],
});

// asTool — manager keeps control:
const reflectionAsTool = reflectionAgent.asTool({
  toolName: "reflect",                 // default: agent.name
  toolDescription: "Reflect on recent events and produce self-assessment",
  // no `parameters` → default schema { input: string }
  onStream: ({ event, agent, toolCall }) => { /* nested run events */ },
});
const participant = new Agent({
  name: "participant",
  tools: [communicateTool, rememberTool, reflectionAsTool, theoryOfMindAsTool, plannerAsTool],
});
```

**Project decision (AGENTS.md §0.2/§2.1/§17.1): neither primitive is used on the
participant path.** Both would create a second agent identity or a nested run
inside one player, which the charter forbids — one player is one peer agent, and
reflection / theory-of-mind / planning must be internal cognitive passes of that
same agent. The patterns are documented here as SDK reference only; `cognition.ts`
implements the passes as plain typed tools that write into the owning agent's
mind. `asTool()` runs the sub-agent in a fresh nested `Runner`; pass `runConfig`
(nested runner defaults) and `runOptions` (nested run options) to tune it — noted
for completeness, not for use in participant code.

### 1.3 Nested runs

- `Agent.asTool()` **is** a nested run (a fresh `Runner` per tool invocation), inheriting parent config via `getInheritedAgentToolRunConfig`.
- You can also nest explicitly with a shared `Runner`, or use `run()` (process-singleton default runner).
- `asTool` can stream the nested run back up via `onStream` (catch-all) or `.on(eventName, handler)` (selective, or `'*'`). Providing either **forces the nested run into streaming mode**; without them it stays non-streaming. Handlers run in parallel.

### 1.4 MemorySession

```ts
import { MemorySession } from "@openai/agents";

const session = new MemorySession({
  sessionId: "participant-7",   // optional; auto UUID otherwise
  initialItems: [],              // seed AgentInputItem[]
});

const result = await runner.run(agent, "turn input", { session });
await runner.run(agent, "next input", { session });  // auto-prepends history + persists
```

- `MemorySession` is explicitly **"for demos/tests, not production."** It stores items **cloned via `structuredClone`** and implements idempotent history transactions (`applyHistoryTransaction`).
- **One `MemorySession` per participant** is the correct pattern for private history. **Do not share one session across participants** — they'd read each other's history.
- For production persistence, implement the `Session` interface (5 methods) yourself (Redis/Postgres), or use `OpenAIConversationsSession` (`[Responses-only]` — it talks to the Conversations API). `RunContextAwareSession<TContext>` lets you route storage by context.

### 1.5 RunConfig vs `run()` options (the important split)

**`RunConfig`** (`new Runner(config)`) = runner-wide defaults:
`model`, `modelProvider`, `modelSettings`, `inputGuardrails`, `outputGuardrails`, `tracingDisabled`, `traceIncludeSensitiveData`, `workflowName`, `traceId`, `groupId`, `traceMetadata`, `tracing`, `handoffInputFilter`, `toolExecution`, `sessionInputCallback`, `callModelInputFilter`, `toolErrorFormatter`, `reasoningItemIdPolicy`.

**`runner.run(agent, input, options)`** options:
`stream`, `context`, `maxTurns`, `signal`, `session`, `conversationId`/`previousResponseId` `[Responses-only]`, `sessionInputCallback`, `toolExecution`, `errorHandlers`.

```ts
const runner = new Runner({
  modelProvider: new OpenAIProvider({ apiKey, baseURL, useResponses: false }),
  tracingDisabled: true,
  toolExecution: { maxFunctionToolConcurrency: 8 },
});

const result = await runner.run(participantAgent, "you wake up in the village", {
  stream: true,                       // → returns StreamedRunResult (non-stream → RunResult)
  maxTurns: 4,                        // default 10; null = unlimited; throws MaxTurnsExceededError
  context: participantState,          // per-agent mutable context (NOT cloned, see §3)
  signal: abortController.signal,     // AbortSignal
  session: participantSession,
});
```

### 1.6 Structured output — it's `outputType`

```ts
const outcome = z.object({
  action: z.enum(["communicate", "vote", "remember", "pass"]),
  message: z.string(),
  reasoning: z.string(),
});

const agent = new Agent<Ctx, z.infer<typeof outcome>>({
  name: "participant",
  outputType: outcome,
});

const result = await runner.run(agent, input);
result.finalOutput;   // => { action, message, reasoning } — parsed & validated by the zod schema
```

- Missing / invalid structured output raises `ModelBehaviorError`; catch it, or handle via `errorHandlers.invalidFinalOutput` to return a validated fallback **without** retrying the model or replaying tool side effects.
- Structured output is **provider-agnostic** — works on Chat Completions (the SDK serializes the schema to a tool/JSON-mode contract). Verify your endpoint honors JSON-mode/structured-output; otherwise the SDK will still parse-and-validate the returned JSON, and a refusal becomes `ModelBehaviorError`.
- On a `tool` (not agent), structured *result* schemas are `outputSchema` (`[Responses-only]` for the wire contract; Zod `outputSchema` adds SDK-side validation).

### 1.7 Guardrails

`InputGuardrail` / `OutputGuardrail` are plain objects:

```ts
import { InputGuardrail, InputGuardrailTripwireTriggered } from "@openai/agents";

const guardrail: InputGuardrail = {
  name: "profanity-check",
  runInParallel: false,       // false = block the model until the guardrail passes (saves tokens)
  execute: async ({ input, context }) => ({
    outputInfo: { ok: true },
    tripwireTriggered: false, // true → throws InputGuardrailTripwireTriggered
  }),
};
const agent = new Agent({ name: "x", inputGuardrails: [guardrail] });
```

- **Input guardrails run only on the first agent** in a handoff/asTool chain; **output guardrails only on the final-output agent**.
- **Tool guardrails** (`tool(inputGuardrails, outputGuardrails)` with `allow`/`rejectContent`/`throwException`) run on **every** function-tool invocation — the right place for checks around `communicate`/`remember`.
- Errors: `InputGuardrailTripwireTriggered`, `OutputGuardrailTripwireTriggered`, `ToolInputGuardrailTripwireTriggered`, `ToolOutputGuardrailTripwireTriggered`, `GuardrailExecutionError`.

### 1.8 `modelSettings.reasoning.effort` — supported

From `model.ts`:

```ts
reasoning?: {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  mode?: "standard" | "pro" | string;                       // [Responses-only]
  context?: "auto" | "current_turn" | "all_turns" | null;   // [Responses-only]
  summary?: "auto" | "concise" | "detailed" | null;
};
```

```ts
const agent = new Agent({
  name: "participant",
  model: "example-model",            // via OpenAI-compatible endpoint
  modelSettings: { reasoning: { effort: "medium" } },
});
```

- `reasoning.effort` **is forwarded on the Chat Completions path** — appropriate for reasoning models. ✔
- `reasoning.mode` and `reasoning.context` are `[Responses-only]`; the Chat Completions model warns-and-ignores them (or throws with `strictFeatureValidation: true`).
- `reasoning.effort` is **not** a native parameter for every provider. If your endpoint rejects it, drop it or route it through `modelSettings.providerData` glue. Verify against your endpoint.

---

## 2. Streaming events

### 2.1 Event types

`RunStreamEvent` is a union of three classes:

1. `RunRawModelStreamEvent` — `{ type: 'raw_model_stream_event', data: ResponseStreamEvent, source }`
2. `RunItemStreamEvent` — `{ type: 'run_item_stream_event', name, item }`
3. `RunAgentUpdatedStreamEvent` — `{ type: 'agent_updated_stream_event', agent }`

```ts
const stream = await runner.run(agent, input, { stream: true });

for await (const event of stream) {
  if (event.type === "raw_model_stream_event") {
    // low-level provider event (§2.3 for the reasoning_content capture)
  } else if (event.type === "run_item_stream_event") {
    switch (event.name) {
      case "tool_called":   /* event.item = RunToolCallItem */ break;
      case "tool_output":   /* event.item = RunToolCallOutputItem */ break;
      case "message_output_created": break;
      case "handoff_requested": case "handoff_occurred": break;
      case "reasoning_item_created": break;
      case "tool_approval_requested": break;
    }
  } else if (event.type === "agent_updated_stream_event") {
    // handoff occurred: event.agent.name
  }
}

const text = stream.toTextStream();  // assistant text only (Node Readable when compatibleWithNodeStreams)
await stream.completed;               // ALWAYS await: flushes session persist + compaction hooks
const final = stream.finalOutput;
```

### 2.2 API-agnostic `run_item_stream_event` names

| `name` | Meaning |
|---|---|
| `message_output_created` | a message output item was created |
| `tool_called` | a tool call item was emitted |
| `tool_output` | a tool result item was emitted |
| `handoff_requested` / `handoff_occurred` | handoff requested / completed |
| `reasoning_item_created` | a reasoning item was emitted |
| `tool_approval_requested` | a tool call paused for human approval |
| `tool_search_called` / `tool_search_output_created` | `[Responses-only]` deferred tool search |

These are already **reassembled and API-agnostic** — prefer them for tool lifecycle (your `tool_called` / `tool_output` usage is correct).

### 2.3 Raw deltas differ by `useResponses` — the critical fact

`useResponses: false` (your setting) **changes the raw event shape**. Narrow safely with the SDK's type guards:

```ts
import {
  isOpenAIResponsesRawModelStreamEvent,
  isOpenAIChatCompletionsRawModelStreamEvent,
} from "@openai/agents";

for await (const event of stream) {
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    event.source;                                       // 'openai-responses'
    if (event.data.event.type === "response.output_text.delta") {
      event.data.event.delta;                           // text delta
    }
  } else if (isOpenAIChatCompletionsRawModelStreamEvent(event)) {
    event.source;                                       // 'openai-chat-completions'
    event.data.event.object;                            // 'chat.completion.chunk'
    const choice = event.data.event.choices?.[0];
    choice?.delta?.content;                             // text delta  ← the SDK-level "delta"
    choice?.delta?.tool_calls;                          // chunked; must be reassembled
    choice?.delta?.reasoning_content;                   // reasoning-capable provider reasoning
  }
}
```

- **Responses** raw `data.event.type` values: `response.output_text.delta`, `response.output_item.done`, `response.reasoning_summary_text.delta`, etc.
- **Chat Completions** raw events are OpenAI chat-completion **chunks**: `{ object: 'chat.completion.chunk', choices: [{ delta: { content?, tool_calls?, … } }] }`. Text deltas are in `choices[0].delta.content` — **not** a top-level `delta` field. Tool-call arguments stream in fragments that must be assembled (the SDK does this for its own `tool_called`/`tool_output` items; raw consumers see fragments).

### 2.4 `reasoning_content` from reasoning providers — NOT surfaced natively

From `openaiChatCompletionsStreaming.ts`, the Chat Completions path reads only:

```ts
if ("reasoning" in delta && delta.reasoning && typeof delta.reasoning === "string") {
  state.reasoning += delta.reasoning;
}
```

It **does not** read `delta.reasoning_content` (the field reasoning-capable providers send). So the model's reasoning is **not** emitted as an SDK `reasoning` item and **not** captured into normalized items. Consequence for production deployments on such providers:

- The raw chunk **still contains** `reasoning_content` inside `choices[0].delta.reasoning_content` — you must capture it yourself (see the concrete fix in §7.1).
- `@openai/agents-extensions` (AI SDK adapter) has explicit `reasoning_content` handling for these providers — an option if you route through AI SDK models instead of the native `OpenAIProvider`.

---

## 3. Context, sessions & private state

### 3.1 Per-agent mutable context — NOT cloned

From `context.mdx` and `RunContext` internals: `RunContext` **forks** created for handoffs and `asTool()` nested runs **share the same underlying app context object** — they are *not* deep-cloned. Nested runs only attach an extra `toolInput` (the structured `asTool` args). Therefore:

```ts
interface ParticipantState { id: string; innerState: Record<string, unknown>; inbox: Message[]; }
const state: ParticipantState = { id: "p7", innerState: {}, inbox: [] };

await runner.run(participantAgent, input, { context: state });

const updateInnerState = tool({
  name: "update_inner_state",
  description: "…",
  parameters: z.object({ key: z.string(), value: z.unknown() }),
  execute: async (args, runContext) => {
    runContext!.context.innerState[args.key] = args.value;  // mutates YOUR object directly
    return "updated";
  },
});
```

- `runContext.context` is **your live object** — mutations persist across turns and across `asTool()` specialists, as long as you pass the **same `state` object** each `run()`.
- `runContext.usage` (aggregated tokens), `runContext.toolInput`, `runContext.approveTool/rejectTool` are SDK-managed.
- **Caution**: `RunState` serialization (HITL interruptions) captures context. Keep **secrets out of `context`** if you persist/transmit serialized state.
- `Session` history items **are** cloned (`structuredClone`) on read/write, so history is safe from accidental mutation — but that also means `context` (not session items) is where you keep live mutable state.

### 3.2 Session strategy for many long-lived agents

- **One `Session` per participant** (private history) + **one `context` object per participant** (private mutable state). Never share sessions.
- Share a single `Runner` (with one shared `OpenAIProvider`) across participants; pass per-participant `context`/`session` per `run()`.
- **LLM-visible context** (the only thing the model sees) comes from: (1) `instructions` (static or a function of context), (2) the `input` string/items, (3) session history, or (4) tools the model calls. The `context` object is **not** sent to the LLM.
- There is **no "context provider" class**; the equivalent is a function-valued `instructions` plus `sessionInputCallback` / `callModelInputFilter`.

```ts
const agent = new Agent<ParticipantState>({
  name: "participant",
  instructions: (ctx) => `
    You are ${ctx.context.id}.
    Inner state: ${JSON.stringify(ctx.context.innerState)}.
    Inbox: ${JSON.stringify(ctx.context.inbox)}.
  `,
});
// sessionInputCallback: merge/trim history before the model call (runs when input is an item array)
// callModelInputFilter: edit input items + instructions right before EACH model call
```

### 3.3 Tool schemas (zod) & parallel tool calls

```ts
const communicate = tool({
  name: "communicate",
  description: "Send a message to another participant. Use when you want to speak or vote.",
  parameters: z.object({
    to: z.string().describe("recipient id"),
    content: z.string().describe("message text"),
  }),
  strict: true,                       // default; false for fuzzy matching
  execute: async (args, ctx, details) => { /* … */ return "sent"; },
});
```

- `parameters` accepts **Zod**, a **Standard Schema** (with jsonSchema support), or raw JSON Schema. Zod enables `strict: true` automatically.
- **Parallel tool calls**: `modelSettings.parallelToolCalls: true` (default `false`) is the *provider-side* flag. SDK-side execution concurrency is separately capped by `toolExecution.maxFunctionToolConcurrency` (≥1; `undefined`/`null` runs all of a turn's tool calls concurrently).
- `tool()` extras: `timeoutMs`, `timeoutBehavior` (`error_as_result` | `raise_exception`), `errorFunction`, `needsApproval` (HITL), `isEnabled`, `inputGuardrails`/`outputGuardrails`, `outputSchema` `[Responses-only]`, `allowedCallers` `[Responses-only]`.

---

## 4. Known pitfalls

- **`stream` is a run option, not a Runner setting.** `runner.run(agent, input, { stream: true })` → `StreamedRunResult`; omit/`false` → `RunResult`.
- **Always `await stream.completed`** — it flushes session persistence and compaction; without it you can lose history.
- **Chat-Completions raw text deltas live in `choices[0].delta.content`**, not a top-level `delta` field. A `textDelta()` helper written for Responses will silently capture nothing under `useResponses: false` (see §7.1).
- **`[Responses-only]` surfaces** (warn-and-ignore, or throw with `strictFeatureValidation: true`): `prompt`, `conversationId`, `previousResponseId`, `reasoning.mode`, `reasoning.context`, `toolSearchTool`, `deferLoading`, `toolNamespace`, `allowedCallers`, `outputSchema`, hosted tools.
- **`reasoning_content` is not surfaced** (only `delta.reasoning` is read) — capture it yourself (§7.1).
- **Default model is `gpt-5.6-luna`** with `reasoning.effort: 'none'` + `text.verbosity: 'low'`. Passing a **non-GPT-5** model name (e.g. a non-OpenAI model) **without** `modelSettings` falls back to empty/generic settings — so **always set `modelSettings` explicitly for such models** (your code does this ✔).
- **Input guardrails run only on the first agent** in a chain; output guardrails only on the final-output agent; use **tool guardrails** for per-tool checks.
- **`asTool()` returns a string** by default (last message or `customOutputExtractor`); structured sub-agent output is `JSON.stringify`d. Use `customOutputExtractor` + `result.agentToolInvocation` for typed results.
- **Model retries are opt-in** (`modelSettings.retry` + a policy). No automatic retries. See §7.3 for the backoff field-name fix.

---

## 5. Tracing & production deployment

### 5.1 Disabling tracing

There is **no `OPENAI_TRACING_DISABLED` env var**. Disable programmatically:

```ts
import { setTracingDisabled } from "@openai/agents";
setTracingDisabled(true);                       // process-wide
const runner = new Runner({ tracingDisabled: true });  // per-Runner
```

Tracing is **enabled by default in server runtimes**, **disabled in browsers and when `NODE_ENV=test`**.

### 5.2 Environment variables — what actually exists

| Var | Read by SDK? | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | ✅ yes | lazy-resolved default key (auto-created OpenAI client) + default trace-export key |
| `OPENAI_DEFAULT_MODEL` | ✅ yes | default model when an agent has none (else `gpt-5.6-luna`) |
| `OPENAI_WEBSOCKET_BASE_URL` | ✅ yes | Responses WebSocket transport endpoint |
| `OPENAI_BASE_URL` | ❌ **NOT read** | pass `baseURL` to `OpenAIProvider`, or `setDefaultOpenAIClient()` |
| `OPENAI_TRACING_DISABLED` | ❌ **does not exist** | use `setTracingDisabled(true)` / `tracingDisabled: true` |

Also: `DEBUG=openai-agents*`, `OPENAI_AGENTS__DEBUG_SAVE_SESSION=1`, `OPENAI_AGENTS_DONT_LOG_MODEL_DATA`/`OPENAI_AGENTS_DONT_LOG_TOOL_DATA` (sensitive-data redaction, secure by default).

### 5.3 Production wiring for an OpenAI-compatible reasoning model

```ts
import { Runner, OpenAIProvider, setTracingDisabled } from "@openai/agents";

setTracingDisabled(true);

const provider = new OpenAIProvider({
  apiKey: process.env.MODEL_API_KEY!,
  baseURL: process.env.MODEL_BASE_URL!,   // e.g. 'https://api.example.com/v1' — OPENAI_BASE_URL is NOT auto-read
  useResponses: false,                       // Chat Completions for OpenAI-compatible endpoints
});

const runner = new Runner({
  modelProvider: provider,
  tracingDisabled: true,
  toolExecution: { maxFunctionToolConcurrency: 8 },
});

const agent = new Agent<ParticipantState, z.infer<typeof OutputZod>>({
  name: "participant",
  model: "example-model",
  modelSettings: { parallelToolCalls: true, reasoning: { effort: "medium" } },
  instructions: (ctx) => buildPrompt(ctx.context),
  tools: [/* … */],
  outputType: OutputZod,
});

const session = new MemorySession();   // per participant; swap for Redis/DB Session in production
const result = await runner.run(agent, turnInput, {
  stream: true, maxTurns: 4, signal: ac.signal, context: participantState, session,
});
```

---

## 6. TL;DR for the society refactor

1. One `Agent` per participant — and only one, per the project charter (no handoffs, no `asTool()` specialists; reflection / mind-read / plan are internal passes of that same agent), **one `MemorySession` per participant** (swap for a DB-backed `Session` in prod), **one mutable `context` per participant** — *not cloned*, so `update_inner_state` mutates it directly.
2. `modelSettings.parallelToolCalls` + `tool()` + zod + `strict` for tool schemas.
3. For OpenAI-compatible reasoning models: `OpenAIProvider({ baseURL, useResponses: false })` (pass `baseURL` explicitly — no env fallback), `modelSettings.reasoning.effort`, and read `reasoning_content` yourself from raw chat-completions chunks (the SDK does not).
4. Disable tracing with `setTracingDisabled(true)` / `Runner({ tracingDisabled: true })` — no env var exists.

---

## 7. Concrete fixes for `src/society/participant.ts` and `src/society/cognition.ts`

Status against the 0.16 API: per-participant MemorySession ✔, `useResponses: false` ✔, `tracingDisabled: true` ✔, dynamic phase guidance ✔, and the charter's single-peer-agent rule ✔ (the former asTool specialists were removed; cognition passes are same-agent tools). The issues below are the *real* deviations from the 0.16 API.

### 7.1 🐛 Critical: `textDelta()` only works for Responses — chat-completions deltas are silently dropped

**Current bug.** Both files define:

```ts
function textDelta(value: unknown): string | undefined {
  const event = value as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  if (!type.includes("output_text.delta") && !type.includes("text_delta")) return undefined;
  return typeof event.delta === "string" ? event.delta : undefined;
}
```

`event.delta` and `type` containing `output_text.delta` are **Responses** shapes. Under `useResponses: false` the raw events are Chat-Completions **chunks** (`object: 'chat.completion.chunk'`), where the text lives at `choices[0].delta.content` and the event has **no** top-level `delta` or a `type` string containing `output_text.delta`. So **`agent.delta` streaming events are likely never emitted today** (you only ever see the final text).

**Fix** — use the SDK's official, type-safe narrowing guards:

```ts
import {
  isOpenAIChatCompletionsRawModelStreamEvent,
  isOpenAIResponsesRawModelStreamEvent,
  type RunStreamEvent,
} from "@openai/agents";

function textDelta(event: RunStreamEvent): string | undefined {
  if (isOpenAIChatCompletionsRawModelStreamEvent(event)) {
    // openai-compatible: choices[0].delta.content
    return event.data.event.choices?.[0]?.delta?.content ?? undefined;
  }
  if (isOpenAIResponsesRawModelStreamEvent(event)) {
    if (event.data.event.type === "response.output_text.delta") {
      return event.data.event.delta;
    }
  }
  return undefined;
}
```

Then in `participant.ts`, change `consumeEvent` to call the typed version (drop the `event.data as unknown` cast):

```ts
if (event.type !== "raw_model_stream_event") return;
const delta = textDelta(event);          // now typed RunStreamEvent
if (!delta) return;
this.deltaBuffer += delta;
```

Apply the same replacement to the two `textDelta` helpers in `cognition.ts` (the `specialistTool.onStream` one and the module-bottom one).

### 7.2 🆕 Capture `reasoning_content` from the raw stream

Add a dedicated branch (kept out of the user-visible text stream so reasoning doesn't leak as speech):

```ts
import { isOpenAIChatCompletionsRawModelStreamEvent } from "@openai/agents";

// In the class:
private reasoningBuffer = "";
private reasoningAccumulator = "";   // optional: total reasoning tokens this turn

private consumeReasoning(event: RunStreamEvent): void {
  if (!isOpenAIChatCompletionsRawModelStreamEvent(event)) return;
  const delta = event.data.event.choices?.[0]?.delta?.reasoning_content as string | undefined;
  if (!delta) return;
  this.reasoningBuffer += delta;
  // Flush on the same cadence as text, but as a distinct, non-public event type:
  if (this.reasoningBuffer.length >= 160 || Date.now() - this.lastReasoningAt > 500) {
    this.context.emit({
      type: "agent.reasoning",              // new event kind; does NOT leak into speech
      roomId: this.context.roomId,
      actorId: this.context.actorId,
      delta: this.reasoningBuffer,
      at: new Date().toISOString(),
    });
    this.reasoningBuffer = "";
    this.lastReasoningAt = Date.now();
  }
}
// In consumeEvent():
if (event.type === "raw_model_stream_event") {
  this.consumeReasoning(event);              // reasoning_content
  const delta = textDelta(event);           // visible content
  if (!delta) return;
  this.deltaBuffer += delta;
  if (this.deltaBuffer.length >= 140 || Date.now() - this.lastDeltaAt > 450) this.flushDelta();
}
```

Add `agent.reasoning` to the `AgentRuntimeEvent` union in `contracts.ts` if you want it typed/observable. Keep it out of the `agent.delta` timeline so observers never mistake private chain-of-thought for public speech (your instructions already forbid leaking CoT — this is the runtime enforcing that separation).

Fallback note: on providers that send `delta.reasoning` (OpenAI's own chat-completions "reasoning" field) instead of `reasoning_content`, add a secondary read: `choices?.[0]?.delta?.reasoning`.

### 7.3 🐛 `providerRetrySettings` uses a non-existent backoff field

**Current code:**

```ts
const providerRetrySettings = {
  retry: {
    maxRetries: 4,
    backoff: { initialMs: 700, multiplier: 2, jitter: true },   // ❌ initialMs is wrong
    policy: retryPolicies.httpStatus([404, 408, 409, 429, 500, 502, 503, 504]),
  },
};
```

The field is **`initialDelayMs`**, not `initialMs` (`ModelRetryBackoffSettings = { initialDelayMs?, maxDelayMs?, multiplier?, jitter? }`). As written, `initialMs` is silently dropped and the SDK uses `DEFAULT_INITIAL_DELAY_MS`.

**Fix:**

```ts
const providerRetrySettings = {
  retry: {
    maxRetries: 4,
    backoff: { initialDelayMs: 700, multiplier: 2, jitter: true },
    policy: retryPolicies.httpStatus([404, 408, 409, 429, 500, 502, 503, 504]),
  },
};
```

**Additional caveat (important for correctness):** `retryPolicies.httpStatus([…])` alone is **not enough** for stateful requests (`previousResponseId`/`conversationId`) or anything the provider marks replay-unsafe — the SDK refuses those retries without a provider-suggested approval. Your society uses a client-managed `Session`, not `previousResponseId`, so this is *mostly* fine; but for maximum safety compose `retryPolicies.providerSuggested()` as the first predicate:

```ts
policy: retryPolicies.any(
  retryPolicies.providerSuggested(),
  retryPolicies.httpStatus([404, 408, 409, 429, 500, 502, 503, 504]),
),
```

(Use `any` so either predicate may authorize the retry while `providerSuggested` preserves replay-safety approvals.)

### 7.4 🆕 Add a typed final decision via `outputType`

Currently the participant uses free text as its final output (`latestReflection = String(result.finalOutput)`), then tools do the work separately. Adding `outputType` lets you get a machine-checked decision with zero extra prompts:

```ts
import { z } from "zod";

const turnDecision = z.object({
  action: z.enum(["communicate", "remember", "plan", "pass"]),
  message: z.string(),
  privateNote: z.string(),   // captured into mind.latestReflection; never sent to world
});

// class field:
this.decisionSchema = turnDecision;

this.agent = new Agent<SocietyAgentContext, z.infer<typeof turnDecision>>({
  name: this.profile.displayName,
  model: this.profile.model,
  outputType: turnDecision,           // ← typed, validated final output
  instructions: ({ context }) => participantInstructions(context),
  // … rest unchanged …
});
```

Then consume it:

```ts
const finalOutput = result.finalOutput;       // { action, message, privateNote }
if (finalOutput) {
  this.mind.latestReflection = finalOutput.privateNote;   // private
  // …remember() with finalOutput.message …
}
```

**Caveat:** because you *also* require the `communicate` tool to do the actual world mutation, a structured `outputType` is a **parallel contract**, not a replacement for tools. Make sure the instructions tell the model "your final structured output mirrors what you already did via tools" so it doesn't announce an action the tool never performed (your prompt already enforces this — extend it to the structured output). If a provider0027s structured-output/JSON-mode is flaky, a `z.object` outputType still works because the SDK parses-and-validates plain JSON and a mismatch becomes `ModelBehaviorError` (handle via `errorHandlers.invalidFinalOutput`).

### 7.5 ✅ (Already correct) Confirmations

- Per-participant `MemorySession` with `sessionId: ${roomId}:${id}` — **correct**; just swap for a durable `Session` backend before production scale.
- Passing `context: this.context` with a live mutable object (`this.mind`) — **correct**; context is not cloned, so `update_inner_state` mutations persist.
- `useResponses: false` + explicit `baseURL`/`apiKey` on `OpenAIProvider` — **correct** for OpenAI-compatible endpoints; note `OPENAI_BASE_URL` is *not* auto-read, so your `baseUrlFromEnv` is doing necessary work.
- `baseUrlFromEnv` stripping trailing `/chat/completions`|`/responses` — sensible; keep it (the SDK does no such normalization).
- `tracingDisabled: true` on the Runner — correct; there is no env var for this.
- Cognition as same-agent internal passes (no `asTool`, no handoffs, no discussion-agent second identity) — **correct per the project charter**; the previous `asTool({ onStream, customOutputExtractor })` specialist wiring has been removed and must not be reintroduced.

### 7.6 Minor polish

- The cognition pass tools in `cognition.ts` are plain `tool()` entries (no more `specialistTool` double cast); keep them typed as `Tool<SocietyAgentContext>`.
- Consider giving each cognition pass an `outputType` (e.g. `z.object({ assessment, options })`) so the recorded pass stores structured data instead of free text.
- `consumeEvent` reads `event.item` via `as unknown as Record<string, unknown>`; the typed `event.item` already exposes `.name`/`.rawItem`/`.output`, so `toolName`/`toolOutput` can accept the SDK `RunItem` type instead of `unknown` for better safety.
