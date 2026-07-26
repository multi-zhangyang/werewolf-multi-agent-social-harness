import type { RedactedHarnessStepDto } from "../../server/artifactProjection";
import type { HarnessAgentProfile } from "../../harness/types";
import type { HarnessAssignmentConfig } from "../../harness/profiles";
import { isSocialStepCommitted, type SocialMessage } from "../../harness/social";
import type { CheckpointSummary, ProjectedSocialStep } from "./cockpitTypes";

export function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseOptionalPositiveInteger(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("最大 transitions 必须留空或填写正整数。");
  }
  return parsed;
}

export function isPositiveIntegerText(value: string): boolean {
  const parsed = Number(value);
  return value.trim().length > 0 && Number.isInteger(parsed) && parsed > 0;
}

export function formatExperimentRosterSummary(request: {
  models: string[];
  profiles: HarnessAgentProfile[];
  assignment: HarnessAssignmentConfig;
}): string {
  const strategy = request.assignment.strategy ?? "profile-rotation";
  return `${request.profiles.length} profiles · ${request.models.length} models · ${strategy}`;
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

export function orderCheckpoints(checkpoints: CheckpointSummary[]): CheckpointSummary[] {
  return [...checkpoints].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function shortId(value: unknown): string {
  if (typeof value !== "string" || !value) return "n/a";
  if (value.length <= 12) return value;
  return value.slice(0, 8);
}

export function formatPackCommitDensity(pack: {
  nativeSteps?: number | null;
  committedSteps?: number | null;
  rejectedSteps?: number | null;
}): string {
  if (
    typeof pack.nativeSteps === "number" &&
    typeof pack.committedSteps === "number" &&
    typeof pack.rejectedSteps === "number"
  ) {
    return `n${pack.nativeSteps}/c${pack.committedSteps}/r${pack.rejectedSteps}`;
  }
  return "n/a";
}

export function formatPackMetricPromotion(pack: {
  metricCount?: number | null;
  scorecardEligibleMetricCount?: number | null;
  metricPromotionClassCounts?: {
    scorecard?: number;
    diagnostic?: number;
    benchmark_only?: number;
  } | null;
}): string {
  const counts = pack.metricPromotionClassCounts;
  if (
    typeof pack.metricCount !== "number" ||
    typeof pack.scorecardEligibleMetricCount !== "number" ||
    !counts ||
    typeof counts.scorecard !== "number" ||
    typeof counts.diagnostic !== "number" ||
    typeof counts.benchmark_only !== "number"
  ) {
    return "n/a";
  }
  return `rows=${pack.metricCount} eligible=${pack.scorecardEligibleMetricCount} scorecard=${counts.scorecard} diagnostic=${counts.diagnostic} benchmark=${counts.benchmark_only}`;
}

export function formatModelRewardDensity(
  modelRewards:
    | Record<
        string,
        {
          agentGames?: number;
          wins?: number;
          winRate?: number;
          averageReward?: number;
          nativeSteps?: number;
          committedSteps?: number;
          rejectedSteps?: number;
        }
      >
    | undefined
): string {
  if (!modelRewards || typeof modelRewards !== "object") return "n/a";
  const entries = Object.entries(modelRewards);
  if (!entries.length) return "n/a";
  return entries
    .map(([model, stats]) => {
      const density = formatPackCommitDensity({
        nativeSteps: stats?.nativeSteps,
        committedSteps: stats?.committedSteps,
        rejectedSteps: stats?.rejectedSteps
      });
      return `${shortId(model)}:${density}`;
    })
    .join(" · ");
}

export function formatMatrixPValue(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "n/a";
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPendingKind(step: RedactedHarnessStepDto): string {
  const pending = step.pendingAction as unknown;
  return isRecord(pending) && typeof pending.kind === "string" ? pending.kind : "unknown";
}

export function readCommandType(command: { type: string }): string {
  return isRecord(command) && typeof command.type === "string" ? command.type : "unknown";
}

export function readSocialCommandType(step: ProjectedSocialStep): string {
  const action = step.action as unknown;
  const command = isRecord(action) ? action.command : undefined;
  return isRecord(command) && typeof command.type === "string" ? command.type : "unknown";
}

export function readSocialPendingKind(step: ProjectedSocialStep): string {
  const pending = step.pendingAction as unknown;
  return isRecord(pending) && typeof pending.kind === "string" ? pending.kind : "unknown";
}

export function readSocialCommitStatus(step: ProjectedSocialStep): "committed" | "rejected" {
  return isSocialStepCommitted(step) ? "committed" : "rejected";
}

export function rangeLabel(range: [number, number]): string {
  return `${range[0]}-${range[1]}`;
}

export function countSocialSchedulerModes(steps: ProjectedSocialStep[]): Record<ProjectedSocialStep["schedulerMode"], number> {
  return steps.reduce<Record<ProjectedSocialStep["schedulerMode"], number>>(
    (counts, step) => {
      counts[step.schedulerMode] += 1;
      return counts;
    },
    { aec: 0, "aec-batched-decision": 0, parallel: 0 }
  );
}

export function summarizeSpeechActKinds(message: SocialMessage): string {
  const kinds = uniqueStrings((message.speechActs ?? []).map((act) => act.kind));
  return kinds.length ? kinds.slice(0, 5).join(", ") : "n/a";
}

export function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))).sort();
}
