import puppeteer from "puppeteer-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { strict as assert } from "node:assert";

// Read-only browser inspection of real model runs. Never creates or restarts a trial.
const manifest = JSON.parse(readFileSync("data/v5-final-studies.json", "utf8"));
mkdirSync("data/v5-live-ui", { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_BIN ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const evidence = { capturedAt: new Date().toISOString(), modelData: "real", studies: manifest, errors: [], screenshots: [] };
try {
  const page = await browser.newPage();
  page.on("pageerror", error => evidence.errors.push(error.message));
  await page.setViewport({ width: 1512, height: 1000 });
  async function access(base) {
    await page.goto(base, { waitUntil: "networkidle2" });
    await page.evaluate(token => { if (token) localStorage.setItem("society:owner-token", token); localStorage.setItem("society:theme", "dark"); }, process.env.SOCIETY_OPERATOR_TOKEN ?? "");
  }
  async function shot(name, fullPage = true) {
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name}: page overflow`);
    assert.equal(await page.$$eval('[data-slot="sheet-content"]', nodes => nodes.every(node => { const bounds = node.getBoundingClientRect(); return bounds.left >= -1 && bounds.right <= window.innerWidth + 1; })), true, `${name}: panel outside viewport`);
    const path = `data/v5-live-ui/${name}.png`;
    await page.screenshot({ path, fullPage }); evidence.screenshots.push(path);
  }
  await access(manifest.repair.base);
  await page.goto(`${manifest.repair.base}/#/studies/${manifest.repair.id}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".study-branches");
  await page.waitForFunction(() => document.body.textContent.includes("原始案例复核"));
  await shot("branches-dark");
  const inspect = await page.$(".study-branches button:not([disabled])");
  if (inspect) {
    await inspect.click(); await page.waitForSelector('[data-slot="sheet-content"] .mind-panel');
    await shot("psychology-dark", false);
    await page.locator('[data-slot="sheet-content"] ::-p-aria(决策案例)').click();
    await page.waitForFunction(() => document.body.textContent.includes("共同前段"));
    await page.locator('button ::-p-text(查看案例)').click();
    await page.waitForFunction(() => document.body.textContent.includes("固定输入 · 隔离复测"));
    await shot("decision-case-dark", false);
    await page.locator('::-p-aria(完整输入)').click();
    await page.waitForFunction(() => [...document.querySelectorAll("pre")].some(p => p.textContent.includes("tools")));
    await shot("decision-input-dark", false);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.body.textContent.includes("固定输入 · 隔离复测"));
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-slot="sheet-content"]', { hidden: true });
  }
  await page.locator("::-p-aria(行为分布)").click();
  await page.waitForSelector(".recharts-surface"); await shot("distribution-dark");
  await page.evaluate(() => localStorage.setItem("society:theme", "light"));
  await page.reload({ waitUntil: "networkidle2" }); await page.waitForSelector(".study-branches");
  await shot("branches-light");
  await page.setViewport({ width: 390, height: 844 }); await shot("branches-mobile");
  await page.evaluate(() => localStorage.setItem("society:theme", "dark"));
  await page.reload({ waitUntil: "networkidle2" }); await page.waitForSelector(".study-branches");
  await shot("branches-mobile-dark");
  await page.setViewport({ width: 1512, height: 1000 });
  const db = new Database(manifest.free.database, { readonly: true });
  const freeStudy = JSON.parse(db.prepare("select document from studies where id=?").get(manifest.free.id).document);
  const runId = freeStudy.trials.find(t => t.status === "completed" && t.runId)?.runId; db.close();
  if (runId) {
    await access(manifest.free.base);
    await page.goto(`${manifest.free.base}/#/runs/${runId}`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".room-shell", { timeout: 20000 });
    await page.waitForSelector(".mind-appraisal"); await shot("free-room");
    await page.goto(`${manifest.free.base}/#/research/${runId}`, { waitUntil: "networkidle2" });
    await page.locator('::-p-aria(轨迹)').click();
    await page.locator('button[aria-label="展开更新主观心理状态"]').click();
    await page.waitForSelector('[data-slot="collapsible-content"][data-state="open"]');
    await page.waitForSelector('[data-slot="collapsible-content"][data-state="open"] [data-slot="table"]');
    await shot("tools-dark", false);
    await page.setViewport({ width: 390, height: 844 }); await shot("tools-mobile-dark", false);
    evidence.freeRunId = runId;
  }
  assert.deepEqual(evidence.errors, []);
  console.log(JSON.stringify(evidence));
} finally {
  writeFileSync("data/v5-live-ui/manifest.json", JSON.stringify(evidence, null, 2));
  await browser.close();
}
