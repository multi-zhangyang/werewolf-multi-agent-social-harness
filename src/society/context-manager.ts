/**
 * Session context manager — multi-level pressure budgeting for long-running
 * peer agents.
 *
 * A society participant accumulates every turn's observations, tool calls and
 * outputs. This manager enforces the resolved ContextPolicy:
 *
 *   normal          < watchRatio            run normally
 *   watch           watch…retrievalTight    report pressure, dedupe
 *   retrieval-tight retrieval…softCompact   shrink memory injection
 *   soft-compact    soft…deepCompact        compact finished old episodes
 *   deep-compact    deep…emergency          structured consolidation
 *   emergency       emergency…hardLimit     keep only pinned facts + recent
 *   hard-guard      ≥ hardLimitRatio        refuse the main model call
 *
 * Compaction preserves a deterministic pinned-facts block (identity, role,
 * win condition, active commitments, open plans) plus a model-written digest
 * of the old history, keeps the most recent items verbatim, and targets a
 * post-compaction pressure of 52–58% with hysteresis and cooldown. A hard
 * guard throws instead of silently overrunning the window.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AgentInputItem, ModelProvider, SessionInputCallback } from "@openai/agents";
import type { ContextPolicy, ResolvedModelConfig } from "./models";

export type ContextPressureLevel =
  | "normal"
  | "watch"
  | "retrieval-tight"
  | "soft-compact"
  | "deep-compact"
  | "emergency"
  | "hard-guard";

export interface ContextBudget {
  contextWindow: number;
  reservedOutputTokens: number;
  reservedToolTokens: number;
  reservedSystemTokens: number;
  safetyMarginTokens: number;
  usableInputTokens: number;
  currentInputTokens: number;
  pressureRatio: number;
}

export interface ContextBudgetOptions {
  provider: ModelProvider;
  model: string;
  /** Display name of the agent whose memory is being managed. */
  actorLabel: string;
  /** New path: fully resolved config (window, reserves, policy). */
  resolvedConfig?: ResolvedModelConfig;
  /** Legacy path (no registry): window and single compaction ratio. */
  contextLimit?: number;
  compactRatio?: number;
  keepRecentItems?: number;
  /** Deterministic facts that must survive every compaction. */
  getPinnedFacts?: () => string[];
  /** The character whose history is being summarized (artifact provenance). */
  ownerCharacterId?: string;
  /** World events the summarized range was derived from, when known. */
  getSourceEventIds?: () => string[];
  /** Open commitments / active deceptions carried into the digest. */
  getOpenCommitmentIds?: () => string[];
  getActiveDeceptionIds?: () => string[];
  /** Room logical time at compaction (replay-safe recency). */
  getLogicalTime?: () => number;
  /** Called with the full provenance artifact after each compaction. */
  onArtifact?: (artifact: ContextSummaryArtifact) => void;
  /** Called after a compaction (for observer UI). */
  onCompacted?: (digest: string, estimatedTokens: number, threshold: number, level: ContextPressureLevel, pressureAfter: number) => void;
  /** Called when the pressure level changes (for observer UI). */
  onPressure?: (budget: ContextBudget, level: ContextPressureLevel) => void;
  /**
   * Rewrite the session to the compacted items. Without this, the request view
   * shrinks but the stored history keeps growing, so the next activation
   * re-estimates the full history and re-trips the hard guard forever — the
   * exact deadlock a long game must never hit.
   */
  onSessionCompacted?: (items: AgentInputItem[]) => Promise<void> | void;
}

/**
 * Provenance of one compaction: the digest is a trusted system-administrative
 * context block, never player speech. The artifact travels with the digest
 * item into the session, so the spectator can still see what was summarized,
 * from which range, by which model.
 */
export interface ContextSummaryArtifact {
  summaryId: string;
  ownerCharacterId: string;
  sourceItemRange: { from: number; to: number };
  sourceEventIds: string[];
  sourceItemIds: string[];
  sourceHash: string;
  summaryModel: string;
  summaryPromptVersion: string;
  createdAtLogicalTime: number;
  facts: string[];
  unresolvedQuestions: string[];
  openCommitmentIds: string[];
  activeDeceptionIds: string[];
  compressedNarrative: string;
  schemaVersion: number;
}

export interface ContextBudgetInfo {
  budget: ContextBudget;
  level: ContextPressureLevel;
  threshold: number;
  compactCount: number;
  lastDigest?: string;
  lastCompactedAt?: string;
}

/** Default context window for models without a configured limit. */
export const DEFAULT_CONTEXT_LIMIT = 256_000;

/**
 * Fraction of the context window at which compaction triggers in legacy mode.
 * Overridable via `SOCIETY_CONTEXT_COMPACT_RATIO` (default 0.75).
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
  private readonly policy: ContextPolicy;
  private readonly usableInputTokens: number;
  private compactCount = 0;
  private lastDigest?: string;
  private lastEstimated = 0;
  /** Undefined until the first preflight, so every room emits at least one
   *  pressure sample for the smoke metric even when it never rises. */
  private lastLevel?: ContextPressureLevel;
  private lastCompactedAt?: string;
  private activationsSinceCompaction = 0;

  constructor(options: ContextBudgetOptions) {
    this.options = options;
    if (options.resolvedConfig) {
      const config = options.resolvedConfig;
      this.policy = config.contextPolicy;
      this.usableInputTokens = config.usableInputTokens;
    } else {
      this.policy = legacyPolicy();
      const contextLimit = options.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
      this.usableInputTokens = Math.floor(contextLimit * 0.92);
    }
  }

  info(): ContextBudgetInfo {
    const budget = this.budgetFor(this.lastEstimated);
    return {
      budget,
      level: this.levelFor(budget.pressureRatio),
      threshold: Math.floor(this.usableInputTokens * this.policy.softCompactRatio),
      compactCount: this.compactCount,
      ...(this.lastDigest ? { lastDigest: this.lastDigest } : {}),
      ...(this.lastCompactedAt ? { lastCompactedAt: this.lastCompactedAt } : {})
    };
  }

  /** Current pressure level (drives retrieval tightening etc.). */
  pressure(): ContextPressureLevel {
    return this.lastLevel ?? "normal";
  }

  /**
   * One-shot compaction against this manager's window, used by model switches:
   * before the agent continues on a smaller window, its history is
   * compacted so the first turn after the switch starts below the pressure
   * thresholds instead of tripping the hard guard. Returns the replacement
   * history (compaction marker + retained suffix).
   */
  async compactHistory(historyItems: AgentInputItem[]): Promise<AgentInputItem[]> {
    if (historyItems.length === 0) return historyItems;
    const estimated = estimateTokens(historyItems, this.policy.heuristicSafetyMultiplier);
    const ratio = estimated / Math.max(1, this.usableInputTokens);
    const level = this.levelFor(ratio);
    if (level !== "soft-compact" && level !== "deep-compact" && level !== "emergency" && level !== "hard-guard") {
      return historyItems;
    }
    const { kept } = await this.compact(historyItems, level === "hard-guard" ? "deep-compact" : level);
    return [digestItem(kept.digest, kept.artifact), ...kept.recent];
  }

  /**
   * This-round pressure BEFORE memory retrieval: estimate the session history
   * plus the fixed part of the incoming input, so the caller sizes retrieval
   * by THIS activation's budget instead of the previous one's.
   */
  preflight(historyItems: AgentInputItem[], extraTokens: number): ContextPressureLevel {
    const estimated = estimateTokens(historyItems, this.policy.heuristicSafetyMultiplier) + Math.max(0, extraTokens);
    this.lastEstimated = estimated;
    const level = this.levelFor(estimated / Math.max(1, this.usableInputTokens));
    this.reportPressure(this.budgetFor(estimated), level);
    return level;
  }

  /** The SDK-native hook: combines session history with the new turn's input. */
  readonly sessionInputCallback: SessionInputCallback = async (historyItems, newItems) => {
    // Some thinking models emit tool-call arguments that get truncated mid-JSON.
    // The provider then rejects the *next* request because the poisoned history
    // item is re-sent verbatim. Replace broken argument JSON with a valid
    // placeholder in the request view only — the stored session is untouched
    // and the agent keeps its own failure history.
    historyItems = sanitizeFunctionCalls(historyItems);
    // Full-candidate measurement: the new turn's input belongs to the SAME
    // budget calculation as the history — never appended afterwards.
    const fullEstimate = estimateTokens([...historyItems, ...newItems], this.policy.heuristicSafetyMultiplier);
    this.lastEstimated = fullEstimate;
    this.activationsSinceCompaction += 1;
    const budget = this.budgetFor(fullEstimate);
    const level = this.levelFor(budget.pressureRatio);
    this.reportPressure(budget, level);

    if (historyItems.length === 0) return [...historyItems, ...newItems];

    // Hard guard: never send a request that would overrun the window. One
    // last-resort emergency compaction runs first — without it, pressure can
    // never drop and the agent deadlocks.
    // The relief check includes the new input: compaction must free enough
    // room for the whole request, not just the history.
    if (budget.pressureRatio >= this.policy.hardLimitRatio) {
      const { kept } = await this.compact(historyItems, "emergency");
      const after = estimateTokens([digestItem(kept.digest, kept.artifact), ...kept.recent, ...newItems], this.policy.heuristicSafetyMultiplier);
      if (after / Math.max(1, this.usableInputTokens) < this.policy.hardLimitRatio) {
        await this.options.onSessionCompacted?.([digestItem(kept.digest, kept.artifact), ...kept.recent]);
        return [digestItem(kept.digest, kept.artifact), ...kept.recent, ...newItems];
      }
      const error = new Error(
        `CONTEXT_HARD_GUARD: Input pressure ${Math.round(budget.pressureRatio * 100)}% exceeds the hard limit ` +
        `(${Math.round(this.policy.hardLimitRatio * 100)}%) of ${this.usableInputTokens.toLocaleString()} usable tokens. ` +
        `Emergency compaction could not relieve the pressure; the agent must not call the model until it does.`
      );
      (error as Error & { code?: string }).code = "CONTEXT_HARD_GUARD";
      throw error;
    }

    if (level !== "soft-compact" && level !== "deep-compact" && level !== "emergency") {
      return [...historyItems, ...newItems];
    }
    // Cooldown: within N activations of a compaction, skip unless escalation.
    if (this.activationsSinceCompaction <= this.policy.compactionCooldownActivations
        && this.lastLevel !== "deep-compact"
        && level === "soft-compact") {
      return [...historyItems, ...newItems];
    }

    const { kept, compacted } = await this.compact(historyItems, level);
    // Write the compacted history back so the next activation estimates the
    // shrunk session instead of the pre-compaction one.
    if (compacted) await this.options.onSessionCompacted?.([digestItem(kept.digest, kept.artifact), ...kept.recent]);
    return [digestItem(kept.digest, kept.artifact), ...kept.recent, ...newItems];
  };

  private async compact(historyItems: AgentInputItem[], level: ContextPressureLevel): Promise<{
    kept: { digest: string; artifact: ContextSummaryArtifact; recent: AgentInputItem[] };
    compacted: boolean;
  }> {
    // Choose the largest recent suffix that lands us inside the post-compaction
    // target band (52–58%), with a floor so the digest never loses the tail.
    const targetMax = Math.floor(this.usableInputTokens * this.policy.targetAfterCompactionMax);
    let keep = this.options.keepRecentItems ?? this.policy.recentRawMessagesToKeep;
    while (keep > 2) {
      const tail = historyItems.slice(-keep);
      if (estimateTokens(tail, this.policy.heuristicSafetyMultiplier) <= targetMax) break;
      keep = Math.max(2, keep - 2);
    }
    const recent = historyItems.slice(-keep);
    const old = historyItems.slice(0, -keep);

    const pinned = (this.options.getPinnedFacts?.() ?? []).map((fact) => fact.trim()).filter(Boolean);
    let digest = await this.summarize(old, pinned, level);
    if (!digest) {
      digest = fallbackExtraction(old);
    }
    this.compactCount += 1;
    this.lastDigest = digest;
    this.lastCompactedAt = new Date().toISOString();
    this.activationsSinceCompaction = 0;

    const digestText = [
      ...(pinned.length ? [`【固定事实 — 压缩后必须保留】\n${pinned.map((fact) => `- ${fact}`).join("\n")}`] : []),
      `【历史摘要】\n${digest}`
    ].join("\n\n");

    const artifact = artifactFor(this.options, old, pinned, digest, 0, Math.max(0, old.length - 1));
    const after = estimateTokens([digestItem(digestText, artifact), ...recent], this.policy.heuristicSafetyMultiplier);
    const pressureAfter = after / Math.max(1, this.usableInputTokens);
    this.lastEstimated = after;
    // The compaction moved the pressure; observers must see the new level.
    this.reportPressure(this.budgetFor(after), this.levelFor(pressureAfter));
    this.options.onArtifact?.(artifact);
    this.options.onCompacted?.(digestText, estimateTokens(historyItems, this.policy.heuristicSafetyMultiplier), Math.floor(this.usableInputTokens * this.policy.softCompactRatio), level, pressureAfter);
    return { kept: { digest: digestText, artifact, recent }, compacted: true };
  }

  private async summarize(items: AgentInputItem[], pinned: string[], level: ContextPressureLevel): Promise<string> {
    if (!items.length) return "";
    const transcript = renderItems(items);
    // Keep the digest input inside the budget so small-window models can read it.
    const cap = Math.floor(this.usableInputTokens * 0.6);
    const trimmed = transcript.length > cap
      ? `${transcript.slice(0, cap)}\n…[earlier history trimmed]`
      : transcript;
    try {
      const model = await this.options.provider.getModel(this.options.model);
      const response = await model.getResponse({
        systemInstructions: [
          `You are the memory manager of ${this.options.actorLabel}, a participant in a continuing social world.`,
          `Compression level: ${level}. Compress the conversation below into a concise private brief.`,
          "Keep, with exact names and facts:",
          "1) commitments and promises made, and whether each was kept;",
          "2) accusations, defenses, and who said what about whom;",
          "3) relationships, grudges, debts and trust changes;",
          "4) the current situation, roles, and open questions;",
          "5) this participant's goals, beliefs and plans;",
          "6) this participant's own recorded reflections and strategic notes (reflect_on_social_situation / plan_social_strategy outputs) — their conclusions and any unfinished plan must survive compression.",
          pinned.length
            ? `These pinned facts are already preserved verbatim elsewhere — do not contradict them:\n${pinned.map((fact) => `- ${fact}`).join("\n")}`
            : "",
          "Drop filler. Write in the language of the conversation. Plain text, no preamble."
        ].filter(Boolean).join("\n"),
        input: trimmed,
        modelSettings: { temperature: 0.2 },
        tools: [],
        outputType: "text",
        handoffs: [],
        tracing: false
      });
      return extractText(response.output).trim();
    } catch {
      // One retry with a lighter request, then deterministic fallback.
      try {
        const model = await this.options.provider.getModel(this.options.model);
        const response = await model.getResponse({
          systemInstructions: "Compress into a short factual brief. Plain text, no preamble.",
          input: trimmed.slice(0, Math.floor(this.usableInputTokens * 0.4)),
          modelSettings: { temperature: 0.2 },
          tools: [],
          outputType: "text",
          handoffs: [],
          tracing: false
        });
        return extractText(response.output).trim();
      } catch {
        return "";
      }
    }
  }

  private budgetFor(currentInputTokens: number): ContextBudget {
    const budget: ContextBudget = {
      contextWindow: this.options.resolvedConfig?.contextWindow ?? (this.options.contextLimit ?? DEFAULT_CONTEXT_LIMIT),
      reservedOutputTokens: this.options.resolvedConfig?.reservedOutputTokens ?? 0,
      reservedToolTokens: this.options.resolvedConfig?.reservedToolTokens ?? 0,
      reservedSystemTokens: this.options.resolvedConfig?.reservedSystemTokens ?? 0,
      safetyMarginTokens: this.options.resolvedConfig?.safetyMarginTokens ?? 0,
      usableInputTokens: this.usableInputTokens,
      currentInputTokens,
      pressureRatio: currentInputTokens / Math.max(1, this.usableInputTokens)
    };
    return budget;
  }

  private levelFor(ratio: number): ContextPressureLevel {
    if (ratio >= this.policy.hardLimitRatio) return "hard-guard";
    if (ratio >= this.policy.emergencyRatio) return "emergency";
    if (ratio >= this.policy.deepCompactRatio) return "deep-compact";
    if (ratio >= this.policy.softCompactRatio) return "soft-compact";
    if (ratio >= this.policy.retrievalTightRatio) return "retrieval-tight";
    if (ratio >= this.policy.watchRatio) return "watch";
    return "normal";
  }

  private reportPressure(budget: ContextBudget, level: ContextPressureLevel): void {
    if (level === this.lastLevel) return;
    this.lastLevel = level;
    this.options.onPressure?.(budget, level);
  }
}

/** Deterministic, extraction-only fallback: facts survive, prose may not. */
function fallbackExtraction(items: AgentInputItem[]): string {
  const lines = renderItems(items).split("\n").filter(Boolean);
  const kept = [
    ...lines.filter((line) => /(承诺|答应|保证|约定|发誓|purpose|promise|commit|pledge|vow)/i.test(line)),
    ...lines.filter((line) => /(指控|怀疑|投票|背叛|accuse|suspicion|accus|betray|vote)/i.test(line))
  ];
  const unique = [...new Set(kept)].slice(0, 40);
  return unique.length
    ? `（确定性提取）\n${unique.join("\n")}`
    : "（本次压缩无可用摘要；历史条目已按窗口上限保留）";
}

function legacyPolicy(): ContextPolicy {
  const ratio = compactRatioFromEnv();
  return {
    id: "policy-legacy",
    name: "旧版单阈值",
    mode: "automatic",
    watchRatio: 0.55,
    retrievalTightRatio: 0.65,
    softCompactRatio: ratio,
    deepCompactRatio: ratio,
    emergencyRatio: 0.9,
    hardLimitRatio: 0.95,
    targetAfterCompactionMin: 0.52,
    targetAfterCompactionMax: 0.58,
    recentTurnsToKeep: 3,
    recentRawMessagesToKeep: 14,
    recentToolResultsToKeep: 6,
    maxRetrievedMemoryTokens: 6_000,
    reservedOutputTokens: "auto",
    reservedToolTokens: "auto",
    safetyMarginTokens: "auto",
    compactionCooldownActivations: 4,
    tokenizer: "heuristic",
    heuristicSafetyMultiplier: 1.15,
    useNativeCompaction: "auto",
    verifyPinnedFacts: true,
    consolidateDuringIdle: true
  };
}

const SUMMARY_PROMPT_VERSION = "context-digest-v1";
export const CONTEXT_SUMMARY_SCHEMA_VERSION = 1;

/**
 * The compaction digest is a TRUSTED system context block, not a user
 * message: it renders with an explicit administrative framing and the full
 * provenance artifact rides on the item into the session.
 */
function digestItem(text: string, artifact: ContextSummaryArtifact): AgentInputItem {
  // Plain-string content: structured `input_text` parts in system messages
  // are rejected by some strict endpoints, which 400s every follow-up
  // request once compaction kicks in (verified against the live gateway).
  return {
    type: "message",
    role: "system",
    content: `【系统管理上下文 — 压缩历史摘要，非玩家发言】
${text}`,
    societySummaryArtifact: artifact
  } as unknown as AgentInputItem;
}

function artifactFor(
  options: ContextBudgetOptions,
  old: AgentInputItem[],
  pinned: string[],
  digest: string,
  fromIndex: number,
  toIndex: number
): ContextSummaryArtifact {
  const rendered = old.map((item) => itemText(item)).join("\n");
  return {
    summaryId: `summary_${randomUUID()}`,
    ownerCharacterId: options.ownerCharacterId ?? options.actorLabel,
    sourceItemRange: { from: fromIndex, to: toIndex },
    sourceEventIds: options.getSourceEventIds?.() ?? [],
    sourceItemIds: old
      .map((item) => (item as unknown as { id?: string }).id)
      .filter((id): id is string => Boolean(id)),
    sourceHash: createHash("sha256").update(rendered).digest("hex"),
    summaryModel: options.model,
    summaryPromptVersion: SUMMARY_PROMPT_VERSION,
    createdAtLogicalTime: options.getLogicalTime?.() ?? 0,
    facts: [...pinned],
    unresolvedQuestions: [],
    openCommitmentIds: options.getOpenCommitmentIds?.() ?? [],
    activeDeceptionIds: options.getActiveDeceptionIds?.() ?? [],
    compressedNarrative: digest,
    schemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION
  };
}

/**
 * Replace malformed tool-call argument JSON in the request view of history.
 * Non-destructive: the session keeps the original items.
 */
export function sanitizeFunctionCalls(items: AgentInputItem[]): AgentInputItem[] {
  let changed = false;
  const next = items.map((item) => {
    const value = item as unknown as Record<string, unknown>;
    if (value.type !== "function_call" || typeof value.arguments !== "string") return item;
    try {
      JSON.parse(value.arguments);
      return item;
    } catch {
      changed = true;
      const repaired = structuredClone(item) as Record<string, unknown>;
      repaired.arguments = JSON.stringify({
        _recovered: true,
        note: "previous tool-call arguments were truncated by the model; call the tool again with complete arguments."
      });
      return repaired as AgentInputItem;
    }
  });
  return changed ? next : items;
}

/**
 * CJK-aware token estimate: Chinese characters count ≈ 1 token each, other
 * text ≈ 4 chars per token, plus per-item overhead, scaled by the policy's
 * heuristic safety multiplier (≥ 1.15). Deliberately conservative.
 */
export function estimateTokens(items: AgentInputItem[], multiplier = 1.15): number {
  let cjk = 0;
  let latin = 0;
  for (const item of items) {
    const text = itemText(item);
    for (const char of text) {
      if (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(char)) cjk += 1;
      else latin += 1;
    }
  }
  return Math.round((cjk * 1.0 + latin / 4 + items.length * 3) * multiplier);
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
  return items.map((item) => {
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

/** Join model response output items into plain text (shared with the room's sidecar extractor). */
export function extractText(output: Array<{ type?: string; content?: unknown; text?: unknown }>): string {
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