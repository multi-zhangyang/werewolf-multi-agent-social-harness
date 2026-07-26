import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";

import type { MatchComparisonArtifact } from "../../../harness/matchComparisonView";
import type { PostgameReplayFrameDto } from "../../../server/artifactProjection";
import { countSocialStepCommits } from "../../../harness/social";
import type { CockpitExperimentRequest } from "../experimentDraft";
import { readLiveMatchStart, type LiveMatchProjection } from "../werewolfLiveProjection";
import {
  apiJson,
  assertArtifactMatchesId,
  assertJointPhaseSchedulerTransitionBudget,
  assertServerProjectedArtifact,
  clampIndex,
  errorMessage,
  inspectorFromArtifact,
  parseOptionalPositiveInteger,
  parsePositiveInteger,
  shortId
} from "../appInspectors";
import {
  DEFAULT_TIMEOUT_SECONDS,
  type ArtifactView,
  type BranchTreeSummary,
  type CheckpointSummary,
  type ComparisonRequestContext,
  type ConfigResponse,
  type ForkLineageSummary,
  type InspectorItem,
  type MatchRecord,
  type ProjectedMatchArtifact,
  type ReplayFrameLoadState,
  type ReplayResponse,
  type Workspace
} from "../appShared";
import type { SetActionStatus } from "./useCockpitStatus";
import type { LoadComparisonPair } from "./useComparison";

export type LoadArtifact = (
  match: MatchRecord | string,
  view: ArtifactView,
  comparisonCandidateId?: string,
  options?: { preserveLiveUntilLoaded?: boolean }
) => Promise<void>;

/**
 * The core run/artifact lifecycle: the operator registry mirror, the loaded
 * server artifact projection and its evidence cursors, plus every transition
 * between the live spectator projection and a terminal artifact authority
 * (bootstrap, load, view switch, run launch, downloads). Cross-cluster resets
 * are wired through the owning hooks' setters so an artifact load remains a
 * single authority boundary.
 */
export function useMatchArtifact({
  initialCompareSelection,
  artifactView,
  setArtifactView,
  loadConfig,
  canUsePostgameArtifact,
  operatorRegistryEnabled,
  canExportMatchArtifacts,
  experimentRequest,
  experimentDraftError,
  jointPhaseScheduler,
  maxTransitions,
  timeoutSeconds,
  liveMatchId,
  setLiveMatchId,
  setLiveProjection,
  setLivePollError,
  livePollSeqRef,
  setReplay,
  replayFrameLoadSeqRef,
  setReplayFrame,
  setReplayFrameCursorIndex,
  setReplayFrameLoadState,
  setReplayFrameError,
  candidateId,
  setCandidateArtifact,
  setComparison,
  setComparisonRequestContext,
  loadComparisonPair,
  setCheckpoints,
  setSelectedCheckpointId,
  setForkLineage,
  setBranchTree,
  setWorkspace,
  setInspector,
  setActionStatus,
  setBusy
}: {
  initialCompareSelection: { baselineId?: string; candidateId?: string; view?: ArtifactView };
  artifactView: ArtifactView;
  setArtifactView: Dispatch<SetStateAction<ArtifactView>>;
  loadConfig: () => Promise<ConfigResponse>;
  canUsePostgameArtifact: boolean;
  operatorRegistryEnabled: boolean;
  canExportMatchArtifacts: boolean;
  experimentRequest: CockpitExperimentRequest;
  experimentDraftError: string | undefined;
  jointPhaseScheduler: "aec-batched-decision" | "parallel";
  maxTransitions: string;
  timeoutSeconds: string;
  liveMatchId: string | null;
  setLiveMatchId: Dispatch<SetStateAction<string | null>>;
  setLiveProjection: Dispatch<SetStateAction<LiveMatchProjection | null>>;
  setLivePollError: Dispatch<SetStateAction<string | null>>;
  livePollSeqRef: RefObject<number>;
  setReplay: Dispatch<SetStateAction<ReplayResponse | null>>;
  replayFrameLoadSeqRef: RefObject<number>;
  setReplayFrame: Dispatch<SetStateAction<PostgameReplayFrameDto | null>>;
  setReplayFrameCursorIndex: Dispatch<SetStateAction<number | null>>;
  setReplayFrameLoadState: Dispatch<SetStateAction<ReplayFrameLoadState>>;
  setReplayFrameError: Dispatch<SetStateAction<string | null>>;
  candidateId: string;
  setCandidateArtifact: Dispatch<SetStateAction<ProjectedMatchArtifact | null>>;
  setComparison: Dispatch<SetStateAction<MatchComparisonArtifact | null>>;
  setComparisonRequestContext: Dispatch<SetStateAction<ComparisonRequestContext | null>>;
  loadComparisonPair: LoadComparisonPair;
  setCheckpoints: Dispatch<SetStateAction<CheckpointSummary[]>>;
  setSelectedCheckpointId: Dispatch<SetStateAction<string>>;
  setForkLineage: Dispatch<SetStateAction<ForkLineageSummary | null>>;
  setBranchTree: Dispatch<SetStateAction<BranchTreeSummary | null>>;
  setWorkspace: Dispatch<SetStateAction<Workspace>>;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: SetActionStatus;
  setBusy: Dispatch<SetStateAction<string | null>>;
}) {
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [selectedMatch, setSelectedMatch] = useState<MatchRecord | null>(null);
  const [artifact, setArtifact] = useState<ProjectedMatchArtifact | null>(null);
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [query, setQuery] = useState("");
  const artifactLoadSeqRef = useRef(0);
  // Startup is an initialization transaction, not a reaction to later view or
  // comparison selection changes. Re-running it would overwrite user intent.
  const bootstrapStartedRef = useRef(false);

  const artifactBackedMatches = useMemo(() => matches.filter((match) => match.hasArtifact), [matches]);
  const currentMatchId = liveMatchId ?? artifact?.matchId ?? artifact?.runId ?? selectedMatch?.id ?? "";

  const filteredMatches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return matches;
    return matches.filter((match) => {
      const haystack = [
        match.id,
        match.status,
        match.harnessStatus ?? "",
        match.state.phase,
        match.models.join(" ")
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [matches, query]);

  const refreshMatches = useCallback(async () => {
    const records = await apiJson<MatchRecord[]>("/api/matches");
    const ordered = [...records].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    setMatches(ordered);
    return ordered;
  }, []);

  const loadArtifact: LoadArtifact = useCallback(
    async (
      match: MatchRecord | string,
      view: ArtifactView,
      comparisonCandidateId?: string,
      options: { preserveLiveUntilLoaded?: boolean } = {}
    ) => {
      const matchId = typeof match === "string" ? match : match.id;
      const selectedSummary = typeof match === "string" ? matches.find((candidate) => candidate.id === matchId) ?? null : match;
      const requestSeq = artifactLoadSeqRef.current + 1;
      artifactLoadSeqRef.current = requestSeq;
      // A terminal artifact is the next authority boundary. It supersedes any
      // ephemeral live table and also cancels an in-flight poll response. A
      // live terminal handoff can retain the narrow spectator shell until the
      // server artifact has actually passed local projection validation.
      livePollSeqRef.current += 1;
      if (!options.preserveLiveUntilLoaded) {
        setLiveMatchId(null);
        setLiveProjection(null);
        setLivePollError(null);
      }
      setBusy(`artifact:${matchId}`);
      try {
        const nextArtifact = await apiJson<ProjectedMatchArtifact>(`/api/matches/${encodeURIComponent(matchId)}/artifact?view=${view}`);
        if (requestSeq !== artifactLoadSeqRef.current) return;
        await assertServerProjectedArtifact(nextArtifact, "match artifact");
        assertArtifactMatchesId(nextArtifact, matchId, "match artifact");
        setLiveMatchId(null);
        setLiveProjection(null);
        setLivePollError(null);
        setSelectedMatch(selectedSummary);
        setArtifact(nextArtifact);
        setArtifactView(view);
        setReplay(null);
        replayFrameLoadSeqRef.current += 1;
        setReplayFrame(null);
        setReplayFrameCursorIndex(null);
        setReplayFrameLoadState("idle");
        setReplayFrameError(null);
        setComparison(null);
        setComparisonRequestContext(null);
        setCandidateArtifact(null);
        setCheckpoints([]);
        setSelectedCheckpointId("");
        setForkLineage(null);
        setBranchTree(null);
        const loadedStepCounts = countSocialStepCommits(nextArtifact.socialEpisode.steps);
        setSelectedStepIndex(clampIndex(loadedStepCounts.nativeSteps - 1, loadedStepCounts.nativeSteps));
        setSelectedAgentId(nextArtifact.agents[0]?.playerId ?? "");
        setInspector(inspectorFromArtifact(nextArtifact));
        setActionStatus(
          `已加载脱敏工件：${shortId(matchId)} · view=${view} · native=${loadedStepCounts.nativeSteps} · committed=${loadedStepCounts.committedSteps} · rejected=${loadedStepCounts.rejectedSteps} · legacy projection=${nextArtifact.trajectory.length}`
        );
        if (comparisonCandidateId && comparisonCandidateId !== matchId) {
          await loadComparisonPair({
            baselineId: matchId,
            candidateId: comparisonCandidateId,
            view,
            statusPrefix: "基准切换后对比已重载"
          });
        }
      } catch (nextError) {
        if (requestSeq === artifactLoadSeqRef.current) {
          setActionStatus("工件加载失败", errorMessage(nextError));
        }
      } finally {
        if (requestSeq === artifactLoadSeqRef.current) {
          setBusy(null);
        }
      }
    },
    [loadComparisonPair, matches, setActionStatus]
  );

  const handleArtifactViewChange = useCallback(
    async (view: ArtifactView) => {
      if (view === "postgame-redacted" && !canUsePostgameArtifact) {
        setActionStatus("当前连接没有本地研究投影权限；继续使用公开真相脱敏视图。");
        return;
      }
      if (!selectedMatch?.hasArtifact) {
        setArtifactView(view);
        setActionStatus(`投影模式已切换为 ${view}；加载工件后生效。`);
        return;
      }
      await loadArtifact(selectedMatch, view, candidateId);
    },
    [canUsePostgameArtifact, candidateId, loadArtifact, selectedMatch, setActionStatus]
  );

  const bootstrap = useCallback(async () => {
    setBusy("bootstrap");
    try {
      const nextConfig = await loadConfig();
      if (nextConfig.capabilities?.operatorRegistry !== true) {
        setActionStatus("已连接公开只读服务；运行注册表与本地研究工件未向当前连接开放。");
        return;
      }
      const records = await refreshMatches();
      const preferredBaselineId = initialCompareSelection.baselineId;
      const preferredCandidateId = initialCompareSelection.candidateId;
      const preferredView =
        initialCompareSelection.view === "truth-redacted" ||
        nextConfig.capabilities?.postgameArtifact !== true
          ? "truth-redacted"
          : "postgame-redacted";
      const preferredBaseline = preferredBaselineId
        ? records.find((match) => match.hasArtifact && match.id === preferredBaselineId)
        : undefined;
      const latest = preferredBaseline ?? records.find((match) => match.hasArtifact);
      if (latest) {
        // candidateId is already bootstrapped from the deep link when present.
        // loadArtifact auto-reloads the comparison pair for a selected candidate.
        await loadArtifact(latest, preferredView, preferredCandidateId);
      } else {
        setActionStatus("API 已连接，但当前没有可加载的 harness 工件。");
      }
      if (latest && preferredCandidateId && preferredCandidateId !== latest.id) {
        setWorkspace("compare");
      }
    } catch (nextError) {
      setActionStatus("初始化失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [
    initialCompareSelection.baselineId,
    initialCompareSelection.candidateId,
    initialCompareSelection.view,
    loadArtifact,
    loadConfig,
    refreshMatches,
    setActionStatus
  ]);

  useEffect(() => {
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    void bootstrap();
  }, [bootstrap]);

  const handleRefresh = useCallback(async () => {
    if (!operatorRegistryEnabled) {
      setActionStatus("当前连接没有运行注册表权限；未发送刷新请求。");
      return;
    }
    setBusy("matches");
    try {
      const records = await refreshMatches();
      setActionStatus(`运行注册表已刷新：${records.length} 条`);
    } catch (nextError) {
      setActionStatus("运行注册表刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [operatorRegistryEnabled, refreshMatches, setActionStatus]);

  const handleLoadLatest = useCallback(async () => {
    if (!operatorRegistryEnabled) {
      setActionStatus("当前连接没有运行注册表权限；未发送加载请求。");
      return;
    }
    setBusy("latest");
    try {
      const records = await refreshMatches();
      const latest = records.find((match) => match.hasArtifact);
      if (!latest) {
        setActionStatus("没有可加载的 artifact-backed run。");
        return;
      }
      await loadArtifact(
        latest,
        canUsePostgameArtifact ? "postgame-redacted" : "truth-redacted",
        candidateId
      );
      setWorkspace("timeline");
    } catch (nextError) {
      setActionStatus("加载最近工件失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [canUsePostgameArtifact, candidateId, loadArtifact, operatorRegistryEnabled, refreshMatches, setActionStatus]);

  const handleRunExperiment = useCallback(async () => {
    if (experimentDraftError) {
      setActionStatus("无法启动：实验编排草案无效", experimentDraftError);
      return;
    }
    setBusy("run");
    setActionStatus("正在通过真实 API 启动 harness run...");
    try {
      const timeoutMs = parsePositiveInteger(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS) * 1000;
      const transitions = parseOptionalPositiveInteger(maxTransitions);
      assertJointPhaseSchedulerTransitionBudget(jointPhaseScheduler, transitions);
      const rawStart = await apiJson<unknown>("/api/matches/run", {
        method: "POST",
        body: JSON.stringify({
          ...experimentRequest,
          seed: `ui-cockpit-${Date.now()}`,
          ...(transitions === undefined ? {} : { maxTransitions: transitions }),
          timeoutMs,
          jointPhaseScheduler,
          // Explicitly select the server-owned live-public contract. The
          // browser will poll its projection; it does not execute a match.
          live: true
        })
      });
      const start = readLiveMatchStart(rawStart);
      artifactLoadSeqRef.current += 1;
      livePollSeqRef.current += 1;
      // A live spectator must not receive or display operator registry truth
      // while the episode is running. The narrow start DTO owns only this id;
      // the registry is read only after a terminal artifact is advertised.
      setSelectedMatch(null);
      setArtifact(null);
      setCandidateArtifact(null);
      setComparison(null);
      setComparisonRequestContext(null);
      setReplay(null);
      replayFrameLoadSeqRef.current += 1;
      setReplayFrame(null);
      setReplayFrameCursorIndex(null);
      setReplayFrameLoadState("idle");
      setReplayFrameError(null);
      setCheckpoints([]);
      setSelectedCheckpointId("");
      setForkLineage(null);
      setBranchTree(null);
      setLiveProjection(null);
      setLivePollError(null);
      setLiveMatchId(start.matchId);
      setWorkspace("domain");
      setActionStatus(
        `真实 harness run 已启动：${shortId(start.matchId)} · 正在显示服务端公开实时局面 · joint=${jointPhaseScheduler}`
      );
    } catch (nextError) {
      setActionStatus("真实 harness run 失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [experimentDraftError, experimentRequest, jointPhaseScheduler, maxTransitions, setActionStatus, timeoutSeconds]);

  const handleDownloadArtifact = useCallback(() => {
    if (!canExportMatchArtifacts) {
      setActionStatus("当前连接没有 match artifact 导出权限；未发送下载请求。");
      return;
    }
    if (!currentMatchId) return;
    const target = `/api/matches/${encodeURIComponent(currentMatchId)}/trajectory.jsonl?view=${artifactView}`;
    setBusy("download");
    void fetch(target)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${shortId(currentMatchId)}-trajectory-${artifactView}.jsonl`;
        anchor.click();
        URL.revokeObjectURL(url);
        setActionStatus(`trajectory.jsonl 已验证并开始下载：${shortId(currentMatchId)} · view=${artifactView}`);
      })
      .catch((nextError: unknown) => {
        setActionStatus("trajectory.jsonl 下载失败", errorMessage(nextError));
      })
      .finally(() => setBusy(null));
  }, [artifactView, canExportMatchArtifacts, currentMatchId, setActionStatus]);

  const handleDownloadMatchArtifact = useCallback(() => {
    if (!canExportMatchArtifacts) {
      setActionStatus("当前连接没有 match artifact 导出权限；未发送下载请求。");
      return;
    }
    if (!currentMatchId) return;
    const target = `/api/matches/${encodeURIComponent(currentMatchId)}/artifact?view=${artifactView}&download=1`;
    setBusy("download-match");
    void fetch(target)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${shortId(currentMatchId)}-match-${artifactView}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        setActionStatus(`match artifact 已验证并开始下载：${shortId(currentMatchId)} · view=${artifactView}`);
      })
      .catch((nextError: unknown) => {
        setActionStatus("match artifact 下载失败", errorMessage(nextError));
      })
      .finally(() => setBusy(null));
  }, [artifactView, canExportMatchArtifacts, currentMatchId, setActionStatus]);

  return {
    matches,
    setMatches,
    selectedMatch,
    setSelectedMatch,
    artifact,
    setArtifact,
    selectedStepIndex,
    setSelectedStepIndex,
    selectedAgentId,
    setSelectedAgentId,
    query,
    setQuery,
    artifactBackedMatches,
    currentMatchId,
    filteredMatches,
    refreshMatches,
    loadArtifact,
    handleArtifactViewChange,
    handleRefresh,
    handleLoadLatest,
    handleRunExperiment,
    handleDownloadArtifact,
    handleDownloadMatchArtifact
  };
}
