/**
 * Society function-tool contract.
 *
 * Every world and cognition tool is still a normal OpenAI Agents SDK tool.
 * This factory only standardizes the model-visible failure result so every
 * OpenAI-compatible model gets the same schema-derived recovery contract.
 * There are deliberately no model ids, provider ids, endpoint checks or
 * provider-specific argument rewrites here.
 */
import { tool as agentsTool } from "@openai/agents";
import type { SocietyAgentContext } from "./contracts";

const MAX_FAILURES_PER_TOOL_PER_TURN = 3;

export interface SocietyToolFailure {
  ok: false;
  error: {
    code: string;
    kind: "input_validation" | "execution";
    tool: string;
    message: string;
    retryable: boolean;
    failures: number;
    retriesRemaining: number;
    expected?: string;
    recovery: string;
  };
}

type ToolOptions = Parameters<typeof agentsTool>[0];
type ErrorFunction = (context: unknown, error: unknown, details?: unknown) => unknown | Promise<unknown>;
type EnabledPredicate = (args: { runContext: unknown; agent: unknown }) => boolean | Promise<boolean>;

/**
 * Drop-in replacement for the SDK's `tool()` factory. Callers retain full SDK
 * typing and may explicitly provide their own errorFunction (including null).
 */
export const societyTool = ((options: ToolOptions) => {
  const record = options as ToolOptions & { name?: string; execute?: { name?: string } | ((...args: never[]) => unknown); errorFunction?: ErrorFunction | null };
  const toolName = record.name
    ?? (typeof record.execute === "function" ? record.execute.name : undefined)
    ?? "tool";
  let expected = "the declared JSON schema";
  const hasExplicitErrorFunction = Object.prototype.hasOwnProperty.call(record, "errorFunction");
  const configuredEnabled = (record as ToolOptions & { isEnabled?: boolean | EnabledPredicate }).isEnabled;
  const configuredExecute = typeof record.execute === "function"
    ? record.execute as unknown as (...args: unknown[]) => unknown
    : undefined;
  const created = agentsTool({
    ...options,
    ...(configuredExecute
      ? {
          execute: async (...args: unknown[]) => {
            const context = societyContext(args[1]);
            if (context?.turnScope?.signal.aborted) {
              throw new Error("TURN_SCOPE_CLOSED: This Agent Turn has ended; the late tool call was not executed.");
            }
            return configuredExecute(...args);
          }
        }
      : {}),
    ...(!hasExplicitErrorFunction
      ? { errorFunction: async (runContext: unknown, error: unknown) => encodeToolFailure(toolName, error, expected, runContext) }
      : {}),
    isEnabled: async (args: { runContext: unknown; agent: unknown }) => {
      const context = societyContext(args.runContext);
      if (context?.turnScope?.signal.aborted) return false;
      if (context?.toolFailureState?.[toolName]?.blocked) return false;
      if (typeof configuredEnabled === "function") return configuredEnabled(args);
      return configuredEnabled ?? true;
    }
  } as ToolOptions);
  expected = describeJsonSchema((created as { parameters?: unknown }).parameters);
  return created;
}) as typeof agentsTool;

/** Runtime/UI classification must not depend on an English SDK error prefix. */
export function isSocietyToolFailure(value: unknown): boolean {
  const parsed = parseFailure(value);
  return parsed?.ok === false
    && typeof parsed.error === "object"
    && parsed.error !== null
    && typeof (parsed.error as { code?: unknown }).code === "string";
}

function encodeToolFailure(toolName: string, error: unknown, expected: string, runContext: unknown): string {
  const rawMessage = errorMessage(error);
  const invalidInput = isInvalidInputError(error, rawMessage);
  const domainCode = invalidInput ? undefined : stableDomainCode(rawMessage);
  const terminal = domainCode ? isTerminalDomainCode(domainCode) : false;
  const state = noteFailure(runContext, toolName);
  const retryable = (invalidInput || !terminal) && state.failures < MAX_FAILURES_PER_TOOL_PER_TURN;
  const retriesRemaining = retryable ? MAX_FAILURES_PER_TOOL_PER_TURN - state.failures : 0;
  if (!retryable) state.blocked = true;
  const failure: SocietyToolFailure = {
    ok: false,
    error: {
      code: invalidInput ? "TOOL_INPUT_INVALID" : domainCode ?? "TOOL_EXECUTION_FAILED",
      kind: invalidInput ? "input_validation" : "execution",
      tool: toolName,
      message: invalidInput
        ? "Arguments did not match this tool's declared JSON schema."
        : sanitizeErrorText(rawMessage),
      retryable,
      failures: state.failures,
      retriesRemaining,
      ...(invalidInput ? { expected } : {}),
      recovery: !retryable
        ? "The failure budget for this tool is exhausted or the world rejected it as terminal. Stop calling it in this turn and never claim success."
        : invalidInput
          ? `Correct the arguments from the declared schema. You have ${retriesRemaining} corrected ${retriesRemaining === 1 ? "retry" : "retries"} left; do not repeat the same payload.`
          : terminal
          ? "Treat this call as failed, do not retry it in the current state, and never claim that the action succeeded."
          : `Treat this call as failed. You have ${retriesRemaining} corrected ${retriesRemaining === 1 ? "retry" : "retries"} left; retry only with corrected arguments or after observing a changed world state.`
    }
  };
  return JSON.stringify(failure);
}

function noteFailure(runContext: unknown, toolName: string): { failures: number; blocked: boolean } {
  const context = societyContext(runContext);
  if (!context) return { failures: 1, blocked: false };
  context.toolFailureState ??= {};
  const state = context.toolFailureState[toolName] ?? { failures: 0, blocked: false };
  state.failures += 1;
  context.toolFailureState[toolName] = state;
  return state;
}

function societyContext(runContext: unknown): SocietyAgentContext | undefined {
  if (!runContext || typeof runContext !== "object") return undefined;
  const candidate = "context" in runContext
    ? (runContext as { context?: unknown }).context
    : runContext;
  if (!candidate || typeof candidate !== "object") return undefined;
  const context = candidate as Partial<SocietyAgentContext>;
  return typeof context.actorId === "string" && typeof context.roomId === "string"
    ? context as SocietyAgentContext
    : undefined;
}

function parseFailure(value: unknown): SocietyToolFailure | undefined {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  return parsed as SocietyToolFailure;
}

function isInvalidInputError(error: unknown, message: string): boolean {
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : "";
  return name === "InvalidToolInputError"
    || /invalid (?:json )?input for tool|tool arguments.*(?:invalid|schema)|schema validation/i.test(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function stableDomainCode(message: string): string | undefined {
  const match = /(?:^|\b)([A-Z][A-Z0-9_]{2,})(?=:)/.exec(message);
  return match?.[1];
}

function isTerminalDomainCode(code: string): boolean {
  return /(?:_ALREADY_|_NOT_AVAILABLE|_CLOSED|_COMPLETE(?:D)?|_FINISHED|_RESOLVED|_STALE|_EXPIRED|_DUPLICATE)/.test(code);
}

function sanitizeErrorText(value: string): string {
  const cleaned = value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return (cleaned || "The tool rejected the call.").slice(0, 500);
}

/** Compact, provider-neutral shape derived from the SDK tool's JSON Schema. */
function describeJsonSchema(value: unknown): string {
  const description = describeSchemaNode(value, 0);
  return description.length > 800 ? `${description.slice(0, 797)}...` : description;
}

function describeSchemaNode(value: unknown, depth: number): string {
  if (!value || typeof value !== "object") return "unknown";
  const schema = value as Record<string, unknown>;
  if (Array.isArray(schema.enum)) return schema.enum.map(String).join(" | ");
  const alternatives = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (alternatives) return alternatives.slice(0, 5).map((entry) => describeSchemaNode(entry, depth + 1)).join(" | ");
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
  if (type === "array") return `array<${depth >= 3 ? "value" : describeSchemaNode(schema.items, depth + 1)}>`;
  if (type === "object" || schema.properties) {
    if (depth >= 3) return "object";
    const properties = schema.properties && typeof schema.properties === "object"
      ? Object.entries(schema.properties as Record<string, unknown>)
      : [];
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const fields = properties.slice(0, 16).map(([key, child]) =>
      `${key}${required.has(key) ? "" : "?"}: ${describeSchemaNode(child, depth + 1)}`
    );
    if (properties.length > fields.length) fields.push("...");
    return `{ ${fields.join(", ")} }`;
  }
  return typeof type === "string" ? type : "value";
}
