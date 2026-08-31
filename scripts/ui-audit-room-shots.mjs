/**
 * Release Chromium audit. It always captures the lobby/configuration routes;
 * with ROOM_ID (and optionally ARCHIVE_ID) it also captures the real room,
 * participant/causality drawers, endgame and static archive request boundary.
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.UI_SHOTS_URL ?? "http://127.0.0.1:8787";
const CHROME = process.env.CHROME_BIN ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TOKEN = process.env.ROOM_TOKEN ?? "local-dev-operator";
const ROOM_ID = process.env.ROOM_ID?.trim();
const ARCHIVE_ID = process.env.ARCHIVE_ID?.trim();
const NAME = process.env.ROOM_NAME ?? "release";
const OUT_DIR = fileURLToPath(new URL("../artifacts/ui-audit/", import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-device-scale-factor=2", "--hide-scrollbars"]
});

const results = {};
try {
  for (const viewport of [
    { width: 390, height: 844, label: "390" },
    { width: 768, height: 900, label: "768" },
    { width: 1440, height: 900, label: "1440" },
    { width: 1920, height: 1080, label: "1920" }
  ]) {
    const page = await preparedPage(viewport.width, viewport.height);
    await open(page, "#/", 1_200);
    await page.screenshot({ path: `${OUT_DIR}lobby-${viewport.label}.png`, fullPage: true });
    results[`lobby${viewport.label}`] = await accessibilityAudit(page);
    await page.close();
  }

  const configDesktop = await preparedPage(1440, 900);
  await open(configDesktop, "#/create", 1_000);
  await configDesktop.screenshot({ path: `${OUT_DIR}create-desktop.png`, fullPage: true });
  results.createDesktop = await accessibilityAudit(configDesktop);
  await open(configDesktop, "#/settings", 1_000);
  await configDesktop.screenshot({ path: `${OUT_DIR}settings-desktop.png`, fullPage: true });
  results.settingsDesktop = await accessibilityAudit(configDesktop);
  await open(configDesktop, "#/characters", 1_000);
  await configDesktop.screenshot({ path: `${OUT_DIR}characters-desktop.png`, fullPage: true });
  results.charactersDesktop = await accessibilityAudit(configDesktop);
  await configDesktop.goBack({ waitUntil: "domcontentloaded" });
  await sleep(300);
  results.browserBack = configDesktop.url().includes("#/settings");
  await configDesktop.close();

  const configMobile = await preparedPage(390, 844);
  await open(configMobile, "#/create", 800);
  await configMobile.screenshot({ path: `${OUT_DIR}create-mobile.png`, fullPage: true });
  results.createMobile = await accessibilityAudit(configMobile);
  await open(configMobile, "#/settings", 800);
  await configMobile.screenshot({ path: `${OUT_DIR}settings-mobile.png`, fullPage: true });
  results.settingsMobile = await accessibilityAudit(configMobile);
  await configMobile.close();

  if (ROOM_ID) {
    const room = await preparedPage(1440, 900);
    await open(room, `#/rooms/${encodeURIComponent(ROOM_ID)}`, 4_000);
    await room.screenshot({ path: `${OUT_DIR}${NAME}-live.png` });
    results.roomDesktop = await accessibilityAudit(room);

    const recordButton = await findButton(room, "查看完整对局记录");
    if (recordButton) { await recordButton.click(); await sleep(1_000); }
    const peopleButton = await findButton(room, "参与者");
    if (peopleButton) { await peopleButton.click(); await sleep(500); await room.screenshot({ path: `${OUT_DIR}${NAME}-participants.png` }); await room.keyboard.press("Escape"); }
    const causalityButton = await findButton(room, "因果");
    if (causalityButton) { await causalityButton.click(); await sleep(800); await room.screenshot({ path: `${OUT_DIR}${NAME}-causality.png` }); await room.keyboard.press("Escape"); }
    await room.close();

    const roomMobile = await preparedPage(390, 844);
    await open(roomMobile, `#/rooms/${encodeURIComponent(ROOM_ID)}`, 3_500);
    await roomMobile.screenshot({ path: `${OUT_DIR}${NAME}-mobile.png` });
    const mobilePeople = await findButton(roomMobile, "参与者");
    if (mobilePeople) { await mobilePeople.click(); await sleep(500); await roomMobile.screenshot({ path: `${OUT_DIR}${NAME}-drawer-mobile.png` }); }
    results.roomMobile = await accessibilityAudit(roomMobile);
    await roomMobile.close();
  }

  if (ARCHIVE_ID) {
    const archive = await preparedPage(1440, 900);
    const requests = [];
    archive.on("request", (request) => requests.push(request.url()));
    await open(archive, `#/archives/${encodeURIComponent(ARCHIVE_ID)}`, 1_800, "networkidle0");
    await archive.screenshot({ path: `${OUT_DIR}${NAME}-archive.png` });
    results.archive = {
      ...(await accessibilityAudit(archive)),
      sseRequests: requests.filter((url) => url.includes("/events")).length,
      liveRoomRequests: requests.filter((url) => url.includes(`/api/rooms/${encodeURIComponent(ARCHIVE_ID)}`)).length
    };
    await archive.close();
  }

  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}

async function preparedPage(width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument((token) => window.localStorage.setItem("society:owner-token", token), TOKEN);
  return page;
}

async function open(page, hash, settleMs, waitUntil = "domcontentloaded") {
  await page.goto(`${BASE_URL}/${hash}`, { waitUntil, timeout: 60_000 });
  await sleep(settleMs);
}

async function accessibilityAudit(page) {
  return page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    unlabeledButtons: [...document.querySelectorAll("button")].filter((button) => {
      const name = button.getAttribute("aria-label") || button.textContent?.trim() || button.getAttribute("title");
      return !name;
    }).length,
    viewportWidth: document.documentElement.clientWidth,
    contentWidth: document.documentElement.scrollWidth
  }));
}

async function findButton(page, text) {
  const handles = await page.$$("button");
  for (const handle of handles) {
    const label = await handle.evaluate((button) => button.textContent ?? "");
    if (label.includes(text)) return handle;
  }
  return undefined;
}
