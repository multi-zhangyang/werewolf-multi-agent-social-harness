import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

import type { CockpitExperimentRequest } from "../experimentDraft";
import { apiJson, errorMessage } from "../appInspectors";
import type {
  ExperimentMatrixArtifactSetSummary,
  ExperimentMatrixRunResponse
} from "../appShared";
import type { SetActionStatus } from "./useCockpitStatus";

/**
 * Owns the experiment-matrix control plane state: the latest matrix run
 * response, research artifact sets and the run form inputs.
 */
export function useExperimentMatrix({
  experimentRequest,
  experimentDraftError,
  jointPhaseScheduler,
  maxTransitions,
  timeoutSeconds,
  matrixExportCapability,
  setActionStatus,
  setBusy
}: {
  experimentRequest: CockpitExperimentRequest;
  experimentDraftError: string | undefined;
  jointPhaseScheduler: "aec-batched-decision" | "parallel";
  maxTransitions: string;
  timeoutSeconds: string;
  matrixExportCapability: boolean | undefined;
  setActionStatus: SetActionStatus;
  setBusy: Dispatch<SetStateAction<string | null>>;
}) {
  const [matrixResult, setMatrixResult] = useState<ExperimentMatrixRunResponse | null>(null);
  const [matrixArtifactSets, setMatrixArtifactSets] = useState<ExperimentMatrixArtifactSetSummary[]>([]);
  const [matrixGames, setMatrixGames] = useState("2");
  const [matrixExportArtifacts, setMatrixExportArtifacts] = useState(false);

  const handleRefreshMatrixArtifacts = useCallback(async () => {
    setBusy("matrix-artifacts");
    try {
      const response = await apiJson<{ artifactSets: ExperimentMatrixArtifactSetSummary[] }>("/api/experiments/matrix/artifacts");
      const sets = response.artifactSets ?? [];
      setMatrixArtifactSets(sets);
      setActionStatus(`实验矩阵研究工件已刷新：${sets.length} 套`);
    } catch (nextError) {
      setActionStatus("实验矩阵研究工件刷新失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [setActionStatus]);

  const handleRunMatrixExperiment = useCallback(async () => {
    if (experimentDraftError) {
      setActionStatus("无法运行实验矩阵：实验编排草案无效", experimentDraftError);
      return;
    }
    setBusy("matrix-run");
    setActionStatus("正在通过 harness control plane 运行实验矩阵...");
    try {
      // The heavy matrix run workflow is code-split; it runs entirely inside
      // this try so any load or run failure reports through the same path.
      const { runMatrixExperiment } = await import("../experimentMatrixActions");
      await runMatrixExperiment({
        experimentRequest,
        jointPhaseScheduler,
        matrixExportArtifacts,
        matrixExportCapability,
        matrixGames,
        maxTransitions,
        timeoutSeconds,
        setMatrixResult,
        setMatrixArtifactSets,
        setActionStatus
      });
    } catch (nextError) {
      setActionStatus("实验矩阵运行失败", errorMessage(nextError));
    } finally {
      setBusy(null);
    }
  }, [
    matrixExportCapability,
    experimentDraftError,
    experimentRequest,
    jointPhaseScheduler,
    matrixExportArtifacts,
    matrixGames,
    maxTransitions,
    setActionStatus,
    timeoutSeconds
  ]);

  return {
    matrixResult,
    matrixArtifactSets,
    matrixGames,
    setMatrixGames,
    matrixExportArtifacts,
    setMatrixExportArtifacts,
    handleRefreshMatrixArtifacts,
    handleRunMatrixExperiment
  };
}
