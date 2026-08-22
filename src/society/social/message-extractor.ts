import type { SocialMessage } from "../contracts";
import type { SocialActDeclaration, SocialActKind } from "./contracts";

/**
 * Message sidecar extraction (AGENTS.md §6.5 / P1-02): derive structured
 * social acts from a discussion message AFTER it is persisted. The original
 * text stays immutable; extraction results carry confidence and are recorded
 * with `extractionMethod: "model-extracted"` so observers can tell them apart
 * from the speaker's own typed declarations.
 *
 * This module is pure: no provider, no ledger access. The room owns the model
 * call and the recording path, so tests can drive parsing deterministically.
 */

/** Acts worth surfacing on the causality page. `silence` is never extracted. */
const EXTRACTABLE_KINDS: readonly SocialActKind[] = [
  "assertion", "denial", "question", "answer", "promise", "offer",
  "acceptance", "rejection", "request", "threat", "accusation", "defense",
  "apology", "alliance-proposal", "disclosure", "endorsement", "warning"
];

/** Below this an act is still recorded but flagged low-confidence in UI copy. */
export const EXTRACTION_CONFIDENCE_FLOOR = 0.55;

export interface ExtractionRosterEntry {
  id: string;
  name: string;
}

export interface ExtractionRequest {
  systemInstructions: string;
  input: string;
}

export function buildExtractionRequest(message: SocialMessage, roster: ExtractionRosterEntry[]): ExtractionRequest {
  const participants = roster
    .map((entry) => `- ${entry.name} (id: ${entry.id})`)
    .join("\n");
  const audience = (message.recipientIds ?? [])
    .map((id) => roster.find((entry) => entry.id === id)?.name ?? id)
    .join("、");
  const systemInstructions = [
    "你是对话的社会语义标注器。给定一条多智能体社交对局中的消息，提取说话者在这条消息里实际做出的社会行为。",
    "只根据消息文本本身判断，不要猜测未说出的意图。宁可漏报，不可编造。",
    "每条行为输出：kind（必须是这些之一：" + EXTRACTABLE_KINDS.join("/") + "）、targets（行为指向的参与者 id 数组，没有则省略）、proposition（该行为主张/承诺/指控的具体内容，一句话，带主语）、confidence（0 到 1 的小数）。",
    "规则：",
    "- 一条消息可以产生 0 到 3 条行为；寒暄、推进剧情、无明确社会行为的输出空数组 []。",
    "- proposition 必须是消息中可引用的原义，不得扩写或演绎。",
    "- promise/offer 只在说话者明确说出将要做某事时输出。",
    "- 只输出 JSON 数组，不要解释、不要 markdown 代码块以外的任何文字。"
  ].join("\n");
  const input = [
    `参与者名册：`,
    participants,
    "",
    `频道：${message.channel}${audience ? `（私聊对象：${audience}）` : ""}`,
    `发言者：${message.senderName} (id: ${message.senderId})`,
    `消息内容：`,
    message.text
  ].join("\n");
  return { systemInstructions, input };
}

/**
 * Parse a model response into validated declarations. Junk kinds, unknown
 * targets and non-finite confidence are dropped; text fields are clamped so a
 * chatty extractor cannot flood the ledger. Returns at most three acts.
 */
export function parseExtractedDeclarations(raw: string, message: SocialMessage, roster: ExtractionRosterEntry[]): SocialActDeclaration[] {
  const payload = extractJsonArray(raw);
  if (!Array.isArray(payload)) return [];
  const byName = new Map(roster.map((entry) => [entry.name.toLowerCase(), entry.id]));
  const knownIds = new Set(roster.map((entry) => entry.id));
  const senderId = message.senderId;
  const channelAudience = message.channel === "public"
    ? [...knownIds].filter((id) => id !== senderId)
    : (message.recipientIds ?? []).filter((id) => knownIds.has(id));
  const declarations: SocialActDeclaration[] = [];
  for (const entry of payload.slice(0, 3)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== "string" || !EXTRACTABLE_KINDS.includes(kind as SocialActKind)) continue;
    const confidence = clamp01(record.confidence);
    if (confidence < EXTRACTION_CONFIDENCE_FLOOR) continue;
    const targetActorIds = resolveTargets(record.targets, { byName, knownIds, fallback: channelAudience });
    const declaration: SocialActDeclaration = {
      kind: kind as SocialActKind,
      ...(targetActorIds.length ? { targetActorIds } : {}),
      ...(confidence < 1 ? { confidence } : {}),
      ...(buildProposition(record.proposition, kind as SocialActKind, senderId) ? {
        proposition: buildProposition(record.proposition, kind as SocialActKind, senderId)!
      } : {})
    };
    declarations.push(declaration);
  }
  return declarations;
}

function resolveTargets(value: unknown, scope: {
  byName: Map<string, string>;
  knownIds: Set<string>;
  fallback: string[];
}): string[] {
  if (!Array.isArray(value)) return [...scope.fallback];
  const resolved: string[] = [];
  for (const item of value.slice(0, 4)) {
    if (typeof item !== "string" || !item.trim()) continue;
    const trimmed = item.trim();
    if (scope.knownIds.has(trimmed)) {
      resolved.push(trimmed);
      continue;
    }
    const byName = scope.byName.get(trimmed.toLowerCase());
    if (byName) resolved.push(byName);
  }
  return [...new Set(resolved)];
}

function buildProposition(
  value: unknown,
  kind: SocialActKind,
  senderId: string
): SocialActDeclaration["proposition"] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const predicate = value.trim().slice(0, 200);
  // A first-person claim ("我会…"/"这轮我投你"/"I will…") is about the speaker
  // themself; claims about others name them explicitly.
  const subjectIsSpeaker = /(我|我们)/.test(predicate) || /^(i|we|my|our)\b/i.test(predicate);
  return {
    kind: propositionKindFor(kind),
    ...(subjectIsSpeaker ? { subjectId: senderId } : {}),
    predicate
  };
}

function propositionKindFor(kind: SocialActKind): NonNullable<SocialActDeclaration["proposition"]>["kind"] {
  switch (kind) {
    case "promise":
    case "offer":
    case "request":
    case "threat":
      return "future-action";
    case "accusation":
    case "assertion":
    case "denial":
    case "disclosure":
      return "past-action";
    case "alliance-proposal":
    case "acceptance":
    case "rejection":
      return "intention";
    default:
      return "evaluation";
  }
}

function clamp01(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

/** Tolerate fenced or prose-wrapped responses: take the outermost JSON array. */
function extractJsonArray(raw: string): unknown {
  const text = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}
