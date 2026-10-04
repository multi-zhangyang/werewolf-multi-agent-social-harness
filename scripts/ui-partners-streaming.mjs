import puppeteer from "puppeteer-core";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { createSdkParticipant } from "../src/partners/agent.ts";
import { PartnerService } from "../src/partners/service.ts";
import { ModelRegistry } from "../src/society/models/registry.ts";
import { fixtureDecision } from "../tests/partners/fixture.ts";

process.env.SOCIETY_DATABASE_FILE = ":memory:";
process.env.SOCIETY_OPERATOR_TOKEN = "partners-stream-ui-fixture";
process.env.SOCIETY_MODEL_SETTINGS_FILE = "data/partners-ui/stream-models.json";
process.env.SOCIETY_CHARACTERS_FILE = "data/partners-ui/stream-characters.json";
mkdirSync("data/partners-ui", { recursive: true });
const { context, createServerApp } = await import("../src/server/index.ts");
let releaseMore; let releaseFinish; let firstRunId; let failRunId;
const more = new Promise(resolve => { releaseMore = resolve; });
const finish = new Promise(resolve => { releaseFinish = resolve; });
const captured = [];
context.partners = new PartnerService(context.partners.store, () => ({ configuration: { fixture: true }, async decide(input) {
  const model = { async getResponse() { throw new Error("The fixture must use the SDK model stream"); }, async *getStreamedResponse(request) {
    captured.push({ actor: input.actorId, request: JSON.stringify(request.input) });
    const phaseAction = fixtureDecision(input).action;
    const { type, ...fields } = phaseAction;
    const args = { ...fields, message: "UI 夹具：这次先兑现承诺。", intent: "UI 夹具：传输与隔离检查", basis: "one-off",
      ...(type === "settle" ? { claimedIncome: phaseAction.claimedIncome ?? null, revealIncome: phaseAction.revealIncome ?? false } : {}) };
    if (type === "offer") args.collateral = 0;
    const text = JSON.stringify(args);
    yield { type: "response_started" };
    yield { type: "model", event: { type: "response.reasoning_summary_text.delta", delta: `UI 夹具 · ${input.actorId} 的私密思考：先看自己的资源。` } };
    if (input.world.id === failRunId) throw new Error("UI 夹具：提供商在输出中途断开");
    const gated = input.world.id === firstRunId && input.world.revision === 0;
    if (gated) await more;
    yield { type: "model", event: { type: "response.reasoning_summary_text.delta", delta: " 然后判断承诺的代价。" } };
    const cut = text.indexOf("兑现承诺") + 2;
    yield { type: "model", event: { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc-native-ui", call_id: "native-ui-call", name: type, arguments: "" } } };
    yield { type: "model", event: { type: "response.function_call_arguments.delta", item_id: "fc-native-ui", delta: text.slice(0, cut) } };
    if (gated) await finish;
    yield { type: "model", event: { type: "response.function_call_arguments.delta", item_id: "fc-native-ui", delta: text.slice(cut) } };
    yield { type: "response_done", response: { id: crypto.randomUUID(), usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, providerData: { status: "completed" },
      output: [{ type: "function_call", callId: "native-ui-call", name: type, arguments: text, status: "completed" }] } };
  } };
  return createSdkParticipant(new ModelRegistry(), { model, psychology: "off", streamOutput: true }).decide(input);
} }));
const created = context.partners.create({ mode: "observe", maxRounds: 1, autoStart: false }); firstRunId = created.id;
const failed = context.partners.create({ mode: "observe", maxRounds: 1, autoStart: false }); failRunId = failed.id;
const checkpointBefore = JSON.stringify(context.partners.store.getCheckpoint(`${firstRunId}:0`));
const server = await new Promise(resolve => { const s = createServerApp().listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const page = await browser.newPage(); const errors = []; page.on("pageerror", error => errors.push(error.message));
try {
  await page.setViewport({ width: 1536, height: 960 }); await page.goto(base, { waitUntil: "networkidle2" });
  await page.evaluate(() => { localStorage.setItem("society:owner-token", "partners-stream-ui-fixture"); localStorage.setItem("society:theme", "dark"); });
  await page.goto(`${base}/#/partners/${firstRunId}`, { waitUntil: "networkidle2" });
  await page.locator('[data-slot="toggle-group-item"] ::-p-text(研究)').click();
  await page.waitForSelector('[data-testid="research-toolbar"]');
  context.partners.control(firstRunId, "step");
  await page.waitForFunction(() => document.body.textContent.includes("b 的私密思考"));
  assert.equal(context.partners.get(firstRunId).world.revision, 0);
  await page.evaluate(() => { window.streamNode = document.querySelector('[data-model-stream-id]'); window.eventNode = document.querySelector('[data-event-id]'); });
  await page.screenshot({ path: "data/partners-ui/stream-reasoning-dark.png", fullPage: true });
  releaseMore();
  await page.waitForFunction(() => document.body.textContent.includes("然后判断承诺的代价"));
  await page.waitForFunction(() => document.querySelector('[data-testid="agent-message-draft"]')?.textContent.includes("这次先兑"));
  assert.equal(await page.evaluate(() => window.streamNode === document.querySelector('[data-model-stream-id]')), true);
  assert.equal(await page.evaluate(() => window.eventNode === document.querySelector('[data-event-id]')), true);
  assert.equal(context.partners.get(firstRunId).world.revision, 0, "Partial model output never commits an action");
  assert.equal(JSON.stringify(context.partners.store.getCheckpoint(`${firstRunId}:0`)), checkpointBefore);
  assert.equal(JSON.stringify(context.partners.snapshot(firstRunId, { owner: false })).includes("私密思考"), false);
  const denied = await fetch(`${base}/api/partners/${firstRunId}/runtime/events`); assert.equal(denied.status, 403);
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: "data/partners-ui/stream-mobile-dark.png", fullPage: true });
  releaseFinish(); await context.partners.waitForRun(firstRunId);
  assert.equal(context.partners.get(firstRunId).world.revision, 1);
  context.partners.control(firstRunId, "step"); await context.partners.waitForRun(firstRunId);
  assert.equal(context.partners.get(firstRunId).world.revision, 2);
  assert.equal(captured.find(item => item.actor === "a").request.includes("b 的私密思考"), false, "Peer reasoning never enters the next actor's model request");
  await page.waitForFunction(() => document.body.textContent.includes("林舟 的运行过程") && document.body.textContent.includes("沈言 的运行过程"));
  await page.setViewport({ width: 1536, height: 960 });
  await page.locator('[data-slot="toggle-group-item"] ::-p-text(现场)').click();
  await page.waitForFunction(() => !document.querySelector('[data-runtime-id]'));
  assert.equal(await page.evaluate(() => document.body.textContent.includes("私密思考")), false);
  await page.goto(`${base}/#/partners/${failRunId}`, { waitUntil: "networkidle2" });
  await page.locator('[data-slot="toggle-group-item"] ::-p-text(研究)').click();
  context.partners.control(failRunId, "step"); await context.partners.waitForRun(failRunId);
  await page.waitForFunction(() => document.body.textContent.includes("本次决策未完成"));
  assert.equal(context.partners.get(failRunId).world.revision, 0);
  assert.ok(context.partners.runtimeActivities(failRunId).some(item => item.stream?.reasoning.includes("私密思考") && item.status === "failed"));
  await page.locator('[aria-label="切换外观"]').click(); await page.locator('[role="menuitemradio"] ::-p-text(浅色)').click();
  await page.screenshot({ path: "data/partners-ui/stream-failure-light.png", fullPage: true });
  assert.deepEqual(errors, []);
  writeFileSync("data/partners-ui/stream-result.json", JSON.stringify({ source: "deterministic streaming fixture through actual Agents SDK; not real-model evidence", providerIncremental: true,
    partialNeverCommitted: true, separateActors: true, noPeerThoughtLeak: true, researchAuth: true, stableDom: true, failureRetained: true, widths: [1536, 390], themes: ["light", "dark"], errors }, null, 2));
  console.log("AI Elements streaming UI passed: real incremental SDK transport, stable DOM, private researcher channel, peer isolation, interrupted output retained, mobile/light/dark.");
} catch (error) { await page.screenshot({ path: "data/partners-ui/stream-failure.png", fullPage: true }); console.log(await page.evaluate(() => document.body.innerText.slice(-2800))); throw error; }
finally { releaseMore(); releaseFinish(); context.partners.stopAll(); await context.partners.settled(); await browser.close(); context.liveConnections.closeAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); context.runs.store.close(); }
