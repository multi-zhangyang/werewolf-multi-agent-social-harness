import puppeteer from "puppeteer-core";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ["--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:5173/#/rooms/${process.argv[2]}`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 4000));
await page.evaluate(() => {
  const triggers = [...document.querySelectorAll("[data-slot='collapsible-trigger']")];
  for (const t of triggers) { if (t.textContent?.includes("社会行为")) t.click(); }
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: "data/ui-sweep-convergence/08-social-acts.png" });
console.log("captured");
await browser.close();
