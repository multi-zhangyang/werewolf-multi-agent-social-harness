import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { RunService } from "../src/runtime/run.ts";
import { runSpecSchema } from "../src/runtime/types.ts";
import { generalFixture } from "../tests/helpers/general-agent-fixture.ts";
import { runtimeCharacter } from "../src/server/routes/runs.ts";

const directory = path.resolve(process.env.SIGNALING_UI_DIR ?? `data/signaling-ui-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const registryHash = () => createHash("sha256").update(readFileSync("data/model-settings.json")).digest("hex");
const beforeRegistry = registryHash();
cpSync("data/model-settings.json", path.join(directory, "model-settings.json"));
process.env.SOCIETY_MODEL_SETTINGS_FILE = path.join(directory, "model-settings.json");
process.env.SOCIETY_DATABASE_FILE = path.join(directory, "fixture.sqlite");
process.env.SOCIETY_OPERATOR_TOKEN = "";
process.env.HOST = "127.0.0.1";
const { context, createServerApp } = await import("../src/server/index.ts");
const fixture = generalFixture();
context.runs = new RunService(context.runs.store, fixture.factory);
const server = createServerApp().listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
let humanRun;
let page;
let step = "create";
console.log(JSON.stringify({ artifact: directory, fixture: true }));
try {
  page = await browser.newPage(); const errors = []; const measurements = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${base}/#/create?scenario=signaling-game&mode=experiment`, { waitUntil: "networkidle2" });
  const condition = '[aria-label="信息交易收益条件"]';
  await page.waitForSelector(condition);
  const initialNames = await page.$$eval(".selected-personalities strong", nodes => nodes.map(node => node.textContent));
  await page.locator(`${condition} ::-p-text(利益一致)`).click();
  assert.ok((await page.$eval(condition, node => node.closest('[data-slot="field"]').textContent)).includes("发送者得 0 点"));
  await page.locator('button ::-p-text(交换发送者与接收者)').click();
  assert.deepEqual(await page.$$eval(".selected-personalities strong", nodes => nodes.map(node => node.textContent)), [...initialNames].reverse());
  await page.screenshot({ path: path.join(directory, "create-desktop.png"), fullPage: true });
  const created = page.waitForResponse(response => response.url() === `${base}/api/v2/runs` && response.request().method() === "POST");
  await page.locator('button ::-p-text(开始互动)').click();
  const response = await created; assert.equal(response.status(), 201);
  const submitted = JSON.parse(response.request().postData());
  assert.equal(submitted.scenario, "signaling-game"); assert.equal(submitted.signalingIncentives, "aligned");
  assert.equal(submitted.rounds, 4); assert.equal(submitted.budgets.discussionTurns, 2);
  const createdData = await response.json(); const runId = createdData.run.id;
  const running = context.runs.live.get(runId); if (running) await running.settled();
  assert.equal(context.runs.store.get(runId).status, "completed");
  const situation = '[aria-label="信息交易真实局势"]';
  await page.waitForSelector(situation);
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes("逐轮核验 · 4"), {}, situation);
  await page.locator(`${situation} button`).click();
  await page.waitForSelector('[aria-label="信息交易结算记录"] tbody tr');
  assert.equal(await page.$$eval('[aria-label="信息交易结算记录"] tbody tr', rows => rows.length), 4);
  for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]]) {
    await page.setViewport({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name} viewport overflow`);
    measurements.push({ view: "replay", width, height, overflow: false });
    await page.screenshot({ path: path.join(directory, `replay-${name}.png`), fullPage: false });
  }
  await page.goto(`${base}/#/create?scenario=signaling-game`, { waitUntil: "networkidle2" });
  await page.waitForSelector(condition);
  await page.screenshot({ path: path.join(directory, "create-mobile.png"), fullPage: true });
  const overflowing = await page.evaluate(() => [...document.querySelectorAll('main *, [data-slot="field"] *')].filter(node => node.getBoundingClientRect().right > window.innerWidth + 1 && node.getBoundingClientRect().width > 0).slice(0, 12).map(node => ({ tag: node.tagName, classes: node.className, text: node.textContent.slice(0, 120), right: node.getBoundingClientRect().right })));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, JSON.stringify({ directory, overflowing }));
  measurements.push({ view: "create", width: 390, height: 844, overflow: false });

  // Exercise actual browser -> API boolean submission on a separate, explicitly human fixture.
  const people = ["builtin-01", "builtin-03"].map(id => runtimeCharacter(context.characters.resolve(id)));
  const human = context.runs.create(runSpecSchema.parse({ scenario: "signaling-game", rounds: 2, seed: 1, mode: "experiment", worldId: "ui-human-fixture",
    roster: people.map(person => ({ characterId: person.id, human: true })), budgets: { discussionTurns: 2 } }), people);
  humanRun = human.run;
  async function watchAs(actorId) {
    step = `watch-${actorId}`;
    await page.evaluate(({ runId, ownerToken, actorId, token }) => {
      localStorage.setItem(`society:run:${runId}:owner`, ownerToken);
      sessionStorage.setItem(`society:run:${runId}:players`, JSON.stringify({ [actorId]: token }));
    }, { runId: humanRun.id, ownerToken: human.ownerToken, actorId, token: human.playerTokens[actorId] });
    await page.goto(`${base}/#/runs/${humanRun.id}`, { waitUntil: "networkidle2" });
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector(situation);
  }
  async function submitChoice(label, option, name, field) {
    step = `open-${name}`;
    await page.locator(`[aria-label="${label}"]`).click();
    step = `select-${name}`;
    await page.locator(`[role="option"] ::-p-text(${option})`).click();
    await page.waitForSelector('[role="listbox"]', { hidden: true });
    const result = page.waitForResponse(response => response.url() === `${base}/api/v2/runs/${humanRun.id}/actions` && response.request().method() === "POST");
    step = `submit-${name}`;
    await page.locator('.human-composer [data-slot="field"] button[data-slot="button"]').click();
    step = `response-${name}`;
    const response = await result; assert.equal(response.status(), 200);
    const body = JSON.parse(response.request().postData()); assert.equal(body.action, name); assert.equal(body.input[field], false);
  }
  await watchAs(people[0].id);
  assert.ok((await page.$eval(situation, node => node.textContent)).includes("公开真值尚未公开"));
  await page.locator('.human-composer button ::-p-text(查看本轮本人信息)').click();
  assert.ok((await page.$eval('[data-testid="human-observation"]', node => node.textContent)).includes("本轮真实质量：低"));
  await page.locator('.human-composer button ::-p-text(查看本轮本人信息)').click();
  await submitChoice("公开报告", "低质量", "declare_quality", "highQuality");
  for (let step = 0; step < 10 && humanRun.world.stage()?.kind === "discussion"; step++) {
    const opportunity = humanRun.view({ research: true }).opportunities[0];
    if (opportunity) await humanRun.humanAction(opportunity.actorId, { opportunityId: opportunity.id, action: "wait", input: {} });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(humanRun.world.stage()?.id, "1:choose");
  await watchAs(people[1].id);
  assert.ok((await page.$eval(situation, node => node.textContent)).includes("公开真值尚未公开"));
  await page.locator('.human-composer button ::-p-text(查看本轮本人信息)').click();
  const receiverInformation = await page.$eval('[data-testid="human-observation"]', node => node.textContent);
  assert.ok(receiverInformation.includes("本轮真实质量尚未向你公开")); assert.ok(!receiverInformation.includes("本轮真实质量：低"));
  await page.locator('.human-composer button ::-p-text(查看本轮本人信息)').click();
  const view = humanRun.view({ actorId: people[1].id });
  assert.equal(view.world.highQuality, undefined);
  assert.ok(view.events.every(event => event.visibility === "public" || Array.isArray(event.visibility) && event.visibility.includes(people[1].id)));
  await page.screenshot({ path: path.join(directory, "human-before-reveal.png"), fullPage: false });
  await submitChoice("交易决定", "拒绝", "choose_offer", "accept");
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes("公开真值低质量"), {}, situation);
  assert.deepEqual(humanRun.world.publicState().scores, { [people[0].id]: 2, [people[1].id]: 2 });
  await page.screenshot({ path: path.join(directory, "human-after-reveal.png"), fullPage: false });
  assert.deepEqual(errors, []); assert.equal(registryHash(), beforeRegistry);
  const result = { passed: true, fixture: true, actualModelEvidence: false, isolatedDatabase: process.env.SOCIETY_DATABASE_FILE,
    productionRegistryUnchanged: true, completedFixtureRunId: runId, humanFixtureRunId: humanRun.id,
    conditionsAndRoleSwapSubmitted: true, humanFalseBooleansSubmitted: true, senderCanReadPrivateTruth: true, truthHiddenUntilSettlement: true,
    measurements, errors, at: new Date().toISOString() };
  writeFileSync(path.join(directory, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, artifact: directory }));
} catch (error) {
  const details = { passed: false, step, error: String(error), url: page?.url(), text: page ? await page.$eval("body", node => node.textContent) : undefined };
  if (page) await page.screenshot({ path: path.join(directory, "failure.png"), fullPage: true });
  writeFileSync(path.join(directory, "failure.json"), JSON.stringify(details, null, 2));
  console.log(JSON.stringify({ artifact: directory, step, error: String(error) }));
  throw error;
} finally {
  await browser.close();
  context.runs.stopAll(); if (humanRun) await humanRun.settled();
  context.liveConnections.closeAll();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  context.runs.store.close();
}
