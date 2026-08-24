/**
 * Smoke-gate report (docs/agent-design.md §7): aggregate the hard-metric
 * families from LIVE rooms over the in-memory metrics endpoint. Zero-disk:
 * nothing is read from or written to the filesystem.
 *
 * Usage:
 *   node scripts/smoke-report.mjs [roomId ...]   # default: all live rooms
 *
 * Requires the server to be running (DEMO_API, default http://127.0.0.1:8787).
 * Data source per room: GET /api/rooms/:id/metrics (in-memory counters).
 *
 * Output: markdown report to stdout only (zero-disk invariant — no report file
 * is written; paste the stdout into the PR).
 */
const API = process.env.DEMO_API ?? "http://127.0.0.1:8787";

async function fetchJson(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
  return response.json();
}

const filter = process.argv.slice(2);
const list = await fetchJson("/api/rooms");
const roomIds = filter.length ? filter : list.rooms.map((room) => room.id);
const reports = [];
for (const roomId of roomIds) {
  try {
    const m = await fetchJson(`/api/rooms/${encodeURIComponent(roomId)}/metrics`);
    const validActions = m.compliance.worldActions;
    const rejected = m.compliance.staleCommandRejections + m.compliance.invalidActionRejections;
    const seen = validActions + rejected;
    m.compliance.validActionRate = seen > 0 ? validActions / seen : undefined;
    reports.push(m);
  } catch (error) {
    reports.push({ roomId, error: String(error).slice(0, 200) });
  }
}

const lines = [`# Society Smoke Report — ${new Date().toISOString()}`, "", "> 数据源：运行时内存 /api/rooms/:id/metrics（零落盘）。", ""];
for (const report of reports) {
  lines.push(`## ${report.roomId}${report.error ? " — 读取失败" : ""}`);
  if (report.error) {
    lines.push("", `> ${report.error}`, "");
    continue;
  }
  const c = report.compliance;
  lines.push(
    `场景 ${report.scenarioId} · 状态 ${report.status} · 回合 ${report.turns}`, "",
    "**工具合规**", "",
    `- agent.tool started/succeeded/failed: ${c.toolStarted}/${c.toolSucceeded}/${c.toolFailed}`,
    `- world.action: ${c.worldActions} · 幂等命中: ${c.idempotencyHits} · 迟到拒绝: ${c.staleCommandRejections} · 无效拒绝: ${c.invalidActionRejections}`,
    c.validActionRate === undefined
      ? "- 有效行动率: 无命令样本"
      : `- 有效行动率: ${(c.validActionRate * 100).toFixed(1)}%（world.action / 命令总数）`,
    `- 行动完成率: ${c.completedActivations} 次激活直接完成 · ${c.retriedActivations} 次经重试轮`,
    `- 弃置回合: ${c.abandonedTurns} 在途 · ${c.settledAbandonedTurns} 已settle`,
    `- runtime.notice: ${JSON.stringify(c.noticeCodes)}`, "",
    "**上下文压力**", "",
    `- 分布（level → 次数）: ${JSON.stringify(report.pressure.byLevel)}`,
    `- 峰值 pressureRatio: ${Number(report.pressure.peak ?? 0).toFixed(3)}`, "",
    "**Provider 延迟（turn 墙钟耗时）**", "",
    report.providerLatencyMs.samples
      ? `- 样本 ${report.providerLatencyMs.samples} · p50 ${report.providerLatencyMs.p50}ms · p95 ${report.providerLatencyMs.p95}ms`
      : "- 无样本", "",
    "**承诺对账**", "",
    `- 承诺数: ${report.commitments.total} · 状态分布: ${JSON.stringify(report.commitments.states)}`, "",
    "**社会行为（提取）**", "",
    `- 按来源: ${JSON.stringify(report.extraction.byMethod)}`,
    `- 提取失败计数: ${report.extraction.extractionFailures}`, ""
  );
}

const text = lines.join("\n");
console.log(text);