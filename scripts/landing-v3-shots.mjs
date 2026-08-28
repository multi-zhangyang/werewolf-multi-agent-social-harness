import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "artifacts/ui-audit";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--hide-scrollbars", "--force-color-profile=srgb", "--disable-lcd-text"]
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page.goto("http://localhost:5173/#/", { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 2500));

await page.screenshot({ path: `${OUT}/landing-v3-hero.png` });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.42));
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${OUT}/landing-v3-mid.png` });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${OUT}/landing-v3-end.png` });

await browser.close();
console.log("done");
