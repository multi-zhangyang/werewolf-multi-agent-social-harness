/**
 * UI audit capture: landing (3 scroll positions), create-room dialog (2),
 * settings dialog (2), characters dialog, about (2). Run with the dev server
 * up: `node scripts/ui-audit-shots.mjs`. Writes to artifacts/ui-audit/.
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.UI_SHOTS_URL ?? "http://127.0.0.1:5173";
const CHROME = process.env.CHROME_BIN ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT_DIR = fileURLToPath(new URL("../artifacts/ui-audit/", import.meta.url));
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
  await page.goto(BASE_URL, { waitUntil: "networkidle0", timeout: 60000 });
  await sleep(2000);

  await page.screenshot({ path: `${OUT_DIR}landing-top.png` });
  await page.evaluate(() => window.scrollTo(0, 900));
  await sleep(400);
  await page.screenshot({ path: `${OUT_DIR}landing-mid.png` });
  await page.evaluate(() => window.scrollTo(0, 1900));
  await sleep(400);
  await page.screenshot({ path: `${OUT_DIR}landing-scenarios.png` });

  // create-room dialog: top + scrolled
  for (const button of await page.$$("button")) {
    const text = await page.evaluate((el) => el.textContent, button);
    if (text?.includes("创建世界")) { await button.click(); break; }
  }
  await sleep(1500);
  await page.screenshot({ path: `${OUT_DIR}create-room-top.png` });
  await page.evaluate(() => {
    const dialog = document.querySelector("[role='dialog']");
    const scroller = dialog?.querySelector("[class*='overflow-y']") ?? dialog;
    if (scroller) scroller.scrollTop = 560;
  });
  await sleep(400);
  await page.screenshot({ path: `${OUT_DIR}create-room-scrolled.png` });
  await page.keyboard.press("Escape");
  await sleep(700);

  // characters dialog
  for (const button of await page.$$("button")) {
    const text = await page.evaluate((el) => el.textContent, button);
    if (text?.includes("人物库")) { await button.click(); break; }
  }
  await sleep(1200);
  await page.screenshot({ path: `${OUT_DIR}characters-dialog.png` });
  await page.keyboard.press("Escape");
  await sleep(700);

  // settings dialog: top + scrolled
  await page.click('button[aria-label="模型提供商设置"]');
  await sleep(1200);
  await page.screenshot({ path: `${OUT_DIR}settings-top.png` });
  await page.evaluate(() => {
    const dialog = document.querySelector("[role='dialog']");
    const scroller = dialog?.querySelector("[class*='overflow-y']") ?? dialog;
    if (scroller) scroller.scrollTop = 700;
  });
  await sleep(400);
  await page.screenshot({ path: `${OUT_DIR}settings-scrolled.png` });
  await page.keyboard.press("Escape");
  await sleep(700);

  // about page
  await page.evaluate(() => { location.hash = "#/about"; });
  await sleep(1200);
  await page.screenshot({ path: `${OUT_DIR}about.png` });
  await page.evaluate(() => window.scrollTo(0, 900));
  await sleep(400);
  await page.screenshot({ path: `${OUT_DIR}about-2.png` });

  console.log(`UI audit shots written to ${OUT_DIR}`);
} finally {
  await browser.close();
}
