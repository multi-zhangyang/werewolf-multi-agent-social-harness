export type PackMetricPromotionClassCounts = {
  scorecard: number;
  diagnostic: number;
  benchmark_only: number;
};

export type PackMetricPromotionSnapshot = {
  metricCount: number | null;
  scorecardEligibleMetricCount: number | null;
  metricPromotionClassCounts?: PackMetricPromotionClassCounts | null;
  scorecardEligibleMetricClassCounts?: PackMetricPromotionClassCounts | null;
};

export type UniquePackMetricPromotionTotals = {
  packsWithPromotionCount: number;
  metricCount: number;
  scorecardEligibleMetricCount: number;
  metricPromotionClassCounts: PackMetricPromotionClassCounts;
};

/**
 * Aggregate pack metric-promotion density by unique pack id so multi-share packs
 * are not double-counted in inventory/analytics totals.
 */
export function aggregateUniquePackMetricPromotion(
  shares: ReadonlyArray<{
    artifactSetId: string;
    packFound?: boolean;
    packMetricPromotion?: PackMetricPromotionSnapshot | null;
  }>
): UniquePackMetricPromotionTotals {
  const uniquePackPromotion = new Map<string, PackMetricPromotionSnapshot>();
  for (const share of shares) {
    if (!share.packFound || !share.packMetricPromotion) continue;
    if (uniquePackPromotion.has(share.artifactSetId)) continue;
    uniquePackPromotion.set(share.artifactSetId, share.packMetricPromotion);
  }

  let metricCount = 0;
  let scorecardEligibleMetricCount = 0;
  const metricPromotionClassCounts: PackMetricPromotionClassCounts = {
    scorecard: 0,
    diagnostic: 0,
    benchmark_only: 0
  };

  for (const promotion of uniquePackPromotion.values()) {
    if (typeof promotion.metricCount === "number") metricCount += promotion.metricCount;
    if (typeof promotion.scorecardEligibleMetricCount === "number") {
      scorecardEligibleMetricCount += promotion.scorecardEligibleMetricCount;
    }
    const counts = promotion.metricPromotionClassCounts;
    if (counts) {
      if (typeof counts.scorecard === "number") metricPromotionClassCounts.scorecard += counts.scorecard;
      if (typeof counts.diagnostic === "number") metricPromotionClassCounts.diagnostic += counts.diagnostic;
      if (typeof counts.benchmark_only === "number") {
        metricPromotionClassCounts.benchmark_only += counts.benchmark_only;
      }
    }
  }

  return {
    packsWithPromotionCount: uniquePackPromotion.size,
    metricCount,
    scorecardEligibleMetricCount,
    metricPromotionClassCounts
  };
}

export function formatSharePackMetricPromotion(
  promotion: PackMetricPromotionSnapshot | null | undefined
): string {
  if (!promotion || typeof promotion.metricCount !== "number" || typeof promotion.scorecardEligibleMetricCount !== "number") {
    return "n/a";
  }
  const counts = promotion.metricPromotionClassCounts;
  if (
    !counts ||
    typeof counts.scorecard !== "number" ||
    typeof counts.diagnostic !== "number" ||
    typeof counts.benchmark_only !== "number"
  ) {
    return `rows=${promotion.metricCount} eligible=${promotion.scorecardEligibleMetricCount}`;
  }
  return `rows=${promotion.metricCount} eligible=${promotion.scorecardEligibleMetricCount} scorecard=${counts.scorecard} diagnostic=${counts.diagnostic} benchmark=${counts.benchmark_only}`;
}

export type PackCommitDensitySnapshot = {
  nativeSteps: number | null;
  committedSteps: number | null;
  rejectedSteps: number | null;
};

export type UniquePackCommitDensityTotals = {
  packsWithDensityCount: number;
  nativeSteps: number;
  committedSteps: number;
  rejectedSteps: number;
};

/**
 * Aggregate pack commit density by unique pack id so multi-share packs are not
 * double-counted in inventory/analytics totals.
 */
export function aggregateUniquePackCommitDensity(
  shares: ReadonlyArray<{
    artifactSetId: string;
    packFound?: boolean;
    packDensity?: PackCommitDensitySnapshot | null;
  }>
): UniquePackCommitDensityTotals {
  const uniquePackDensity = new Map<string, PackCommitDensitySnapshot>();
  for (const share of shares) {
    if (!share.packFound || !share.packDensity) continue;
    if (uniquePackDensity.has(share.artifactSetId)) continue;
    uniquePackDensity.set(share.artifactSetId, share.packDensity);
  }

  let nativeSteps = 0;
  let committedSteps = 0;
  let rejectedSteps = 0;
  for (const density of uniquePackDensity.values()) {
    if (typeof density.nativeSteps === "number") nativeSteps += density.nativeSteps;
    if (typeof density.committedSteps === "number") committedSteps += density.committedSteps;
    if (typeof density.rejectedSteps === "number") rejectedSteps += density.rejectedSteps;
  }

  return {
    packsWithDensityCount: uniquePackDensity.size,
    nativeSteps,
    committedSteps,
    rejectedSteps
  };
}

export function formatSharePackCommitDensity(
  density: PackCommitDensitySnapshot | null | undefined
): string {
  if (
    !density ||
    typeof density.nativeSteps !== "number" ||
    typeof density.committedSteps !== "number" ||
    typeof density.rejectedSteps !== "number"
  ) {
    return "n/a";
  }
  return `n=${density.nativeSteps} c=${density.committedSteps} r=${density.rejectedSteps}`;
}
