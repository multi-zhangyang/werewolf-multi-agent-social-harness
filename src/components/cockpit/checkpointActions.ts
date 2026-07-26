import type { Dispatch, SetStateAction } from "react";

// Imports stay fine-grained (no barrels): this async chunk must not pull the
// icon/nav/lazy-board modules into its graph.
import { apiJson } from "./apiClient";
import {
  orderCheckpoints,
  parseOptionalPositiveInteger,
  parsePositiveInteger,
  shortId
} from "./formatters";
import { inspectorFromCheckpoint } from "./inspectorBuilders";
import { DEFAULT_TIMEOUT_SECONDS } from "./cockpitDefaults";
import type {
  ArtifactView,
  BranchTreeResponse,
  BranchTreeSummary,
  CheckpointCreateResponse,
  CheckpointForkResponse,
  CheckpointSummary,
  CheckpointsResponse,
  ForkLineageResponse,
  ForkLineageSummary,
  InspectorItem,
  MatchRecord,
  Workspace
} from "./cockpitTypes";

/**
 * Heavy checkpoint create/fork workflows, loaded on demand from
 * `useCheckpointActions`. Each entry point runs strictly after its hook-side
 * synchronous preflight and inside the hook's existing try/catch/finally, so
 * status messages, state-update ordering and error surfaces are unchanged.
 * This module must only ever be imported dynamically (bundle budget).
 */

export async function createCheckpoint({
  currentMatchId,
  replayFrameNativeStepCount,
  setCheckpoints,
  setSelectedCheckpointId,
  setBranchTree,
  setInspector,
  setActionStatus
}: {
  currentMatchId: string;
  replayFrameNativeStepCount: number | undefined;
  setCheckpoints: Dispatch<SetStateAction<CheckpointSummary[]>>;
  setSelectedCheckpointId: Dispatch<SetStateAction<string>>;
  setBranchTree: Dispatch<SetStateAction<BranchTreeSummary | null>>;
  setInspector: Dispatch<SetStateAction<InspectorItem | null>>;
  setActionStatus: (message: string, nextError?: string | null) => void;
}): Promise<void> {
  const created = await apiJson<CheckpointCreateResponse>(`/api/matches/${encodeURIComponent(currentMatchId)}/checkpoints`, {
    method: "POST",
    body: JSON.stringify({
      reason: `ui checkpoint ${new Date().toISOString()}`,
      ...(replayFrameNativeStepCount === undefined
        ? {}
        : { nativeStepCount: replayFrameNativeStepCount })
    })
  });
  const response = await apiJson<CheckpointsResponse>(`/api/checkpoints?matchId=${encodeURIComponent(currentMatchId)}`);
  const ordered = orderCheckpoints(response.checkpoints);
  setCheckpoints(ordered);
  setSelectedCheckpointId(created.summary.checkpointId);
  setBranchTree(null);
  setInspector(inspectorFromCheckpoint(created.summary));
  setActionStatus(
    `checkpoint 已创建：${shortId(created.summary.checkpointId)} · boundary=native #${created.summary.source.nativeStepCount} · artifact=${created.artifactUrl ? "summary-only" : "n/a"}`
  );
}

export async function forkCheckpoint({
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
}: {
  checkpoint: CheckpointSummary;
  parentMatchId: string;
  forkBusyId: string;
  maxTransitions: string;
  timeoutSeconds: string;
  refreshMatches: () => Promise<MatchRecord[]>;
  setCandidateId: Dispatch<SetStateAction<string>>;
  loadComparisonPair: (options: {
    baselineId: string;
    candidateId: string;
    view: ArtifactView;
    statusPrefix?: string;
  }) => Promise<boolean>;
  setForkLineage: Dispatch<SetStateAction<ForkLineageSummary | null>>;
  setBranchTree: Dispatch<SetStateAction<BranchTreeSummary | null>>;
  setSelectedCheckpointId: Dispatch<SetStateAction<string>>;
  setWorkspace: Dispatch<SetStateAction<Workspace>>;
  setActionStatus: (message: string, nextError?: string | null) => void;
  setBusy: Dispatch<SetStateAction<string | null>>;
}): Promise<void> {
  const transitions = parseOptionalPositiveInteger(maxTransitions);
  const forked = await apiJson<CheckpointForkResponse>(
    `/api/checkpoints/${encodeURIComponent(checkpoint.checkpointId)}/fork`,
    {
      method: "POST",
      body: JSON.stringify({
        reason: `ui fork ${shortId(checkpoint.checkpointId)}`,
        ...(transitions === undefined ? {} : { maxTransitions: transitions }),
        timeoutMs: parsePositiveInteger(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS) * 1000
      })
    }
  );
  if (
    !forked.id ||
    forked.hasArtifact !== true ||
    forked.summary?.kind !== "fork" ||
    forked.summary.checkpointId !== checkpoint.checkpointId
  ) {
    throw new Error("checkpoint fork response identity mismatch");
  }
  await refreshMatches();
  setCandidateId(forked.id);
  const comparisonLoaded = await loadComparisonPair({
    baselineId: parentMatchId,
    candidateId: forked.id,
    view: "postgame-redacted",
    statusPrefix: "checkpoint fork 对比已加载"
  });
  if (!comparisonLoaded) throw new Error("fork child artifact or parent/child comparison failed validation");
  setBusy(forkBusyId);
  const [lineageResponse, branchResponse] = await Promise.all([
    apiJson<ForkLineageResponse>(`/api/matches/${encodeURIComponent(forked.id)}/fork-lineage`),
    apiJson<BranchTreeResponse>(`/api/checkpoints/${encodeURIComponent(checkpoint.checkpointId)}/branch-tree`)
  ]);
  setForkLineage(lineageResponse.summary);
  setBranchTree(branchResponse.summary);
  setSelectedCheckpointId(checkpoint.checkpointId);
  setWorkspace("compare");
  const childFailed = forked.harnessStatus === "failed";
  const childCompleted = forked.harnessStatus === "completed" && forked.summary.ok !== false;
  setActionStatus(
    childFailed
      ? `checkpoint fork 已记录失败 child：parent=${shortId(parentMatchId)} · child=${shortId(forked.id)} · comparison 已打开`
      : childCompleted
        ? `checkpoint fork 已完成：parent=${shortId(parentMatchId)} · child=${shortId(forked.id)} · boundary=native #${checkpoint.source.nativeStepCount} · comparison 已打开`
        : `checkpoint fork 已记录 ${forked.harnessStatus ?? "incomplete"} child：parent=${shortId(parentMatchId)} · child=${shortId(forked.id)} · boundary=native #${checkpoint.source.nativeStepCount} · comparison 已打开`,
    childFailed ? forked.summary.failureReason ?? "fork child harness reported failure" : null
  );
}
