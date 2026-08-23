/**
 * Wire-contract enforcement for tool calling (OpenAI spec: each
 * `function.arguments` value is a JSON string). Models occasionally emit
 * malformed payloads — unescaped ASCII quotes inside string values, or
 * truncation when output tokens run out mid-call — and strict endpoints
 * reject the ENTIRE request over one bad entry, which would permanently
 * poison the conversation. These helpers make outgoing payloads valid
 * without special-casing any provider or model.
 */

/** Deterministic repair: escape inner quotes, close truncated strings/brackets. */
export function repairJsonText(text: string): string | undefined {
  const stack: string[] = [];
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === String.fromCharCode(92)) {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
        const closes = next === undefined || next === "," || next === ":" || next === "}" || next === "]";
        if (!closes) {
          out += String.fromCharCode(92) + '"';
          continue;
        }
        inString = false;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    if ((ch === "}" || ch === "]") && stack.length) stack.pop();
    out += ch;
  }
  if (inString) out += '"';
  while (stack.length) out += stack.pop();
  try {
    JSON.parse(out);
    return out;
  } catch {
    return undefined;
  }
}

const WIRE_INVALID_ARGS = "{}";

function repairArgumentsValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return repairJsonText(raw) ?? WIRE_INVALID_ARGS;
  }
}

/**
 * Some strict endpoints reject structured content arrays in messages (the
 * `[{type:"input_text",...}]` part format), returning a generic 400 for the
 * whole request. For text-only content the array is losslessly convertible
 * to a plain string, which every OpenAI-compatible endpoint accepts.
 */
export function normalizeInputTextParts(value: unknown): unknown {
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((part) => part && typeof part === "object" && part.type === "input_text" && typeof part.text === "string")
  ) {
    return value.map((part) => part.text).join("\n");
  }
  return value;
}

function normalizeTextArrayContent(message: Record<string, unknown>): boolean {
  const content = message.content;
  if (!Array.isArray(content)) return false;
  const normalized = normalizeInputTextParts(content);
  if (normalized === content) return false;
  message.content = normalized;
  return true;
}

/**
 * Sanitize chat-completions style payloads: every
 * `messages[].tool_calls[].function.arguments` becomes wire-valid and every
 * text-only content array becomes a plain string. Returns the original object
 * when nothing needed changing.
 */
export function sanitizeChatCompletionsPayload<T>(body: T): T | undefined {
  const record = body as unknown as Record<string, unknown> | undefined;
  const messages = record?.messages;
  if (!Array.isArray(messages)) return undefined;
  let changed = false;
  for (const rawMessage of messages) {
    const message = rawMessage as Record<string, unknown>;
    if (normalizeTextArrayContent(message)) changed = true;
    const toolCalls = message?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      const fn = (call as Record<string, unknown>)?.function as Record<string, unknown> | undefined;
      if (!fn || !("arguments" in fn)) continue;
      const fixed = repairArgumentsValue(fn.arguments);
      if (fixed !== fn.arguments) {
        fn.arguments = fixed;
        changed = true;
      }
    }
  }
  return changed ? body : undefined;
}
