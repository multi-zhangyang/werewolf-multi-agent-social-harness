/**
 * Room view audit capture. Usage:
 *   ROOM_ID=... ROOM_NAME=room-pd node scripts/ui-audit-room-shots.mjs
 * Writes desktop + mobile room screenshots into artifacts/ui-audit/.
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.UI_SHOTS_URL ?? "http://127.0.0.1:5173";
const CHROME = process.env.CHROME_BIN ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TOKEN = process.env.ROOM_TOKEN ?? "local-dev-operator";
const ROOM_ID = process.env.ROOM_ID;
if (!ROOM_ID) throw new Error("ROOM_ID is required");
const NAME = process.env.ROOM_NAME ?? "room";
const OUT_DIR = fileURLToPath(new URL("../artifacts/ui-audit/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-device-scale-factor=2", "--hide-scrollbars"]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument((token) => {
    window.localStorage.setItem("society:owner-token", token);
  }, TOKEN);
  await page.goto(`${BASE_URL}/#/rooms/${encodeURIComponent(ROOM_ID)}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(4000);
  await page.screenshot({ path: `${OUT_DIR}${NAME}-desktop.png` });

  // causality panel: open all collapsible sections
  await page.evaluate(() => {
    const triggers = [...document.querySelectorAll("[data-slot='collapsible-trigger']")];
    for (const trigger of triggers) {
      if (trigger.getAttribute("data-state") !== "open") trigger.click();
    }
  });
  await sleep(900);
  await page.screenshot({ path: `${OUT_DIR}${NAME}-causality.png` });

  // mobile
  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await mobile.evaluateOnNewDocument((token) => {
    window.localStorage.setItem("society:owner-token", token);
  }, TOKEN);
  await mobile.goto(`${BASE_URL}/#/rooms/${encodeURIComponent(ROOM_ID)}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(4000);
  await mobile.screenshot({ path: `${OUT_DIR}${NAME}-mobile.png` });

  console.log(`room shots written to ${OUT_DIR} (${NAME})`);
} finally {
  await browser.close();
}
