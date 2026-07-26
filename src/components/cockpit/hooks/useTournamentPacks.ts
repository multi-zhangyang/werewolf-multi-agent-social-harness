import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type { CockpitExperimentRequest } from "../experimentDraft";
import {
  DEFAULT_SHARE_ALLOWLIST,
  errorMessage,
  flattenTournamentPackFiles,
  shortId,
  tournamentPackAggregateFiles
} from "../appInspectors";
import type {
  ComparisonRegistrySummary,
  InspectorItem,
  MatchRecord,
  TournamentArtifactSetSummary,
  TournamentExecutionTelemetry,
  TournamentPublicShareInventory,
  TournamentPublicShareSummary,
  Workspace
} from "../appShared";
import type { SetActionStatus } from "./useCockpitStatus";

/**
 * Owns the tournament public-pack workspace: exported artifact sets, the
 * execution telemetry DTO, public share links and their inventory, plus the
 * pack export / share lifecycle actions.
 */
export function useTournamentPacks({
  experimentRequest,
  experimentDraftError,
  jointPhaseScheduler,
  maxTransitions,
  timeoutSeconds,
  refreshMatches,
  loadSavedComparisonById,
  setComparisonRegistry,
  setSelectedComparisonId,
  setWorkspace,
  setInspector,
  setActionStatus,
  setBusy
}: {
  experimentRequest: CockpitExperimentRequest;
  experimentDraftError: string | undefined;
  jointPhaseScheduler: "aec-batched-decision" | "parallel";
  maxTransitions: string;
  timeoutSeconds: string;
  refreshMatches: () => Promise<MatchRecord[]>;
  loadSavedComparisonById: (
    comparisonId: string,
    options?: { switchToCompareWorkspace?: boolean; preserveInspector?: boolean }
  ) => Promise<boolean>;
  setComparisonRegistry: Dispatch<SetStateAction<ComparisonRegistrySummary[]>>;
  setSelectedComparisonId: Dispatch<SetStateAction<string>>;
  setWorkspace: Dispatch<SetStateAction<Workspace>>;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: SetActionStatus;
  setBusy: Dispatch<SetStateAction<string | null>>;
}) {
  const [tournamentPacks, setTournamentPacks] = useState<TournamentArtifactSetSummary[]>([]);
  const [tournamentExecutionTelemetry, setTournamentExecutionTelemetry] =
    useState<TournamentExecutionTelemetry | null>(null);
  const [selectedPackId, setSelectedPackId] = useState("");
  const [packShares, setPackShares] = useState<TournamentPublicShareSummary[]>([]);
  const [shareInventory, setShareInventory] = useState<TournamentPublicShareInventory | null>(null);
  const [shareLabel, setShareLabel] = useState("paper-pack");
  const [packGames, setPackGames] = useState("2");
  const [shareExpiresInHours, setShareExpiresInHours] = useState("");
  const [shareAllowlist, setShareAllowlist] = useState<string[]>(DEFAULT_SHARE_ALLOWLIST);
  const inspectTournamentComparisonRef = useRef<(pack: TournamentArtifactSetSummary) => Promise<boolean>>(async () => false);

  const handleRefreshTournamentPacks = useCallback(async () => {
    setBusy("packs");
    try {
      const { refreshTournamentPacks } = await import("../tournamentPackActions");
      await refreshTournamentPacks({ setTournamentPacks, setSelectedPackId, setActionStatus });
    } catch (nextError) {
      setActionStatus("锦标赛公开包刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [setActionStatus]);

  const handleRefreshShareInventory = useCallback(async () => {
    setBusy("share-inventory");
    try {
      const { refreshShareInventory } = await import("../tournamentPackActions");
      await refreshShareInventory({ setShareInventory, setActionStatus });
    } catch (nextError) {
      setActionStatus("分享清单刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [setActionStatus]);

  const handleDownloadShareAnalyticsSummary = useCallback(
    async (format: "json" | "markdown") => {
      setBusy("share-summary");
      try {
        const { downloadShareAnalyticsSummary } = await import("../tournamentPackActions");
        await downloadShareAnalyticsSummary({ setActionStatus }, format);
      } catch (nextError) {
        setActionStatus("分享分析摘要导出失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [setActionStatus]
  );

  const handleExportTournamentPack = useCallback(async () => {
    if (experimentDraftError) {
      setActionStatus("无法导出锦标赛公开包：实验编排草案无效", experimentDraftError);
      return;
    }
    setBusy("pack-export");
    setTournamentExecutionTelemetry(null);
    setActionStatus("正在运行锦标赛并导出 truth-redacted 公开包...");
    try {
      // The heavy export workflow is code-split; it runs entirely inside this
      // try so any load or run failure reports through the same status path.
      const { runTournamentPackExport } = await import("../tournamentPackActions");
      await runTournamentPackExport({
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
      });
    } catch (nextError) {
      setActionStatus("锦标赛公开包导出失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [
    experimentDraftError,
    experimentRequest,
    jointPhaseScheduler,
    loadSavedComparisonById,
    maxTransitions,
    packGames,
    refreshMatches,
    setActionStatus,
    timeoutSeconds
  ]);

  const handleSelectTournamentPack = useCallback(
    async (pack: TournamentArtifactSetSummary) => {
      setSelectedPackId(pack.artifactSetId);
      const available = flattenTournamentPackFiles(pack.files);
      const preferred = DEFAULT_SHARE_ALLOWLIST.filter((file) => available.includes(file));
      setShareAllowlist(preferred.length ? preferred : available.slice(0, Math.min(8, available.length)));
      setBusy("pack-shares");
      try {
        const { loadPackShares } = await import("../tournamentPackActions");
        await loadPackShares({ setPackShares, setActionStatus }, pack);
      } catch (nextError) {
        setPackShares([]);
        setActionStatus("公开包分享列表加载失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [setActionStatus]
  );

  const handleInspectTournamentComparison = useCallback(
    async (pack: TournamentArtifactSetSummary): Promise<boolean> => {
      const files = tournamentPackAggregateFiles(pack);
      const comparisonFile = files.find((file) => file.file === "tournament_comparison.json");
      if (!comparisonFile?.href) {
        setActionStatus("无法检视 tournament comparison：当前包未注册 tournament_comparison.json。");
        return false;
      }
      setBusy("pack-comparison");
      try {
        // The aggregate inspect workflow is code-split; it runs entirely inside
        // this try so any load failure reports through the same status path.
        const { inspectTournamentComparisonAggregate } = await import("../tournamentPackActions");
        return await inspectTournamentComparisonAggregate({
          comparisonHref: comparisonFile.href,
          pack,
          loadSavedComparisonById,
          setInspector,
          setActionStatus
        });
      } catch (nextError) {
        setActionStatus("tournament comparison 加载失败", errorMessage(nextError));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [loadSavedComparisonById, setActionStatus]
  );
  inspectTournamentComparisonRef.current = handleInspectTournamentComparison;


  const handleCreateTournamentShare = useCallback(async () => {
    if (!selectedPackId) {
      setActionStatus("无法创建分享链接：尚未选择公开包。");
      return;
    }
    setBusy("share-create");
    try {
      const { createTournamentShare } = await import("../tournamentPackActions");
      await createTournamentShare({
        selectedPackId,
        shareLabel,
        shareExpiresInHours,
        shareAllowlist,
        setPackShares,
        setInspector,
        setActionStatus
      });
    } catch (nextError) {
      setActionStatus("公开分享链接创建失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [selectedPackId, setActionStatus, shareAllowlist, shareExpiresInHours, shareLabel]);

  const handleCopyShareUrl = useCallback(
    async (share: TournamentPublicShareSummary) => {
      const detailPath = share.urls?.detail ?? `/api/public/tournament-shares/${encodeURIComponent(share.shareId)}`;
      const absolute = `${window.location.origin}${detailPath}`;
      try {
        await navigator.clipboard.writeText(absolute);
        setActionStatus(`已复制分享链接：${shortId(share.shareId)}`);
      } catch (nextError) {
        setActionStatus("复制分享链接失败", errorMessage(nextError));
      }
    },
    [setActionStatus]
  );

  const handleRevokeTournamentShare = useCallback(
    async (share: TournamentPublicShareSummary) => {
      setBusy("share-revoke");
      try {
        const { revokeTournamentShare } = await import("../tournamentPackActions");
        await revokeTournamentShare({ setPackShares, setActionStatus }, share);
      } catch (nextError) {
        setActionStatus("吊销分享链接失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [setActionStatus]
  );

  const handleRevokeAllActiveShares = useCallback(async () => {
    const active = packShares.filter((share) => !share.expired);
    if (!active.length) {
      setActionStatus("没有可吊销的活跃分享链接。");
      return;
    }
    setBusy("share-revoke-all");
    try {
      const { revokeAllActiveShares } = await import("../tournamentPackActions");
      await revokeAllActiveShares({ setPackShares, setActionStatus }, active);
    } finally {
      setBusy(null);
    }
  }, [packShares, setActionStatus]);

  return {
    tournamentPacks,
    tournamentExecutionTelemetry,
    selectedPackId,
    packShares,
    shareInventory,
    shareLabel,
    setShareLabel,
    packGames,
    setPackGames,
    shareExpiresInHours,
    setShareExpiresInHours,
    shareAllowlist,
    setShareAllowlist,
    handleRefreshTournamentPacks,
    handleRefreshShareInventory,
    handleDownloadShareAnalyticsSummary,
    handleExportTournamentPack,
    handleSelectTournamentPack,
    handleInspectTournamentComparison,
    handleCreateTournamentShare,
    handleCopyShareUrl,
    handleRevokeTournamentShare,
    handleRevokeAllActiveShares
  };
}
