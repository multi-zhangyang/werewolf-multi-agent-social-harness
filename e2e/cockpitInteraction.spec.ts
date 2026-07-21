import { expect, test } from "@playwright/test";
import type { Page, Response } from "@playwright/test";

const cockpitUrl = process.env.PLAY_URL ?? "http://127.0.0.1:5173/";
const preferredReasoningModel = process.env.E2E_PREFERRED_MODEL;

function statusWith(page: Page, text: string | RegExp) {
  return page.getByRole("status").filter({ hasText: text }).first();
}

function apiUrl(path: string): string {
  return new URL(path, cockpitUrl).toString();
}

function isApiResponse(response: Response, path: string, method = "GET") {
  const url = new URL(response.url());
  return url.pathname === path && response.request().method() === method;
}

async function selectComboboxOption(
  page: Page,
  name: string,
  target: { name: string | RegExp } | { index: number }
): Promise<void> {
  const selector = page.getByRole("combobox", { name });
  await selector.click();
  await expect(selector).toHaveAttribute("aria-expanded", "true", { timeout: 10_000 });
  // rc-select keeps hidden ARIA listbox portals for assistive metadata. Its
  // rendered, interactive choices are the visible option items; selecting
  // from that set avoids stale hidden portals while exercising the real UI.
  const options = page.locator(".ant-select-item-option:visible");
  await expect(options.first()).toBeVisible({ timeout: 10_000 });
  const option = "name" in target
    ? options.filter({ hasText: target.name })
    : options.nth(target.index);
  await option.click();
}

/**
 * The primary sidebar and the horizontal tab strip invoke the same workspace
 * state transition. Prefer the sidebar in E2E so rc-tabs overflow/scroll
 * mechanics never decide whether a live harness/API assertion is exercised.
 */
async function navigateWorkspace(page: Page, name: string): Promise<void> {
  await page.getByRole("menuitem", { name: new RegExp(name) }).click();
  await expect(page.getByRole("tabpanel", { name })).toBeVisible();
}

type E2EMatchRecord = {
  id?: string;
  hasArtifact?: boolean;
  nativeSteps?: number;
  trajectorySteps?: number;
  status?: string;
  harnessStatus?: string | null;
  summary?: {
    kind?: string;
    ok?: boolean;
    status?: string;
    harnessErrorCount?: number;
    harnessFailureCount?: number;
    failureReason?: string | null;
    nativeSteps?: number;
  };
};

function expectSuccessfulHarnessRun(run: E2EMatchRecord): void {
  expect(run.status).toBe("completed");
  expect(["completed", "truncated"]).toContain(run.harnessStatus);
  expect(run.summary).toMatchObject({
    kind: "match",
    ok: true,
    status: run.harnessStatus,
    harnessErrorCount: 0,
    harnessFailureCount: 0,
    failureReason: null
  });
}

type E2EMatchArtifactProjection = {
  artifactVersion?: string;
  kind?: string;
  runId?: string;
  matchId?: string;
  projection?: { view?: string; privateEvidenceRedacted?: boolean; postgameTruthRedacted?: boolean };
  trajectory?: unknown[];
  socialEpisode?: { messages?: unknown[] };
};

type E2EMatchComparisonArtifact = {
  artifactVersion?: string;
  kind?: string;
  baseline?: { runId?: string; matchId?: string };
  candidate?: { runId?: string; matchId?: string };
  projection?: { view?: string; privateEvidenceRedacted?: boolean };
  rows?: Array<{ id?: string; label?: string; baseline?: unknown; candidate?: unknown; delta?: number }>;
};

type E2ECheckpointCreateResponse = {
  summary?: {
    kind?: string;
    ok?: boolean;
    checkpointId?: string;
    counts?: { nativeSteps?: number; socialMessages?: number; channels?: number };
  };
  artifactUrl?: string;
};

type E2EForkLineageResponse = {
  summary?: {
    kind?: string;
    ok?: boolean;
    isFork?: boolean;
    boundary?: { status?: string; checkpointFound?: boolean };
  };
};

type E2EBranchTreeResponse = {
  summary?: {
    kind?: string;
    ok?: boolean;
    rootCheckpointId?: string;
    counts?: { checkpoints?: number; matches?: number; edges?: number };
    checkpoints?: unknown[];
    matches?: unknown[];
    edges?: unknown[];
  };
};

async function readArtifactBackedMatches(page: Page): Promise<Array<E2EMatchRecord & { id: string }>> {
  const matchesResponse = await page.request.get(apiUrl("/api/matches"));
  expect(matchesResponse.ok()).toBeTruthy();
  const matches = (await matchesResponse.json()) as E2EMatchRecord[] | { error?: string };
  expect(Array.isArray(matches)).toBeTruthy();
  return (matches as E2EMatchRecord[]).filter((match): match is E2EMatchRecord & { id: string } => Boolean(match.id && match.hasArtifact));
}

async function ensureServerArtifacts(page: Page, requiredCount = 1) {
  let artifactBackedMatches = await readArtifactBackedMatches(page);
  if (artifactBackedMatches.length >= requiredCount) return artifactBackedMatches;

  const configResponse = await page.request.get(apiUrl("/api/config"));
  expect(configResponse.ok()).toBeTruthy();
  const config = (await configResponse.json()) as {
    defaultProfiles?: Array<{ id: string; model: string; temperature?: number; policyName?: string }>;
    models?: string[];
  };
  const models = config.models ?? [];
  const configuredProfileModel = config.defaultProfiles?.find((profile) => profile.model && (!models.length || models.includes(profile.model)))?.model;
  const model =
    preferredReasoningModel && (!models.length || models.includes(preferredReasoningModel))
      ? preferredReasoningModel
      : configuredProfileModel ?? models[0];
  if (!model) throw new Error("No model available for e2e artifact generation.");
  const sourceProfiles = config.defaultProfiles?.length
    ? config.defaultProfiles.slice(0, 3)
    : [
        { id: "e2e-wolf", policyName: "wolf-deceiver", temperature: 0.7 },
        { id: "e2e-village-a", policyName: "village-analyst", temperature: 0.7 },
        { id: "e2e-village-b", policyName: "seer-information", temperature: 0.7 }
      ];
  const profiles = sourceProfiles.map((profile, index) => ({
    ...profile,
    id: profile.id || `e2e-profile-${index + 1}`,
    model,
    temperature: profile.temperature ?? 0.7
  }));

  while (artifactBackedMatches.length < requiredCount) {
    const runResponse = await page.request.post(apiUrl("/api/matches/run"), {
      data: {
        models: [model],
        profiles,
        assignment: { strategy: "profile-rotation" },
        seed: `e2e-cockpit-baseline-${Date.now()}-${artifactBackedMatches.length}`,
        maxTransitions: 2,
        timeoutMs: 120_000
      },
      timeout: 180_000
    });
    expect(runResponse.status()).toBe(200);
    expect(runResponse.ok()).toBeTruthy();
    const run = (await runResponse.json()) as E2EMatchRecord;
    expectSuccessfulHarnessRun(run);
    expect(run.id).toBeTruthy();
    expect(run.hasArtifact).toBeTruthy();
    expect((run.nativeSteps ?? run.summary?.nativeSteps ?? run.trajectorySteps) ?? 0).toBeGreaterThan(0);
    artifactBackedMatches = await readArtifactBackedMatches(page);
  }

  return artifactBackedMatches;
}

test("harness cockpit uses real API-backed interactions", async ({ page }) => {
  // One bounded streaming turn may consume the normal per-run timeout; keep
  // the aggregate budget above that plus the subsequent replay/API assertions.
  test.setTimeout(480_000);
  const failedRequests: string[] = [];
  const failedApiResponses: string[] = [];
  const apiResponses: string[] = [];
  const pageErrors: string[] = [];

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
  });
  page.on("response", (response) => {
    const url = response.url();
    if (!url.includes("/api/")) return;
    apiResponses.push(`${response.status()} ${url}`);
    if (response.status() >= 400) failedApiResponses.push(`${response.status()} ${url}`);
  });

  const [existingBaseline] = await ensureServerArtifacts(page, 1);
  const startupConfig = page.waitForResponse((response) => isApiResponse(response, "/api/config"));
  const startupMatches = page.waitForResponse((response) => isApiResponse(response, "/api/matches"));
  await page.goto(cockpitUrl, { waitUntil: "networkidle" });
  expect((await startupConfig).ok()).toBeTruthy();
  expect((await startupMatches).ok()).toBeTruthy();

  await expect(page.getByText("多 Agent 社会 Harness Cockpit")).toBeVisible();
  await expect(page.getByText("postgame-redacted").first()).toBeVisible();
  await expect(page.getByText("运行注册表")).toBeVisible();

  const latestMatches = page.waitForResponse((response) => isApiResponse(response, "/api/matches"));
  const latestArtifact = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname.includes("/api/matches/") && url.pathname.endsWith("/artifact") && url.searchParams.get("view") === "postgame-redacted";
  });
  await page.getByRole("button", { name: "加载最近", exact: true }).click();
  expect((await latestMatches).ok()).toBeTruthy();
  const baselineArtifactResponse = await latestArtifact;
  expect(baselineArtifactResponse.ok()).toBeTruthy();
  const baselineArtifact = (await baselineArtifactResponse.json()) as E2EMatchArtifactProjection;
  expect(baselineArtifact).toMatchObject({
    artifactVersion: "harness.match.v2",
    kind: "match",
    projection: {
      view: "postgame-redacted",
      privateEvidenceRedacted: true
    }
  });
  const baselineMatchId = baselineArtifact.matchId ?? baselineArtifact.runId ?? existingBaseline.id;
  expect(baselineMatchId).toBeTruthy();
  await expect(statusWith(page, /已加载脱敏工件/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "查看原始片段", exact: true }).click();
  const rawDrawer = page.getByRole("dialog");
  await expect(rawDrawer).toBeVisible();
  await expect(rawDrawer.getByText("private evidence redacted")).toBeVisible();
  const rawText = await rawDrawer.getByRole("textbox").inputValue();
  const rawProjection = JSON.parse(rawText) as {
    projection?: { view?: string; privateEvidenceRedacted?: boolean; postgameTruthRedacted?: boolean };
  };
  expect(rawProjection.projection).toMatchObject({
    view: "postgame-redacted",
    privateEvidenceRedacted: true
  });
  expect(rawText).not.toContain('"view": "full"');
  await page.keyboard.press("Escape");
  await expect(rawDrawer).toBeHidden();

  const truthArtifact = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname.includes("/api/matches/") &&
      url.pathname.endsWith("/artifact") &&
      url.searchParams.get("view") === "truth-redacted"
    );
  }, { timeout: 30_000 });
  await selectComboboxOption(page, "工件投影", { name: /公开视图/ });
  const truthArtifactResponse = await truthArtifact;
  expect(truthArtifactResponse.ok()).toBeTruthy();
  const truthArtifactBody = (await truthArtifactResponse.json()) as E2EMatchArtifactProjection & {
    projection?: { view?: string; privateEvidenceRedacted?: boolean; postgameTruthRedacted?: boolean };
    finalState?: { players?: Array<Record<string, unknown>>; winner?: unknown };
  };
  expect(truthArtifactBody.projection).toMatchObject({
    view: "truth-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: true
  });
  for (const player of truthArtifactBody.finalState?.players ?? []) {
    expect(player).not.toHaveProperty("role");
    expect(player).not.toHaveProperty("team");
  }
  await expect(statusWith(page, /view=truth-redacted/)).toBeVisible({ timeout: 15_000 });

  const researchArtifact = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname.includes("/api/matches/") &&
      url.pathname.endsWith("/artifact") &&
      url.searchParams.get("view") === "postgame-redacted"
    );
  }, { timeout: 30_000 });
  await selectComboboxOption(page, "工件投影", { name: /研究视图/ });
  expect((await researchArtifact).ok()).toBeTruthy();

  await page.getByLabel("最大 transitions").fill("2");
  await page.getByLabel("超时秒数").fill("120");
  const runRequest = page.waitForResponse((response) => isApiResponse(response, "/api/matches/run", "POST"), { timeout: 180_000 });
  const runArtifact = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname.includes("/api/matches/") && url.pathname.endsWith("/artifact") && url.searchParams.get("view") === "postgame-redacted";
  }, { timeout: 180_000 });
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  const runResponse = await runRequest;
  expect(runResponse.status()).toBe(200);
  expect(runResponse.ok()).toBeTruthy();
  const uiRun = (await runResponse.json()) as E2EMatchRecord & { id: string };
  expectSuccessfulHarnessRun(uiRun);
  expect(uiRun.id).toBeTruthy();
  expect(uiRun.hasArtifact).toBeTruthy();
  expect((uiRun.nativeSteps ?? uiRun.summary?.nativeSteps ?? uiRun.trajectorySteps) ?? 0).toBeGreaterThan(0);
  const uiRunArtifactResponse = await runArtifact;
  expect(uiRunArtifactResponse.ok()).toBeTruthy();
  const uiRunArtifact = (await uiRunArtifactResponse.json()) as E2EMatchArtifactProjection;
  expect([uiRunArtifact.matchId, uiRunArtifact.runId]).toContain(uiRun.id);
  await expect(statusWith(page, /真实 harness run 完成/)).toBeVisible({ timeout: 20_000 });

  await navigateWorkspace(page, "对比");
  await expect(statusWith(page, "工作区已切换：对比")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "候选运行" })).toBeVisible();
  const candidateArtifactResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname.startsWith("/api/matches/") &&
      url.pathname.endsWith("/artifact") &&
      url.searchParams.get("view") === "postgame-redacted"
    );
  }, { timeout: 30_000 });
  const comparisonArtifactResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname.startsWith(`/api/matches/${uiRun.id}/compare/`) &&
      url.searchParams.get("view") === "postgame-redacted"
    );
  }, { timeout: 30_000 });
  // The just-run match is excluded from its own candidate list. With a single
  // existing baseline there is exactly one selectable candidate at index 0.
  await selectComboboxOption(page, "候选运行", { index: 0 });
  expect((await candidateArtifactResponse).ok()).toBeTruthy();
  const comparisonResponse = await comparisonArtifactResponse;
  expect(comparisonResponse.ok()).toBeTruthy();
  const comparisonArtifact = (await comparisonResponse.json()) as E2EMatchComparisonArtifact;
  expect(comparisonArtifact).toMatchObject({
    artifactVersion: "harness.match-comparison.v1",
    kind: "match-comparison",
    projection: {
      view: "postgame-redacted",
      privateEvidenceRedacted: true
    }
  });
  expect([comparisonArtifact.baseline?.matchId, comparisonArtifact.baseline?.runId]).toContain(uiRun.id);
  const comparisonCandidateId = comparisonArtifact.candidate?.matchId ?? comparisonArtifact.candidate?.runId;
  expect(comparisonCandidateId).toBeTruthy();
  expect(comparisonCandidateId).not.toBe(uiRun.id);
  expect(comparisonArtifact.rows ?? []).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "trajectory_steps" }),
      expect.objectContaining({ id: "social_messages" })
    ])
  );
  await expect(statusWith(page, /候选切换后对比已加载|对比工件已加载/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("columnheader", { name: "row", exact: true }).last()).toBeVisible();

  await navigateWorkspace(page, "时间线");
  await expect(page.getByRole("button", { name: "复现", exact: true })).toBeVisible();
  await expect(page.getByText(/主时间线来自原生 social episode/)).toBeVisible();
  await expect(page.getByText("Legacy trajectory projection", { exact: true })).toBeVisible();
  await expect(page.getByText("migration/debug only", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "scheduler", exact: true }).first()).toBeVisible();
  const replayResponse = page.waitForResponse((response) => isApiResponse(response, `/api/matches/${uiRun.id}/replay`, "POST"));
  await page.getByRole("button", { name: "复现", exact: true }).click();
  const replay = await replayResponse;
  expect(replay.ok()).toBeTruthy();
  const replayJson = (await replay.json()) as { summary?: { ok?: boolean; finalHashMatchesArtifact?: boolean } };
  expect(replayJson.summary?.ok).toBe(true);
  expect(replayJson.summary?.finalHashMatchesArtifact).toBe(true);
  await expect(statusWith(page, /复现通过/)).toBeVisible({ timeout: 15_000 });

  const jsonlResponse = page.waitForResponse((response) => isApiResponse(response, `/api/matches/${uiRun.id}/trajectory.jsonl`));
  await page.getByRole("button", { name: "JSONL", exact: true }).click();
  const jsonl = await jsonlResponse;
  expect(jsonl.ok()).toBeTruthy();
  expect(new URL(jsonl.url()).searchParams.get("view")).toBe("postgame-redacted");
  await expect(statusWith(page, /trajectory\.jsonl 已验证/)).toBeVisible({ timeout: 15_000 });

  await navigateWorkspace(page, "谱系");
  await expect(page.getByText("Checkpoint Registry", { exact: true })).toBeVisible();
  await expect(page.getByText("只展示 summary，不读取 full checkpoint artifact")).toBeVisible();

  const checkpointCreateResponse = page.waitForResponse((response) => isApiResponse(response, `/api/matches/${uiRun.id}/checkpoints`, "POST"));
  const checkpointListResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname === "/api/checkpoints" && url.searchParams.get("matchId") === uiRun.id;
  });
  await page.getByRole("button", { name: "创建 checkpoint", exact: true }).click();
  const checkpointCreate = await checkpointCreateResponse;
  expect(checkpointCreate.ok()).toBeTruthy();
  const checkpointJson = (await checkpointCreate.json()) as E2ECheckpointCreateResponse;
  const checkpointId = checkpointJson.summary?.checkpointId;
  expect(checkpointJson.summary).toMatchObject({
    kind: "checkpoint",
    ok: true
  });
  expect(checkpointId).toBeTruthy();
  expect(checkpointJson.artifactUrl).toMatch(/^\/api\/checkpoints\/.+\/artifact$/);
  const checkpointList = await checkpointListResponse;
  expect(checkpointList.ok()).toBeTruthy();
  await expect(statusWith(page, /checkpoint 已创建/)).toBeVisible({ timeout: 15_000 });

  const forkLineageResponse = page.waitForResponse((response) => isApiResponse(response, `/api/matches/${uiRun.id}/fork-lineage`));
  await page.getByRole("button", { name: "加载 lineage", exact: true }).click();
  const forkLineage = await forkLineageResponse;
  expect(forkLineage.ok()).toBeTruthy();
  const forkLineageJson = (await forkLineage.json()) as E2EForkLineageResponse;
  expect(forkLineageJson.summary).toMatchObject({
    kind: "fork-lineage",
    ok: true
  });
  await expect(statusWith(page, /fork lineage 已加载/)).toBeVisible({ timeout: 15_000 });

  const branchTreeResponse = page.waitForResponse((response) => isApiResponse(response, `/api/checkpoints/${checkpointId}/branch-tree`));
  await page.getByRole("button", { name: "加载 branch tree", exact: true }).click();
  const branchTree = await branchTreeResponse;
  expect(branchTree.ok()).toBeTruthy();
  const branchTreeJson = (await branchTree.json()) as E2EBranchTreeResponse;
  expect(branchTreeJson.summary).toMatchObject({
    kind: "checkpoint-branch-tree",
    rootCheckpointId: checkpointId
  });
  expect(branchTreeJson.summary?.counts?.checkpoints ?? 0).toBeGreaterThan(0);
  await expect(statusWith(page, /branch tree 已加载/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Branch Tree Nodes", { exact: true })).toBeVisible();

  await navigateWorkspace(page, "社会");
  await expect(page.getByRole("columnheader", { name: "agent", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "channel", exact: true }).first()).toBeVisible();

  await navigateWorkspace(page, "评测");
  await expect(page.getByRole("columnheader", { name: "metric", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "severity", exact: true }).first()).toBeVisible();

  expect(failedRequests.filter((request) => request.includes("/api/"))).toEqual([]);
  expect(failedApiResponses).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(apiResponses.some((response) => response.includes("/api/matches/run"))).toBeTruthy();
  expect(apiResponses.some((response) => response.includes("/api/matches") && response.includes("/compare/"))).toBeTruthy();
  expect(apiResponses.some((response) => response.includes("view=full"))).toBeFalsy();
  expect(apiResponses.some((response) => response.includes("/api/checkpoints/") && response.includes("/artifact"))).toBeFalsy();
});
