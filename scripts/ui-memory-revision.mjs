import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { enterEpisode, remember, reviseMemory } from "../src/agents/cognition.ts";

const directory = path.resolve(process.env.AGENT_REVISION_UI_DIR ?? `data/memory-revision-ui-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const base = process.env.AGENT_UI_BASE ?? "http://127.0.0.1:8794";
const runId = process.env.AGENT_UI_RUN ?? "c2598218-0367-4149-9c09-e35ecddbd84a";
const endpoint = `${base}/api/v2/runs/${runId}?view=research`;
const response = await fetch(endpoint); assert.equal(response.status, 200);
const fixture = await response.json(); const original = JSON.stringify(fixture);
const actor = fixture.characters[0];
const event = fixture.events.findLast(event => event.actorId === actor.id && event.data.cognition);
assert.ok(event);
const mind = enterEpisode(event.data.cognition, actor.id, event.data.cognition.episode);
event.data.cognition = mind;
const sourceIds = event.data.sourceIds;
assert.ok(sourceIds.length);
const optimistic = remember(mind, { kind: "procedural", scope: "transferable", confidence: .95, sourceIds, tags: ["界面夹具"],
  text: "只要对方作出承诺，就总能兑现。", when: "对方承诺返还", then: "提高投入" });
reviseMemory(mind, { id: optimistic.id, change: "revise", sourceIds,
  reason: "实际返还与承诺不符，需要根据已经发生的行为重新判断，并保留新的不确定性。",
  replacement: { kind: "procedural", scope: "transferable", confidence: .5, tags: ["界面夹具"],
    text: "承诺需要兑现记录支持。", when: "承诺尚未获得实际行为支持", then: "先核验行为再决定投入" } });
const obsolete = remember(mind, { kind: "semantic", scope: "transferable", confidence: .6, sourceIds, tags: ["界面夹具"],
  text: "已经不适用的旧判断仍可在历史中查看。", when: null, then: null });
reviseMemory(mind, { id: obsolete.id, change: "retire", sourceIds, reason: "当前情境已经变化，这条判断停止参与下一次决策。", replacement: null });

const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
try {
  const page = await browser.newPage(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.evaluateOnNewDocument(({ streamEndpoint, fixture }) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = new URL(typeof input === "string" ? input : input.url, location.origin).href;
      if (url !== streamEndpoint) return originalFetch(input, options);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(fixture)}\n\n`));
        options?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      } }), { headers: { "content-type": "text/event-stream" } }));
    };
  }, { streamEndpoint: `${base}/api/v2/runs/${runId}/events?view=research`, fixture });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${base}/#/research/${runId}`, { waitUntil: "networkidle2" });
  await page.locator('[role="tab"] ::-p-text(心理与决策)').click();
  const scope = `[aria-label="${actor.name}的心理视角"] [data-testid="general-cognition"]`;
  const selector = `${scope} [data-testid="memory-revisions"]`;
  await page.waitForSelector(selector);
  await page.$$eval(`${selector} button`, buttons => buttons.forEach(button => button.click()));
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes("修订后：承诺需要兑现记录支持。"), {}, selector);
  const measurements = [];
  for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
    await page.setViewport({ width, height });
    await page.$eval(selector, node => node.scrollIntoView({ block: "start" }));
    const text = await page.$eval(scope, node => node.textContent);
    for (const value of ["修订判断", "停用判断", "已停用", "95% → 50%", "原判断：只要对方作出承诺，就总能兑现。", "修订后：承诺需要兑现记录支持。", "先核验行为再决定投入"]) assert.ok(text.includes(value), value);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}px viewport must not overflow`);
    const overflow = await page.$$eval(`${selector} p`, nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent));
    assert.deepEqual(overflow, []);
    measurements.push({ width, height, overflow });
    await page.screenshot({ path: path.join(directory, `memory-revision-${name}.png`), fullPage: false });
  }
  assert.deepEqual(errors, []);
  assert.equal(JSON.stringify(await (await fetch(endpoint)).json()), original, "UI fixture must not change stored model evidence");
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ passed: true, actualModelEvidence: false, fixture: true,
    sourceRunId: runId, databaseUnchanged: true, expandedBeforeAndAfter: true, retirementDisplayed: true, measurements, errors, at: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture: true, databaseUnchanged: true, artifact: directory }));
} finally { await browser.close(); }
