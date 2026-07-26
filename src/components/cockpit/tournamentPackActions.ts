import type { Dispatch, RefObject, SetStateAction } from "react";

import {
  mergeExportedTournamentPackList,
  resolvePackSeededComparisonSelection,
  type ResolvePackSeededComparisonSource
} from "../../harness/matchComparisonView";
import type { CockpitExperimentRequest } from "./experimentDraft";
// Imports stay fine-grained (no ./appShared or ./appInspectors barrels): this
// async chunk must not pull the icon/nav/lazy-board modules into its graph.
import { apiJson } from "./apiClient";
import { assertJointPhaseSchedulerTransitionBudget } from "./artifactGuards";
import {
  errorMessage,
  formatDate,
  formatModelRewardDensity,
  formatPackCommitDensity,
  formatPackMetricPromotion,
  parseOptionalPositiveInteger,
  parsePositiveInteger,
  shortId
} from "./formatters";
import { DEFAULT_SHARE_ALLOWLIST, flattenTournamentPackFiles } from "./packFiles";
import { inspectorFromTournamentComparison } from "./inspectorBuilders";
import { DEFAULT_TIMEOUT_SECONDS } from "./cockpitDefaults";
import type {
  ComparisonRegistrySummary,
  InspectorItem,
  MatchRecord,
  TournamentArtifactSetSummary,
  TournamentComparisonAggregateView,
  TournamentExecutionTelemetry,
  TournamentPublicShareInventory,
  TournamentPublicShareSummary,
  TournamentRunResponse,
  Workspace
} from "./cockpitTypes";

/**
 * Heavy tournament public-pack workflows, loaded on demand from
 * `useTournamentPacks`. Both entry points run strictly after their hook-side
 * synchronous preflight and inside the hook's existing try/catch/finally, so
 * status messages, state-update ordering and error surfaces are unchanged.
 * This module must only ever be imported dynamically (bundle budget).
 */

export interface TournamentPackExportContext {
  experimentRequest: CockpitExperimentRequest;
  jointPhaseScheduler: "aec-batched-decision" | "parallel";
  maxTransitions: string;
  timeoutSeconds: string;
  packGames: string;
  refreshMatches: () => Promise<MatchRecord[]>;
  loadSavedComparisonById: (
    comparisonId: string,
    options?: { switchToCompareWorkspace?: boolean; preserveInspector?: boolean }
  ) => Promise<boolean>;
  inspectTournamentComparisonRef: RefObject<(pack: TournamentArtifactSetSummary) => Promise<boolean>>;
  setTournamentExecutionTelemetry: Dispatch<SetStateAction<TournamentExecutionTelemetry | null>>;
  setTournamentPacks: Dispatch<SetStateAction<TournamentArtifactSetSummary[]>>;
  setSelectedPackId: Dispatch<SetStateAction<string>>;
  setShareAllowlist: Dispatch<SetStateAction<string[]>>;
  setPackShares: Dispatch<SetStateAction<TournamentPublicShareSummary[]>>;
  setComparisonRegistry: Dispatch<SetStateAction<ComparisonRegistrySummary[]>>;
  setSelectedComparisonId: Dispatch<SetStateAction<string>>;
  setWorkspace: Dispatch<SetStateAction<Workspace>>;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: (message: string, nextError?: string | null) => void;
}

export async function runTournamentPackExport({
  experimentRequest,
  jointPhaseScheduler,
  maxTransitions,
  timeoutSeconds,
  packGames,
  refreshMatches,
  loadSavedComparisonById,
  inspectTournamentComparisonRef,
  setTournamentExecutionTelemetry,
  setTournamentPacks,
  setSelectedPackId,
  setShareAllowlist,
  setPackShares,
  setComparisonRegistry,
  setSelectedComparisonId,
  setWorkspace,
  setInspector,
  setActionStatus
}: TournamentPackExportContext): Promise<void> {
  const timeoutMs = parsePositiveInteger(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS) * 1000;
  const transitions = parseOptionalPositiveInteger(maxTransitions);
  const games = Math.min(10, Math.max(1, parsePositiveInteger(packGames, 1)));
  assertJointPhaseSchedulerTransitionBudget(jointPhaseScheduler, transitions);
  const response = await apiJson<TournamentRunResponse>("/api/tournaments/run", {
    method: "POST",
    body: JSON.stringify({
      ...experimentRequest,
      seed: `ui-pack-${Date.now()}`,
      games,
      ...(transitions === undefined ? {} : { maxTransitions: transitions }),
      timeoutMs,
      jointPhaseScheduler,
      exportArtifacts: true
    })
  });
  // This is a direct rendering DTO from the server's canonical
  // cost_latency reducer. React must not recompute lifecycle denominators
  // or promote partial outcomes into completed-only leaderboard rows.
  setTournamentExecutionTelemetry(response.summary?.executionTelemetry ?? null);
  const pack = response.artifacts ?? response.summary?.artifacts ?? null;
  if (!pack?.artifactSetId) {
    throw new Error(response.error ?? response.summary?.failureReason ?? "tournament export returned no artifact set");
  }
  const degradedNotes: string[] = [];
  let packs: TournamentArtifactSetSummary[] = [pack];
  try {
    const listed = await apiJson<{ artifactSets: TournamentArtifactSetSummary[] }>("/api/tournament-artifacts");
    const merged = mergeExportedTournamentPackList({
      exportedPack: pack,
      listedPacks: listed.artifactSets ?? []
    });
    packs = merged.packs;
    if (merged.note !== "ok") {
      degradedNotes.push(merged.note);
    }
  } catch {
    // Pack export already succeeded; list refresh is best-effort.
    const merged = mergeExportedTournamentPackList({
      exportedPack: pack,
      listRefreshFailed: true
    });
    packs = merged.packs;
    degradedNotes.push(merged.note);
  }
  setTournamentPacks(packs);
  setSelectedPackId(pack.artifactSetId);
  const available = flattenTournamentPackFiles(pack.files);
  const preferred = DEFAULT_SHARE_ALLOWLIST.filter((file) => available.includes(file));
  setShareAllowlist(preferred.length ? preferred : available.slice(0, Math.min(8, available.length)));
  try {
    const sharesResponse = await apiJson<{ artifactSetId: string; shares: TournamentPublicShareSummary[] }>(
      `/api/tournament-artifacts/${encodeURIComponent(pack.artifactSetId)}/shares`
    );
    setPackShares(sharesResponse.shares ?? []);
  } catch {
    // Pack export already succeeded; share inventory refresh is best-effort.
    setPackShares([]);
    degradedNotes.push("share-refresh-degraded");
  }
  let registeredMatchCount = 0;
  let packMatchIds = new Set<string>();
  try {
    const matchRecords = await refreshMatches();
    registeredMatchCount = matchRecords.filter((match) => match.hasArtifact).length;
  } catch {
    // Pack export already succeeded; match registry refresh is best-effort.
    degradedNotes.push("match-refresh-degraded");
  }
  // Episode ids from the just-finished tournament run. Prefer these over a
  // global newest comparison, which may belong to an older pack.
  for (const episode of response.episodes ?? []) {
    if (typeof episode.matchId === "string" && episode.matchId) packMatchIds.add(episode.matchId);
    if (typeof episode.runId === "string" && episode.runId) packMatchIds.add(episode.runId);
  }
  let autoLoadComparisonId = "";
  let seededComparisonSource: ResolvePackSeededComparisonSource =
    packMatchIds.size >= 2 ? "missing" : "none";
  try {
    // Keep the full comparison registry for the compare workspace UI.
    // Pack-scoped matchIds filtering is used only to select the export pair.
    // Fetch both lists in parallel, but isolate failures so a pack-scoped
    // filter error cannot wipe the full registry refresh.
    const fullRegistryPromise = apiJson<{ comparisons: ComparisonRegistrySummary[] }>("/api/comparisons").then(
      (response) => ({ ok: true as const, response }),
      () => ({ ok: false as const, response: null })
    );
    const packScopedPromise =
      packMatchIds.size >= 2
        ? apiJson<{ comparisons: ComparisonRegistrySummary[] }>(
            `/api/comparisons?matchIds=${encodeURIComponent(Array.from(packMatchIds).join(","))}`
          ).then(
            (response) => ({ ok: true as const, response }),
            () => ({ ok: false as const, response: null })
          )
        : Promise.resolve({ ok: false as const, response: null });
    const [fullResult, packScopedResult] = await Promise.all([fullRegistryPromise, packScopedPromise]);

    const fullEntries =
      fullResult.ok && Array.isArray(fullResult.response?.comparisons)
        ? fullResult.response.comparisons
        : [];
    if (fullResult.ok) {
      setComparisonRegistry(fullEntries);
    } else {
      degradedNotes.push("comparison-registry-refresh-degraded");
    }

    const selection = resolvePackSeededComparisonSelection({
      packMatchIds,
      packScopedEntries: packScopedResult.ok ? packScopedResult.response?.comparisons ?? [] : null,
      packScopedRefreshOk: packScopedResult.ok,
      fullEntries
    });
    autoLoadComparisonId = selection.comparisonId;
    seededComparisonSource = selection.source;
    for (const note of selection.degradedNotes) {
      degradedNotes.push(note);
    }
    setSelectedComparisonId(autoLoadComparisonId);
  } catch {
    // Pack export already succeeded; comparison registry refresh is best-effort.
    degradedNotes.push("comparison-refresh-degraded");
  }
  setWorkspace("packs");
  setInspector({
    kind: "tournament-artifact-set",
    title: `Pack ${shortId(pack.artifactSetId)}`,
    subtitle: pack.seed,
    fields: [
      ["artifactSetId", pack.artifactSetId],
      ["seed", pack.seed],
      ["experimentId", pack.experimentId],
      ["publicShareSafe", String(Boolean(pack.projection?.publicShareSafe))],
      ["matchArtifactView", pack.projection?.matchArtifactView ?? "n/a"],
      ["density", formatPackCommitDensity(pack)],
      [
        "runSummaryDensity",
        formatPackCommitDensity({
          nativeSteps: response.summary?.nativeSteps,
          committedSteps: response.summary?.committedSteps,
          rejectedSteps: response.summary?.rejectedSteps
        })
      ],
      [
        "evaluationDensity",
        formatPackCommitDensity({
          nativeSteps: response.summary?.evaluation?.nativeSteps,
          committedSteps: response.summary?.evaluation?.committedSteps,
          rejectedSteps: response.summary?.evaluation?.rejectedSteps
        })
      ],
      [
        "evaluationPromotion",
        formatPackMetricPromotion({
          metricCount: response.summary?.evaluation?.metricCount,
          scorecardEligibleMetricCount: response.summary?.evaluation?.scorecardEligibleMetricCount,
          metricPromotionClassCounts: response.summary?.evaluation?.metricPromotionClassCounts
        })
      ],
      [
        "evaluationReportsPromotion",
        formatPackMetricPromotion({
          metricCount: response.summary?.evaluationReports?.metricCount,
          scorecardEligibleMetricCount: response.summary?.evaluationReports?.scorecardEligibleMetricCount,
          metricPromotionClassCounts: response.summary?.evaluationReports?.metricPromotionClassCounts
        })
      ],
      ["evaluationModelRewards", formatModelRewardDensity(response.summary?.evaluation?.modelRewards)],
      ["metricCount", typeof pack.metricCount === "number" ? pack.metricCount : "n/a"],
      [
        "scorecardEligibleMetrics",
        typeof pack.scorecardEligibleMetricCount === "number" ? pack.scorecardEligibleMetricCount : "n/a"
      ],
      ["metricPromotion", formatPackMetricPromotion(pack)],
      ["artifactBackedMatches", registeredMatchCount],
      ["packEpisodeIds", packMatchIds.size],
      ["seededComparisons", seededComparisonSource],
      ["seededComparisonId", autoLoadComparisonId || "none"],
      ["postExportRefresh", degradedNotes.length ? degradedNotes.join(",") : "ok"]
    ],
    json: pack
  });
  const degradedSuffix = degradedNotes.length ? ` · ${degradedNotes.join(" · ")}` : "";
  const selectionSuffix =
    seededComparisonSource === "none"
      ? ""
      : ` · selection=${seededComparisonSource}${autoLoadComparisonId ? `:${shortId(autoLoadComparisonId)}` : ""}`;
  const summaryDensity = formatPackCommitDensity({
    nativeSteps: response.summary?.nativeSteps,
    committedSteps: response.summary?.committedSteps,
    rejectedSteps: response.summary?.rejectedSteps
  });
  const densityLabel =
    summaryDensity !== "n/a" ? summaryDensity : formatPackCommitDensity(pack);
  const densitySuffix = densityLabel === "n/a" ? "" : ` · density=${densityLabel}`;
  const evaluationPromotionLabel = formatPackMetricPromotion({
    metricCount: response.summary?.evaluation?.metricCount,
    scorecardEligibleMetricCount: response.summary?.evaluation?.scorecardEligibleMetricCount,
    metricPromotionClassCounts: response.summary?.evaluation?.metricPromotionClassCounts
  });
  const packPromotionLabel = formatPackMetricPromotion(pack);
  const promotionLabel =
    evaluationPromotionLabel !== "n/a" ? evaluationPromotionLabel : packPromotionLabel;
  const promotionSuffix = promotionLabel === "n/a" ? "" : ` · promotion=${promotionLabel}`;
  const exportStatusBase =
    `锦标赛公开包已导出：${shortId(pack.artifactSetId)} · publicShareSafe=${String(Boolean(pack.projection?.publicShareSafe))} · completed=${response.summary?.gamesCompleted ?? "?"} · truncated=${response.summary?.gamesTruncated ?? "?"} · matches=${registeredMatchCount}${densitySuffix}${promotionSuffix}${selectionSuffix}${degradedSuffix}`;
  setActionStatus(
    exportStatusBase +
      (packMatchIds.size >= 2
        ? " · opening tournament comparison"
        : autoLoadComparisonId
          ? ` · loading pack comparison ${shortId(autoLoadComparisonId)}`
          : "")
  );
  // Multi-episode packs seed pairwise comparisons and emit tournament_comparison.json.
  // Prefer the aggregate inspect path so operators get pair navigation, loading busy
  // state, and active-pair highlighting instead of only a single pairwise matrix.
  // If aggregate inspect fails, fall back to the pack-scoped pairwise matrix.
  // Prefer the just-exported pack object; fall back to the refreshed list entry.
  const listedPack =
    packs.find((entry) => entry.artifactSetId === pack.artifactSetId) ?? pack;
  let openedAggregate = false;
  if (packMatchIds.size >= 2) {
    try {
      openedAggregate = await inspectTournamentComparisonRef.current(listedPack);
    } catch {
      openedAggregate = false;
    }
  }
  if (openedAggregate) {
    // Inspect/pair-load status overwrote the export banner; restore export provenance.
    setActionStatus(`${exportStatusBase} · tournament comparison opened`);
  } else if (autoLoadComparisonId) {
    setActionStatus(
      `${exportStatusBase} · aggregate inspect unavailable · loading pack comparison ${shortId(autoLoadComparisonId)}`
    );
    const loadedPairwise = await loadSavedComparisonById(autoLoadComparisonId, {
      switchToCompareWorkspace: true,
      preserveInspector: true
    });
    setActionStatus(
      loadedPairwise
        ? `${exportStatusBase} · aggregate inspect unavailable · pack comparison loaded ${shortId(autoLoadComparisonId)}`
        : `${exportStatusBase} · aggregate inspect unavailable · pack comparison load failed`
    );
  } else if (packMatchIds.size >= 2) {
    setActionStatus(`${exportStatusBase} · tournament comparison inspect unavailable`);
  }
}

export interface TournamentComparisonInspectContext {
  comparisonHref: string;
  pack: TournamentArtifactSetSummary;
  loadSavedComparisonById: (
    comparisonId: string,
    options?: { switchToCompareWorkspace?: boolean; preserveInspector?: boolean }
  ) => Promise<boolean>;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: (message: string, nextError?: string | null) => void;
}

export async function inspectTournamentComparisonAggregate({
  comparisonHref,
  pack,
  loadSavedComparisonById,
  setInspector,
  setActionStatus
}: TournamentComparisonInspectContext): Promise<boolean> {
  const response = await apiJson<TournamentComparisonAggregateView>(comparisonHref);
  if (response.kind !== "tournament-comparison") {
    throw new Error("tournament comparison artifact kind mismatch");
  }
  if (response.artifactVersion !== "harness.tournament-comparison.v1") {
    throw new Error(`unexpected tournament comparison version: ${response.artifactVersion}`);
  }
  const renderAggregateInspector = (options: {
    activeComparisonId: string | null;
    loadingComparisonId?: string | null;
  }) => {
    const activeComparisonId = options.activeComparisonId;
    const loadingComparisonId = options.loadingComparisonId ?? null;
    const pairActions = response.pairs.slice(0, 8).map((pair) => ({
      key: pair.comparisonId,
      label:
        pair.comparisonId === loadingComparisonId
          ? `加载中 e${pair.baseline.episodeIndex}→e${pair.candidate.episodeIndex}`
          : pair.comparisonId === activeComparisonId
            ? `当前 pair e${pair.baseline.episodeIndex}→e${pair.candidate.episodeIndex}${
                typeof pair.committedStepsDelta === "number" && typeof pair.rejectedStepsDelta === "number"
                  ? ` cΔ${pair.committedStepsDelta}/rΔ${pair.rejectedStepsDelta}`
                  : ""
              }`
            : `加载 pair e${pair.baseline.episodeIndex}→e${pair.candidate.episodeIndex}${
                typeof pair.committedStepsDelta === "number" && typeof pair.rejectedStepsDelta === "number"
                  ? ` cΔ${pair.committedStepsDelta}/rΔ${pair.rejectedStepsDelta}`
                  : ""
              }`,
      // While a pair load is in flight, freeze all pair actions so concurrent clicks
      // cannot start overlapping loads even though the race guard would drop them.
      disabled: Boolean(loadingComparisonId) || pair.comparisonId === activeComparisonId,
      onClick: () => {
        void (async () => {
          renderAggregateInspector({
            activeComparisonId,
            loadingComparisonId: pair.comparisonId
          });
          const loaded = await loadSavedComparisonById(pair.comparisonId, {
            switchToCompareWorkspace: true,
            preserveInspector: true
          });
          // Only mark a pair current after the comparison matrix load succeeds.
          renderAggregateInspector({
            activeComparisonId: loaded ? pair.comparisonId : activeComparisonId
          });
        })();
      }
    }));
    setInspector(
      inspectorFromTournamentComparison(response, pack, pairActions, {
        activeComparisonId
      })
    );
  };
  const firstPairId = response.pairs[0]?.comparisonId ?? "";
  // Render actions first without claiming an active pair until load succeeds.
  renderAggregateInspector({
    activeComparisonId: null,
    loadingComparisonId: firstPairId || null
  });
  setActionStatus(
    `已加载 tournament comparison：${shortId(response.comparisonSetId)} · pairs=${response.pairCount} · matches=${response.artifactMatchCount}` +
      (typeof response.summary.totalSocialStepsDelta === "number"
        ? ` · socialΔ${response.summary.totalSocialStepsDelta}`
        : "") +
      (typeof response.summary.totalCommittedStepsDelta === "number" &&
      typeof response.summary.totalRejectedStepsDelta === "number"
        ? ` · cΔ${response.summary.totalCommittedStepsDelta}/rΔ${response.summary.totalRejectedStepsDelta}`
        : "") +
      (firstPairId ? ` · loading first pair ${shortId(firstPairId)}` : "")
  );
  // Multi-episode packs expose pair comparison ids in the aggregate artifact.
  // Auto-load the first pair matrix into the compare workspace while keeping the
  // aggregate inspector (and remaining pair actions) intact.
  if (firstPairId) {
    const loaded = await loadSavedComparisonById(firstPairId, {
      switchToCompareWorkspace: true,
      preserveInspector: true
    });
    renderAggregateInspector({
      activeComparisonId: loaded ? firstPairId : null
    });
    return true;
  }
  renderAggregateInspector({ activeComparisonId: null });
  // Aggregate with zero pairs is still a successful inspect of the pack artifact.
  return true;
}

export async function refreshTournamentPacks({
  setTournamentPacks,
  setSelectedPackId,
  setActionStatus
}: {
  setTournamentPacks: Dispatch<SetStateAction<TournamentArtifactSetSummary[]>>;
  setSelectedPackId: Dispatch<SetStateAction<string>>;
  setActionStatus: (message: string, nextError?: string | null) => void;
}): Promise<void> {
  const response = await apiJson<{ artifactSets: TournamentArtifactSetSummary[] }>("/api/tournament-artifacts");
  const packs = response.artifactSets ?? [];
  setTournamentPacks(packs);
  setSelectedPackId((current) => (current && packs.some((pack) => pack.artifactSetId === current) ? current : packs[0]?.artifactSetId ?? ""));
  setActionStatus(`锦标赛公开包已刷新：${packs.length} 套`);
}

export async function refreshShareInventory({
  setShareInventory,
  setActionStatus
}: {
  setShareInventory: Dispatch<SetStateAction<TournamentPublicShareInventory | null>>;
  setActionStatus: (message: string, nextError?: string | null) => void;
}): Promise<void> {
  const inventory = await apiJson<TournamentPublicShareInventory>("/api/tournament-public-shares");
  setShareInventory(inventory);
  const promotionLabel = formatPackMetricPromotion({
    metricCount: inventory.metricCount,
    scorecardEligibleMetricCount: inventory.scorecardEligibleMetricCount,
    metricPromotionClassCounts: inventory.metricPromotionClassCounts
  });
  const densityLabel = formatPackCommitDensity({
    nativeSteps: inventory.nativeSteps,
    committedSteps: inventory.committedSteps,
    rejectedSteps: inventory.rejectedSteps
  });
  setActionStatus(
    `分享清单已刷新：total=${inventory.count} · active=${inventory.activeCount} · expired=${inventory.expiredCount} · packsWithPromotion=${inventory.packsWithPromotionCount ?? 0} · packsWithDensity=${inventory.packsWithDensityCount ?? 0}${promotionLabel === "n/a" ? "" : ` · promotion=${promotionLabel}`}${densityLabel === "n/a" ? "" : ` · density=${densityLabel}`}`
  );
}

export async function downloadShareAnalyticsSummary(
  { setActionStatus }: { setActionStatus: (message: string, nextError?: string | null) => void },
  format: "json" | "markdown"
): Promise<void> {
  const target = `/api/tournament-public-shares/summary?format=${format}`;
  const response = await fetch(target);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download =
    format === "markdown" ? "tournament-public-share-analytics.md" : "tournament-public-share-analytics.json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setActionStatus(`分享分析摘要已导出：format=${format}`);
}

export async function loadPackShares(
  {
    setPackShares,
    setActionStatus
  }: {
    setPackShares: Dispatch<SetStateAction<TournamentPublicShareSummary[]>>;
    setActionStatus: (message: string, nextError?: string | null) => void;
  },
  pack: TournamentArtifactSetSummary
): Promise<void> {
  const response = await apiJson<{ artifactSetId: string; shares: TournamentPublicShareSummary[] }>(
    `/api/tournament-artifacts/${encodeURIComponent(pack.artifactSetId)}/shares`
  );
  setPackShares(response.shares ?? []);
  setActionStatus(
    `已选择公开包：${shortId(pack.artifactSetId)} · publicShareSafe=${String(Boolean(pack.projection?.publicShareSafe))} · density=${formatPackCommitDensity(pack)} · promotion=${formatPackMetricPromotion(pack)} · shares=${response.shares?.length ?? 0}`
  );
}

export async function createTournamentShare({
  selectedPackId,
  shareLabel,
  shareExpiresInHours,
  shareAllowlist,
  setPackShares,
  setInspector,
  setActionStatus
}: {
  selectedPackId: string;
  shareLabel: string;
  shareExpiresInHours: string;
  shareAllowlist: string[];
  setPackShares: Dispatch<SetStateAction<TournamentPublicShareSummary[]>>;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: (message: string, nextError?: string | null) => void;
}): Promise<void> {
  const hours = shareExpiresInHours.trim() === "" ? 0 : parsePositiveInteger(shareExpiresInHours, 0);
  const expiresAt =
    hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;
  const relativeFiles = shareAllowlist.length ? [...shareAllowlist] : undefined;
  const share = await apiJson<TournamentPublicShareSummary>(
    `/api/tournament-artifacts/${encodeURIComponent(selectedPackId)}/shares`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: shareLabel.trim() || undefined,
        expiresAt,
        relativeFiles
      })
    }
  );
  setPackShares((current) => [share, ...current.filter((item) => item.shareId !== share.shareId)]);
  setInspector({
    kind: "tournament-public-share",
    title: `Share ${shortId(share.shareId)}`,
    subtitle: share.label ?? share.artifactSetId,
    fields: [
      ["shareId", share.shareId],
      ["artifactSetId", share.artifactSetId],
      ["expiresAt", share.expiresAt ?? "never"],
      ["relativeFiles", relativeFiles?.join(", ") ?? "all registered files"],
      ["publicShareSafe", String(Boolean(share.projection?.publicShareSafe))],
      ["detail", share.urls?.detail ?? "n/a"],
      ["filesBase", share.urls?.filesBase ?? "n/a"]
    ],
    json: share
  });
  setActionStatus(
    `公开分享链接已创建：${shortId(share.shareId)} · expires=${share.expiresAt ? formatDate(share.expiresAt) : "never"} · files=${relativeFiles?.length ?? "all"}`
  );
}

export async function revokeTournamentShare(
  {
    setPackShares,
    setActionStatus
  }: {
    setPackShares: Dispatch<SetStateAction<TournamentPublicShareSummary[]>>;
    setActionStatus: (message: string, nextError?: string | null) => void;
  },
  share: TournamentPublicShareSummary
): Promise<void> {
  const response = await fetch(`/api/public/tournament-shares/${encodeURIComponent(share.shareId)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 204) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  setPackShares((current) => current.filter((item) => item.shareId !== share.shareId));
  setActionStatus(`已吊销分享链接：${shortId(share.shareId)}`);
}

export async function revokeAllActiveShares(
  {
    setPackShares,
    setActionStatus
  }: {
    setPackShares: Dispatch<SetStateAction<TournamentPublicShareSummary[]>>;
    setActionStatus: (message: string, nextError?: string | null) => void;
  },
  active: TournamentPublicShareSummary[]
): Promise<void> {
  let revoked = 0;
  const failed: string[] = [];
  for (const share of active) {
    try {
      const response = await fetch(`/api/public/tournament-shares/${encodeURIComponent(share.shareId)}`, {
        method: "DELETE"
      });
      if (!response.ok && response.status !== 204) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      revoked += 1;
      setPackShares((current) => current.filter((item) => item.shareId !== share.shareId));
    } catch (error) {
      failed.push(`${shortId(share.shareId)}: ${errorMessage(error)}`);
    }
  }
  if (failed.length) {
    setActionStatus(`批量吊销完成：revoked=${revoked}/${active.length}`, failed.join("; "));
  } else {
    setActionStatus(`已批量吊销 ${revoked} 条活跃分享链接。`);
  }
}
