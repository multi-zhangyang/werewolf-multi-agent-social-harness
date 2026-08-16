/**
 * Session context manager — strict context budgeting for long-running agents.
 *
 * A society participant is an agent, not a chat: its session accumulates every
 * turn's observations, tool calls and outputs, and without discipline a long
 * game would drown the model in history. The OpenAI Agents SDK exposes the
 * right seam for this — `sessionInputCallback` — which lets us rewrite what
 * goes to the model on every turn. This manager:
 *
 *   1. estimates the session's input tokens from the history items;
 *   2. when the estimate crosses `compactRatio × contextLimit`, compresses the
 *      older history into a structured digest (via the agent's own model) and
 *      keeps the most recent exchanges verbatim;
 *   3. returns the digest + recent items + new input. The SDK persists the
 *      digest into the session itself, so compaction is durable across turns
 *      and later digests absorb earlier ones — history stays bounded.
 *
 * The digest prompt preserves exactly what a social agent must not forget:
 * commitments, accusations, grudges, relationships, open questions, goals.
 * Everything else is allowed to fade, like a human's memory.
 */

import type { AgentInputItem, ModelProvider, SessionInputCallback } from "@openai/agents";

export interface ContextBudgetOptions {
  provider: ModelProvider;
  model: string;
  /** The model's context window in tokens (per-model, env-driven). */
  contextLimit: number;
  /** Compact when estimated input tokens exceed this ratio of the window. */
  compactRatio?: number;
  /** Keep this many of the most recent history items verbatim. */
  keepRecentItems?: number;
  /** Display name of the agent whose memory is being managed. */
  actorLabel: string;
  /** Called after a compaction with the digest text (for observer UI). */
  onCompacted?: (digest: string, estimatedTokens: number, threshold: number) => void;
}

export interface ContextBudgetInfo {
  /** Estimated input tokens of the last turn's history. */
  estimatedTokens: number;
  /** Token threshold that triggers compaction. */
  threshold: number;
  /** How many compactions have happened. */
  compactCount: number;
  /** The most recent digest, if any. */
  lastDigest?: string;
}

/**
 * Default context window for models without a configured limit. Configure
 * per-model windows precisely via `SOCIETY_MODEL_CONTEXTS` (see .env.example);
 * 256k is a sane default for models we do not know yet.
 */
export const DEFAULT_CONTEXT_LIMIT = 256_000;

/**
 * Fraction of the context window at which compaction triggers. Overridable via
 * `SOCIETY_CONTEXT_COMPACT_RATIO` (default 0.75): a 256k model compacts around
 * 192k tokens, a 1M model around 750k.
 */
export function compactRatioFromEnv(): number {
  const value = Number(process.env.SOCIETY_CONTEXT_COMPACT_RATIO);
  return Number.isFinite(value) && value > 0.1 && value < 0.99 ? value : 0.75;
}

/**
 * Per-model context windows, from `SOCIETY_MODEL_CONTEXTS`:
 * comma-separated `modelId:tokens` entries, e.g.
 * `my-model-a:1000000,my-model-b:262144`. Never hardcoded per provider.
 */
export function contextLimitForModel(model: string): number {
  const configured = parseContextMap(process.env.SOCIETY_MODEL_CONTEXTS);
  return configured.get(model) ?? DEFAULT_CONTEXT_LIMIT;
}

export function parseContextMap(value: string | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of (value ?? "").split(",")) {
    const [id, tokens] = entry.split(":");
    const parsed = Number(tokens);
    if (id && Number.isInteger(parsed) && parsed > 0) map.set(id.trim(), parsed);
  }
  return map;
}

export function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return "1M";
  if (tokens >= 500_000) return "512k";
  if (tokens >= 250_000) return "256k";
  if (tokens >= 120_000) return "128k";
  return `${Math.round(tokens / 1000)}k`;
}

export class SessionContextManager {
  private readonly options: ContextBudgetOptions;
  private compactCount = 0;
  private lastDigest?: string;
  private lastEstimated = 0;

  constructor(options: ContextBudgetOptions) {
    this.options = {
      compactRatio: compactRatioFromEnv(),
      keepRecentItems: 14,
      ...options
    };
  }

  info(): ContextBudgetInfo {
    const threshold = Math.floor(this.options.contextLimit * (this.options.compactRatio ?? 0.7));
    return {
      estimatedTokens: this.lastEstimated,
      threshold,
      compactCount: this.compactCount,
      ...(this.lastDigest ? { lastDigest: this.lastDigest } : {})
    };
  }

  /** The SDK-native hook: combines session history with the new turn's input. */
  readonly sessionInputCallback: SessionInputCallback = async (historyItems, newItems) => {
    const estimated = estimateTokens(historyItems);
    this.lastEstimated = estimated;
    if (historyItems.length === 0) return [...historyItems, ...newItems];
    const ratio = this.options.compactRatio ?? 0.7;
    const threshold = Math.floor(this.options.contextLimit * ratio);
    if (estimated < threshold) return [...historyItems, ...newItems];

    const keep = Math.min(historyItems.length, this.options.keepRecentItems ?? 14);
    const recent = historyItems.slice(-keep);
    const old = historyItems.slice(0, -keep);
    const digest = await this.summarize(old);
    this.compactCount += 1;
    this.lastDigest = digest;
    this.options.onCompacted?.(digest, estimated, threshold);
    return [digestItem(digest), ...recent, ...newItems];
  };

  private async summarize(items: AgentInputItem[]): Promise<string> {
    const transcript = renderItems(items);
    // Keep the digest input inside the budget so 256k models can always read it.
    const cap = Math.floor(this.options.contextLimit * 0.6);
    const trimmed = transcript.length > cap
      ? `${transcript.slice(0, cap)}\n…[earlier history trimmed]`
      : transcript;
    const model = await this.options.provider.getModel(this.options.model);
    const response = await model.getResponse({
      systemInstructions: [
        `You are the memory manager of ${this.options.actorLabel}, a participant in a continuing social world.`,
        "Compress the conversation below into a concise private brief. Keep, with exact names and facts:",
        "1) commitments and promises made, and whether each was kept;",
        "2) accusations, defenses, and who said what about whom;",
        "3) relationships, grudges, debts and trust changes;",
        "4) the current situation, roles, and open questions;",
        "5) this participant's goals, beliefs and plans.",
        "Drop filler. Write in the language of the conversation. Plain text, no preamble."
      ].join("\n"),
      input: trimmed,
      modelSettings: { temperature: 0.2 },
      tools: [],
      outputType: "text",
      handoffs: [],
      tracing: false
    });
    return extractText(response.output).trim() || "（上下文压缩摘要为空）";
  }
}

function digestItem(text: string): AgentInputItem {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }]
  } as unknown as AgentInputItem;
}

/**
 * CJK-aware token estimate: Chinese characters count ≈ 1 token each (Chinese
 * tokenizers typically run 0.6–1.0 tokens/character), other text ≈ 4 chars per
 * token, plus a small per-item overhead. Deliberately conservative: compact a
 * little early rather than blow the window.
 */
function estimateTokens(items: AgentInputItem[]): number {
  let cjk = 0;
  let latin = 0;
  for (const item of items) {
    const text = itemText(item);
    for (const char of text) {
      if (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(char)) cjk += 1;
      else latin += 1;
    }
  }
  return Math.round(cjk * 1.0 + latin / 4) + items.length * 3;
}

function itemText(item: AgentInputItem): string {
  const value = item as unknown as Record<string, unknown>;
  if (value.type === "message") {
    const content = value.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          const p = part as Record<string, unknown>;
          return typeof p.text === "string" ? p.text : "";
        })
        .join("\n");
    }
    return "";
  }
  if (value.type === "function_call") {
    return `${value.name ?? "tool"}(${JSON.stringify(value.arguments ?? "")})`;
  }
  if (value.type === "function_call_output") {
    const output = value.output;
    return typeof output === "string" ? output : JSON.stringify(output ?? "");
  }
  if (value.type === "reasoning") {
    return "";
  }
  return JSON.stringify(value).slice(0, 500);
}

function renderItems(items: AgentInputItem[]): string {
  return items.map((item, index) => {
    const value = item as unknown as Record<string, unknown>;
    if (value.type === "message") {
      const role = value.role ?? "message";
      const text = itemText(item);
      return text ? `[${role}] ${text}` : "";
    }
    const text = itemText(item);
    return text ? `[tool] ${text}` : "";
  }).filter(Boolean).join("\n");
}

function extractText(output: Array<{ type?: string; content?: unknown; text?: unknown }>): string {
  const parts: string[] = [];
  for (const entry of output ?? []) {
    if (entry.type !== "message") continue;
    const content = entry.content;
    if (typeof content === "string") {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") parts.push(p.text);
      }
    }
  }
  return parts.join("\n");
}
