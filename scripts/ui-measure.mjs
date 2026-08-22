/** Verify the settings dialog now fits the viewport at phone width. */
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:8787/", { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => {
  const button = [...document.querySelectorAll("button")].find((entry) => entry.getAttribute("aria-label") === "模型提供商设置");
  button?.click();
});
await new Promise((r) => setTimeout(r, 1200));
const report = await page.evaluate(() => {
  const dialog = document.querySelector("[data-slot='dialog-content']");
  const wrap = dialog?.firstElementChild;
  const dr = dialog?.getBoundingClientRect();
  const wr = wrap?.getBoundingClientRect();
  let worst = { right: -1e9, cls: "" };
  dialog?.querySelectorAll("*").forEach((element) => {
    const r = element.getBoundingClientRect();
    if (r.right > worst.right) worst = { right: Math.round(r.right), cls: String(element.className).slice(0, 60) };
  });
  return {
    viewport: globalThis.window?.innerWidth ?? 0,
    docScrollWidth: document.documentElement.scrollWidth,
    dialog: dr ? { left: Math.round(dr.left), right: Math.round(dr.right), width: Math.round(dr.width) } : undefined,
    wrapper: wr ? { left: Math.round(wr.left), right: Math.round(wr.right), width: Math.round(wr.width) } : undefined,
    widestChildRight: worst
  };
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
