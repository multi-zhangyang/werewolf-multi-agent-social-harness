/**
 * Headless visual sweep: capture the key surfaces at high resolution so
 * layout bugs (overflow, crush, wrap) are visible without the in-app browser.
 * Usage: node scripts/ui-sweep.mjs [outDir]
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? "data/ui-sweep");
mkdirSync(outDir, { recursive: true });

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = "http://127.0.0.1:8787";

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--no-first-run", "--disable-extensions"]
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

const shot = async (name) => {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log("captured", name);
};

// 1. Landing
await page.goto(BASE, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1500));
await shot("01-landing-top");
await page.evaluate(() => document.querySelector("#scenarios")?.scrollIntoView());
await new Promise((r) => setTimeout(r, 500));
await shot("02-landing-scenarios");

// 2. Settings dialog (model profiles were the overflow source)
await page.goto(BASE, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1200));
await page.keyboard.press("Tab").catch(() => {});
await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((entry) => entry.getAttribute("aria-label") === "模型提供商设置");
  button?.click();
});
await new Promise((r) => setTimeout(r, 1200));
await shot("03-settings-models");

// 3. Narrow viewport settings (overflow regression check at phone width)
await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
await new Promise((r) => setTimeout(r, 600));
await shot("04-settings-narrow");

// 4. Create-room dialog in unified mode
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
await page.goto(BASE, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => {
  const chip = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "囚徒困境");
  chip?.click();
});
await new Promise((r) => setTimeout(r, 1000));
await shot("05-create-unified");

await browser.close();
console.log("done ->", outDir);
