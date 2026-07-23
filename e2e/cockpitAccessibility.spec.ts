import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const criticalWorkspaces = [
  { id: "runs", label: "运行" },
  { id: "domain", label: "狼人杀复盘" },
  { id: "society", label: "社会" }
] as const;

async function waitForRecordedCockpit(page: Page): Promise<void> {
  await expect(page.getByRole("status")).toContainText("已加载脱敏工件");
}

async function expectWcagAa(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations,
    results.violations
      .map((violation) => `${violation.id}: ${violation.help}\n${violation.nodes.map((node) => node.target.join(" ")).join("\n")}`)
      .join("\n\n")
  ).toEqual([]);
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 }
] as const) {
  test.describe(`${viewport.name} WCAG 2.2 AA`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const workspace of criticalWorkspaces) {
      test(`${workspace.label} workspace has no automated WCAG A/AA violations`, async ({ page }) => {
        await page.goto(`/?workspace=${workspace.id}`, { waitUntil: "domcontentloaded" });
        await waitForRecordedCockpit(page);
        await expect(page.getByRole("main", { name: `${workspace.label} 工作区` })).toBeVisible();
        await expectWcagAa(page);
      });
    }
  });
}

test.describe("compact keyboard and reflow", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("returns focus to each drawer trigger and remains usable with reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/?workspace=runs", { waitUntil: "domcontentloaded" });
    await waitForRecordedCockpit(page);

    const contextTrigger = page.getByRole("button", { name: "打开运行上下文" });
    await contextTrigger.click();
    await expect(page.getByRole("dialog", { name: "运行上下文" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "运行上下文" })).toBeHidden();
    await expect(contextTrigger).toBeFocused();

    const inspectorTrigger = page.getByRole("button", { name: "打开证据检查器" });
    await inspectorTrigger.click();
    await expect(page.getByRole("dialog", { name: "Evidence Inspector" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Evidence Inspector" })).toBeHidden();
    await expect(inspectorTrigger).toBeFocused();

    await inspectorTrigger.click();
    await page.getByRole("button", { name: "查看原始片段" }).click();
    await expect(page.getByRole("dialog", { name: "Evidence Inspector" })).toBeHidden();
    const rawEvidence = page.getByRole("textbox");
    await expect(rawEvidence).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(rawEvidence).toBeHidden();
    await expect(inspectorTrigger).toBeFocused();
  });

  test("reflows without horizontal document overflow at 320 CSS pixels", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/?workspace=domain", { waitUntil: "domcontentloaded" });
    await waitForRecordedCockpit(page);
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  });
});
