import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishNewLocalArtifactDirectory } from "../src/harness/localArtifactDirectory";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("immutable local artifact directory publication", () => {
  it("keeps the final path invisible until the complete staging tree is renamed", async () => {
    const parent = await temporaryParent();
    const finalDirectory = path.join(parent, "published-artifact");
    let releasePopulate!: () => void;
    const paused = new Promise<void>((resolve) => { releasePopulate = resolve; });
    let stagingDirectory = "";
    const publication = publishNewLocalArtifactDirectory({
      finalDirectory,
      async populate(staging) {
        stagingDirectory = staging;
        await writeFile(path.join(staging, "first.json"), "{}\n", "utf8");
        await paused;
        await mkdir(path.join(staging, "nested"));
        await writeFile(path.join(staging, "nested", "second.json"), "{}\n", "utf8");
        return "complete";
      }
    });

    await waitFor(() => stagingDirectory.length > 0);
    await expect(readdir(finalDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(parent)).some((entry) => entry.startsWith(".tmp-published-artifact-"))).toBe(true);
    releasePopulate();

    await expect(publication).resolves.toBe("complete");
    expect((await readdir(finalDirectory)).sort()).toEqual(["first.json", "nested"]);
    expect(await readFile(path.join(finalDirectory, "nested", "second.json"), "utf8")).toBe("{}\n");
    expect((await readdir(parent)).some((entry) => entry.startsWith(".tmp-"))).toBe(false);
  });

  it("cleans failed staging, permits retry, and never replaces an occupied target", async () => {
    const parent = await temporaryParent();
    const finalDirectory = path.join(parent, "retry-artifact");
    await expect(publishNewLocalArtifactDirectory({
      finalDirectory,
      async populate(staging) {
        await writeFile(path.join(staging, "partial.json"), "{}\n", "utf8");
        throw new Error("injected population failure");
      }
    })).rejects.toThrow(/injected population failure/i);
    await expect(readdir(finalDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(parent)).some((entry) => entry.startsWith(".tmp-"))).toBe(false);

    await publishNewLocalArtifactDirectory({
      finalDirectory,
      async populate(staging) {
        await writeFile(path.join(staging, "complete.json"), "complete\n", "utf8");
      }
    });
    await expect(readFile(path.join(finalDirectory, "complete.json"), "utf8")).resolves.toBe("complete\n");

    await expect(publishNewLocalArtifactDirectory({
      finalDirectory,
      async populate(staging) {
        await writeFile(path.join(staging, "replacement.json"), "replacement\n", "utf8");
      }
    })).rejects.toThrow(/target already exists/i);
    await expect(readFile(path.join(finalDirectory, "complete.json"), "utf8")).resolves.toBe("complete\n");
    await expect(readFile(path.join(finalDirectory, "replacement.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryParent(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "local-artifact-publication-"));
  roots.push(root);
  return root;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for publication test barrier.");
}
