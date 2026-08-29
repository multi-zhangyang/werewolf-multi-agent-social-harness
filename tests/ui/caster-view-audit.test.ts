/**
 * Caster broadcast-surface end-to-end audit — opt-in, never part of CI:
 *
 *   UI_AUDIT=1 npx vitest run tests/ui/caster-view-audit.test.ts
 *
 * Spins the real express app with an in-memory scripted-model room (no
 * network, no paid model calls) and drives a real Chrome through the caster
 * page: the locked public view mid-game, the automatic postgame reveal, and
 * the pure-stream popout from the room header. The wire-level assertion
 * proves no caster surface ever requests a privileged projection.
 */
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";
import type { Browser, HTTPRequest, Page, Target } from "puppeteer-core";
import { ScriptedModel } from "@openai/agents/testing";
import type { Model, ModelRequest, ModelResponse, StreamEvent } from "@openai/agents";
import type { OpenAIProvider } from "@openai/agents";
import { ActivationLimiter } from "../../src/society/activation-limiter";
import { createAgentProfiles } from "../../src/society/profiles";
import { createServerApp, context } from "../../src/server/index";
import { fakeModelRegistry, fakeProvider, twoRoundScript } from "../helpers/scripted-room";

const CHROME = process.env.CHROME_BIN ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const enabled = process.env.UI_AUDIT === "1"
  && existsSync(CHROME)
  && existsSync(fileURLToPath(new URL("../../dist/index.html", import.meta.url)));
const OUT_DIR = fileURLToPath(new URL("../../artifacts/ui-audit/", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A scripted model that paces every response so a browser can catch the
 * game mid-flight; after the script runs out it hangs instead of erroring.
 */
class PacedModel implements Model {
  private readonly inner: ScriptedModel;
  private readonly delayMs: number;

  constructor(steps: ConstructorParameters<typeof ScriptedModel>[0], delayMs = 550) {
    this.inner = new ScriptedModel(steps);
    this.delayMs = delayMs;
  }

  async getResponse(_request: ModelRequest): Promise<ModelResponse> {
    throw new Error("UNEXPECTED_NON_STREAMING_CALL: the runner should always stream.");
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (this.inner.remainingSteps <= 0) {
      await new Promise<void>(() => undefined);
      return;
    }
    await sleep(this.delayMs);
    for await (const event of this.inner.getStreamedResponse(request)) {
      yield event;
    }
  }
}

describe.skipIf(!enabled)("caster broadcast surface (e2e over a scripted room)", () => {
  let app: Express;
  let server: Server;
  let baseUrl: string;
  let roomId: string;
  let browser: Browser;
  let disposeRoom: () => void = () => undefined;
  /** Every /api/rooms/:id request made by caster pages, for the wire audit. */
  const casterRequestUrls: string[] = [];

  beforeAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const limiter = new ActivationLimiter(1);
    const room = context.rooms.create({
      id: `room-ui-caster-${Date.now().toString(36)}`,
      scenarioId: "trust-game",
      profiles: createAgentProfiles(["fake-model"], 2),
      rounds: 2,
      provider: fakeProvider(new PacedModel(twoRoundScript())) as unknown as OpenAIProvider,
      modelRegistry: fakeModelRegistry(),
      limiter
    });
    roomId = room.id;
    disposeRoom = (): void => room.dispose("audit cleanup");

    app = createServerApp();
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-device-scale-factor=2", "--hide-scrollbars"]
    });
    // Start last: the pacing budget is what lets the browser land mid-game.
    void room.start();
  });

  afterAll(async () => {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    disposeRoom();
  });

  async function openCaster(width: number, height: number): Promise<Page> {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    page.on("request", (request: HTTPRequest) => {
      const url = request.url();
      if (url.includes(`/api/rooms/${encodeURIComponent(roomId)}`)) casterRequestUrls.push(url);
    });
    await page.goto(`${baseUrl}/#/caster/${encodeURIComponent(roomId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return page;
  }

  it("locks the view to the public projection while the game runs", async () => {
    const page = await openCaster(1440, 900);
    await page.waitForFunction(
      () => document.body.innerText.includes("无剧透") || document.body.innerText.includes("赛后揭晓"),
      { timeout: 30_000 }
    );
    // Catch the stream with at least one committed public message on it.
    await page.waitForFunction(
      () => document.body.innerText.includes("观察") || document.body.innerText.includes("投资"),
      { timeout: 30_000 }
    );
    await sleep(1_000);
    await page.screenshot({ path: `${OUT_DIR}caster-live-desktop.png` });

    const text = await page.evaluate(() => document.body.innerText);
    expect(text).not.toContain("全知");
    expect(text).not.toContain("返回大厅");
    expect(text).not.toContain("打开大厅");
    const chromeCount = await page.evaluate(() => ({
      back: Boolean(document.querySelector("[aria-label='返回大厅']")),
      modeSelect: Boolean(document.querySelector("[aria-label='切换视角']"))
    }));
    expect(chromeCount.back).toBe(false);
    expect(chromeCount.modeSelect).toBe(false);
    await page.close();
  });

  it("flips itself to the postgame reveal once the game ends", async () => {
    const page = await openCaster(1440, 900);
    await page.waitForFunction(
      () => document.body.innerText.includes("赛后揭晓"),
      { timeout: 60_000 }
    );
    await sleep(1_500);
    await page.screenshot({ path: `${OUT_DIR}caster-endgame.png` });
    await page.close();
  });

  it("pops the pure-stream window from the room header", async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.goto(`${baseUrl}/#/rooms/${encodeURIComponent(roomId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("[aria-label='打开主播纯流窗口']", { timeout: 30_000 });
    await page.screenshot({ path: `${OUT_DIR}room-cast-entry.png` });

    const popupTarget = new Promise<Target>((resolve) => {
      browser.once("targetcreated", (target: Target) => resolve(target));
    });
    await page.click("[aria-label='打开主播纯流窗口']");
    const popup = await (await popupTarget).page();
    expect(popup).toBeTruthy();
    if (!popup) throw new Error("popout target had no page");
    expect(popup.url()).toContain(`#/caster/${encodeURIComponent(roomId)}`);
    await popup.setViewport({ width: 640, height: 960, deviceScaleFactor: 2 });
    await popup.waitForFunction(
      () => document.body.innerText.includes("无剧透") || document.body.innerText.includes("赛后揭晓"),
      { timeout: 30_000 }
    );
    await sleep(1_000);
    await popup.screenshot({ path: `${OUT_DIR}caster-popout.png` });
    await page.close();
    await popup.close();
  });

  it("never asked the server for a privileged projection", () => {
    expect(casterRequestUrls.length).toBeGreaterThan(0);
    for (const url of casterRequestUrls) {
      expect(url).toMatch(/[?&]mode=(public|postgame)/);
      expect(url).not.toContain("mode=omniscient");
      expect(url).not.toContain("mode=agent-pov");
    }
  });
});
