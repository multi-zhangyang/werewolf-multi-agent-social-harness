import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

import type { PostgameReplayFrameDto } from "../../../server/artifactProjection";
import {
  apiJson,
  errorMessage,
  inspectorFromBranchTree,
  inspectorFromCheckpoint,
  inspectorFromForkLineage,
  orderCheckpoints,
  shortId
} from "../appInspectors";
import type {
  ArtifactView,
  BranchTreeResponse,
  BranchTreeSummary,
  CheckpointSummary,
  CheckpointsResponse,
  ForkLineageResponse,
  ForkLineageSummary,
  InspectorItem,
  MatchRecord,
  Workspace
} from "../appShared";
import type { SetActionStatus } from "./useCockpitStatus";
import type { LoadComparisonPair } from "./useComparison";

/**
 * Owns the lineage evidence for the current run: checkpoint summaries, the
 * selected checkpoint, fork lineage and the branch tree.
 */
export function useCheckpointState() {
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState("");
  const [forkLineage, setForkLineage] = useState<ForkLineageSummary | null>(null);
  const [branchTree, setBranchTree] = useState<BranchTreeSummary | null>(null);

  return {
    checkpoints,
    setCheckpoints,
    selectedCheckpointId,
    setSelectedCheckpointId,
    forkLineage,
    setForkLineage,
    branchTree,
    setBranchTree
  };
}

/**
 * Checkpoint registry refresh, checkpoint create/fork and lineage/branch-tree
 * loads for the lineage workspace.
 */
export function useCheckpointActions({
  canUseCheckpointControls,
  currentMatchId,
  artifactView,
  replayFrame,
  maxTransitions,
  timeoutSeconds,
  selectedCheckpointId,
  setCheckpoints,
  setSelectedCheckpointId,
  setForkLineage,
  setBranchTree,
  setCandidateId,
  loadComparisonPair,
  refreshMatches,
  setWorkspace,
  setInspector,
  setActionStatus,
  setBusy
}: {
  canUseCheckpointControls: boolean;
  currentMatchId: string;
  artifactView: ArtifactView;
  replayFrame: PostgameReplayFrameDto | null;
  maxTransitions: string;
  timeoutSeconds: string;
  selectedCheckpointId: string;
  setCheckpoints: Dispatch<SetStateAction<CheckpointSummary[]>>;
  setSelectedCheckpointId: Dispatch<SetStateAction<string>>;
  setForkLineage: Dispatch<SetStateAction<ForkLineageSummary | null>>;
  setBranchTree: Dispatch<SetStateAction<BranchTreeSummary | null>>;
  setCandidateId: Dispatch<SetStateAction<string>>;
  loadComparisonPair: LoadComparisonPair;
  refreshMatches: () => Promise<MatchRecord[]>;
  setWorkspace: Dispatch<SetStateAction<Workspace>>;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: SetActionStatus;
  setBusy: Dispatch<SetStateAction<string | null>>;
}) {
  const handleRefreshCheckpoints = useCallback(async () => {
    if (!canUseCheckpointControls) {
      setActionStatus("当前连接没有 checkpoint registry 权限；未发送刷新请求。");
      return;
    }
    if (!currentMatchId) {
      setActionStatus("无法刷新 checkpoint：尚未选择 run。");
      return;
    }
    setBusy("checkpoints");
    try {
      const response = await apiJson<CheckpointsResponse>(`/api/checkpoints?matchId=${encodeURIComponent(currentMatchId)}`);
      const ordered = orderCheckpoints(response.checkpoints);
      setCheckpoints(ordered);
      setSelectedCheckpointId((current) => (current && ordered.some((checkpoint) => checkpoint.checkpointId === current) ? current : ordered[0]?.checkpointId ?? ""));
      setActionStatus(`checkpoint 摘要已刷新：${ordered.length} 条`);
    } catch (nextError) {
      setActionStatus("checkpoint 摘要刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [canUseCheckpointControls, currentMatchId, setActionStatus]);

  const handleCreateCheckpoint = useCallback(async () => {
    if (!canUseCheckpointControls) {
      setActionStatus("当前连接没有 checkpoint create 权限；未发送创建请求。");
      return;
    }
    if (!currentMatchId) {
      setActionStatus("无法创建 checkpoint：尚未选择 run。");
      return;
    }
    setBusy("checkpoint:create");
    try {
      // The create workflow is code-split; it runs entirely inside this try
      // so any load or request failure reports through the same status path.
      const { createCheckpoint } = await import("../checkpointActions");
      await createCheckpoint({
        currentMatchId,
        replayFrameNativeStepCount: replayFrame?.cursor.nativeStepCount,
        setCheckpoints,
        setSelectedCheckpointId,
        setBranchTree,
        setInspector,
        setActionStatus
      });
    } catch (nextError) {
      setActionStatus("checkpoint 创建失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [canUseCheckpointControls, currentMatchId, replayFrame?.cursor.nativeStepCount, setActionStatus]);

  const handleForkCheckpoint = useCallback(
    async (checkpoint: CheckpointSummary) => {
      if (!canUseCheckpointControls) {
        setActionStatus("当前连接没有 checkpoint fork 权限；未发送 fork 请求。");
        return;
      }
      if (!currentMatchId) {
        setActionStatus("无法 fork checkpoint：尚未选择 parent run。");
        return;
      }
      if (artifactView !== "postgame-redacted") {
        setActionStatus("checkpoint fork 仅在 postgame-redacted 本地研究视图可用。");
        return;
      }
      const parentMatchId = currentMatchId;
      if (checkpoint.source.runId !== parentMatchId && checkpoint.source.matchId !== parentMatchId) {
        setActionStatus("无法 fork checkpoint：所选 checkpoint 不属于当前 parent run。");
        return;
      }
      const forkBusyId = `checkpoint:fork:${checkpoint.checkpointId}`;
      setBusy(forkBusyId);
      try {
        // The fork workflow is code-split; it runs entirely inside this try
        // so any load or request failure reports through the same status path.
        const { forkCheckpoint } = await import("../checkpointActions");
        await forkCheckpoint({
          checkpoint,
          parentMatchId,
          forkBusyId,
          maxTransitions,
          timeoutSeconds,
          refreshMatches,
          setCandidateId,
          loadComparisonPair,
          setForkLineage,
          setBranchTree,
          setSelectedCheckpointId,
          setWorkspace,
          setActionStatus,
          setBusy
        });
      } catch (nextError) {
        setActionStatus("checkpoint fork 失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [artifactView, canUseCheckpointControls, currentMatchId, loadComparisonPair, maxTransitions, refreshMatches, setActionStatus, timeoutSeconds]
  );

  const handleLoadForkLineage = useCallback(async () => {
    if (!canUseCheckpointControls) {
      setActionStatus("当前连接没有 fork lineage 权限；未发送请求。");
      return;
    }
    if (!currentMatchId) {
      setActionStatus("无法加载 fork lineage：尚未选择 run。");
      return;
    }
    setBusy("fork-lineage");
    try {
      const response = await apiJson<ForkLineageResponse>(`/api/matches/${encodeURIComponent(currentMatchId)}/fork-lineage`);
      setForkLineage(response.summary);
      setInspector(inspectorFromForkLineage(response.summary));
      setActionStatus(`fork lineage 已加载：${response.summary.isFork ? "fork" : "root run"} · boundary=${response.summary.boundary?.status ?? "n/a"}`);
    } catch (nextError) {
      setActionStatus("fork lineage 加载失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [canUseCheckpointControls, currentMatchId, setActionStatus]);

  const handleSelectCheckpoint = useCallback(
    (checkpoint: CheckpointSummary) => {
      setSelectedCheckpointId(checkpoint.checkpointId);
      setInspector(inspectorFromCheckpoint(checkpoint));
      setActionStatus(`已选择 checkpoint：${shortId(checkpoint.checkpointId)}`);
    },
    [setActionStatus]
  );

  const handleLoadBranchTree = useCallback(
    async (checkpointId = selectedCheckpointId) => {
      if (!canUseCheckpointControls) {
        setActionStatus("当前连接没有 branch tree 权限；未发送请求。");
        return;
      }
      if (!checkpointId) {
        setActionStatus("无法加载 branch tree：尚未选择 checkpoint。");
        return;
      }
      setBusy("branch-tree");
      try {
        const response = await apiJson<BranchTreeResponse>(`/api/checkpoints/${encodeURIComponent(checkpointId)}/branch-tree`);
        setBranchTree(response.summary);
        setInspector(inspectorFromBranchTree(response.summary));
        setActionStatus(
          `branch tree 已加载：checkpoints=${response.summary.counts?.checkpoints ?? 0} · matches=${response.summary.counts?.matches ?? 0} · edges=${response.summary.counts?.edges ?? 0}`
        );
      } catch (nextError) {
        setActionStatus("branch tree 加载失败", errorMessage(nextError));
      } finally {
        setBusy(null);
      }
    },
    [canUseCheckpointControls, selectedCheckpointId, setActionStatus]
  );

  return {
    handleRefreshCheckpoints,
    handleCreateCheckpoint,
    handleForkCheckpoint,
    handleLoadForkLineage,
    handleSelectCheckpoint,
    handleLoadBranchTree
  };
}
