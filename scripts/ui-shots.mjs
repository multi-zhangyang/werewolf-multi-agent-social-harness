/**
 * UI QA screenshot capture (run with `node scripts/ui-shots.mjs`).
 * Requires the server running (npm run server) and a local Chrome.
 * Captures the landing page, the create-room dialog, the model settings
 * dialog, the about page and optional room workbenches into artifacts/ui-shots
 * (e.g. by a vision-capable model). No provider calls are made.
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.UI_SHOTS_URL ?? "http://127.0.0.1:8787";
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const ROOM_ID = process.env.UI_SHOTS_ROOM_ID?.trim();
const ROOM_TARGETS = (process.env.UI_SHOTS_ROOMS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1 || separator === entry.length - 1) {
      throw new Error(`Invalid UI_SHOTS_ROOMS entry: ${entry}`);
    }
    return {
      name: entry.slice(0, separator).replace(/[^a-z0-9-]/gi, "-"),
      roomId: entry.slice(separator + 1)
    };
  });
if (ROOM_ID) ROOM_TARGETS.push({ name: "workbench", roomId: ROOM_ID });
// URL.pathname produces `/E:/...` on Windows, which Node resolves as
// `E:\E:\...`. Convert with the platform-aware helper so the same capture
// script works on the Windows desktop used for visual QA and on CI Linux.
const OUT_DIR = fileURLToPath(new URL("../artifacts/ui-shots/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--force-device-scale-factor=2",
    "--window-size=1440,900",
    "--hide-scrollbars"
  ]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(BASE_URL, { waitUntil: "networkidle0", timeout: 60000 });
  await sleep(2500);

  await page.screenshot({ path: `${OUT_DIR}landing-full.png`, fullPage: true });
  await page.screenshot({ path: `${OUT_DIR}landing-viewport.png` });

  // Create-room dialog via the hero 创建世界 button.
  for (const button of await page.$$("button")) {
    const text = await page.evaluate((el) => el.textContent, button);
    if (text?.includes("创建世界")) {
      await button.click();
      break;
    }
  }
  await sleep(1800);
  await page.screenshot({ path: `${OUT_DIR}create-room.png` });

  await page.keyboard.press("Escape");
  await sleep(800);

  const settingsButton = await page.$('button[aria-label="模型提供商设置"]');
  if (settingsButton) {
    await settingsButton.click();
    await sleep(1500);
    await page.screenshot({ path: `${OUT_DIR}settings.png` });
  }
  await page.keyboard.press("Escape");
  await sleep(600);

  await page.evaluate(() => {
    location.hash = "#/about";
  });
  await sleep(1500);
  await page.screenshot({ path: `${OUT_DIR}about.png` });

  await page.evaluate(() => {
    location.hash = "#/";
  });
  await sleep(800);
  await page.screenshot({ path: `${OUT_DIR}landing-clean.png` });

  for (const target of ROOM_TARGETS) {
    await page.goto(`${BASE_URL}/?shot=1&static=1#/rooms/${encodeURIComponent(target.roomId)}`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every((image) => image.complete), { timeout: 20000 }).catch(() => undefined);
    await sleep(3500);
    await page.screenshot({ path: `${OUT_DIR}room-${target.name}.png` });
    if (target.name === "public-goods") {
      const tabs = await page.$$('[role="tab"]');
      for (const tab of tabs) {
        const label = await page.evaluate((element) => element.textContent, tab);
        if (!label?.includes("因果")) continue;
        await tab.click();
        await sleep(800);
        await page.screenshot({ path: `${OUT_DIR}room-public-goods-causality.png` });
        break;
      }
    }
  }

  console.log(`UI screenshots written to ${OUT_DIR}`);
} finally {
  await browser.close();
}
