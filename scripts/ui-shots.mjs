/**
 * UI QA screenshot capture (run with `node scripts/ui-shots.mjs`).
 * Requires the server running (npm run server) and a local Chrome.
 * Captures the landing page, the create-room dialog, the model settings
 * dialog and the about page into artifacts/ui-shots for visual review
 * (e.g. by a vision-capable model). No provider calls are made.
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const BASE_URL = process.env.UI_SHOTS_URL ?? "http://127.0.0.1:8787";
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const OUT_DIR = new URL("../artifacts/ui-shots/", import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--force-device-scale-factor=1",
    "--window-size=1440,900",
    "--hide-scrollbars"
  ]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
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

  console.log(`UI screenshots written to ${OUT_DIR}`);
} finally {
  await browser.close();
}