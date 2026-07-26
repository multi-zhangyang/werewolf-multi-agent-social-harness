import path from "node:path";
import { MATCH_ARTIFACT_VERSION, type MatchArtifact, assertValidMatchArtifactIntegrity } from "../harness/artifacts";
import { hashStableState } from "../harness/hash";
import { sanitizePersistedProviderDiagnostics } from "../harness/providerFailure";
import { redactSecrets } from "../harness/redaction";
import { countSocialStepCommits } from "../harness/social";
import {
  MATCH_ARTIFACT_DIR,
  MATCH_ARTIFACT_INDEX_FILE,
  assertRegularFileInsideDirectory,
  ensureWritableArtifactSubdirectory,
  isFileReadNotFound,
  isPersistedMatchArtifactId,
  normalizeRequestedArtifactPath,
  resolveUnderDirectory
} from "./artifactFiles";
import { HttpError } from "./httpValidation";
import { isRecord, stringField } from "./jsonUtil";
import {
  type ArtifactRecoveryReadResult,
  artifactRecoveryAuditMessageForCode,
  loadArtifactRecoveryAuditSidecar,
  recordArtifactRecoveryAudit
} from "./recoveryAudit";
import { type StoredMatch, listMatches, saveMatch } from "./store";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

export async function persistMatchArtifact(artifact: MatchArtifact, baseDir: string | undefined): Promise<void> {
  assertValidMatchArtifactIntegrity(artifact);
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  const file = matchArtifactAbsoluteFile(root, matchArtifactId(artifact));
  await ensureWritableArtifactSubdirectory(root, matchArtifactDirectory(root), "Match artifact directory is not safe.");
  // Overwrite is intentional for deterministic tournament episode ids so a re-export
  // under the same seed/episode replaces the prior match store entry.
  await atomicReplaceUtf8(
    file,
    `${JSON.stringify(sanitizePersistedProviderDiagnostics(redactSecrets(artifact)), null, 2)}\n`
  );
}

export async function recoverMatchArtifactIndex(baseDir: string): Promise<void> {
  const root = path.resolve(baseDir);
  await loadArtifactRecoveryAuditSidecar(root, "match");
  let parsed: unknown;
  let shouldRewriteIndex = false;
  const loadedIds = new Set<string>();
  let indexExists = true;
  try {
    parsed = JSON.parse(await readFile(matchArtifactIndexPath(root), "utf8"));
  } catch (error) {
    if (isFileReadNotFound(error)) {
      indexExists = false;
    } else if (error instanceof SyntaxError) {
      indexExists = false;
      await recordArtifactRecoveryAudit(root, {
        store: "match",
        source: "index",
        code: "index_invalid_json",
        relativeFile: MATCH_ARTIFACT_INDEX_FILE,
        message: "Match artifact index contained invalid JSON and will be repaired."
      });
      shouldRewriteIndex = true;
    } else {
      throw new HttpError(500, "Match artifact index could not be read.");
    }
  }

  if (indexExists) {
    if (!isRecord(parsed) || parsed.kind !== "match-artifact-index" || !Array.isArray(parsed.matches)) {
      await recordArtifactRecoveryAudit(root, {
        store: "match",
        source: "index",
        code: "index_invalid_shape",
        relativeFile: MATCH_ARTIFACT_INDEX_FILE,
        message: "Match artifact index shape was invalid and will be repaired."
      });
      shouldRewriteIndex = true;
    } else {
      for (const record of parsed.matches) {
        const artifact = await matchArtifactFromIndexRecord(root, record);
        if (artifact) {
          saveMatch(storedMatchFromMatchArtifact(artifact));
          loadedIds.add(matchArtifactId(artifact));
        } else {
          await recordArtifactRecoveryAudit(root, {
            store: "match",
            source: "index",
            code: "index_record_rejected",
            artifactId: isRecord(record) ? stringField(record, "matchId") ?? undefined : undefined,
            relativeFile: isRecord(record) ? stringField(record, "relativeFile") ?? undefined : undefined,
            message: "Match artifact index record did not resolve to a valid server-owned artifact."
          });
          shouldRewriteIndex = true;
        }
      }
    }
  }

  const scannedIds = await loadMatchArtifactsFromDirectory(root, loadedIds);
  if (scannedIds.length > 0 || shouldRewriteIndex || !indexExists) {
    await writeMatchArtifactIndex(root);
  }
}

export async function writeMatchArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await mkdir(matchArtifactDirectory(root), { recursive: true });
  const matches = [];
  for (const match of listMatches()) {
    if (!match.artifact) continue;
    const id = matchArtifactId(match.artifact);
    if (!isPersistedMatchArtifactId(id)) continue;
    const artifact = await matchArtifactFromFile(root, id, matchArtifactRelativeFile(id));
    if (!artifact) continue;
    const stepCounts = countSocialStepCommits(artifact.socialEpisode.steps);
    matches.push({
      matchId: matchArtifactId(artifact),
      runId: artifact.runId,
      createdAt: artifact.createdAt,
      seed: artifact.seed,
      status: artifact.status,
      stateHash: hashStableState(artifact.finalState),
      trajectoryHash: hashStableState(artifact.trajectory),
      agentCount: artifact.agents.length,
      nativeSteps: stepCounts.nativeSteps,
      committedSteps: stepCounts.committedSteps,
      rejectedSteps: stepCounts.rejectedSteps,
      trajectorySteps: artifact.trajectory.length,
      socialMessages: artifact.socialEpisode.messages.length,
      relativeFile: matchArtifactRelativeFile(matchArtifactId(artifact))
    });
  }
  const index = {
    artifactVersion: "harness.match-artifact-index.v1",
    kind: "match-artifact-index",
    updatedAt: new Date().toISOString(),
    matches
  };
  await atomicReplaceUtf8(matchArtifactIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`);
}

export async function atomicReplaceUtf8(target: string, contents: string): Promise<void> {
  try {
    const current = await lstat(target);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new HttpError(500, "Artifact publication target is not a safe regular file.");
    }
  } catch (error) {
    if (!isFileReadNotFound(error)) throw error;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function matchArtifactFromIndexRecord(baseDir: string, value: unknown): Promise<MatchArtifact | null> {
  try {
    if (!isRecord(value)) return null;
    const matchId = stringField(value, "matchId");
    const relativeFile = stringField(value, "relativeFile");
    if (!matchId || !relativeFile) return null;
    if (relativeFile !== matchArtifactRelativeFile(matchId)) return null;
    return matchArtifactFromFile(baseDir, matchId, relativeFile);
  } catch {
    return null;
  }
}

export async function loadMatchArtifactsFromDirectory(baseDir: string, skipIds: Set<string>): Promise<string[]> {
  const dir = matchArtifactDirectory(baseDir);
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isFileReadNotFound(error)) return [];
    throw new HttpError(500, "Match artifact directory could not be read.");
  }
  const loadedIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const matchId = entry.name.slice(0, -".json".length);
    if (!isPersistedMatchArtifactId(matchId)) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "match",
        source: "directory",
        code: "file_name_rejected",
        relativeFile: `${MATCH_ARTIFACT_DIR}/${entry.name}`,
        message: "Match artifact file name was not a server-owned match artifact id."
      });
      continue;
    }
    if (skipIds.has(matchId)) continue;
    const artifactResult = await readMatchArtifactFromFile(baseDir, matchId, matchArtifactRelativeFile(matchId));
    if (!artifactResult.ok) {
      await recordArtifactRecoveryAudit(baseDir, {
        store: "match",
        source: "directory",
        code: artifactResult.code,
        artifactId: matchId,
        relativeFile: matchArtifactRelativeFile(matchId),
        message: artifactRecoveryAuditMessageForCode("match", "directory", artifactResult.code) ?? "Match artifact file failed recovery validation."
      });
      continue;
    }
    const artifact = artifactResult.artifact;
    saveMatch(storedMatchFromMatchArtifact(artifact));
    const id = matchArtifactId(artifact);
    skipIds.add(id);
    loadedIds.push(id);
  }
  return loadedIds;
}

export async function matchArtifactFromFile(baseDir: string, matchId: string, relativeFile: string): Promise<MatchArtifact | null> {
  const result = await readMatchArtifactFromFile(baseDir, matchId, relativeFile);
  return result.ok ? result.artifact : null;
}

export async function readMatchArtifactFromFile(baseDir: string, matchId: string, relativeFile: string): Promise<ArtifactRecoveryReadResult<MatchArtifact>> {
  try {
    if (!isPersistedMatchArtifactId(matchId)) return { ok: false, code: "file_identity_mismatch" };
    const normalized = normalizeRequestedArtifactPath(relativeFile);
    if (normalized !== matchArtifactRelativeFile(matchId)) return { ok: false, code: "file_identity_mismatch" };
    const absolutePath = resolveUnderDirectory(baseDir, normalized);
    try {
      await assertRegularFileInsideDirectory(baseDir, absolutePath, "match artifact file not found");
    } catch {
      return { ok: false, code: "file_not_regular" };
    }
    let artifact: unknown;
    try {
      artifact = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
    } catch (error) {
      return { ok: false, code: error instanceof SyntaxError ? "file_invalid_json" : "file_not_regular" };
    }
    if (!isRecord(artifact)) return { ok: false, code: "file_invalid_shape" };
    if (artifact.artifactVersion !== MATCH_ARTIFACT_VERSION || artifact.kind !== "match") return { ok: false, code: "file_invalid_shape" };
    const restored = artifact as unknown as MatchArtifact;
    if (matchArtifactId(restored) !== matchId) return { ok: false, code: "file_identity_mismatch" };
    try {
      assertValidMatchArtifactIntegrity(restored);
    } catch {
      return { ok: false, code: "file_integrity_invalid" };
    }
    return { ok: true, artifact: restored };
  } catch {
    return { ok: false, code: "file_identity_mismatch" };
  }
}

export function storedMatchFromMatchArtifact(artifact: MatchArtifact): StoredMatch {
  const id = matchArtifactId(artifact);
  return {
    id,
    createdAt: artifact.createdAt,
    state: artifact.finalState,
    metrics: artifact.metrics,
    artifact,
    initialState: artifact.initialState,
    trajectory: artifact.trajectory,
    socialEpisode: artifact.socialEpisode,
    evaluation: artifact.evaluation,
    evaluationReport: artifact.evaluationReport,
    profiles: artifact.profiles,
    assignment: artifact.assignment,
    resolvedAssignments: artifact.resolvedAssignments,
    models: artifact.models,
    status: artifact.status,
    error: artifact.failureReason
  };
}

export function matchArtifactIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), MATCH_ARTIFACT_INDEX_FILE);
}

export function matchArtifactDirectory(baseDir: string): string {
  return resolveUnderDirectory(baseDir, MATCH_ARTIFACT_DIR);
}

export function matchArtifactAbsoluteFile(baseDir: string, matchId: string): string {
  return resolveUnderDirectory(baseDir, matchArtifactRelativeFile(matchId));
}

export function matchArtifactRelativeFile(matchId: string): string {
  if (!isPersistedMatchArtifactId(matchId)) throw new HttpError(500, "server-owned match artifact id is invalid");
  return `${MATCH_ARTIFACT_DIR}/${matchId}.json`;
}

export function matchArtifactId(artifact: MatchArtifact): string {
  return artifact.matchId ?? artifact.runId;
}
