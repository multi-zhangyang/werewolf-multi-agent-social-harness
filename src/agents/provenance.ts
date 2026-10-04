import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const agentSourceDirectories = ["src/agents", "src/partners", "src/runtime", "src/society", "src/server"] as const;

/** Include the common executor as well as environment adapters in reproducibility hashes. */
export function agentSourceHash(root = process.cwd()): string {
  const files: string[] = [];
  function visit(directory: string) {
    for (const item of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${item.name}`;
      if (item.isDirectory()) visit(file); else if (item.name.endsWith(".ts")) files.push(file);
    }
  }
  for (const directory of agentSourceDirectories) visit(directory);
  return createHash("sha256").update([...files.sort(), "package-lock.json"].map(file => `${file}\n${readFileSync(path.join(root, file), "utf8")}`).join("\n")).digest("hex");
}

/** Save the exact shared executor, adapters and dependency lock used by a live validation. */
export function snapshotAgentSource(destination: string, root = process.cwd()): string {
  const before = agentSourceHash(root);
  mkdirSync(destination, { recursive: true });
  for (const directory of agentSourceDirectories) cpSync(path.join(root, directory), path.join(destination, directory), { recursive: true, errorOnExist: true, force: false });
  cpSync(path.join(root, "package-lock.json"), path.join(destination, "package-lock.json"), { errorOnExist: true, force: false });
  if (agentSourceHash(destination) !== before || agentSourceHash(root) !== before) throw new Error("Source changed while recording validation provenance");
  return before;
}
