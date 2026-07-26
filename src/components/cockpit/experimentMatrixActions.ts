import type { Dispatch, SetStateAction } from "react";

import type { CockpitExperimentRequest } from "./experimentDraft";
// Imports stay fine-grained (no barrels): this async chunk must not pull the
// icon/nav/lazy-board modules into its graph.
import { apiJson } from "./apiClient";
import { parseOptionalPositiveInteger, parsePositiveInteger } from "./formatters";
import { DEFAULT_TIMEOUT_SECONDS } from "./cockpitDefaults";
import type {
  ExperimentMatrixArtifactSetSummary,
  ExperimentMatrixRunResponse
} from "./cockpitTypes";

/**
 * Heavy experiment-matrix run workflow, loaded on demand from
 * `useExperimentMatrix`. Runs strictly after the hook-side synchronous
 * preflight and inside the hook's existing try/catch/finally, so status
 * messages, state-update ordering and error surfaces are unchanged.
 * This module must only ever be imported dynamically (bundle budget).
 */
export async function runMatrixExperiment({
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
}: {
  experimentRequest: CockpitExperimentRequest;
  jointPhaseScheduler: "aec-batched-decision" | "parallel";
  matrixExportArtifacts: boolean;
  matrixExportCapability: boolean | undefined;
  matrixGames: string;
  maxTransitions: string;
  timeoutSeconds: string;
  setMatrixResult: Dispatch<SetStateAction<ExperimentMatrixRunResponse | null>>;
  setMatrixArtifactSets: Dispatch<SetStateAction<ExperimentMatrixArtifactSetSummary[]>>;
  setActionStatus: (message: string, nextError?: string | null) => void;
}): Promise<void> {
  const games = Math.min(10, Math.max(1, parsePositiveInteger(matrixGames, 1)));
  const transitions = parseOptionalPositiveInteger(maxTransitions);
  const timeoutMs = parsePositiveInteger(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS) * 1000;
  const matrixId = `ui-matrix-${Date.now()}`;
  const exportArtifacts = matrixExportArtifacts && matrixExportCapability === true;
  const response = await apiJson<ExperimentMatrixRunResponse>("/api/experiments/matrix/run", {
    method: "POST",
    body: JSON.stringify({
      version: "harness.experiment-matrix.v1",
      kind: "matrix",
      id: matrixId,
      continueOnError: true,
      base: {
        ...experimentRequest,
        games,
        seed: matrixId,
        ...(transitions === undefined ? {} : { maxTransitions: transitions }),
        timeout: timeoutMs,
        jointPhaseScheduler,
        continueOnError: true
      },
      cells: [
        {
          id: `${matrixId}-roster`,
          label: `${experimentRequest.models.length} models / ${experimentRequest.profiles.length} profiles`,
          group: `cockpit-${experimentRequest.assignment.strategy ?? "profile-rotation"}-roster`
        }
      ],
      exportArtifacts
    })
  });
  setMatrixResult(response);
  const artifactSet = response.artifacts ?? response.summary?.artifacts ?? null;
  if (artifactSet) {
    setMatrixArtifactSets((current) => [artifactSet, ...current.filter((item) => item.artifactSetId !== artifactSet.artifactSetId)]);
  }
  const summary = response.summary;
  setActionStatus(
    `实验矩阵完成：${summary?.matrixId ?? matrixId} · completed=${summary?.gamesCompleted ?? 0} · truncated=${summary?.gamesTruncated ?? 0} · failed=${summary?.gamesFailed ?? 0}`,
    summary?.failureReason ?? response.error ?? null
  );
}
