/**
 * Full-surface UI audit capture: create-room dialog (top + bottom),
 * characters dialog (top + bottom), about (2 stops). Run with the dev
 * server up: `node scripts/full-audit-shots.mjs`. Writes to artifacts/ui-audit/.
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
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars", "--force-color-profile=srgb", "--disable-lcd-text"]
});

const clickButtonByText = async (page, text) => {
  await page.evaluate((needle) => {
    const buttons = [...document.querySelectorAll("button")];
    buttons.find((b) => b.textContent?.includes(needle))?.click();
  }, text);
};

const scrollDialogToBottom = async (page) => {
  await page.evaluate(() => {
    const dialog = document.querySelector("[role='dialog']");
    const scrollers = dialog ? [...dialog.querySelectorAll("*")].filter((el) => {
      const style = getComputedStyle(el);
      return (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 40;
    }) : [];
    scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
    if (scrollers[0]) scrollers[0].scrollTop = scrollers[0].scrollHeight;
  });
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(`${BASE_URL}/#/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2000);

  // create-room dialog: top + scrolled to bottom
  await clickButtonByText(page, "创建世界");
  await sleep(1500);
  await page.screenshot({ path: `${OUT_DIR}audit-create-top.png` });
  await scrollDialogToBottom(page);
  await sleep(500);
  await page.screenshot({ path: `${OUT_DIR}audit-create-bottom.png` });
  await page.keyboard.press("Escape");
  await sleep(800);

  // characters dialog: top + scrolled to bottom
  await clickButtonByText(page, "人物库");
  await sleep(1200);
  await page.screenshot({ path: `${OUT_DIR}audit-characters-top.png` });
  await scrollDialogToBottom(page);
  await sleep(500);
  await page.screenshot({ path: `${OUT_DIR}audit-characters-bottom.png` });
  await page.keyboard.press("Escape");
  await sleep(800);

  // about page: two stops
  await page.evaluate(() => { location.hash = "#/about"; });
  await sleep(1500);
  await page.screenshot({ path: `${OUT_DIR}audit-about-top.png` });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.55));
  await sleep(500);
  await page.screenshot({ path: `${OUT_DIR}audit-about-mid.png` });

  console.log(`full audit shots written to ${OUT_DIR}`);
} finally {
  await browser.close();
}
