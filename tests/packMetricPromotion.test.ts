import { describe, expect, it } from "vitest";
import {
  aggregateUniquePackCommitDensity,
  aggregateUniquePackMetricPromotion,
  formatSharePackCommitDensity,
  formatSharePackMetricPromotion
} from "../src/server/packMetricPromotion";

describe("aggregateUniquePackMetricPromotion", () => {
  it("aggregates unique packs and ignores missing or packless shares", () => {
    const totals = aggregateUniquePackMetricPromotion([
      {
        artifactSetId: "pack-a",
        packFound: true,
        packMetricPromotion: {
          metricCount: 10,
          scorecardEligibleMetricCount: 2,
          metricPromotionClassCounts: {
            scorecard: 2,
            diagnostic: 7,
            benchmark_only: 1
          }
        }
      },
      {
        // Same pack appears twice via multi-share; must not double-count.
        artifactSetId: "pack-a",
        packFound: true,
        packMetricPromotion: {
          metricCount: 10,
          scorecardEligibleMetricCount: 2,
          metricPromotionClassCounts: {
            scorecard: 2,
            diagnostic: 7,
            benchmark_only: 1
          }
        }
      },
      {
        artifactSetId: "pack-b",
        packFound: true,
        packMetricPromotion: {
          metricCount: 5,
          scorecardEligibleMetricCount: 1,
          metricPromotionClassCounts: {
            scorecard: 1,
            diagnostic: 4,
            benchmark_only: 0
          }
        }
      },
      {
        artifactSetId: "pack-missing",
        packFound: false,
        packMetricPromotion: {
          metricCount: 99,
          scorecardEligibleMetricCount: 99,
          metricPromotionClassCounts: {
            scorecard: 99,
            diagnostic: 0,
            benchmark_only: 0
          }
        }
      },
      {
        artifactSetId: "pack-empty",
        packFound: true,
        packMetricPromotion: null
      }
    ]);

    expect(totals).toEqual({
      packsWithPromotionCount: 2,
      metricCount: 15,
      scorecardEligibleMetricCount: 3,
      metricPromotionClassCounts: {
        scorecard: 3,
        diagnostic: 11,
        benchmark_only: 1
      }
    });
  });

  it("returns zero totals for empty input", () => {
    expect(aggregateUniquePackMetricPromotion([])).toEqual({
      packsWithPromotionCount: 0,
      metricCount: 0,
      scorecardEligibleMetricCount: 0,
      metricPromotionClassCounts: {
        scorecard: 0,
        diagnostic: 0,
        benchmark_only: 0
      }
    });
  });
});

describe("formatSharePackMetricPromotion", () => {
  it("formats complete and partial promotion snapshots", () => {
    expect(formatSharePackMetricPromotion(null)).toBe("n/a");
    expect(
      formatSharePackMetricPromotion({
        metricCount: 4,
        scorecardEligibleMetricCount: 1
      })
    ).toBe("rows=4 eligible=1");
    expect(
      formatSharePackMetricPromotion({
        metricCount: 4,
        scorecardEligibleMetricCount: 1,
        metricPromotionClassCounts: {
          scorecard: 1,
          diagnostic: 2,
          benchmark_only: 1
        }
      })
    ).toBe("rows=4 eligible=1 scorecard=1 diagnostic=2 benchmark=1");
  });
});

describe("aggregateUniquePackCommitDensity", () => {
  it("aggregates unique packs and ignores missing or packless shares", () => {
    const totals = aggregateUniquePackCommitDensity([
      {
        artifactSetId: "pack-a",
        packFound: true,
        packDensity: { nativeSteps: 10, committedSteps: 8, rejectedSteps: 2 }
      },
      {
        artifactSetId: "pack-a",
        packFound: true,
        packDensity: { nativeSteps: 10, committedSteps: 8, rejectedSteps: 2 }
      },
      {
        artifactSetId: "pack-b",
        packFound: true,
        packDensity: { nativeSteps: 4, committedSteps: 3, rejectedSteps: 1 }
      },
      {
        artifactSetId: "pack-missing",
        packFound: false,
        packDensity: { nativeSteps: 99, committedSteps: 99, rejectedSteps: 99 }
      },
      {
        artifactSetId: "pack-empty",
        packFound: true,
        packDensity: null
      }
    ]);

    expect(totals).toEqual({
      packsWithDensityCount: 2,
      nativeSteps: 14,
      committedSteps: 11,
      rejectedSteps: 3
    });
  });
});

describe("formatSharePackCommitDensity", () => {
  it("formats complete and incomplete density snapshots", () => {
    expect(formatSharePackCommitDensity(null)).toBe("n/a");
    expect(
      formatSharePackCommitDensity({
        nativeSteps: 4,
        committedSteps: 3,
        rejectedSteps: null
      })
    ).toBe("n/a");
    expect(
      formatSharePackCommitDensity({
        nativeSteps: 4,
        committedSteps: 3,
        rejectedSteps: 1
      })
    ).toBe("n=4 c=3 r=1");
  });
});
