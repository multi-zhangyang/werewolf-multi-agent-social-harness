import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

describe("CLI provider diagnostic safety", () => {
  it("does not relay endpoints, provider request ids, or raw setup errors on provider configuration failure", async () => {
    const outputs = await Promise.all([
      runFailingCli("agent:probe", ["--models=placeholder-model", "--timeout=1s"]),
      runFailingCli("arena:match", ["--models=placeholder-model", "--maxTransitions=1", "--timeout=1s", "--json=summary"]),
      runFailingCli("arena:tournament", [
        "--models=placeholder-model",
        "--games=1",
        "--maxTransitions=1",
        "--timeout=1s",
        "--json=summary"
      ])
    ]);

    for (const output of outputs) {
      expect(output).toContain('"configured": false');
      expect(output).not.toContain("endpoint");
      expect(output).not.toContain("providerRequestId");
      expect(output).not.toMatch(/https?:\/\//i);
      expect(output).not.toContain("unsupported-provider");
    }
  }, 30_000);
});

async function runFailingCli(script: string, args: string[]): Promise<string> {
  try {
    await execFileAsync(npmCommand, ["run", script, "--", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLM_PROVIDER_PROTOCOL: "unsupported-provider"
      },
      maxBuffer: 1024 * 1024
    });
    throw new Error(`${script} unexpectedly succeeded with an invalid provider protocol.`);
  } catch (error) {
    const result = error as Error & { code?: number; stdout?: string; stderr?: string };
    expect(result.code).not.toBe(0);
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  }
}
