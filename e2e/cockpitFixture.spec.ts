import { expect, test, type Locator, type Page, type Response } from "@playwright/test";

const fixtureMatchId = "fixture-match-001";
const fixtureCandidateMatchId = "fixture-match-002";

test("renders recorded server truth without a provider and never requests a full artifact", async ({ page }) => {
  const pageErrors: string[] = [];
  const artifactViews: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/artifact")) artifactViews.push(url.searchParams.get("view") ?? "default");
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("多 Agent 社会 Harness Cockpit")).toBeVisible();
  await expect(page.getByText("运行注册表")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
  await expect(page.getByText(fixtureMatchId).first()).toBeVisible();

  const projection = page.getByRole("combobox", { name: "工件投影" });
  const requestCountBeforeViewChange = artifactViews.length;
  const truthArtifact = page.waitForResponse((response) => isArtifactResponse(response, "truth-redacted"));
  await projection.click();
  // rc-select renders its popup in a portal. When the page is scrolled, a
  // pointer click can target stale popup coordinates while only moving focus.
  // Select through the combobox's keyboard contract so this test exercises the
  // same accessible control without depending on popup placement.
  await projection.press("ArrowDown");
  await projection.press("Enter");
  const truthResponse = await truthArtifact;
  expect(truthResponse.ok()).toBeTruthy();
  expect((await truthResponse.json()).projection).toMatchObject({
    view: "truth-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: true
  });
  await expect(page.getByRole("status")).toContainText("view=truth-redacted");

  // The public comparison DTO intentionally contains neither run ids nor
  // seeds. Its route context must still make the actual matrix current.
  await page.getByRole("tab", { name: "对比", exact: true }).click();
  const truthComparison = page.waitForResponse((response) => isComparisonResponse(response, "truth-redacted"));
  const candidate = page.getByRole("combobox", { name: "候选运行" });
  await candidate.click();
  await candidate.press("ArrowDown");
  await candidate.press("Enter");
  const comparisonResponse = await truthComparison;
  expect(comparisonResponse.ok()).toBeTruthy();
  const comparisonJson = await comparisonResponse.json();
  expect(comparisonJson.projection).toMatchObject({
    view: "truth-redacted",
    privateEvidenceRedacted: true,
    postgameTruthRedacted: true
  });
  for (const source of [comparisonJson.baseline, comparisonJson.candidate]) {
    expect(source).not.toHaveProperty("runId");
    expect(source).not.toHaveProperty("matchId");
    expect(source).not.toHaveProperty("seed");
  }
  await expect(page.getByText("对比已就绪")).toBeVisible();
  // This control exists only when the identityless DTO is current and the
  // comparison matrix has been materialized from its rows.
  expect(comparisonJson.rows.length).toBeGreaterThan(0);
  await expect(page.getByText(/^changed \d+\/\d+$/)).toHaveCount(1);
  await expect(page.getByText(new RegExp(`候选 ${fixtureCandidateMatchId.slice(0, 8)}`))).toBeVisible();
  expect(artifactViews.slice(requestCountBeforeViewChange)).toEqual(["truth-redacted", "truth-redacted"]);

  await page.getByRole("tab", { name: "时间线", exact: true }).click();
  await expect(page.getByText("主时间线来自原生 social episode 执行工件")).toBeVisible();
  await expect(page.getByText("native steps").first()).toBeVisible();
  const replayResponse = page.waitForResponse((response) => isReplayResponse(response));
  await page.getByRole("button", { name: "复现" }).click();
  expect((await replayResponse).ok()).toBeTruthy();
  await expect(page.getByRole("status")).toContainText("原生复现通过");

  // A projection change must remain selected through workspace and replay work;
  // bootstrap is not allowed to restore its default postgame projection.
  expect(artifactViews).toContain("postgame-redacted");
  expect(artifactViews).not.toContain("full");
  expect(pageErrors).toEqual([]);
});

test.describe("compact cockpit", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("keeps every artifact workspace within the viewport", async ({ page }) => {
    const workspaces = [
      ["timeline", "时间线"],
      ["society", "社会"],
      ["lineage", "谱系"],
      ["evaluation", "评测"],
      ["compare", "对比"],
      ["packs", "公开包"]
    ] as const;

    for (const [workspace, label] of workspaces) {
      await page.goto(`/?workspace=${workspace}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
      const inspector = page.getByRole("dialog", { name: "Evidence Inspector" });
      if (await inspector.isVisible()) {
        await page.keyboard.press("Escape");
        await expect(inspector).toBeHidden();
      }
      await expect(page.getByRole("tabpanel", { name: label })).toBeVisible();
      await expectPageWithinViewport(page);
    }
  });

  test("uses bounded drawers for context and evidence", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status")).toContainText("已加载脱敏工件");

    const initialInspector = page.getByRole("dialog", { name: "Evidence Inspector" });
    await expect(initialInspector).toBeVisible();
    await expectDrawerWithinViewport(page, initialInspector);
    await page.keyboard.press("Escape");
    await expect(initialInspector).toBeHidden();

    await page.getByRole("button", { name: "打开运行上下文" }).click();
    const context = page.getByRole("dialog", { name: "运行上下文" });
    await expect(context).toBeVisible();
    await expectDrawerWithinViewport(page, context);
    await context.getByRole("menuitem", { name: /社会/ }).click();
    await expect(context).toBeHidden();
    await expect(page.getByRole("tabpanel", { name: "社会" })).toBeVisible();
    await expect(page.getByText("可见性 / 影响边")).toBeVisible();

    await page.getByRole("button", { name: "打开证据检查器" }).click();
    const inspector = page.getByRole("dialog", { name: "Evidence Inspector" });
    await expect(inspector).toBeVisible();
    await expectDrawerWithinViewport(page, inspector);
    expect(pageErrors).toEqual([]);
  });
});

function isArtifactResponse(response: Response, view: "postgame-redacted" | "truth-redacted"): boolean {
  const url = new URL(response.url());
  return (
    response.request().method() === "GET" &&
    url.pathname === `/api/matches/${fixtureMatchId}/artifact` &&
    url.searchParams.get("view") === view
  );
}

function isReplayResponse(response: Response): boolean {
  const url = new URL(response.url());
  return response.request().method() === "POST" && url.pathname === `/api/matches/${fixtureMatchId}/replay`;
}

function isComparisonResponse(response: Response, view: "postgame-redacted" | "truth-redacted"): boolean {
  const url = new URL(response.url());
  return (
    response.request().method() === "GET" &&
    url.pathname === `/api/matches/${fixtureMatchId}/compare/${fixtureCandidateMatchId}` &&
    url.searchParams.get("view") === view
  );
}

async function expectDrawerWithinViewport(page: Page, drawer: Locator): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const panel = drawer.locator("xpath=..");
  await expect(panel).toHaveCSS("transform", "none", { timeout: 2_000 });
  const box = await drawer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  await expectPageWithinViewport(page);
}

async function expectPageWithinViewport(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(viewport!.width + 1);
}
