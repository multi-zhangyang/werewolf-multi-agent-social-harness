import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Build an immutable artifact tree in a same-filesystem sibling and publish it
 * with one directory rename. This provides process-crash atomic visibility;
 * it deliberately does not claim fsync/power-loss durability.
 */
export async function publishNewLocalArtifactDirectory<TResult>(options: {
  finalDirectory: string;
  populate(stagingDirectory: string): Promise<TResult>;
}): Promise<TResult> {
  const finalDirectory = path.resolve(options.finalDirectory);
  const parentDirectory = path.dirname(finalDirectory);
  if (parentDirectory === finalDirectory || !path.basename(finalDirectory)) {
    throw new Error("Artifact publication requires a bounded child directory.");
  }
  await mkdir(parentDirectory, { recursive: true });
  await assertPublishTargetMissing(finalDirectory);
  const stagingDirectory = path.join(
    parentDirectory,
    `.tmp-${path.basename(finalDirectory)}-${randomUUID()}`
  );
  await mkdir(stagingDirectory, { recursive: false });
  let published = false;
  try {
    const result = await options.populate(stagingDirectory);
    await assertPublishTargetMissing(finalDirectory);
    await rename(stagingDirectory, finalDirectory);
    published = true;
    return result;
  } finally {
    if (!published) await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function assertPublishTargetMissing(directory: string): Promise<void> {
  try {
    await lstat(directory);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new Error("Artifact publication target already exists.");
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
