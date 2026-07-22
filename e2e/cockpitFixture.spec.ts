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

  // The postgame projection contains the recorded native timeline. Its
  // explicit inspector action must be usable with ordinary keyboard focus;
  // pointer row selection remains only a convenience path.
  await page.getByRole("menuitem", { name: /时间线/ }).click();
  await expect(page.getByRole("tabpanel", { name: "时间线" })).toBeVisible();
  const firstNativeStep = page.getByRole("button", { name: "查看原生步骤 1" });
  await firstNativeStep.focus();
  await expect(firstNativeStep).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Step 详情")).toBeVisible();
  const decisionEvidence = page.getByTestId("agent-decision-evidence-panel");
  await expect(decisionEvidence).toBeVisible();
  await expect(decisionEvidence).toContainText("Environment receipt");
  await expect(decisionEvidence).toContainText("private actor state");

  // A complete native replay is a local postgame-research action. Exercise it
  // before changing projection, then prove the strict public view cannot make
  // the same request or display its scheduler/hash summary.
  const postgameReplay = page.waitForResponse((response) => isReplayResponse(response));
  await page.getByRole("button", { name: "复现" }).click();
  expect((await postgameReplay).ok()).toBeTruthy();
  await expect(page.getByRole("status")).toContainText("原生复现通过");

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
  await expect(page.getByTestId("agent-decision-evidence-panel")).toHaveCount(0);

  // The public comparison DTO intentionally contains neither run ids nor
  // seeds. Its route context must still make the actual matrix current.
  // The tab strip can overflow after every cockpit workspace is registered.
  // Use the primary navigation path, which invokes the same workspace state
  // transition without relying on rc-tabs' transient horizontal scroll offset.
  await page.getByRole("menuitem", { name: /对比/ }).click();
  const comparePanel = page.getByRole("tabpanel", { name: "对比" });
  await expect(comparePanel).toBeVisible();
  const truthComparison = page.waitForResponse((response) => isComparisonResponse(response, "truth-redacted"));
  const candidate = comparePanel.getByRole("combobox", { name: "候选运行" });
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
  const replayButton = page.getByRole("button", { name: "复现" });
  await expect(replayButton).toBeDisabled();
  await expect(page.getByText("Replay validation")).toHaveCount(0);

  // A projection change must remain selected through workspace and replay work;
  // bootstrap is not allowed to restore its default postgame projection.
  expect(artifactViews).toContain("postgame-redacted");
  expect(artifactViews).not.toContain("full");
  expect(pageErrors).toEqual([]);
});

test("renders matrix lifecycle and statistics only from the harness API response", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/?workspace=experiments", { waitUntil: "domcontentloaded" });
  const experimentPanel = page.getByRole("tabpanel", { name: "实验矩阵" });
  await expect(experimentPanel).toBeVisible();

  const games = experimentPanel.getByRole("combobox", { name: "矩阵游戏局数" });
  await games.click();
  await games.press("ArrowUp");
  await games.press("Enter");
  const matrixResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/experiments/matrix/run";
  });
  await experimentPanel.getByRole("button", { name: "运行矩阵" }).click();
  const response = await matrixResponse;
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.summary).toMatchObject({ kind: "experiment-matrix", gamesRequested: 1, ok: true });
  expect(body.summary.gamesCompleted + body.summary.gamesTruncated + body.summary.gamesFailed).toBe(1);
  expect(body.cells).toHaveLength(1);
  expect(body.cells[0]).toMatchObject({ gamesRequested: 1 });
  await expect(experimentPanel.getByText("已记录的 Matrix Cells")).toBeVisible();
  await expect(experimentPanel.locator(".ant-tag").filter({ hasText: new RegExp(`^${body.cells[0].status}$`) })).toBeVisible();
  await expect(experimentPanel.getByText("描述性 Pairwise 比较")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("renders a projection-safe Werewolf postgame review board", async ({ page }) => {
  await page.goto("/?workspace=domain", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
  await expect(page.getByRole("tabpanel", { name: "狼人杀复盘" })).toBeVisible();
  const board = page.getByTestId("werewolf-review-board");
  const seatBoard = page.getByRole("region", { name: "狼人杀座位复盘" });
  await expect(board.getByText("狼人杀赛后复盘")).toBeVisible();
  await expect(seatBoard.getByRole("listitem")).toHaveCount(9);
  await expect(board.locator('[data-testid^="werewolf-seat-role-"]')).toHaveCount(9);
  await expect(board.getByText("服务端事件账本")).toBeVisible();
  const ledgerBoundary = board.getByRole("button", { name: /定位事件 \d+ 的服务端回放边界/ }).first();
  await expect(ledgerBoundary).toBeVisible();
  const ledgerFrameResponse = page.waitForResponse((response) => isReplayFrameResponse(response));
  await ledgerBoundary.click();
  expect((await ledgerFrameResponse).ok()).toBeTruthy();
  await expect(board.getByText("狼人杀回放局面")).toBeVisible();

  const projection = page.getByRole("combobox", { name: "工件投影" });
  const truthArtifact = page.waitForResponse((response) => isArtifactResponse(response, "truth-redacted"));
  await projection.click();
  await projection.press("ArrowDown");
  await projection.press("Enter");
  await truthArtifact;

  await expect(board.getByText("真相脱敏局面")).toBeVisible();
  await expect(seatBoard.getByRole("listitem")).toHaveCount(9);
  await expect(seatBoard).toContainText("身份隐藏");
  await expect(board.locator('[data-testid^="werewolf-seat-role-"]')).toHaveCount(0);
  await expect(board.getByRole("button", { name: /定位事件 \d+ 的服务端回放边界/ })).toHaveCount(0);
  expect(await seatBoard.textContent()).not.toMatch(/狼人|预言家|女巫|猎人|村民/);
});

test("renders only a server-owned live public table and does not reconstruct a failed match", async ({ page }) => {
  test.setTimeout(15_000);
  const artifactViews: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/artifact")) artifactViews.push(url.searchParams.get("view") ?? "default");
  });

  await page.goto("/?workspace=domain", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
  const artifactViewsBeforeLiveRun = artifactViews.length;

  const liveMatchId = "fixture-live-public-ui";
  const registryReadsDuringLive: string[] = [];
  let liveStartAcknowledged = false;
  await page.route("**/api/matches", async (route) => {
    if (route.request().method() === "GET" && liveStartAcknowledged) {
      registryReadsDuringLive.push(route.request().url());
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "operator registry is forbidden while spectating" })
      });
      return;
    }
    await route.continue();
  });
  let liveReads = 0;
  await page.route("**/api/matches/run", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    liveStartAcknowledged = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        artifactVersion: "server.match-live-start.v1",
        kind: "match-live-start",
        matchId: liveMatchId,
        lifecycle: "running",
        artifactAvailable: false,
        projection: { view: "live-public", privateEvidenceRedacted: true, postgameTruthRedacted: true },
        id: "fixture-operator-registry-id",
        state: { phase: "night_wolves", privateMemo: "fixture-start-private-state" },
        models: ["fixture-start-model"],
        nativeSteps: 99,
        checkpointCount: 7
      })
    });
  });
  await page.route(`**/api/matches/${liveMatchId}/live`, async (route) => {
    liveReads += 1;
    const body =
      liveReads <= 4
        ? {
            artifactVersion: "server.match-live-projection.v1",
            kind: "match-live-projection",
            matchId: liveMatchId,
            lifecycle: "running",
            artifactAvailable: false,
            projection: { view: "live-public", privateEvidenceRedacted: true, postgameTruthRedacted: true },
            publicState: {
              phase: "night",
              day: 1,
              players: [
                {
                  id: "p1",
                  seat: 1,
                  name: "1号",
                  alive: true,
                  isSheriff: false,
                  role: "werewolf",
                  team: "werewolves",
                  privateMemo: "fixture-private-live-memo"
                },
                {
                  id: "p2",
                  seat: 2,
                  name: "2号",
                  alive: false,
                  isSheriff: true,
                  eliminatedAt: { day: 1, reason: "night_kill", phase: "night_resolve" },
                  ability: { poison: true }
                }
              ],
              speeches: [
                { day: 1, playerId: "p1", text: "公开发言", kind: "day", claimedRole: "seer" }
              ],
              votes: [{ day: 1, voterId: "p1", targetId: "p2", abstain: false, weight: 2 }],
              deaths: [{ day: 1, playerId: "p2", reason: "night_kill", traceId: "fixture-secret-trace" }],
              currentSpeakerSeat: 1,
              pendingActionCount: 3,
              night: { seerInspection: { targetId: "p2" } }
            }
          }
        : {
            artifactVersion: "server.match-live-projection.v1",
            kind: "match-live-projection",
            matchId: liveMatchId,
            lifecycle: "failed",
            artifactAvailable: false
          };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  const runRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return request.method() === "POST" && url.pathname === "/api/matches/run";
  });
  const runResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/matches/run";
  });
  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  const request = await runRequest;
  expect(request.postDataJSON()).toMatchObject({ live: true });
  expect((await runResponse).status()).toBe(202);

  const board = page.getByTestId("werewolf-live-board");
  await expect(page.getByTestId("live-spectator-shell")).toBeVisible();
  await expect(board.getByText("实时公开局面 · 服务端权威")).toBeVisible();
  await expect(board.getByRole("region", { name: "狼人杀实时公开座位" }).getByRole("listitem")).toHaveCount(2);
  await expect(board).toContainText("夜晚");
  const liveText = await board.textContent();
  for (const forbidden of [
    "werewolf",
    "werewolves",
    "fixture-private-live-memo",
    "night_resolve",
    "seer",
    "fixture-secret-trace",
    "pendingActionCount",
    "seerInspection"
  ]) {
    expect(liveText).not.toContain(forbidden);
  }
  await expect(board.locator('[data-testid^="werewolf-seat-role-"]')).toHaveCount(0);
  await expect(board.getByRole("button")).toHaveCount(0);
  await expect(page.getByText("运行注册表")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "运行实验", exact: true })).toHaveCount(0);
  const spectatorText = await page.getByTestId("live-spectator-shell").textContent();
  for (const forbidden of ["fixture-operator-registry-id", "night_wolves", "fixture-start-private-state", "fixture-start-model", "nativeSteps", "checkpointCount"]) {
    expect(spectatorText).not.toContain(forbidden);
  }

  await expect(page.locator(".ant-alert-error").filter({ hasText: "服务端没有可加载的赛后工件" })).toBeVisible({ timeout: 5_000 });
  expect(liveReads).toBeGreaterThanOrEqual(2);
  expect(registryReadsDuringLive).toEqual([]);
  expect(artifactViews.slice(artifactViewsBeforeLiveRun)).not.toContain("full");
  expect(artifactViews.slice(artifactViewsBeforeLiveRun)).not.toContain("postgame-redacted");
});

test("hands a successful live spectator directly to its postgame-redacted artifact without reading the operator registry", async ({ page }) => {
  test.setTimeout(15_000);
  const artifactViews: string[] = [];
  const registryReadsDuringLive: string[] = [];
  let liveStartAcknowledged = false;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/artifact")) artifactViews.push(url.searchParams.get("view") ?? "default");
  });

  await page.goto("/?workspace=domain", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
  const artifactViewsBeforeLiveRun = artifactViews.length;

  await page.route("**/api/matches", async (route) => {
    if (route.request().method() === "GET" && liveStartAcknowledged) {
      registryReadsDuringLive.push(route.request().url());
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "registry not available to spectator" }) });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/matches/run", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    liveStartAcknowledged = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        artifactVersion: "server.match-live-start.v1",
        kind: "match-live-start",
        matchId: fixtureMatchId,
        lifecycle: "running",
        artifactAvailable: false,
        projection: { view: "live-public", privateEvidenceRedacted: true, postgameTruthRedacted: true }
      })
    });
  });
  let liveReads = 0;
  await page.route(`**/api/matches/${fixtureMatchId}/live`, async (route) => {
    liveReads += 1;
    const body =
      liveReads === 1
        ? {
            artifactVersion: "server.match-live-projection.v1",
            kind: "match-live-projection",
            matchId: fixtureMatchId,
            lifecycle: "running",
            artifactAvailable: false,
            projection: { view: "live-public", privateEvidenceRedacted: true, postgameTruthRedacted: true },
            publicState: { phase: "day", day: 1, players: [], speeches: [], votes: [], deaths: [] }
          }
        : {
            artifactVersion: "server.match-live-projection.v1",
            kind: "match-live-projection",
            matchId: fixtureMatchId,
            lifecycle: "completed",
            artifactAvailable: true
          };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.getByRole("button", { name: "运行实验", exact: true }).click();
  await expect(page.getByTestId("live-spectator-shell")).toBeVisible();
  await expect(page.getByTestId("werewolf-live-board")).toContainText("实时公开局面 · 服务端权威");
  await expect(page.getByTestId("werewolf-live-board")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId("werewolf-review-board")).toBeVisible();
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
  expect(liveReads).toBeGreaterThanOrEqual(2);
  expect(registryReadsDuringLive).toEqual([]);
  expect(artifactViews.slice(artifactViewsBeforeLiveRun)).toContain("postgame-redacted");
  expect(artifactViews.slice(artifactViewsBeforeLiveRun)).not.toContain("full");
});

test("loads a server-authoritative native replay frame without a browser-side game transition", async ({ page }) => {
  const pageErrors: string[] = [];
  const artifactViews: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/artifact")) artifactViews.push(url.searchParams.get("view") ?? "default");
  });

  await page.goto("/?workspace=timeline", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
  const controls = page.getByTestId("server-replay-cursor-controls");
  await expect(controls).toBeVisible();
  const cursor = controls.getByRole("combobox", { name: "跳转服务端回放帧" });
  const frameResponse = page.waitForResponse((response) => isReplayFrameResponse(response));
  await cursor.click();
  await cursor.press("ArrowDown");
  await cursor.press("Enter");
  const response = await frameResponse;
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.frame).toMatchObject({
    artifactVersion: "server.match-replay-frame.v1",
    kind: "match-replay-frame",
    authority: "native-social-episode",
    source: "server-owned-match-artifact",
    projection: { view: "postgame-redacted", privateEvidenceRedacted: true },
    cursor: { nativeStepCount: expect.any(Number), stateHash: expect.any(String), recordedPostStateHash: expect.any(String) }
  });
  expect(body.frame.cursor.nativeStepCount).toBeGreaterThan(0);
  expect(body.frame).not.toHaveProperty("agents");
  expect(body.frame).not.toHaveProperty("socialEpisode");
  expect(JSON.stringify(body.frame)).not.toContain("privateMemos");

  await page.getByRole("menuitem", { name: /狼人杀复盘/ }).click();
  const board = page.getByTestId("werewolf-review-board");
  await expect(board.getByText("狼人杀回放局面")).toBeVisible();
  await expect(board).toContainText("服务端基于已记录原生步骤重放");

  const projection = page.getByRole("combobox", { name: "工件投影" });
  const truthArtifact = page.waitForResponse((next) => isArtifactResponse(next, "truth-redacted"));
  await projection.click();
  await projection.press("ArrowDown");
  await projection.press("Enter");
  await truthArtifact;
  await page.getByRole("menuitem", { name: /时间线/ }).click();
  await expect(page.getByText("真相脱敏视图不暴露原生 scheduler 游标")).toBeVisible();
  await expect(page.getByTestId("server-replay-cursor-controls")).toHaveCount(0);
  expect(artifactViews).not.toContain("full");
  expect(pageErrors).toEqual([]);
});

test("renders social evidence as a server-projected graph and keeps interaction in the existing inspector", async ({ page }) => {
  const artifactViews: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/artifact")) artifactViews.push(url.searchParams.get("view") ?? "default");
  });

  await page.goto("/?workspace=society", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
  const graph = page.getByTestId("social-evidence-graph");
  await expect(graph).toBeVisible();
  await expect(graph.getByRole("group", { name: "Agent 社会可见性与通信证据图" })).toBeVisible();

  const agentNode = graph.getByRole("button", { name: "查看 agent p1 的社会证据" });
  await expect(agentNode).toBeVisible();
  await agentNode.focus();
  await agentNode.press("Space");
  await expect(page.getByText("Agent p1")).toBeVisible();
  expect(artifactViews).not.toContain("full");
});

test("moves keyboard focus into the named main workspace through the skip link", async ({ page }) => {
  await page.goto("/?workspace=society", { waitUntil: "domcontentloaded" });
  const skipLink = page.getByRole("link", { name: "跳至工作区内容" });
  await skipLink.focus();
  await skipLink.press("Enter");
  await expect(page.getByRole("main", { name: "社会 工作区" })).toBeFocused();
});

test.describe("compact cockpit", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("keeps every artifact workspace within the viewport", async ({ page }) => {
    const workspaces = [
      ["timeline", "时间线"],
      ["domain", "狼人杀复盘"],
      ["society", "社会"],
      ["lineage", "谱系"],
      ["evaluation", "评测"],
      ["experiments", "实验矩阵"],
      ["compare", "对比"],
      ["packs", "公开包"]
    ] as const;

    for (const [workspace, label] of workspaces) {
      await page.goto(`/?workspace=${workspace}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
      // Compact controls are provided by explicit Drawers. The desktop
      // sidebars must be absent rather than collapsed to a focusable 0px box.
      await expect(page.locator(".ant-layout-sider")).toHaveCount(0);
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
    // Bootstrap can select a recorded artifact for the desktop side panel, but
    // on a 390px viewport the full-width evidence drawer must never cover the
    // Cockpit before the researcher explicitly asks to see it.
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

test("blocks an invalid roster assignment in the browser before it can start a match", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");

  await page.getByRole("button", { name: "实验编排" }).click();
  const composer = page.getByRole("dialog", { name: "实验编排 · Agent Roster" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "profile 1 id" }).fill("wolves");
  await composer.getByRole("textbox", { name: "profile 2 id" }).fill("village");

  const strategy = composer.getByRole("combobox", { name: "Agent assignment strategy" });
  await strategy.click();
  await strategy.press("ArrowDown");
  await strategy.press("ArrowDown");
  await strategy.press("ArrowDown");
  await strategy.press("Enter");
  const wolvesTeam = composer.getByRole("combobox", { name: "Agent assignment team werewolves" });
  await expect(wolvesTeam).toBeVisible();
  await wolvesTeam.click();
  await wolvesTeam.press("ArrowDown");
  await wolvesTeam.press("Enter");

  // Whichever valid profile keyboard selection chose is now dangling. The UI
  // must fail this request locally rather than asking the server to discover it.
  await composer.getByRole("textbox", { name: "profile 1 id" }).fill("retired-wolves");
  await composer.getByRole("textbox", { name: "profile 2 id" }).fill("retired-village");
  await composer.getByRole("button", { name: "完成编排" }).click();

  let matchRunRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/matches/run") {
      matchRunRequests += 1;
    }
  });
  await page.getByRole("button", { name: "运行实验" }).click();
  const runError = page.getByRole("alert").filter({ hasText: "无法启动：实验编排草案无效" });
  await expect(runError).toContainText("无法启动：实验编排草案无效");
  await expect(runError).toContainText("unknown profile id");
  expect(matchRunRequests).toBe(0);
});

// The remaining write tests intentionally run after every read-only fixture
// assertion so the bootstrap path keeps selecting the recorded fixture match.
test("submits a heterogeneous Agent roster through the existing harness control plane", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");

  await page.getByRole("button", { name: "实验编排" }).click();
  const composer = page.getByRole("dialog", { name: "实验编排 · Agent Roster" });
  await expect(composer).toBeVisible();

  // The fixture config exposes two generic OpenAI-compatible model names.
  // We only edit durable profile ids and control-plane conditions; neither
  // browser code nor this request resolves seats, roles, or game truth.
  await composer.getByRole("textbox", { name: "profile 1 id" }).fill("wolves");
  await composer.getByRole("textbox", { name: "profile 2 id" }).fill("village");
  await composer.getByRole("textbox", { name: "profile 1 temperature" }).fill("0.2");
  await composer.getByRole("textbox", { name: "profile 2 temperature" }).fill("0.8");

  const strategy = composer.getByRole("combobox", { name: "Agent assignment strategy" });
  await strategy.click();
  await strategy.press("ArrowDown");
  await strategy.press("ArrowDown");
  await strategy.press("ArrowDown");
  await strategy.press("Enter");
  await expect(composer.getByRole("combobox", { name: "Agent assignment team werewolves" })).toBeVisible();

  const wolvesTeam = composer.getByRole("combobox", { name: "Agent assignment team werewolves" });
  await wolvesTeam.click();
  await wolvesTeam.press("ArrowDown");
  await wolvesTeam.press("Enter");
  await composer.getByRole("button", { name: "完成编排" }).click();

  const submittedRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return request.method() === "POST" && url.pathname === "/api/matches/run";
  });
  const runResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/matches/run";
  });
  await page.getByRole("button", { name: "运行实验" }).click();

  const request = await submittedRequest;
  const body = request.postDataJSON() as {
    models?: unknown;
    profiles?: Array<{ id?: unknown; model?: unknown; temperature?: unknown }>;
    assignment?: { strategy?: unknown; fallback?: unknown; teams?: Record<string, unknown> };
    [key: string]: unknown;
  };
  expect(body.models).toEqual(["fixture-model", "fixture-rival"]);
  expect(body.profiles).toEqual([
    { id: "wolves", model: "fixture-model", temperature: 0.2 },
    { id: "village", model: "fixture-rival", temperature: 0.8 }
  ]);
  expect(body.assignment).toMatchObject({
    strategy: "team",
    fallback: "profile-rotation",
    // Ant Design's keyboard navigation starts at an implementation-dependent
    // option offset for an empty Select. The contract under test is that the
    // selected profile id is carried to the server, not visual option order.
    teams: { werewolves: expect.stringMatching(/^(wolves|village)$/) }
  });
  expect(body).not.toHaveProperty("resolvedAssignments");
  expect(body).not.toHaveProperty("artifact");
  expect(body).not.toHaveProperty("winner");
  expect(body.live).toBe(true);

  const response = await runResponse;
  expect(response.status()).toBe(202);
  expect(response.ok()).toBeTruthy();
  const start = await response.json();
  expect(start).toMatchObject({
    artifactVersion: "server.match-live-start.v1",
    kind: "match-live-start",
    matchId: expect.any(String),
    lifecycle: "running",
    artifactAvailable: false,
    projection: { view: "live-public", privateEvidenceRedacted: true, postgameTruthRedacted: true }
  });
  // The immediate response only acknowledges the server-owned run. Its
  // terminal artifact remains server-owned and is fetched later through the
  // ordinary redacted route after the live projection reaches a terminal state.
  expect(start).not.toHaveProperty("artifact");
  expect(start).not.toHaveProperty("state");
  expect(start).not.toHaveProperty("models");
});

test("submits the selected parallel scheduler when exporting a tournament public pack", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/?workspace=packs", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
  await expect(page.getByRole("tabpanel", { name: "公开包" })).toBeVisible();

  const scheduler = page.getByRole("combobox", { name: "联合阶段调度" });
  await scheduler.click();
  await scheduler.press("ArrowDown");
  await scheduler.press("Enter");

  const submittedRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return request.method() === "POST" && url.pathname === "/api/tournaments/run";
  });
  const tournamentResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/tournaments/run";
  });
  await page.getByRole("button", { name: "导出公开包" }).click();

  const request = await submittedRequest;
  const body = request.postDataJSON() as {
    models?: unknown;
    profiles?: unknown;
    assignment?: unknown;
    jointPhaseScheduler?: unknown;
    exportArtifacts?: unknown;
    [key: string]: unknown;
  };
  expect(body.jointPhaseScheduler).toBe("parallel");
  expect(body.exportArtifacts).toBe(true);
  expect(Array.isArray(body.models)).toBeTruthy();
  expect(Array.isArray(body.profiles)).toBeTruthy();
  expect(body.assignment).toBeTruthy();
  expect(body).not.toHaveProperty("resolvedAssignments");
  expect(body).not.toHaveProperty("artifact");
  expect(body).not.toHaveProperty("winner");

  const response = await tournamentResponse;
  expect(response.ok()).toBeTruthy();
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

function isReplayFrameResponse(response: Response): boolean {
  const url = new URL(response.url());
  return response.request().method() === "POST" && url.pathname === `/api/matches/${fixtureMatchId}/replay/frame`;
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
