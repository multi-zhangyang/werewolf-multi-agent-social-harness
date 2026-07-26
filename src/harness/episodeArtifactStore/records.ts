import { assertJsonData, isNonemptyString, isRecord, jsonClone, jsonDocument, parseJsonLines, sha256 } from "./support";
import { hashStableJsonValue } from "../hash";
import { HarnessEvaluationReport, HarnessEvaluatorFailure, HarnessMetricRecord } from "../types";
import { CHECKPOINT_FILE, GenericCheckpointEnvelope, GenericEpisodeEnvelope, HARNESS_EPISODE_CHECKPOINT_INDEX_VERSION, HARNESS_EPISODE_CHECKPOINT_MANIFEST_VERSION, HARNESS_EPISODE_EVALUATION_RECORD_VERSION, HARNESS_EPISODE_FAILURE_ROW_VERSION, HARNESS_EPISODE_METRIC_ROW_VERSION, HARNESS_EPISODE_TRAJECTORY_HEADER_VERSION, HARNESS_EPISODE_TRAJECTORY_MESSAGE_VERSION, HARNESS_EPISODE_TRAJECTORY_STEP_VERSION, HarnessEpisodeCheckpointStoreEntry, HarnessEpisodeCheckpointStoreIndex, HarnessEpisodeCheckpointStoreManifest, HarnessEpisodeEvaluationRecordV1, HarnessEpisodeFailureRow, HarnessEpisodeMetricRow, MANIFEST_FILE } from "./model";
export function checkpointManifestFor(
  checkpoint: GenericCheckpointEnvelope,
  directoryKey: string,
  checkpointText: string
): HarnessEpisodeCheckpointStoreManifest {
  return {
    schemaVersion: HARNESS_EPISODE_CHECKPOINT_MANIFEST_VERSION,
    manifestKind: "episode-checkpoint-manifest",
    ...checkpointEntryFor(checkpoint, directoryKey),
    checkpointSha256: sha256(checkpointText),
    files: {
      checkpoint: CHECKPOINT_FILE,
      manifest: MANIFEST_FILE
    }
  };
}

function checkpointEntryFor(
  checkpoint: GenericCheckpointEnvelope,
  directoryKey: string
): HarnessEpisodeCheckpointStoreEntry {
  return {
    checkpointId: checkpoint.checkpointId,
    runId: checkpoint.source.runId,
    artifactVersion: checkpoint.artifactVersion,
    kind: checkpoint.kind,
    createdAt: checkpoint.createdAt,
    directoryKey,
    sourceArtifactVersion: checkpoint.source.sourceArtifactVersion,
    nativeStepCount: checkpoint.source.nativeStepCount,
    messageCount: checkpoint.source.messageCount
  };
}

export function checkpointEntryFromManifest(
  manifest: HarnessEpisodeCheckpointStoreManifest
): HarnessEpisodeCheckpointStoreEntry {
  return {
    checkpointId: manifest.checkpointId,
    runId: manifest.runId,
    artifactVersion: manifest.artifactVersion,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    directoryKey: manifest.directoryKey,
    sourceArtifactVersion: manifest.sourceArtifactVersion,
    nativeStepCount: manifest.nativeStepCount,
    messageCount: manifest.messageCount
  };
}

export function isValidCheckpointManifest(
  value: unknown,
  directoryKey: string,
  checkpoint: GenericCheckpointEnvelope
): value is HarnessEpisodeCheckpointStoreManifest {
  if (!isRecord(value)) return false;
  const expected = checkpointEntryFor(checkpoint, directoryKey);
  return (
    value.schemaVersion === HARNESS_EPISODE_CHECKPOINT_MANIFEST_VERSION &&
    value.manifestKind === "episode-checkpoint-manifest" &&
    value.checkpointId === expected.checkpointId &&
    value.runId === expected.runId &&
    value.artifactVersion === expected.artifactVersion &&
    value.kind === expected.kind &&
    value.createdAt === expected.createdAt &&
    value.directoryKey === expected.directoryKey &&
    value.sourceArtifactVersion === expected.sourceArtifactVersion &&
    value.nativeStepCount === expected.nativeStepCount &&
    value.messageCount === expected.messageCount &&
    typeof value.checkpointSha256 === "string" &&
    isRecord(value.files) &&
    value.files.checkpoint === CHECKPOINT_FILE &&
    value.files.manifest === MANIFEST_FILE
  );
}

export function emptyCheckpointIndex(runId: string, updatedAt: string): HarnessEpisodeCheckpointStoreIndex {
  return {
    schemaVersion: HARNESS_EPISODE_CHECKPOINT_INDEX_VERSION,
    kind: "episode-checkpoint-index",
    runId,
    updatedAt,
    entries: []
  };
}

export function evaluationRecordJson(
  artifact: GenericEpisodeEnvelope,
  artifactText: string,
  report?: HarnessEvaluationReport
): string {
  if (!report) return jsonDocument(null);
  assertEvaluationReport(report);
  const record: HarnessEpisodeEvaluationRecordV1 = {
    schemaVersion: HARNESS_EPISODE_EVALUATION_RECORD_VERSION,
    kind: "episode-evaluation",
    runId: artifact.runId,
    artifactSha256: sha256(artifactText),
    evaluatorSetHash: hashStableJsonValue(report.evaluatorRegistry ?? report.evaluatorIds),
    report: jsonClone(report, "Episode evaluation report could not be cloned.")
  };
  return jsonDocument(record);
}

export function parseEvaluationRecord(
  text: string,
  artifact: GenericEpisodeEnvelope,
  artifactText: string,
  expectedReportId?: string
): HarnessEvaluationReport | undefined {
  const value = JSON.parse(text) as unknown;
  if (value === null) {
    if (expectedReportId !== undefined) throw new Error("Stored evaluation report identity is missing.");
    return undefined;
  }
  if (!isRecord(value)) throw new Error("Stored episode evaluation record is invalid.");
  const unknownFields = Object.keys(value).filter(
    (key) => !["schemaVersion", "kind", "runId", "artifactSha256", "evaluatorSetHash", "report"].includes(key)
  );
  if (
    unknownFields.length > 0 ||
    value.schemaVersion !== HARNESS_EPISODE_EVALUATION_RECORD_VERSION ||
    value.kind !== "episode-evaluation" ||
    value.runId !== artifact.runId ||
    value.artifactSha256 !== sha256(artifactText) ||
    typeof value.evaluatorSetHash !== "string" ||
    !isRecord(value.report)
  ) {
    throw new Error("Stored episode evaluation record binding is invalid.");
  }
  const report = value.report as unknown as HarnessEvaluationReport;
  assertEvaluationReport(report);
  if (!expectedReportId || report.id !== expectedReportId) {
    throw new Error("Stored episode evaluation report id does not match its manifest.");
  }
  if (value.evaluatorSetHash !== hashStableJsonValue(report.evaluatorRegistry ?? report.evaluatorIds)) {
    throw new Error("Stored episode evaluator set hash does not match its report.");
  }
  return jsonClone(report, "Stored episode evaluation report could not be cloned.");
}

export function metricRowsForArtifact(
  artifact: GenericEpisodeEnvelope,
  evaluationReport?: HarnessEvaluationReport
): HarnessEpisodeMetricRow[] {
  if (!evaluationReport) return [];
  assertEvaluationReport(evaluationReport);
  return evaluationReport.metrics.map((metric) => ({
    ...jsonClone(metric, "Episode metric is not JSON serializable."),
    schemaVersion: HARNESS_EPISODE_METRIC_ROW_VERSION,
    kind: "episode-metric",
    runId: artifact.runId,
    evaluationReportId: evaluationReport.id
  }));
}

export function failureRowsForArtifact(
  artifact: GenericEpisodeEnvelope,
  evaluationReport?: HarnessEvaluationReport
): HarnessEpisodeFailureRow[] {
  const rows: HarnessEpisodeFailureRow[] = [];
  if (artifact.status === "failed") {
    rows.push({
      schemaVersion: HARNESS_EPISODE_FAILURE_ROW_VERSION,
      kind: "episode-failure",
      runId: artifact.runId,
      source: "episode_lifecycle",
      stage: "execution",
      code: "episode_failed",
      message: reviewedFailureMessage("episode_failed")
    });
  }
  for (const failure of evaluationReport?.failures ?? []) {
    assertEvaluatorFailure(failure);
    rows.push({
      schemaVersion: HARNESS_EPISODE_FAILURE_ROW_VERSION,
      kind: "episode-failure",
      runId: artifact.runId,
      source: "evaluator",
      stage: failure.stage,
      code: failure.code,
      message: reviewedFailureMessage(failure.code),
      evaluatorId: failure.evaluatorId,
      evaluatorVersion: failure.version
    });
  }
  return rows;
}

export function parseMetricRows(
  text: string,
  runId: string,
  evaluationReportId?: string
): HarnessEpisodeMetricRow[] {
  const values = parseJsonLines(text);
  const rows: HarnessEpisodeMetricRow[] = [];
  for (const value of values) {
    if (!isRecord(value)) throw new Error("Stored episode metric row is invalid.");
    if (
      value.schemaVersion !== HARNESS_EPISODE_METRIC_ROW_VERSION ||
      value.kind !== "episode-metric" ||
      value.runId !== runId ||
      !isNonemptyString(value.evaluationReportId) ||
      (evaluationReportId !== undefined && value.evaluationReportId !== evaluationReportId)
    ) {
      throw new Error("Stored episode metric row identity is invalid.");
    }
    const {
      schemaVersion: _schemaVersion,
      kind: _kind,
      runId: _runId,
      evaluationReportId: _evaluationReportId,
      ...metric
    } = value;
    assertMetricRecord(metric);
    rows.push(value as unknown as HarnessEpisodeMetricRow);
  }
  if (rows.length > 0 && !evaluationReportId) {
    throw new Error("Stored episode metrics require an evaluation report identity.");
  }
  return rows;
}

export function metricFromRow(row: HarnessEpisodeMetricRow): HarnessMetricRecord {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    runId: _runId,
    evaluationReportId: _evaluationReportId,
    ...metric
  } = row;
  return jsonClone(metric, "Stored episode metric could not be cloned.");
}

export function parseFailureRows(text: string, runId: string): HarnessEpisodeFailureRow[] {
  const values = parseJsonLines(text);
  const rows: HarnessEpisodeFailureRow[] = [];
  for (const value of values) {
    if (!isRecord(value)) throw new Error("Stored episode failure row is invalid.");
    if (
      value.schemaVersion !== HARNESS_EPISODE_FAILURE_ROW_VERSION ||
      value.kind !== "episode-failure" ||
      value.runId !== runId ||
      (value.source !== "episode_lifecycle" && value.source !== "evaluator") ||
      !isNonemptyString(value.message)
    ) {
      throw new Error("Stored episode failure row identity is invalid.");
    }
    if (value.source === "episode_lifecycle") {
      const unknownFields = Object.keys(value).filter(
        (key) => !["schemaVersion", "kind", "runId", "source", "stage", "code", "message"].includes(key)
      );
      if (
        unknownFields.length > 0 ||
        value.stage !== "execution" ||
        value.code !== "episode_failed" ||
        value.message !== reviewedFailureMessage("episode_failed") ||
        value.evaluatorId !== undefined ||
        value.evaluatorVersion !== undefined
      ) {
        throw new Error("Stored episode lifecycle failure row is invalid.");
      }
    } else {
      const unknownFields = Object.keys(value).filter(
        (key) => ![
          "schemaVersion",
          "kind",
          "runId",
          "source",
          "stage",
          "code",
          "message",
          "evaluatorId",
          "evaluatorVersion"
        ].includes(key)
      );
      if (unknownFields.length > 0) throw new Error("Stored evaluator failure row contains unknown fields.");
      assertEvaluatorFailure({
        evaluatorId: value.evaluatorId,
        label: "stored evaluator",
        version: value.evaluatorVersion,
        stage: value.stage,
        code: value.code,
        message: value.message
      });
      if (value.message !== reviewedFailureMessage(value.code as HarnessEvaluatorFailure["code"])) {
        throw new Error("Stored evaluator failure row message is invalid.");
      }
    }
    rows.push(value as unknown as HarnessEpisodeFailureRow);
  }
  return rows;
}

export function assertEvaluationReport(report: HarnessEvaluationReport): void {
  assertJsonData(report, "Episode evaluation report contains unsupported non-JSON data.");
  if (!isRecord(report) || !isNonemptyString(report.id) || !isNonemptyString(report.createdAt)) {
    throw new Error("Episode evaluation report identity is invalid.");
  }
  if (!Number.isFinite(Date.parse(report.createdAt))) throw new Error("Episode evaluation report createdAt is invalid.");
  if (
    !Array.isArray(report.metrics) ||
    !Array.isArray(report.failures ?? []) ||
    !Array.isArray(report.evaluatorIds) ||
    !isRecord(report.outputs) ||
    !isRecord(report.summary)
  ) {
    throw new Error("Episode evaluation report records are invalid.");
  }
  if (report.status !== undefined && report.status !== "completed" && report.status !== "incomplete") {
    throw new Error("Episode evaluation report status is invalid.");
  }
  const evaluatorIds = new Set<string>();
  for (const evaluatorId of report.evaluatorIds) {
    if (!isNonemptyString(evaluatorId) || evaluatorIds.has(evaluatorId)) {
      throw new Error("Episode evaluation report evaluatorIds are invalid.");
    }
    evaluatorIds.add(evaluatorId);
  }
  const registry = report.evaluatorRegistry ?? [];
  if (!Array.isArray(registry)) throw new Error("Episode evaluation report evaluatorRegistry is invalid.");
  const registryIds = new Map<string, string>();
  for (const evaluator of registry) {
    if (!isRecord(evaluator) || !isNonemptyString(evaluator.id) || !isNonemptyString(evaluator.version)) {
      throw new Error("Episode evaluation report evaluator registry identity is invalid.");
    }
    if (registryIds.has(evaluator.id)) throw new Error("Episode evaluation report evaluator registry contains duplicate ids.");
    registryIds.set(evaluator.id, evaluator.version);
  }
  for (const evaluatorId of evaluatorIds) {
    if (registry.length > 0 && !registryIds.has(evaluatorId)) throw new Error("Episode evaluation report evaluator coverage is incomplete.");
    if (!Object.prototype.hasOwnProperty.call(report.outputs, evaluatorId)) {
      throw new Error("Episode evaluation report output coverage is incomplete.");
    }
  }
  if (!Number.isInteger(report.metricCount) || report.metricCount !== report.metrics.length) {
    throw new Error("Episode evaluation report metricCount does not match metrics.");
  }
  for (const metric of report.metrics) {
    assertMetricRecord(metric);
    if (metric.evaluatorId && registry.length > 0 && registryIds.get(metric.evaluatorId) !== metric.evaluatorVersion) {
      throw new Error("Episode evaluation metric evaluator identity is not registered.");
    }
  }
  for (const failure of report.failures ?? []) {
    assertEvaluatorFailure(failure);
    if (!isNonemptyString(failure.label) || failure.message !== reviewedFailureMessage(failure.code)) {
      throw new Error("Episode evaluation report contains an unreviewed evaluator failure.");
    }
    if (registry.length > 0 && registryIds.get(failure.evaluatorId) !== failure.version) {
      throw new Error("Episode evaluation failure evaluator identity is not registered.");
    }
  }
  if (report.warnings !== undefined && !Array.isArray(report.warnings)) {
    throw new Error("Episode evaluation report warnings are invalid.");
  }
  if (report.status === "completed" && (report.failures?.length ?? 0) > 0) {
    throw new Error("Completed episode evaluation report cannot contain failures.");
  }
  if (report.status === "incomplete" && (report.failures?.length ?? 0) === 0) {
    throw new Error("Incomplete episode evaluation report requires a controlled failure record.");
  }
}

function assertMetricRecord(value: unknown): asserts value is HarnessMetricRecord {
  if (!isRecord(value)) throw new Error("Episode metric must be a record.");
  if (!isNonemptyString(value.id) || !isNonemptyString(value.label) || !isNonemptyString(value.source)) {
    throw new Error("Episode metric identity is invalid.");
  }
  if (!["episode", "team", "agent", "profile", "model", "role", "seat"].includes(String(value.scope))) {
    throw new Error("Episode metric scope is invalid.");
  }
  const metricValue = value.value;
  if (
    metricValue !== null &&
    typeof metricValue !== "string" &&
    typeof metricValue !== "boolean" &&
    !(typeof metricValue === "number" && Number.isFinite(metricValue))
  ) {
    throw new Error("Episode metric value is invalid.");
  }
  if (value.evidenceRefs !== undefined && !Array.isArray(value.evidenceRefs)) {
    throw new Error("Episode metric evidenceRefs must be an array when present.");
  }
  assertJsonData(value, "Episode metric contains unsupported non-JSON data.");
}

function assertEvaluatorFailure(value: unknown): asserts value is HarnessEvaluatorFailure {
  if (!isRecord(value)) throw new Error("Evaluator failure must be a record.");
  if (!isNonemptyString(value.evaluatorId) || !isNonemptyString(value.version)) {
    throw new Error("Evaluator failure identity is invalid.");
  }
  const validPair =
    (value.stage === "evaluate" && value.code === "evaluator_exception") ||
    (value.stage === "result_normalization" && value.code === "invalid_module_result");
  if (!validPair) throw new Error("Evaluator failure stage/code pair is invalid.");
}

function reviewedFailureMessage(
  code: "episode_failed" | HarnessEvaluatorFailure["code"]
): string {
  if (code === "episode_failed") return "Harness episode ended with a failed lifecycle; inspect canonical trajectory evidence.";
  if (code === "evaluator_exception") return "Evaluator execution failed; no metrics or output were recorded.";
  return "Evaluator returned an invalid module result; no metrics or output were recorded.";
}

export function trajectoryJsonl(artifact: GenericEpisodeEnvelope): string {
  const rows: unknown[] = [
    {
      schemaVersion: HARNESS_EPISODE_TRAJECTORY_HEADER_VERSION,
      kind: "episode-trajectory-header",
      runId: artifact.runId,
      artifactVersion: artifact.artifactVersion,
      status: artifact.status,
      domainId: artifact.socialEpisode.domainId,
      schedulerMode: artifact.socialEpisode.schedulerMode,
      nativeStepCount: artifact.socialEpisode.steps.length,
      messageCount: artifact.socialEpisode.messages.length
    },
    ...artifact.socialEpisode.steps.map((step, index) => ({
      schemaVersion: HARNESS_EPISODE_TRAJECTORY_STEP_VERSION,
      kind: "episode-trajectory-step",
      runId: artifact.runId,
      index,
      step
    })),
    ...artifact.socialEpisode.messages.map((message, index) => ({
      schemaVersion: HARNESS_EPISODE_TRAJECTORY_MESSAGE_VERSION,
      kind: "episode-trajectory-message",
      runId: artifact.runId,
      index,
      message
    }))
  ];
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}
