import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { assessStrategy, bindStrategyAssessments, completeEpisodeReview, consolidateStrategy, enterEpisode, integrateExperience, remember } from "../src/agents/cognition.ts";

const directory = path.resolve(process.env.STRATEGY_UI_DIR ?? `data/strategy-learning-ui-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const base = process.env.AGENT_UI_BASE ?? "http://127.0.0.1:8794";
const runId = process.env.AGENT_UI_RUN ?? "6df3ce63-3a1a-4cc6-b0bd-34deb5c7498a";
const endpoint = `${base}/api/v2/runs/${runId}?view=research`;
const response = await fetch(endpoint); assert.equal(response.status, 200);
const fixture = await response.json(); const original = JSON.stringify(fixture);
const actor = fixture.characters[0];
const event = fixture.events.findLast(event => event.actorId === actor.id && event.data.cognition); assert.ok(event);
const mind = enterEpisode(event.data.cognition, actor.id, event.data.cognition.episode); event.data.cognition = mind;
mind.episodeReviews = (mind.episodeReviews ?? []).filter(review => review.episode !== mind.episode);
const sourceIds = event.data.sourceIds; assert.ok(sourceIds.length);
const source = remember(mind, { kind: "episodic", scope: "transferable", text: "界面夹具：公开核验后的实际结果", sourceIds, confidence: 1, tags: ["界面夹具"], when: null, then: null });
let memory = consolidateStrategy(mind, { strategyId: null, memoryIds: [source.id], confidence: .55, tags: ["界面夹具"],
  text: "把承诺与实际行为分开核验", when: "有机会观察行为且能够承担试探代价；无法核验时应保持不确定", then: "根据核验结果调整下一次选择",
  rationale: "界面夹具：可复用的是核验与调整的关系，原局身份和具体金额不构成通用规则。" }, sourceIds);
memory.episode = "earlier-ui-fixture";
memory = consolidateStrategy(mind, { strategyId: memory.id, memoryIds: [source.id], confidence: .55, tags: ["界面夹具"],
  text: "把承诺与实际行为分开核验", when: "有机会观察行为且能够承担试探代价；无法核验时应保持不确定", then: "根据核验结果调整下一次选择",
  rationale: "界面夹具：修订已有原则并保留此前经历的来源；原局身份和具体金额不构成通用规则。" }, sourceIds);
assert.equal(memory.episode, mind.episode); assert.equal(memory.revisions[0].previous.episode, "earlier-ui-fixture");
const historical = assessStrategy(mind, { id: memory.id, sourceIds, verdict: "apply", matching: "旧版界面夹具", differences: "旧版没有记录动作的明确选择", adaptation: null }, "ui-legacy", 4);
const legacy = { id: "ui-legacy-decision", episode: mind.episode, round: 4, action: "contribute", strategy: "probe", intent: "none", privateAim: "旧版界面夹具", predictionIds: [], assessmentIds: [historical.id] };
mind.decisions.push(legacy); historical.decisionIds.push(legacy.id);
const adopted = assessStrategy(mind, { id: memory.id, sourceIds, verdict: "adapt", matching: "仍然面对需要验证的承诺", differences: "当前是多人合作，共同结果不能直接归因给某个人", adaptation: "先区分个体贡献和共同结果，再调整自己的风险" }, "ui-adopt", 4);
const decision = { id: "ui-decision", episode: mind.episode, round: 4, action: "contribute", strategy: "probe", intent: "none", privateAim: "界面夹具", predictionIds: [],
  strategyBasis: { assessmentIds: [adopted.id], reason: "界面夹具：以当前版本核验策略限制实际投入" } };
bindStrategyAssessments(mind, "ui-adopt", decision); mind.decisions.push(decision);
integrateExperience(mind, { id: "ui-feedback", episode: mind.episode, seq: (mind.cursors[mind.episode] ?? 0) + 1, round: 4,
  kind: "outcome", name: "settlement", text: "界面夹具所得", data: { payoffs: { [actor.id]: 3 } }, reward: { value: 3, normalized: .1, unit: "points" } });
assert.equal(adopted.feedback.length, 1);
assessStrategy(mind, { id: memory.id, sourceIds, verdict: "reject", matching: "仍然存在利益冲突", differences: "这次没有独立核验机会，不满足原策略的适用条件", adaptation: null }, "ui-reject", 4);
completeEpisodeReview(mind, { status: "ready", sourceIds, strategyIds: [memory.id], summary: "界面夹具：保留核验与调整的假设，下一场景须重新判断适用范围。" }, "ui-review");

const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
try {
  const page = await browser.newPage(); const errors = [], measurements = [];
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
  const scope = `[aria-label="${actor.name}的心理视角"] [data-testid="general-cognition"]`;
  const selector = `${scope} [data-testid="strategy-assessments"]`;
  await page.waitForSelector(selector);
  for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
    await page.setViewport({ width, height });
    await page.$eval(selector, node => node.scrollIntoView({ block: "start" }));
    const text = await page.$eval(selector, node => node.textContent);
    for (const value of ["调整后采用", "不适用", "来自此前经历", "未采用这条策略", "明确采用 1 次实际行动", "历史自动关联", "实际结算：3 点", "当前是多人合作"]) assert.ok(text.includes(value), value);
    assert.ok(await page.$eval(scope, node => node.textContent.includes("选择理由：界面夹具：以当前版本核验策略限制实际投入")));
    const overflow = await page.$$eval(`${selector} p`, nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.textContent));
    assert.deepEqual(overflow, []); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    measurements.push({ width, height, overflow });
    await page.screenshot({ path: path.join(directory, `strategy-assessment-${name}.png`), fullPage: false });
  }
  await page.locator(`${scope} button ::-p-text(由 ${new Set(sourceIds).size} 次结算、1 条记录提炼)`).click();
  await page.waitForFunction(scope => document.querySelector(scope)?.textContent.includes("原局身份和具体金额不构成通用规则"), {}, scope);
  await page.screenshot({ path: path.join(directory, "strategy-consolidation-mobile.png"), fullPage: false });
  const reviewSelector = `${scope} [data-testid="episode-review"]`;
  for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
    await page.setViewport({ width, height }); await page.$eval(reviewSelector, node => node.scrollIntoView({ block: "start" }));
    const text = await page.$eval(reviewSelector, node => node.textContent);
    for (const value of ["整局复盘", "可供后续检验", "界面夹具：保留核验", "版本 2"]) assert.ok(text.includes(value), value);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(directory, `episode-review-${name}.png`), fullPage: false });
  }
  assert.deepEqual(errors, []); assert.equal(JSON.stringify(await (await fetch(endpoint)).json()), original);
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ passed: true, actualModelEvidence: false, fixture: true,
    sourceRunId: runId, databaseUnchanged: true, adoptionAndRejectionDisplayed: true, revisedOriginDisplayed: true, consolidationDisplayed: true, episodeReviewDisplayed: true, ledgerFeedbackDisplayed: true, measurements, errors, at: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ passed: true, actualModelEvidence: false, databaseUnchanged: true, artifact: directory }));
} catch (error) { await browser.pages().then(async pages => pages[0] && pages[0].screenshot({ path: path.join(directory, "failure.png") })); throw error; }
finally { await browser.close(); }
