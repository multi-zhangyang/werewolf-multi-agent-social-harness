import puppeteer from "puppeteer-core";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fixtureDecision } from "../tests/partners/fixture.ts";
import { PartnerService } from "../src/partners/service.ts";

process.env.SOCIETY_DATABASE_FILE = ":memory:";
process.env.SOCIETY_OPERATOR_TOKEN = "partners-scroll-ui-fixture";
process.env.SOCIETY_MODEL_SETTINGS_FILE = "data/partners-ui/scroll-models.json";
process.env.SOCIETY_CHARACTERS_FILE = "data/partners-ui/scroll-characters.json";
mkdirSync("data/partners-ui", { recursive: true });
const { context, createServerApp } = await import("../src/server/index.ts");
context.partners = new PartnerService(context.partners.store, () => ({ configuration: { fixture: true }, async decide(input) {
  const activity = { actorId: input.actorId, at: new Date().toISOString(), attempt: 1, tool: "recall", input: { query: "承诺与投入" } };
  input.onActivity?.({ ...activity, id: randomUUID(), kind: "tool_start" });
  input.onActivity?.({ ...activity, id: randomUUID(), kind: "tool_end", output: { source: "offline fixture", found: 1 } });
  return fixtureDecision(input);
} }));
const created = context.partners.create({ mode: "observe", maxRounds: 3 });
await context.partners.waitForRun(created.id);
assert.equal(context.partners.get(created.id).status, "completed");
const earlyEvent = context.partners.get(created.id).world.events.find(event => event.kind === "offer");
const server = await new Promise(resolve => { const s = createServerApp().listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const page = await browser.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message));
async function geometry() { return page.evaluate(id => {
  const button = document.querySelector(`[data-event-id="${id}"] button`);
  const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const parents = []; let node = button;
  while (node) { parents.push({ tag: node.tagName, class: node.className, rect: rect(node), scroll: node.scrollTop, height: node.scrollHeight, client: node.clientHeight, overflow: getComputedStyle(node).overflow }); node = node.parentElement; }
  return { button: Boolean(button), parents };
}, earlyEvent.id); }
try {
  await page.setViewport({ width: 1536, height: 960 }); await page.goto(base, { waitUntil: "networkidle2" });
  await page.evaluate(() => localStorage.setItem("society:owner-token", "partners-scroll-ui-fixture"));
  await page.goto(`${base}/#/partners/${created.id}`, { waitUntil: "networkidle2" });
  await page.locator('[data-slot="toggle-group-item"] ::-p-text(研究)').click();
  await page.waitForFunction(() => document.body.textContent.includes("人物内部状态"));
  const before = await geometry();
  const cycles = [];
  for (const width of [1536, 390, 1280, 1920, 768, 1536]) {
    await page.setViewport({ width, height: width < 768 ? 844 : 960 });
    const historyBox = await page.$eval('[data-testid="partners-conversation"]', node => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(historyBox.x, historyBox.y); await page.mouse.wheel({ deltaY: -10000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="partners-conversation"] > div')?.scrollTop < 2);
    await page.locator(`[data-event-id="${earlyEvent.id}"] button`).setTimeout(10000).click();
    await page.waitForFunction(revision => document.querySelector('[data-testid="mind-timepoint"]')?.textContent.includes(`第 ${revision} 次行动后的心理状态`) && !document.querySelector('[data-slot="skeleton"]'), {}, earlyEvent.revision);
    cycles.push({ width, historySelected: true });
    if (width < 768) { await page.keyboard.press("Escape"); await page.waitForSelector('[role="dialog"]', { hidden: true }); }
    // A real wheel gesture must be able to read earlier messages without follow-scroll reclaiming them.
    const box = await page.$eval('[data-testid="partners-conversation"]', node => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(box.x, box.y); await page.mouse.wheel({ deltaY: 10000 });
    await page.waitForFunction(() => { const s = document.querySelector('[data-testid="partners-conversation"] > div'); return s.scrollHeight - s.scrollTop - s.clientHeight < 3; });
    await page.mouse.wheel({ deltaY: -450 });
    await page.waitForFunction(() => { const s = document.querySelector('[data-testid="partners-conversation"] > div'); return s.scrollHeight - s.scrollTop - s.clientHeight > 100; });
    const samples = await page.evaluate(async () => {
      const s = document.querySelector('[data-testid="partners-conversation"] > div'); const positions = [];
      for (let i = 0; i < 100; i++) { await new Promise(window.requestAnimationFrame); positions.push(s.scrollTop); }
      return positions;
    });
    assert.ok(Math.max(...samples.slice(-50)) - Math.min(...samples.slice(-50)) <= 1, `History scroll must settle without oscillation at ${width}px`);
    await page.locator('[data-slot="toggle-group-item"] ::-p-text(现场)').click();
    await page.waitForSelector('[data-runtime-id]', { hidden: true });
    await page.locator('[data-slot="toggle-group-item"] ::-p-text(研究)').click();
    await page.waitForSelector('[data-testid="research-toolbar"]');
  }
  assert.deepEqual(errors, []);
  writeFileSync("data/partners-ui/scroll-result.json", JSON.stringify({ source: "offline fixture", before, after: await geometry(), cycles, errors }, null, 2));
  console.log("Long AI Elements conversation: earliest event remains accessible after enabling runtime history.");
} catch (error) {
  writeFileSync("data/partners-ui/scroll-failure.json", JSON.stringify({ geometry: await geometry(), error: String(error), errors }, null, 2));
  await page.screenshot({ path: "data/partners-ui/scroll-failure.png" }); throw error;
} finally { context.partners.stopAll(); await context.partners.settled(); await browser.close(); context.liveConnections.closeAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); context.runs.store.close(); }
