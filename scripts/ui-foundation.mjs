import puppeteer from "puppeteer-core";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { mindFixture } from "../tests/helpers/psychology-fixture.ts";

process.env.SOCIETY_DATABASE_FILE = ":memory:";
process.env.SOCIETY_OPERATOR_TOKEN = "foundation-ui-test-only";
process.env.SOCIETY_MODEL_SETTINGS_FILE = "data/v7-ui/models-test.json";
process.env.SOCIETY_CHARACTERS_FILE = "data/v7-ui/characters-test.json";
mkdirSync("data/v7-ui", { recursive: true });
const { context, createServerApp } = await import("../src/server/index.ts");
const { RunService } = await import("../src/runtime/run.ts");
const { defaultCapabilities, defaultContextPolicy } = await import("../src/society/models/defaults.ts");
const now = new Date().toISOString();
context.models.upsertProvider({ id: "fixture", name: "fixture", kind: "custom", baseURL: "https://offline.invalid/v1", apiKeyRef: "env:UNUSED_UI_KEY", apiMode: "chat-completions", enabled: true, createdAt: now, updatedAt: now });
context.models.upsertModelProfile({ id: "fixture", name: "离线 UI 夹具", modelId: "fixture", providerProfileId: "fixture", contextWindow: 32768, contextWindowSource: "manual", capabilities: defaultCapabilities(), contextPolicyId: defaultContextPolicy().id, defaults: {}, enabled: true });
context.models.setGlobalDefaults({ modelProfileId: "fixture" });
let holdFirst = true; let release; let activeContext;
context.runs = new RunService(context.runs.store, () => ({ async turn(c) {
  const sourceId = c.recent.findLast(e => e.data.identityScope)?.id ?? c.recent.at(-1).id;
  await c.call("update_mind", { ...mindFixture(sourceId, "unused"), relationships: [], conflict: "收益与公平", regulation: "none", predictions: [], ...(c.opportunity.actions.some(a => a.name === "pledge_return") ? { commitmentIntent: { plannedReturnPercent: 20, expectedInvestment: 6, purpose: "UI 夹具：观察承诺和计划的差距" } } : {}) });
  if (holdFirst) {
    holdFirst = false; activeContext = c;
    c.recordHarnessEvent({ kind: "tool_start", phase: "discussion", step: 1, attempt: 1, callId: "stable-call", toolName: "recall_memory", input: { query: "对方的承诺", about: null } });
    await new Promise(resolve => { release = resolve; });
  }
  for (const action of c.opportunity.actions) await c.call(action.name, { amount: action.name === "pledge_return" ? 80 : action.name === "invest" ? 6 : 0 });
  return { text: c.opportunity.stage.kind === "discussion" ? "你可以先说说自己的条件，我会看实际投入。" : undefined };
} }));
const server = await new Promise(resolve => { const s = createServerApp().listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
try {
  const page = await browser.newPage(); const errors = []; let createdId;
  page.on("pageerror", e => errors.push(e.message));
  page.on("response", async response => { if (response.url() === `${base}/api/v2/runs` && response.request().method() === "POST" && response.status() === 201) createdId = (await response.json()).run.id; });
  await page.setViewport({ width: 1536, height: 864, deviceScaleFactor: 1.25 });
  await page.goto(`${base}/#/legacy`, { waitUntil: "networkidle2" });
  await page.evaluate(() => localStorage.setItem("society:owner-token", "foundation-ui-test-only"));
  await page.screenshot({ path: "data/v7-ui/home-dark.png", fullPage: true });
  await page.locator('button ::-p-text(我来对局)').click();
  await page.waitForSelector('textarea[aria-label="说点什么"]');
  await page.type('textarea[aria-label="说点什么"]', "你准备返还多少？我会看实际到账。");
  await page.click('button[aria-label="发送"]');
  await page.waitForFunction(() => document.body.textContent.includes("正在回应"));
  await page.locator('[aria-label="观看视角"]').click();
  await page.locator('[role="option"] ::-p-text(研究视角 · 含工具)').click();
  await page.waitForSelector('[role="listbox"]', { hidden: true });
  await page.locator('[aria-label="展开检索自己的经历"]').click();
  await page.waitForFunction(() => document.querySelector('[aria-label="展开检索自己的经历"]')?.getAttribute("aria-expanded") === "true");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector('[aria-label="展开检索自己的经历"]')?.getAttribute("aria-expanded") === "false");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('[aria-label="展开检索自己的经历"]')?.getAttribute("aria-expanded") === "true");
  await page.evaluate(() => { window.fixtureTrigger = document.querySelector('[aria-label="展开检索自己的经历"]'); });
  activeContext.recordHarnessEvent({ kind: "tool_end", phase: "discussion", step: 1, attempt: 1, callId: "stable-call", toolName: "recall_memory", result: [], durationMs: 120 });
  await page.waitForFunction(() => document.querySelector('[aria-label="展开检索自己的经历"]')?.getAttribute("aria-expanded") === "true");
  assert.equal(await page.evaluate(() => window.fixtureTrigger === document.querySelector('[aria-label="展开检索自己的经历"]')), true);
  release();
  await page.waitForSelector('input[aria-label="投资"]');
  await page.locator('input[aria-label="投资"]').fill("11");
  assert.equal(await page.$eval('.human-composer button', button => button.disabled), true);
  await page.locator('input[aria-label="投资"]').fill("6");
  await page.screenshot({ path: "data/v7-ui/play-dark.png" });
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForSelector('.room-shell .mind-panel', { hidden: true });
  await page.locator('[aria-label="对局操作"]').click();
  await page.locator('[role="menuitem"] ::-p-text(暂停对局)').click();
  await page.waitForSelector('[role="menu"]', { hidden: true });
  await page.waitForFunction(() => document.querySelector('.room-heading p')?.textContent.includes("已暂停"));
  assert.equal(await page.$eval('.human-composer button', el => el.disabled), true);
  await page.locator('[aria-label="对局操作"]').click();
  await page.locator('[role="menuitem"] ::-p-text(恢复对局)').click();
  await page.waitForSelector('[role="menu"]', { hidden: true });
  await page.waitForFunction(() => document.querySelector('.room-heading p')?.textContent.includes("投资中"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.ok(await page.$eval('[data-slot="message-scroller-viewport"]', el => el.clientHeight >= 100), "Mobile conversation must keep usable reading space");
  await page.screenshot({ path: "data/v7-ui/play-mobile-dark.png" });
  await page.locator('.human-composer button ::-p-text(提交)').click();
  await page.setViewport({ width: 1536, height: 864, deviceScaleFactor: 1.25 });
  // Complete all remaining genuine UI opportunities, including the role swap.
  for (let guard = 0; guard < 55; guard++) {
    const run = context.runs.live.get(createdId);
    if (!run) break;
    const view = run.view({ research: true });
    const opportunity = view.opportunities[0];
    if (!opportunity) { await new Promise(resolve => setTimeout(resolve, 80)); continue; }
    if (!opportunity.actions.length) {
      await page.waitForSelector('.human-composer textarea');
      await page.locator('.human-composer button ::-p-text(先听听)').click();
    } else {
      const action = opportunity.actions[0];
      await page.waitForSelector(`input[aria-label="${action.fields[0].label}"]`);
      const value = action.name === "invest" ? 6 : action.name === "pledge_return" ? 50 : 0;
      await page.locator(`input[aria-label="${action.fields[0].label}"]`).fill(String(value));
      await page.locator('.human-composer button ::-p-text(提交)').click();
    }
    await page.waitForFunction(op => !document.querySelector('.human-composer') || document.querySelector('.human-composer').textContent !== op, { timeout: 1500 }, await page.$eval('.human-composer', n => n.textContent).catch(() => "")).catch(() => {});
  }
  await page.waitForFunction(() => document.body.textContent.includes("只读回放"));
  assert.equal(context.runs.store.get(createdId).status, "completed");
  await page.goto(`${base}/#/create?mode=experiment`, { waitUntil: "networkidle2" });
  const first = context.characters.list().builtins[0];
  await page.locator(`[aria-label="${first.displayName}的本局动机"]`).click();
  await page.locator('[role="option"] ::-p-text(个人收益)').click();
  await page.waitForSelector('[role="listbox"]', { hidden: true });
  assert.equal(await page.$eval(`[aria-label="${first.displayName}的本局动机"]`, e => e.textContent), "个人收益");
  await page.locator(`[aria-label="${first.displayName}的初始情绪"]`).click();
  await page.locator('[role="option"] ::-p-text(愤怒)').click();
  await page.waitForSelector('[role="listbox"]', { hidden: true });
  await page.focus(`[role="slider"][aria-label="${first.displayName}的情绪强度"]`); await page.keyboard.press("End");
  await page.type(`#objective-${first.id}`, "UI 夹具：争取投入，保留收益。");
  await page.screenshot({ path: "data/v7-ui/injection-dark.png", fullPage: true });
  await page.locator('button ::-p-text(开始互动)').click();
  await page.waitForFunction(() => location.hash.startsWith("#/runs/"));
  const experimentId = await page.evaluate(() => location.hash.split("/")[2]);
  const live = context.runs.live.get(experimentId); if (live) await live.settled();
  assert.equal(context.runs.store.events(experimentId).filter(e => e.data.origin === "researcher-intervention").length, 1);
  await page.goto(`${base}/#/research/${experimentId}`, { waitUntil: "networkidle2" });
  await page.locator('[role="tab"] ::-p-text(意图与承诺)').click();
  await page.waitForFunction(() => document.body.textContent.includes("公开承诺高于私下计划"));
  await page.screenshot({ path: "data/v7-ui/intent-dark.png", fullPage: true });
  await page.evaluate(() => localStorage.setItem("society:theme", "light"));
  await page.reload({ waitUntil: "networkidle2" }); await page.locator('[role="tab"] ::-p-text(意图与承诺)').click();
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: "data/v7-ui/intent-mobile-light.png", fullPage: true });
  assert.deepEqual(errors, []);
  writeFileSync("data/v7-ui/foundation-result.json", JSON.stringify({ source: "offline fixtures", play: "completed three rounds through UI", lifecycleIdentity: "preserved", injection: "recorded", intentAudit: "verified", errors }, null, 2));
  console.log("Foundation UI passed: full human controls across three rounds, role swap, stable open tool card, experiment injection, intent audit, keyboard, dark/light, mobile.");
} catch (error) {
  const page = (await browser.pages()).at(-1);
  await page.screenshot({ path: "data/v7-ui/foundation-failure.png", fullPage: true });
  console.log(await page.evaluate(() => document.body.innerText.slice(-3500)));
  console.log(await page.evaluate(() => ({ focused: document.activeElement?.outerHTML.slice(0, 800), tool: document.querySelector('[aria-label="展开检索自己的经历"]')?.outerHTML.slice(0, 800) })));
  throw error;
} finally {
  release?.(); context.runs.stopAll(); await Promise.all([...context.runs.live.values()].map(r => r.settled()));
  await browser.close(); context.liveConnections.closeAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); context.runs.store.close();
}
