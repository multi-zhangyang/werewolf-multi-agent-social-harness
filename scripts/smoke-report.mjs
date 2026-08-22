/**
 * Smoke-gate report (AGENTS.md §38): aggregate the three hard-metric families
 * from finished room checkpoints on disk.
 *
 * Usage:
 *   node scripts/smoke-report.mjs [roomId ...]   # default: all checkpoints
 *
 * Data sources per checkpoint (data/rooms/<id>/checkpoint.json):
 *   - worldState.shared.socialCausality  (full omniscient ledger projection)
 *   - worldState.shared.runtimeStats     (idempotency hits, stale rejects)
 *   - replayEnvelopes                    (runtime.notice / agent.tool / world.action)
 *   - snapshot.world.log                 (story beats for the strong-label audit)
 * The visibility-filtered snapshot.world.details is deliberately NOT used.
 *
 * Output: markdown report to stdout and artifacts/smoke/<timestamp>-report.md.
 * The extraction list at the bottom is the manual spot-check sample (§37).
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const dataDir = resolve("data/rooms");
const outDir = resolve("artifacts/smoke");
mkdirSync(outDir, { recursive: true });

const STRONG_BEATS = new Set(["betrayal", "promise-kept", "promise-broken", "deception-exposed", "alliance"]);

function listCheckrooms(filter) {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => !filter || filter.includes(id));
}

function loadCheckpoint(roomId) {
  const file = resolve(dataDir, roomId, "checkpoint.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { roomId, corrupt: String(error).slice(0, 120) };
  }
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item) ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function analyze(roomId, checkpoint) {
  if (!checkpoint || checkpoint.corrupt) {
    return { roomId, corrupt: checkpoint?.corrupt ?? "missing" };
  }
  const shared = checkpoint.worldState?.shared ?? {};
  const ledger = shared.socialCausality ?? {};
  const stats = shared.runtimeStats ?? {};
  const envelopes = checkpoint.replayEnvelopes ?? checkpoint.envelopes ?? [];

  const notices = envelopes.filter((entry) => entry.event?.type === "runtime.notice").map((entry) => entry.event);
  const noticeCodes = countBy(notices, (event) => event.code ?? "unknown");
  const degradations = notices.filter((event) => event.category === "reasoning").length;

  const toolsStarted = envelopes.filter((entry) => entry.event?.type === "agent.tool" && entry.event.phase === "started").length;
  const toolsSucceeded = envelopes.filter((entry) => entry.event?.type === "agent.tool" && entry.event.phase === "succeeded").length;
  const worldActions = envelopes.filter((entry) => entry.event?.type === "world.action").length;

  const commitments = ledger.commitments ?? [];
  const commitmentStates = countBy(commitments, (entry) => entry.state);
  const socialActs = ledger.socialActs ?? [];
  const actsByMethod = countBy(socialActs, (entry) => entry.extractionMethod);
  const extracted = socialActs.filter((entry) => entry.extractionMethod === "model-extracted");

  // Strong-label audit (§37): a strong beat must cite a real settled record.
  const log = checkpoint.snapshot?.world?.log ?? [];
  const strongBeats = log.filter((entry) => entry.beat && STRONG_BEATS.has(entry.beat));
  const hasSettledCommitments = commitments.some((entry) => entry.state === "fulfilled" || entry.state === "violated");
  const hasDeceptionEpisodes = (ledger.deceptions ?? []).length > 0;
  const violations = strongBeats
    .filter((entry) => {
      if (entry.beat === "promise-kept" || entry.beat === "promise-broken") return !hasSettledCommitments;
      if (entry.beat === "deception-exposed") return !hasDeceptionEpisodes;
      return false; // betrayal/alliance need evidence-chain review; listed for manual pass
    })
    .map((entry) => `turn ${entry.turn ?? "?"}: ${entry.beat}`);

  const snapshot = checkpoint.snapshot ?? {};
  return {
    roomId,
    title: snapshot.title ?? "",
    scenario: snapshot.scenarioId ?? "",
    status: checkpoint.status ?? "",
    turns: `${snapshot.world?.turn ?? "?"}/${snapshot.world?.totalTurns ?? "?"}`,
    compliance: {
      toolsStarted,
      toolsSucceeded,
      worldActions,
      idempotencyHits: stats.idempotencyHits ?? 0,
      staleCommandRejections: stats.staleCommandRejections ?? 0,
      degradations,
      noticeCodes
    },
    commitments: { total: commitments.length, states: commitmentStates },
    extraction: {
      byMethod: actsByMethod,
      extractedCount: extracted.length,
      sample: extracted.slice(0, 10).map((act) => ({
        actorId: act.actorId,
        kind: act.kind,
        confidence: act.confidence,
        messageId: act.messageId
      }))
    },
    strongLabelAudit: { strongBeatCount: strongBeats.length, violations, manualReview: strongBeats.filter((entry) => entry.beat === "betrayal" || entry.beat === "alliance").length },
    runtime: { extractionFailures: checkpoint.runtimeStats?.extractionFailures ?? 0, settledAbandonedTurns: checkpoint.runtimeStats?.settledAbandonedTurns ?? 0 }
  };
}

const filter = process.argv.slice(2);
const rooms = listCheckrooms(filter.length ? filter : undefined);
const reports = rooms.map((id) => analyze(id, loadCheckpoint(id)));

const lines = [`# Society Smoke Report — ${new Date().toISOString()}`, ""];
for (const report of reports) {
  lines.push(`## ${report.roomId}${report.title ? ` — ${report.title}` : ""}`);
  if (report.corrupt) {
    lines.push("", `> checkpoint 损坏：${report.corrupt}`, "");
    continue;
  }
  lines.push(
    `场景 ${report.scenario} · 状态 ${report.status} · 回合 ${report.turns}`, "",
    "**工具合规**", "",
    `- agent.tool started/succeeded: ${report.compliance.toolsStarted}/${report.compliance.toolsSucceeded}`,
    `- world.action: ${report.compliance.worldActions}`,
    `- 幂等命中: ${report.compliance.idempotencyHits} · 迟到拒绝: ${report.compliance.staleCommandRejections}`,
    `- 推理降级通知: ${report.compliance.degradations}`,
    `- runtime.notice: ${JSON.stringify(report.compliance.noticeCodes)}`, "",
    "**承诺对账**", "",
    `- 承朽数: ${report.commitments.total} · 状态分布: ${JSON.stringify(report.commitments.states)}`, "",
    "**社会行为（提取）**", "",
    `- 按来源: ${JSON.stringify(report.extraction.byMethod)}`,
    `- 提取失败计数: ${report.runtime.extractionFailures} · 弃置回合: ${report.runtime.settledAbandonedTurns}`, "",
    "**强标签审计**", "",
    `- 强标签数: ${report.strongLabelAudit.strongBeatCount}（betrayal/alliance 需人工复核 ${report.strongLabelAudit.manualReview} 条）`,
    `- 规则违规: ${report.strongLabelAudit.violations.length ? report.strongLabelAudit.violations.join("；") : "无"}`, ""
  );
  if (report.extraction.sample.length) {
    lines.push("**旁路提取抽检样例（人工核对）**", "");
    for (const act of report.extraction.sample) {
      lines.push(`- [${act.kind}] ${act.actorId} · 置信度 ${act.confidence} · 消息 ${act.messageId}`);
    }
    lines.push("");
  }
}

const text = lines.join("\n");
console.log(text);
writeFileSync(resolve(outDir, `${Date.now()}-report.md`), text);
console.error(`\nreport written to ${outDir}`);
