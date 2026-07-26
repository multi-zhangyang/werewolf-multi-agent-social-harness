import { useCallback, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import type {
  MatchComparisonArtifact,
  MatchComparisonEvidenceIdentityFilter,
  MatchComparisonNumericDeltaFilter,
  MatchComparisonPromotionFilter,
  MatchComparisonRowGroup
} from "../../../harness/matchComparisonView";
import {
  apiJson,
  assertArtifactMatchesId,
  assertComparisonMatchesIds,
  assertServerProjectedArtifact,
  assertServerProjectedComparison,
  errorMessage,
  inspectorFromComparison,
  isComparisonCurrentForRoute,
  shortId
} from "../appInspectors";
import type {
  ArtifactView,
  ComparisonRegistrySummary,
  ComparisonRequestContext,
  InspectorItem,
  MatchRecord,
  ProjectedMatchArtifact,
  Workspace
} from "../appShared";
import type { SetActionStatus } from "./useCockpitStatus";
import type { LoadArtifact } from "./useMatchArtifact";

export type LoadComparisonPair = (options: {
  baselineId: string;
  candidateId: string;
  view: ArtifactView;
  statusPrefix?: string;
}) => Promise<boolean>;

/**
 * Owns the baseline/candidate comparison evidence: the candidate selection,
 * the loaded pair artifacts, the comparison registry mirror and the shared
 * pairwise loader used by the compare workspace, checkpoint forks and the
 * artifact lifecycle.
 */
export function useComparisonState({
  initialCandidateId,
  setInspector,
  setActionStatus,
  setBusy
}: {
  initialCandidateId: string | undefined;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: SetActionStatus;
  setBusy: Dispatch<SetStateAction<string | null>>;
}) {
  const [candidateArtifact, setCandidateArtifact] = useState<ProjectedMatchArtifact | null>(null);
  const [comparison, setComparison] = useState<MatchComparisonArtifact | null>(null);
  const [comparisonRequestContext, setComparisonRequestContext] = useState<ComparisonRequestContext | null>(null);
  const [comparisonRegistry, setComparisonRegistry] = useState<ComparisonRegistrySummary[]>([]);
  const [selectedComparisonId, setSelectedComparisonId] = useState("");
  const comparisonLoadSeqRef = useRef(0);
  const [candidateId, setCandidateId] = useState<string>(initialCandidateId ?? "");

  const loadComparisonPair: LoadComparisonPair = useCallback(
    async (options: {
      baselineId: string;
      candidateId: string;
      view: ArtifactView;
      statusPrefix?: string;
    }) => {
      const { baselineId, candidateId, view, statusPrefix } = options;
      const requestSeq = comparisonLoadSeqRef.current + 1;
      comparisonLoadSeqRef.current = requestSeq;
      setBusy("compare");
      try {
        const [candidate, nextComparison] = await Promise.all([
          apiJson<ProjectedMatchArtifact>(
            `/api/matches/${encodeURIComponent(candidateId)}/artifact?view=${view}`
          ),
          apiJson<MatchComparisonArtifact>(
            `/api/matches/${encodeURIComponent(baselineId)}/compare/${encodeURIComponent(candidateId)}?view=${view}`
          )
        ]);
        if (requestSeq !== comparisonLoadSeqRef.current) {
          return false;
        }
        await assertServerProjectedArtifact(candidate, "candidate artifact");
        assertArtifactMatchesId(candidate, candidateId, "candidate artifact");
        assertServerProjectedComparison(nextComparison);
        assertComparisonMatchesIds(nextComparison, baselineId, candidateId);
        setCandidateArtifact(candidate);
        setComparison(nextComparison);
        setComparisonRequestContext({
          comparisonId: nextComparison.comparisonId,
          baselineId,
          candidateId,
          view
        });
        setInspector(inspectorFromComparison(nextComparison));
        setActionStatus(
          `${statusPrefix ?? "对比工件已加载"}：${shortId(baselineId)} vs ${shortId(candidateId)} · view=${view} · rows=${nextComparison.rows.length} · socialΔ${nextComparison.summary.socialStepsDelta} · cΔ${nextComparison.summary.committedStepsDelta}/rΔ${nextComparison.summary.rejectedStepsDelta}`
        );
        try {
          const response = await apiJson<{ comparisons: ComparisonRegistrySummary[] }>(
            `/api/comparisons?view=${encodeURIComponent(view)}`
          );
          const entries = Array.isArray(response.comparisons) ? response.comparisons : [];
          setComparisonRegistry(entries);
          setSelectedComparisonId(nextComparison.comparisonId);
        } catch {
          // Registry refresh is best-effort; the just-loaded comparison remains authoritative.
        }
        return true;
      } catch (nextError) {
        if (requestSeq !== comparisonLoadSeqRef.current) {
          return false;
        }
        setActionStatus("对比工件加载失败", errorMessage(nextError));
        return false;
      } finally {
        if (requestSeq === comparisonLoadSeqRef.current) {
          setBusy(null);
        }
      }
    },
    [setActionStatus]
  );

  return {
    candidateArtifact,
    setCandidateArtifact,
    comparison,
    setComparison,
    comparisonRequestContext,
    setComparisonRequestContext,
    comparisonRegistry,
    setComparisonRegistry,
    selectedComparisonId,
    setSelectedComparisonId,
    comparisonLoadSeqRef,
    candidateId,
    setCandidateId,
    loadComparisonPair
  };
}

/**
 * Compare-workspace actions on top of the comparison state: candidate
 * switching, registry refresh/load and server-side comparison exports.
 */
export function useComparisonActions({
  artifact,
  selectedMatch,
  matches,
  artifactBackedMatches,
  artifactView,
  setArtifact,
  setArtifactView,
  setMatches,
  setSelectedMatch,
  candidateId,
  setCandidateId,
  setCandidateArtifact,
  comparison,
  comparisonRequestContext,
  setComparison,
  setComparisonRequestContext,
  selectedComparisonId,
  setSelectedComparisonId,
  setComparisonRegistry,
  comparisonLoadSeqRef,
  loadComparisonPair,
  loadArtifact,
  setWorkspace,
  setInspector,
  setActionStatus,
  setBusy
}: {
  artifact: ProjectedMatchArtifact | null;
  selectedMatch: MatchRecord | null;
  matches: MatchRecord[];
  artifactBackedMatches: MatchRecord[];
  artifactView: ArtifactView;
  setArtifact: Dispatch<SetStateAction<ProjectedMatchArtifact | null>>;
  setArtifactView: Dispatch<SetStateAction<ArtifactView>>;
  setMatches: Dispatch<SetStateAction<MatchRecord[]>>;
  setSelectedMatch: Dispatch<SetStateAction<MatchRecord | null>>;
  candidateId: string;
  setCandidateId: Dispatch<SetStateAction<string>>;
  setCandidateArtifact: Dispatch<SetStateAction<ProjectedMatchArtifact | null>>;
  comparison: MatchComparisonArtifact | null;
  comparisonRequestContext: ComparisonRequestContext | null;
  setComparison: Dispatch<SetStateAction<MatchComparisonArtifact | null>>;
  setComparisonRequestContext: Dispatch<SetStateAction<ComparisonRequestContext | null>>;
  selectedComparisonId: string;
  setSelectedComparisonId: Dispatch<SetStateAction<string>>;
  setComparisonRegistry: Dispatch<SetStateAction<ComparisonRegistrySummary[]>>;
  comparisonLoadSeqRef: RefObject<number>;
  loadComparisonPair: LoadComparisonPair;
  loadArtifact: LoadArtifact;
  setWorkspace: Dispatch<SetStateAction<Workspace>>;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: SetActionStatus;
  setBusy: Dispatch<SetStateAction<string | null>>;
}) {
  const compareCandidates = useMemo(() => {
    const baselineIds = new Set([selectedMatch?.id, artifact?.runId, artifact?.matchId].filter(Boolean));
    return artifactBackedMatches.filter((match) => !baselineIds.has(match.id));
  }, [artifact?.matchId, artifact?.runId, artifactBackedMatches, selectedMatch?.id]);

  const handleCandidateChange = useCallback(
    async (value: string) => {
      setCandidateId(value);
      setCandidateArtifact(null);
      setComparison(null);
      setComparisonRequestContext(null);
      const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
      if (!baselineId || !value || value === baselineId) {
        setActionStatus(`候选运行已选择：${shortId(value)}`);
        return;
      }
      setActionStatus(`候选运行已选择：${shortId(value)}，正在自动加载对比…`);
      await loadComparisonPair({
        baselineId,
        candidateId: value,
        view: artifactView,
        statusPrefix: "候选切换后对比已加载"
      });
    },
    [artifact?.matchId, artifact?.runId, artifactView, loadComparisonPair, selectedMatch?.id, setActionStatus]
  );

  const handleLoadComparison = useCallback(async () => {
    const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
    if (!baselineId || !candidateId) {
      setActionStatus("无法对比：需要基准 run 和候选 run。");
      return;
    }
    await loadComparisonPair({
      baselineId,
      candidateId,
      view: artifactView
    });
  }, [artifact?.matchId, artifact?.runId, artifactView, candidateId, loadComparisonPair, selectedMatch?.id, setActionStatus]);

  const refreshComparisonRegistry = useCallback(async () => {
    setBusy("comparison-registry");
    try {
      const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
      const query = new URLSearchParams();
      query.set("view", artifactView);
      if (baselineId) query.set("baselineId", baselineId);
      if (candidateId) query.set("candidateId", candidateId);
      const path = query.size > 0 ? `/api/comparisons?${query.toString()}` : "/api/comparisons";
      const response = await apiJson<{ comparisons: ComparisonRegistrySummary[] }>(path);
      const entries = Array.isArray(response.comparisons) ? response.comparisons : [];
      setComparisonRegistry(entries);
      setSelectedComparisonId((current) =>
        current && entries.some((entry) => entry.comparisonId === current)
          ? current
          : entries[0]?.comparisonId ?? ""
      );
      setActionStatus(`对比注册表已刷新：${entries.length} 条`);
    } catch (nextError) {
      setActionStatus("对比注册表刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [artifact?.matchId, artifact?.runId, artifactView, candidateId, selectedMatch?.id, setActionStatus]);

  const loadSavedComparisonById = useCallback(
    async (
      comparisonId: string,
      options?: { switchToCompareWorkspace?: boolean; preserveInspector?: boolean }
    ): Promise<boolean> => {
      if (!comparisonId) {
        setActionStatus("无法加载已保存对比：请先选择 comparisonId。");
        return false;
      }
      try {
        // The heavy registry-load workflow is code-split; it owns the existing
        // race guard, busy lifecycle and status/error surface verbatim.
        const { loadSavedComparison } = await import("../comparisonRegistryActions");
        return await loadSavedComparison(
          {
            artifactView,
            matches,
            comparisonLoadSeqRef,
            loadArtifact,
            setArtifact,
            setArtifactView,
            setMatches,
            setSelectedMatch,
            setCandidateId,
            setCandidateArtifact,
            setComparison,
            setComparisonRequestContext,
            setSelectedComparisonId,
            setWorkspace,
            setInspector,
            setActionStatus,
            setBusy
          },
          comparisonId,
          options
        );
      } catch (nextError) {
        setActionStatus("注册表对比加载失败", errorMessage(nextError));
        return false;
      }
    },
    [artifactView, loadArtifact, matches, setActionStatus]
  );

  const handleLoadSavedComparison = useCallback(async () => {
    await loadSavedComparisonById(selectedComparisonId);
  }, [loadSavedComparisonById, selectedComparisonId]);


  const handleDownloadComparison = useCallback(
    async (format: "json" | "markdown") => {
      const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
      if (!baselineId || !candidateId) {
        setActionStatus("无法导出对比：需要基准 run 和候选 run。");
        return;
      }
      if (
        !isComparisonCurrentForRoute({
          comparison,
          context: comparisonRequestContext,
          baselineId,
          candidateId,
          view: artifactView
        })
      ) {
        setActionStatus("无法导出对比：当前对比工件与基准/候选/view 不一致，请先加载/重载。");
        return;
      }
      setBusy(format === "markdown" ? "download-compare-md" : "download-compare-json");
      try {
        // The download workflow is code-split; it owns the fetch/anchor flow
        // and its own status/error surface verbatim.
        const { downloadComparisonArtifact } = await import("../comparisonRegistryActions");
        await downloadComparisonArtifact({ baselineId, candidateId, artifactView, setActionStatus }, format);
      } catch (nextError) {
        setActionStatus("对比工件导出失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [artifact?.matchId, artifact?.runId, artifactView, candidateId, comparison, comparisonRequestContext, selectedMatch?.id, setActionStatus]
  );

  const handleDownloadFilteredComparison = useCallback(
    async (
      format: "json" | "markdown",
      filter: {
        group: "all" | MatchComparisonRowGroup;
        changedOnly: boolean;
        promotion: MatchComparisonPromotionFilter;
        evidenceIdentity: MatchComparisonEvidenceIdentityFilter;
        numericDelta: MatchComparisonNumericDeltaFilter;
      }
    ) => {
      const baselineId = selectedMatch?.id ?? artifact?.matchId ?? artifact?.runId;
      if (!baselineId || !candidateId) {
        setActionStatus("无法导出过滤对比：需要基准 run 和候选 run。");
        return;
      }
      if (
        !isComparisonCurrentForRoute({
          comparison,
          context: comparisonRequestContext,
          baselineId,
          candidateId,
          view: artifactView
        })
      ) {
        setActionStatus("无法导出过滤对比：当前对比工件与基准/候选/view 不一致，请先加载/重载。");
        return;
      }
      setBusy(format === "markdown" ? "download-compare-filtered-md" : "download-compare-filtered-json");
      try {
        // The filtered download workflow is code-split; it owns the
        // fetch/anchor flow and its own status/error surface verbatim.
        const { downloadFilteredComparisonArtifact } = await import("../comparisonRegistryActions");
        await downloadFilteredComparisonArtifact(
          { baselineId, candidateId, artifactView, setActionStatus },
          format,
          filter
        );
      } catch (nextError) {
        setActionStatus("过滤对比投影导出失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [artifact?.matchId, artifact?.runId, artifactView, candidateId, comparison, comparisonRequestContext, selectedMatch?.id, setActionStatus]
  );

  return {
    compareCandidates,
    handleCandidateChange,
    handleLoadComparison,
    refreshComparisonRegistry,
    loadSavedComparisonById,
    handleLoadSavedComparison,
    handleDownloadComparison,
    handleDownloadFilteredComparison
  };
}
