import { parseFailureRows, parseMetricRows } from "./records";
import { directoryKeyForRunId, isNonemptyString, isNonnegativeInteger, isRecord, isSha256, readSafeFile, sha256 } from "./support";
import { HarnessEpisodeProjectionEnvelope, validateHarnessEpisodeProjectionEnvelope } from "../episodeArtifacts";
import { ARTIFACT_FILE, CHECKPOINTS_DIRECTORY, CHECKPOINT_INDEX_FILE, EVALUATION_FILE, FAILURES_FILE, GenericEpisodeEnvelope, HARNESS_EPISODE_STORE_INDEX_VERSION, HARNESS_EPISODE_STORE_MANIFEST_VERSION, HarnessEpisodeStoreEntry, HarnessEpisodeStoreManifest, INVALID_PROJECTION, LEGACY_EPISODE_STORE_MANIFEST_V1_VERSION, LEGACY_EPISODE_STORE_MANIFEST_V2_VERSION, LEGACY_EPISODE_STORE_MANIFEST_V3_VERSION, MANIFEST_FILE, METRICS_FILE, PROJECTION_FILE, TRAJECTORY_FILE } from "./model";
export function manifestForArtifact(
  artifact: GenericEpisodeEnvelope,
  directoryKey: string,
  artifactText: string,
  trajectoryText: string,
  metricsText: string,
  failuresText: string,
  evaluationText: string,
  projection: HarnessEpisodeProjectionEnvelope | undefined,
  projectionText: string | undefined,
  evaluationReportId?: string
): HarnessEpisodeStoreManifest {
  const metrics = parseMetricRows(metricsText, artifact.runId, evaluationReportId);
  const failures = parseFailureRows(failuresText, artifact.runId);
  return {
    schemaVersion: HARNESS_EPISODE_STORE_MANIFEST_VERSION,
    manifestKind: "episode-store-manifest",
    ...entryForArtifact(artifact, directoryKey, metrics.length, failures.length),
    artifactSha256: sha256(artifactText),
    trajectorySha256: sha256(trajectoryText),
    metricsSha256: sha256(metricsText),
    failuresSha256: sha256(failuresText),
    evaluationSha256: sha256(evaluationText),
    evaluationReportId,
    ...(projection && projectionText ? {
      projectionSha256: sha256(projectionText),
      projectionVisibility: projection.source.visibility,
      projectionPolicyId: projection.source.policyId,
      projectionPolicyVersion: projection.source.policyVersion
    } : {}),
    files: {
      artifact: ARTIFACT_FILE,
      trajectory: TRAJECTORY_FILE,
      metrics: METRICS_FILE,
      failures: FAILURES_FILE,
      evaluation: EVALUATION_FILE,
      ...(projection ? { projection: PROJECTION_FILE } : {}),
      manifest: MANIFEST_FILE,
      checkpointIndex: CHECKPOINT_INDEX_FILE,
      checkpoints: CHECKPOINTS_DIRECTORY
    }
  };
}

export function entryForArtifact(
  artifact: GenericEpisodeEnvelope,
  directoryKey: string,
  metricCount = 0,
  failureCount = 0,
  checkpointCount = 0
): HarnessEpisodeStoreEntry {
  return {
    runId: artifact.runId,
    artifactVersion: artifact.artifactVersion,
    kind: artifact.kind,
    createdAt: artifact.createdAt,
    status: artifact.status,
    directoryKey,
    nativeStepCount: artifact.socialEpisode.steps.length,
    messageCount: artifact.socialEpisode.messages.length,
    metricCount,
    failureCount,
    checkpointCount
  };
}

export function entryFromManifest(manifest: HarnessEpisodeStoreManifest): HarnessEpisodeStoreEntry {
  return {
    runId: manifest.runId,
    artifactVersion: manifest.artifactVersion,
    kind: manifest.kind,
    createdAt: manifest.createdAt,
    status: manifest.status,
    directoryKey: manifest.directoryKey,
    nativeStepCount: manifest.nativeStepCount,
    messageCount: manifest.messageCount,
    metricCount: manifest.metricCount,
    failureCount: manifest.failureCount,
    checkpointCount: 0,
    ...(manifest.evaluationReportId ? { evaluationReportId: manifest.evaluationReportId } : {})
  };
}

export function projectionEntryFromManifest(value: unknown, directoryKey: string): HarnessEpisodeStoreEntry | undefined {
  if (!isRecord(value)) return undefined;
  const legacyV1 = value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V1_VERSION;
  const legacyV2 = value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V2_VERSION;
  const legacyV3 = value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V3_VERSION;
  const current = value.schemaVersion === HARNESS_EPISODE_STORE_MANIFEST_VERSION;
  if (
    (!legacyV1 && !legacyV2 && !legacyV3 && !current) ||
    value.manifestKind !== "episode-store-manifest" ||
    !isNonemptyString(value.runId) ||
    directoryKeyForRunId(value.runId) !== directoryKey ||
    value.directoryKey !== directoryKey ||
    !isNonemptyString(value.artifactVersion) ||
    !isNonemptyString(value.kind) ||
    !isNonemptyString(value.createdAt) ||
    (value.status !== "completed" && value.status !== "truncated" && value.status !== "failed") ||
    !isNonnegativeInteger(value.nativeStepCount) ||
    !isNonnegativeInteger(value.messageCount)
  ) return undefined;
  const metricCount = legacyV1 ? 0 : value.metricCount;
  const failureCount = legacyV1 ? 0 : value.failureCount;
  if (!isNonnegativeInteger(metricCount) || !isNonnegativeInteger(failureCount)) return undefined;
  if (value.evaluationReportId !== undefined && !isNonemptyString(value.evaluationReportId)) return undefined;
  return {
    runId: value.runId,
    artifactVersion: value.artifactVersion,
    kind: value.kind,
    createdAt: value.createdAt,
    status: value.status,
    directoryKey,
    nativeStepCount: value.nativeStepCount,
    messageCount: value.messageCount,
    metricCount,
    failureCount,
    checkpointCount: 0,
    ...(isNonemptyString(value.evaluationReportId) ? { evaluationReportId: value.evaluationReportId } : {})
  };
}

export function parseEpisodeStoreIndexEntries(value: unknown): Map<string, HarnessEpisodeStoreEntry> | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== HARNESS_EPISODE_STORE_INDEX_VERSION ||
    value.kind !== "episode-store-index" ||
    !isNonemptyString(value.updatedAt) ||
    !Array.isArray(value.entries)
  ) return undefined;
  const recovered = new Map<string, HarnessEpisodeStoreEntry>();
  for (const candidate of value.entries) {
    if (
      !isRecord(candidate) ||
      !isNonemptyString(candidate.runId) ||
      !isNonemptyString(candidate.artifactVersion) ||
      !isNonemptyString(candidate.kind) ||
      !isNonemptyString(candidate.createdAt) ||
      (candidate.status !== "completed" && candidate.status !== "truncated" && candidate.status !== "failed") ||
      !isNonemptyString(candidate.directoryKey) ||
      directoryKeyForRunId(candidate.runId) !== candidate.directoryKey ||
      !isNonnegativeInteger(candidate.nativeStepCount) ||
      !isNonnegativeInteger(candidate.messageCount) ||
      !isNonnegativeInteger(candidate.metricCount) ||
      !isNonnegativeInteger(candidate.failureCount) ||
      !isNonnegativeInteger(candidate.checkpointCount) ||
      (candidate.evaluationReportId !== undefined && !isNonemptyString(candidate.evaluationReportId)) ||
      recovered.has(candidate.runId)
    ) return undefined;
    recovered.set(candidate.runId, {
      runId: candidate.runId,
      artifactVersion: candidate.artifactVersion,
      kind: candidate.kind,
      createdAt: candidate.createdAt,
      status: candidate.status,
      directoryKey: candidate.directoryKey,
      nativeStepCount: candidate.nativeStepCount,
      messageCount: candidate.messageCount,
      metricCount: candidate.metricCount,
      failureCount: candidate.failureCount,
      checkpointCount: candidate.checkpointCount,
      ...(isNonemptyString(candidate.evaluationReportId) ? { evaluationReportId: candidate.evaluationReportId } : {})
    });
  }
  return recovered;
}

export function isValidManifest(
  value: unknown,
  directoryKey: string,
  artifact: GenericEpisodeEnvelope
): value is HarnessEpisodeStoreManifest {
  if (!isRecord(value)) return false;
  const expected = entryForArtifact(
    artifact,
    directoryKey,
    typeof value.metricCount === "number" ? value.metricCount : 0,
    typeof value.failureCount === "number" ? value.failureCount : 0
  );
  return (
    value.schemaVersion === HARNESS_EPISODE_STORE_MANIFEST_VERSION &&
    value.manifestKind === "episode-store-manifest" &&
    value.runId === expected.runId &&
    value.artifactVersion === expected.artifactVersion &&
    value.kind === expected.kind &&
    value.createdAt === expected.createdAt &&
    value.status === expected.status &&
    value.directoryKey === expected.directoryKey &&
    value.nativeStepCount === expected.nativeStepCount &&
    value.messageCount === expected.messageCount &&
    typeof value.metricCount === "number" &&
    Number.isInteger(value.metricCount) &&
    value.metricCount >= 0 &&
    typeof value.failureCount === "number" &&
    Number.isInteger(value.failureCount) &&
    value.failureCount >= 0 &&
    typeof value.artifactSha256 === "string" &&
    typeof value.trajectorySha256 === "string" &&
    typeof value.metricsSha256 === "string" &&
    typeof value.failuresSha256 === "string" &&
    typeof value.evaluationSha256 === "string" &&
    (value.evaluationReportId === undefined || isNonemptyString(value.evaluationReportId)) &&
    isRecord(value.files) &&
    value.files.artifact === ARTIFACT_FILE &&
    value.files.trajectory === TRAJECTORY_FILE &&
    value.files.metrics === METRICS_FILE &&
    value.files.failures === FAILURES_FILE &&
    value.files.evaluation === EVALUATION_FILE &&
    isValidProjectionManifestBinding(value) &&
    value.files.manifest === MANIFEST_FILE &&
    value.files.checkpointIndex === CHECKPOINT_INDEX_FILE &&
    value.files.checkpoints === CHECKPOINTS_DIRECTORY
  );
}

export function isValidLegacyV3Manifest(
  value: unknown,
  directoryKey: string,
  artifact: GenericEpisodeEnvelope
): value is HarnessEpisodeStoreManifest {
  if (!isRecord(value)) return false;
  const expected = entryForArtifact(
    artifact,
    directoryKey,
    typeof value.metricCount === "number" ? value.metricCount : 0,
    typeof value.failureCount === "number" ? value.failureCount : 0
  );
  return (
    value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V3_VERSION &&
    value.manifestKind === "episode-store-manifest" &&
    value.runId === expected.runId &&
    value.artifactVersion === expected.artifactVersion &&
    value.kind === expected.kind &&
    value.createdAt === expected.createdAt &&
    value.status === expected.status &&
    value.directoryKey === expected.directoryKey &&
    value.nativeStepCount === expected.nativeStepCount &&
    value.messageCount === expected.messageCount &&
    Number.isInteger(value.metricCount) && Number(value.metricCount) >= 0 &&
    Number.isInteger(value.failureCount) && Number(value.failureCount) >= 0 &&
    typeof value.artifactSha256 === "string" &&
    typeof value.trajectorySha256 === "string" &&
    typeof value.metricsSha256 === "string" &&
    typeof value.failuresSha256 === "string" &&
    typeof value.evaluationSha256 === "string" &&
    (value.evaluationReportId === undefined || isNonemptyString(value.evaluationReportId)) &&
    isRecord(value.files) &&
    value.files.artifact === ARTIFACT_FILE &&
    value.files.trajectory === TRAJECTORY_FILE &&
    value.files.metrics === METRICS_FILE &&
    value.files.failures === FAILURES_FILE &&
    value.files.evaluation === EVALUATION_FILE &&
    value.files.projection === undefined &&
    value.files.manifest === MANIFEST_FILE &&
    value.files.checkpointIndex === CHECKPOINT_INDEX_FILE &&
    value.files.checkpoints === CHECKPOINTS_DIRECTORY &&
    value.projectionSha256 === undefined &&
    value.projectionVisibility === undefined &&
    value.projectionPolicyId === undefined &&
    value.projectionPolicyVersion === undefined
  );
}

function isValidProjectionManifestBinding(value: Record<string, unknown>): boolean {
  if (!isRecord(value.files)) return false;
  const fields = [
    value.projectionSha256,
    value.projectionVisibility,
    value.projectionPolicyId,
    value.projectionPolicyVersion,
    value.files.projection
  ];
  const hasProjection = fields.some((field) => field !== undefined);
  if (!hasProjection) return true;
  return (
    isSha256(value.projectionSha256) &&
    (value.projectionVisibility === "postgame-redacted" || value.projectionVisibility === "public") &&
    isNonemptyString(value.projectionPolicyId) &&
    isNonemptyString(value.projectionPolicyVersion) &&
    value.files.projection === PROJECTION_FILE
  );
}

export async function readProjection(
  directory: string,
  manifest: HarnessEpisodeStoreManifest,
  artifact: GenericEpisodeEnvelope,
  artifactText: string
): Promise<HarnessEpisodeProjectionEnvelope | undefined | typeof INVALID_PROJECTION> {
  if (manifest.projectionSha256 === undefined) return undefined;
  try {
    const projectionText = await readSafeFile(directory, PROJECTION_FILE);
    if (sha256(projectionText) !== manifest.projectionSha256) return INVALID_PROJECTION;
    const projection = JSON.parse(projectionText) as unknown;
    if (validateHarnessEpisodeProjectionEnvelope(projection).length) return INVALID_PROJECTION;
    const envelope = projection as HarnessEpisodeProjectionEnvelope;
    if (
      envelope.source.runId !== artifact.runId ||
      envelope.source.artifactSha256 !== sha256(artifactText) ||
      envelope.source.visibility !== manifest.projectionVisibility ||
      envelope.source.policyId !== manifest.projectionPolicyId ||
      envelope.source.policyVersion !== manifest.projectionPolicyVersion
    ) return INVALID_PROJECTION;
    return envelope;
  } catch {
    return INVALID_PROJECTION;
  }
}

export function isValidLegacyV1Manifest(
  value: unknown,
  directoryKey: string,
  artifact: GenericEpisodeEnvelope
): value is Record<string, unknown> & {
  artifactSha256: string;
  trajectorySha256: string;
} {
  if (!isRecord(value)) return false;
  const expected = entryForArtifact(artifact, directoryKey);
  return (
    value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V1_VERSION &&
    value.manifestKind === "episode-store-manifest" &&
    value.runId === expected.runId &&
    value.artifactVersion === expected.artifactVersion &&
    value.kind === expected.kind &&
    value.createdAt === expected.createdAt &&
    value.status === expected.status &&
    value.directoryKey === expected.directoryKey &&
    value.nativeStepCount === expected.nativeStepCount &&
    value.messageCount === expected.messageCount &&
    typeof value.artifactSha256 === "string" &&
    typeof value.trajectorySha256 === "string" &&
    isRecord(value.files) &&
    value.files.artifact === ARTIFACT_FILE &&
    value.files.trajectory === TRAJECTORY_FILE &&
    value.files.manifest === MANIFEST_FILE
  );
}

export function isValidLegacyV2Manifest(
  value: unknown,
  directoryKey: string,
  artifact: GenericEpisodeEnvelope
): value is HarnessEpisodeStoreManifest {
  if (!isRecord(value)) return false;
  const expected = entryForArtifact(
    artifact,
    directoryKey,
    typeof value.metricCount === "number" ? value.metricCount : 0,
    typeof value.failureCount === "number" ? value.failureCount : 0
  );
  return (
    value.schemaVersion === LEGACY_EPISODE_STORE_MANIFEST_V2_VERSION &&
    value.manifestKind === "episode-store-manifest" &&
    value.runId === expected.runId &&
    value.artifactVersion === expected.artifactVersion &&
    value.kind === expected.kind &&
    value.createdAt === expected.createdAt &&
    value.status === expected.status &&
    value.directoryKey === expected.directoryKey &&
    value.nativeStepCount === expected.nativeStepCount &&
    value.messageCount === expected.messageCount &&
    Number.isInteger(value.metricCount) && Number(value.metricCount) >= 0 &&
    Number.isInteger(value.failureCount) && Number(value.failureCount) >= 0 &&
    typeof value.artifactSha256 === "string" &&
    typeof value.trajectorySha256 === "string" &&
    typeof value.metricsSha256 === "string" &&
    typeof value.failuresSha256 === "string" &&
    (value.evaluationReportId === undefined || isNonemptyString(value.evaluationReportId)) &&
    isRecord(value.files) &&
    value.files.artifact === ARTIFACT_FILE &&
    value.files.trajectory === TRAJECTORY_FILE &&
    value.files.metrics === METRICS_FILE &&
    value.files.failures === FAILURES_FILE &&
    value.files.manifest === MANIFEST_FILE &&
    value.files.checkpointIndex === CHECKPOINT_INDEX_FILE &&
    value.files.checkpoints === CHECKPOINTS_DIRECTORY
  );
}
