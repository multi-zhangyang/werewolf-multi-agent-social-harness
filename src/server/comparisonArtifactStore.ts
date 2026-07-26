import path from "node:path";
import { MATCH_COMPARISON_ARTIFACT_VERSION, type MatchComparisonArtifact } from "../harness/matchComparison";
import { redactSecrets } from "../harness/redaction";
import {
  COMPARISON_ARTIFACT_DIR,
  COMPARISON_ARTIFACT_INDEX_FILE,
  ensureWritableArtifactSubdirectory,
  isFileReadNotFound,
  resolveUnderDirectory
} from "./artifactFiles";
import { HttpError } from "./httpValidation";
import { isRecord, stringField } from "./jsonUtil";
import { getComparison, listComparisons, registerServerStoreResetHook, saveComparison } from "./store";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";

/**
 * One-time recovery memo per base directory. In-process comparison writes go
 * through saveComparison()/persistComparisonArtifact() and stay coherent with
 * the memoized recovery; the only flow that makes memory diverge from disk is
 * a store clear (tests clear and expect a rehydrating rescan), so the memo is
 * dropped through the store reset hook.
 */
const comparisonIndexLoadsByRoot = new Map<string, Promise<void>>();
registerServerStoreResetHook(() => comparisonIndexLoadsByRoot.clear());

export async function persistComparisonArtifact(
  comparison: MatchComparisonArtifact,
  baseDir: string | undefined
): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  const file = comparisonArtifactAbsoluteFile(root, comparison.comparisonId);
  await ensureWritableArtifactSubdirectory(
    root,
    comparisonArtifactDirectory(root),
    "Comparison artifact directory is not safe."
  );
  // Overwrite is intentional for deterministic comparison ids so recompute
  // under the same baseline/candidate/view replaces the prior registry entry.
  await writeFile(file, `${JSON.stringify(redactSecrets(comparison), null, 2)}\n`, {
    encoding: "utf8"
  });
}

export async function loadComparisonArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  let pending = comparisonIndexLoadsByRoot.get(root);
  if (!pending) {
    pending = loadComparisonArtifactIndexFromDisk(root).catch((error: unknown) => {
      comparisonIndexLoadsByRoot.delete(root);
      throw error;
    });
    comparisonIndexLoadsByRoot.set(root, pending);
  }
  await pending;
}

async function loadComparisonArtifactIndexFromDisk(root: string): Promise<void> {
  let parsed: unknown;
  let shouldRewriteIndex = false;
  const loadedIds = new Set<string>();
  let indexExists = true;
  try {
    parsed = JSON.parse(await readFile(comparisonArtifactIndexPath(root), "utf8"));
  } catch (error) {
    if (isFileReadNotFound(error)) {
      indexExists = false;
    } else if (error instanceof SyntaxError) {
      indexExists = false;
      shouldRewriteIndex = true;
    } else {
      throw new HttpError(500, "Comparison artifact index could not be read.");
    }
  }

  if (indexExists) {
    if (
      !isRecord(parsed) ||
      parsed.artifactVersion !== "harness.comparison-artifact-index.v1" ||
      parsed.kind !== "comparison-artifact-index" ||
      !Array.isArray(parsed.comparisons)
    ) {
      shouldRewriteIndex = true;
    } else {
      for (const record of parsed.comparisons) {
        const comparison = await comparisonFromIndexRecord(root, record);
        if (comparison) {
          saveComparison(comparison);
          loadedIds.add(comparison.comparisonId);
        } else {
          shouldRewriteIndex = true;
        }
      }
    }
  }

  const scannedIds = await loadComparisonArtifactsFromDirectory(root, loadedIds);
  if (scannedIds.length > 0 || shouldRewriteIndex || !indexExists) {
    await writeComparisonArtifactIndex(root);
  }
}

export async function writeComparisonArtifactIndex(baseDir: string | undefined): Promise<void> {
  if (!baseDir) return;
  const root = path.resolve(baseDir);
  await mkdir(comparisonArtifactDirectory(root), { recursive: true });
  const comparisons = [];
  for (const comparison of listComparisons()) {
    const relativeFile = comparisonArtifactRelativeFile(comparison.comparisonId);
    const absolute = comparisonArtifactAbsoluteFile(root, comparison.comparisonId);
    try {
      await lstat(absolute);
    } catch {
      // Skip registry entries that no longer have files.
      continue;
    }
    comparisons.push({
      comparisonId: comparison.comparisonId,
      createdAt: comparison.createdAt,
      view: comparison.view,
      baselineRunId: comparison.baseline.runId,
      baselineMatchId: comparison.baseline.matchId ?? null,
      candidateRunId: comparison.candidate.runId,
      candidateMatchId: comparison.candidate.matchId ?? null,
      baselineHash: comparison.summary.baselineHash,
      candidateHash: comparison.summary.candidateHash,
      rowCount: comparison.summary.rowCount,
      changedRowCount: comparison.summary.changedRowCount,
      relativeFile
    });
  }
  const index = {
    artifactVersion: "harness.comparison-artifact-index.v1",
    kind: "comparison-artifact-index",
    updatedAt: new Date().toISOString(),
    comparisons
  };
  await writeFile(comparisonArtifactIndexPath(root), `${JSON.stringify(redactSecrets(index), null, 2)}\n`, "utf8");
}

export async function comparisonFromIndexRecord(
  baseDir: string,
  value: unknown
): Promise<MatchComparisonArtifact | null> {
  try {
    if (!isRecord(value)) return null;
    const comparisonId = stringField(value, "comparisonId");
    const relativeFile = stringField(value, "relativeFile");
    if (!comparisonId || !relativeFile) return null;
    if (relativeFile !== comparisonArtifactRelativeFile(comparisonId)) return null;
    return comparisonArtifactFromFile(baseDir, comparisonId, relativeFile);
  } catch {
    return null;
  }
}

export async function loadComparisonArtifactsFromDirectory(
  baseDir: string,
  skipIds: Set<string>
): Promise<string[]> {
  const dir = comparisonArtifactDirectory(baseDir);
  let entries: Array<{ isFile(): boolean; name: string }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isFileReadNotFound(error)) return [];
    throw new HttpError(500, "Comparison artifact directory could not be read.");
  }
  const loadedIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const fileStem = entry.name.slice(0, -".json".length);
    const comparisonId = `match-comparison:${fileStem}`;
    if (skipIds.has(comparisonId)) continue;
    const comparison = await comparisonArtifactFromFile(
      baseDir,
      comparisonId,
      comparisonArtifactRelativeFile(comparisonId)
    );
    if (!comparison) continue;
    saveComparison(comparison);
    skipIds.add(comparison.comparisonId);
    loadedIds.push(comparison.comparisonId);
  }
  return loadedIds;
}

export async function comparisonArtifactFromFile(
  baseDir: string,
  comparisonId: string,
  relativeFile: string
): Promise<MatchComparisonArtifact | null> {
  try {
    const absolute = resolveUnderDirectory(baseDir, relativeFile);
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    const real = await realpath(absolute);
    const rootReal = await realpath(path.resolve(baseDir));
    if (!real.startsWith(rootReal + path.sep) && real !== rootReal) return null;
    const parsed: unknown = JSON.parse(await readFile(absolute, "utf8"));
    if (!isRecord(parsed)) return null;
    if (parsed.artifactVersion !== MATCH_COMPARISON_ARTIFACT_VERSION || parsed.kind !== "match-comparison") {
      return null;
    }
    const parsedId = stringField(parsed, "comparisonId");
    if (!parsedId || parsedId !== comparisonId) return null;
    // Store path revalidates required comparison identity fields.
    const candidate = parsed as unknown as MatchComparisonArtifact;
    saveComparison(candidate);
    return getComparison(comparisonId) ?? null;
  } catch {
    return null;
  }
}

export function comparisonArtifactIndexPath(baseDir: string): string {
  return path.join(path.resolve(baseDir), COMPARISON_ARTIFACT_INDEX_FILE);
}

export function comparisonArtifactDirectory(baseDir: string): string {
  return resolveUnderDirectory(baseDir, COMPARISON_ARTIFACT_DIR);
}

export function comparisonArtifactAbsoluteFile(baseDir: string, comparisonId: string): string {
  return resolveUnderDirectory(baseDir, comparisonArtifactRelativeFile(comparisonId));
}

export function comparisonArtifactRelativeFile(comparisonId: string): string {
  const prefix = "match-comparison:";
  if (!comparisonId.startsWith(prefix)) {
    throw new HttpError(500, "comparison artifact id is invalid");
  }
  const stem = comparisonId.slice(prefix.length);
  if (!/^[a-f0-9]{24}$/i.test(stem)) {
    throw new HttpError(500, "comparison artifact id is invalid");
  }
  return `${COMPARISON_ARTIFACT_DIR}/${stem}.json`;
}
