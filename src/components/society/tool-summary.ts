/**
 * Tool outputs arrive at the UI as sanitized pretty-printed JSON strings
 * (the privacy layer's safeOutputSummary). Spectators should read facts,
 * not JSON: this module flattens one payload into a single semantic line —
 * known keys get Chinese labels, actor ids resolve to display names,
 * bookkeeping noise is dropped, long machine ids are middle-truncated,
 * and anything unparseable degrades to truncated raw text.
 */

/** Pure bookkeeping — present in almost every payload, never useful to a spectator. */
const NOISE_KEYS: ReadonlySet<string> = new Set([
  "recorded", "commitmentId", "actorModelIds", "messageId", "callId", "ok", "detailId"
]);

/** Chinese labels for payload keys we know about; unknown keys pass through. */
const KEY_LABELS: Record<string, string> = {
  accepted: "接受",
  acceptedBy: "接受者",
  action: "行动",
  amount: "数额",
  bid: "出价",
  channel: "频道",
  choice: "选择",
  claimedRole: "自称角色",
  detected: "识破",
  emphasized: "强调",
  face: "点数",
  from: "来自",
  goal: "目标",
  investigation: "查验",
  kind: "类型",
  liarsBidQuantity: "数量",
  move: "动作",
  note: "备注",
  number: "数字",
  offer: "报价",
  pressure: "压力",
  quantity: "数量",
  reason: "理由",
  result: "结果",
  role: "角色",
  round: "回合",
  split: "分配",
  stage: "阶段",
  state: "状态",
  status: "状态",
  target: "目标",
  team: "队伍",
  text: "内容",
  topic: "主张",
  vote: "票",
  waitingFor: "等待"
};

/** Boolean keys where both poles carry meaning — [trueLabel, falseLabel]. */
const BOOLEAN_LABELS: Record<string, [string, string]> = {
  accepted: ["已接受", "未接受"],
  approved: ["通过", "否决"],
  detected: ["已识破", "未识破"],
  fulfilled: ["已履约", "已违约"],
  success: ["成功", "失败"]
};

/** Common enum-ish values worth translating; unknown values pass through. */
const VALUE_LABELS: Record<string, string> = {
  accepted: "已接受",
  rejected: "已拒绝",
  proposed: "待接受",
  fulfilled: "已履约",
  violated: "已违约",
  cooperate: "合作",
  defect: "背叛",
  invest: "投入",
  keep: "自留",
  "mind-read": "读心",
  reflect: "复盘",
  plan: "谋划",
  werewolf: "狼人",
  villager: "村民",
  seer: "预言家",
  witch: "女巫",
  hunter: "猎人",
  guard: "守卫",
  public: "公开",
  private: "私聊",
  team: "阵营"
};

const SUMMARY_CAP = 120;
const VALUE_CAP = 60;
const ARRAY_ITEM_CAP = 3;
/** ids: `commit:pd:1:agent-02:1`, `actor-model-447afbda…` — keep head and tail, drop the middle. */
const ID_THRESHOLD = 22;
const ID_HEAD = 10;
const ID_TAIL = 6;

export type NameResolver = (id: string) => string | undefined;

/**
 * One-line spectator summary of a tool payload. `undefined` when nothing
 * survives the noise filter — the row then shows just the tool name.
 */
export function summarizeToolOutput(raw: string | undefined, resolveName?: NameResolver): string | undefined {
  if (!raw) return undefined;
  const parts = payloadParts(parsePayload(raw), resolveName);
  if (!parts.length) return undefined;
  const summary = parts.join(" · ");
  return summary.length > SUMMARY_CAP ? `${summary.slice(0, SUMMARY_CAP - 1)}…` : summary;
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function payloadParts(payload: unknown, resolveName: NameResolver | undefined): string[] {
  if (payload === null || payload === undefined) return [];
  if (Array.isArray(payload)) return [listLabel(payload, resolveName)];
  if (typeof payload !== "object") return [valueLabel(payload, resolveName) ?? ""];
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (NOISE_KEYS.has(key) || value === null || value === undefined) continue;
    // A boolean paired with a polar label already says everything ("已接受").
    if (typeof value === "boolean" && BOOLEAN_LABELS[key]) {
      parts.push(value ? BOOLEAN_LABELS[key][0] : BOOLEAN_LABELS[key][1]);
      continue;
    }
    const rendered = valueLabel(value, resolveName);
    if (!rendered) continue;
    parts.push(`${KEY_LABELS[key] ?? key} ${rendered}`);
  }
  return parts;
}

function valueLabel(value: unknown, resolveName: NameResolver | undefined): string | undefined {
  if (typeof value === "string") return stringLabel(value, resolveName);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return listLabel(value, resolveName);
  if (value && typeof value === "object") {
    const nested = payloadParts(value, resolveName);
    return nested.length ? nested.join("，") : undefined;
  }
  return undefined;
}

function listLabel(items: unknown[], resolveName: NameResolver | undefined): string {
  const labels = items
    .slice(0, ARRAY_ITEM_CAP)
    .map((item) => valueLabel(item, resolveName))
    .filter((label): label is string => Boolean(label));
  if (!labels.length) return "";
  const more = items.length - labels.length;
  return `${labels.join("、")}${more > 0 ? ` 等 ${items.length} 项` : ""}`;
}

function stringLabel(value: string, resolveName: NameResolver | undefined): string {
  if (!value) return "";
  const name = resolveName?.(value);
  if (name) return name;
  if (looksLikeMachineId(value)) return compactId(value);
  const labeled = VALUE_LABELS[value];
  if (labeled) return labeled;
  return value.length > VALUE_CAP ? `${value.slice(0, VALUE_CAP - 1)}…` : value;
}

function looksLikeMachineId(value: string): boolean {
  return value.length >= ID_THRESHOLD && !/\s/.test(value);
}

function compactId(value: string): string {
  return `${value.slice(0, ID_HEAD)}…${value.slice(-ID_TAIL)}`;
}
