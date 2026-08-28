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
await new Promise((r) => setTimeout(r, 2000));

await page.evaluate(() => {
  document.querySelector('[aria-label="模型提供商设置"]')?.click();
});
await new Promise((r) => setTimeout(r, 1500));

for (const [label, file] of [["提供商", "settings-v2-providers.png"], ["全局默认", "settings-v2-defaults.png"], ["模型档案", "settings-v2-models.png"]]) {
  await page.evaluate((text) => {
    const buttons = [...document.querySelectorAll("nav[aria-label='设置分区'] button")];
    buttons.find((b) => b.textContent?.includes(text))?.click();
  }, label);
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${OUT}/${file}` });
}

// Expand the add-model form and capture it too.
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("button")];
  buttons.find((b) => b.textContent?.includes("添加模型档案"))?.click();
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: `${OUT}/settings-v2-models-form.png` });

await browser.close();
console.log("done");
