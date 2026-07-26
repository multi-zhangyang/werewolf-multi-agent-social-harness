import type { Dispatch, RefObject, SetStateAction } from "react";

import type { MatchComparisonArtifact } from "../../harness/matchComparisonView";
// Imports stay fine-grained (no barrels): this async chunk must not pull the
// icon/nav/lazy-board modules into its graph.
import { apiJson } from "./apiClient";
import {
  assertArtifactMatchesId,
  assertServerProjectedArtifact,
  assertServerProjectedComparison
} from "./artifactGuards";
import { errorMessage, shortId } from "./formatters";
import { inspectorFromComparison } from "./inspectorBuilders";
import type {
  ArtifactView,
  ComparisonRequestContext,
  InspectorItem,
  MatchRecord,
  ProjectedMatchArtifact,
  Workspace
} from "./cockpitTypes";

/**
 * Heavy comparison-registry workflows, loaded on demand from
 * `useComparisonActions`. Each entry point runs strictly after its hook-side
 * synchronous preflight and inside the hook's existing error surface, so
 * status messages, state-update ordering, race-guard semantics and error
 * paths are unchanged. This module must only ever be imported dynamically
 * (bundle budget).
 */

export interface SavedComparisonLoadContext {
  artifactView: ArtifactView;
  matches: MatchRecord[];
  comparisonLoadSeqRef: RefObject<number>;
  loadArtifact: (
    match: MatchRecord | string,
    view: ArtifactView,
    comparisonCandidateId?: string,
    options?: { preserveLiveUntilLoaded?: boolean }
  ) => Promise<void>;
  setArtifact: Dispatch<SetStateAction<ProjectedMatchArtifact | null>>;
  setArtifactView: Dispatch<SetStateAction<ArtifactView>>;
  setMatches: Dispatch<SetStateAction<MatchRecord[]>>;
  setSelectedMatch: Dispatch<SetStateAction<MatchRecord | null>>;
  setCandidateId: Dispatch<SetStateAction<string>>;
  setCandidateArtifact: Dispatch<SetStateAction<ProjectedMatchArtifact | null>>;
  setComparison: Dispatch<SetStateAction<MatchComparisonArtifact | null>>;
  setComparisonRequestContext: Dispatch<SetStateAction<ComparisonRequestContext | null>>;
  setSelectedComparisonId: Dispatch<SetStateAction<string>>;
  setWorkspace: Dispatch<SetStateAction<Workspace>>;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: (message: string, nextError?: string | null) => void;
  setBusy: Dispatch<SetStateAction<string | null>>;
}

export async function loadSavedComparison(
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
  }: SavedComparisonLoadContext,
  comparisonId: string,
  options?: { switchToCompareWorkspace?: boolean; preserveInspector?: boolean }
): Promise<boolean> {
  const requestSeq = comparisonLoadSeqRef.current + 1;
  comparisonLoadSeqRef.current = requestSeq;
  setBusy("comparison-registry-load");
  try {
    const nextComparison = await apiJson<MatchComparisonArtifact>(
      `/api/comparisons/${encodeURIComponent(comparisonId)}?view=${encodeURIComponent(artifactView)}`
    );
    if (requestSeq !== comparisonLoadSeqRef.current) {
      return false;
    }
    assertServerProjectedComparison(nextComparison);
    setSelectedComparisonId(comparisonId);
    const nextView =
      nextComparison.view === "truth-redacted" || nextComparison.view === "postgame-redacted"
        ? nextComparison.view
        : artifactView;
    const nextCandidateId = nextComparison.candidate.matchId ?? nextComparison.candidate.runId;
    const nextBaselineId = nextComparison.baseline.matchId ?? nextComparison.baseline.runId;
    let candidateHydrated = false;
    let baselineHydrated = false;
    if (nextCandidateId) {
      setCandidateId(nextCandidateId);
      try {
        const candidate = await apiJson<ProjectedMatchArtifact>(
          `/api/matches/${encodeURIComponent(nextCandidateId)}/artifact?view=${nextView}`
        );
        if (requestSeq !== comparisonLoadSeqRef.current) {
          return false;
        }
        await assertServerProjectedArtifact(candidate, "candidate artifact");
        assertArtifactMatchesId(candidate, nextCandidateId, "candidate artifact");
        setCandidateArtifact(candidate);
        candidateHydrated = true;
      } catch {
        // Comparison matrix can still render from the server comparison artifact.
      }
    }

    if (nextBaselineId) {
      try {
        const baselineMatch = matches.find((match) => match.id === nextBaselineId);
        if (baselineMatch?.hasArtifact) {
          await loadArtifact(baselineMatch, nextView, nextCandidateId);
          if (requestSeq !== comparisonLoadSeqRef.current) {
            return false;
          }
          baselineHydrated = true;
        } else {
          const baseline = await apiJson<ProjectedMatchArtifact>(
            `/api/matches/${encodeURIComponent(nextBaselineId)}/artifact?view=${nextView}`
          );
          if (requestSeq !== comparisonLoadSeqRef.current) {
            return false;
          }
          await assertServerProjectedArtifact(baseline, "baseline artifact");
          assertArtifactMatchesId(baseline, nextBaselineId, "baseline artifact");
          setArtifact(baseline);
          setArtifactView(nextView);
          try {
            const listed = await apiJson<MatchRecord[]>("/api/matches");
            if (requestSeq !== comparisonLoadSeqRef.current) {
              return false;
            }
            if (Array.isArray(listed)) {
              setMatches(listed);
              const listedBaseline = listed.find((match) => match.id === nextBaselineId);
              if (listedBaseline) setSelectedMatch(listedBaseline);
            }
          } catch {
            // Artifact hydration already succeeded.
          }
          baselineHydrated = true;
        }
      } catch {
        if (requestSeq === comparisonLoadSeqRef.current && nextView !== artifactView) {
          setArtifactView(nextView);
        }
      }
    } else if (requestSeq === comparisonLoadSeqRef.current && nextView !== artifactView) {
      setArtifactView(nextView);
    }

    if (requestSeq !== comparisonLoadSeqRef.current) {
      return false;
    }

    setComparison(nextComparison);
    setComparisonRequestContext(
      nextBaselineId && nextCandidateId
        ? {
            comparisonId: nextComparison.comparisonId,
            baselineId: nextBaselineId,
            candidateId: nextCandidateId,
            view: nextView
          }
        : null
    );
    // Preserve an existing aggregate inspector (e.g. tournament comparison with pair
    // actions) when the caller is auto-loading a pair matrix as a side effect.
    if (!options?.preserveInspector) {
      setInspector(inspectorFromComparison(nextComparison));
    }
    if (options?.switchToCompareWorkspace) setWorkspace("compare");
    setActionStatus(
      `已加载注册表对比：${shortId(nextComparison.comparisonId)} · view=${nextComparison.view} · rows=${nextComparison.rows.length}` +
        ` · socialΔ${nextComparison.summary.socialStepsDelta} · cΔ${nextComparison.summary.committedStepsDelta}/rΔ${nextComparison.summary.rejectedStepsDelta}` +
        ` · baseline=${baselineHydrated ? "hydrated" : "summary-only"}` +
        ` · candidate=${candidateHydrated ? "hydrated" : "summary-only"}`
    );
    return true;
  } catch (nextError) {
    if (requestSeq !== comparisonLoadSeqRef.current) {
      return false;
    }
    setActionStatus("注册表对比加载失败", errorMessage(nextError));
    return false;
  } finally {
    if (requestSeq === comparisonLoadSeqRef.current) {
      setBusy(null);
    }
  }
}

export interface ComparisonDownloadContext {
  baselineId: string;
  candidateId: string;
  artifactView: ArtifactView;
  setActionStatus: (message: string, nextError?: string | null) => void;
}

export async function downloadComparisonArtifact(
  { baselineId, candidateId, artifactView, setActionStatus }: ComparisonDownloadContext,
  format: "json" | "markdown"
): Promise<void> {
  const target =
    `/api/matches/${encodeURIComponent(baselineId)}/compare/${encodeURIComponent(candidateId)}` +
    `?view=${artifactView}&format=${format}&download=1`;
  try {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const extension = format === "markdown" ? "md" : "json";
    anchor.download = `${shortId(baselineId)}-vs-${shortId(candidateId)}-comparison.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setActionStatus(
      `对比工件已从服务端导出：${shortId(baselineId)} vs ${shortId(candidateId)} · format=${format} · view=${artifactView}`
    );
  } catch (nextError) {
    setActionStatus("对比工件导出失败", errorMessage(nextError));
  }
}

export async function downloadFilteredComparisonArtifact(
  { baselineId, candidateId, artifactView, setActionStatus }: ComparisonDownloadContext,
  format: "json" | "markdown",
  filter: {
    group: string;
    changedOnly: boolean;
    promotion: string;
    evidenceIdentity: string;
    numericDelta: string;
  }
): Promise<void> {
  const params = new URLSearchParams({
    view: artifactView,
    format,
    download: "1",
    filtered: "1",
    group: filter.group,
    changedOnly: filter.changedOnly ? "1" : "0",
    promotion: filter.promotion,
    evidenceIdentity: filter.evidenceIdentity,
    numericDelta: filter.numericDelta
  });
  const target =
    `/api/matches/${encodeURIComponent(baselineId)}/compare/${encodeURIComponent(candidateId)}?` +
    params.toString();
  try {
    const response = await fetch(target);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const extension = format === "markdown" ? "md" : "json";
    anchor.download = `${shortId(baselineId)}-vs-${shortId(candidateId)}-comparison-filtered.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setActionStatus(
      `过滤对比投影已从服务端导出：${shortId(baselineId)} vs ${shortId(candidateId)} · format=${format} · view=${artifactView} · filter=${filter.group}/${filter.promotion}/${filter.evidenceIdentity}/${filter.numericDelta}${filter.changedOnly ? "/changedOnly" : ""}`
    );
  } catch (nextError) {
    setActionStatus("过滤对比投影导出失败", errorMessage(nextError));
  }
}
