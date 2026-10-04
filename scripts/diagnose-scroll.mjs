import puppeteer from "puppeteer-core";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("data/v7-ui", { recursive: true });
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
try {
  const page = await browser.newPage(); const errors = []; const requests = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("request", r => { if (r.url().includes("/api/")) requests.push(r.url()); });
  const cases = [];
  async function sample() { return page.evaluate(async () => {
    const viewport = document.querySelector('[data-slot="message-scroller-viewport"]');
    const content = document.querySelector('[data-slot="message-scroller-content"]');
    const samples = [];
    for (let i = 0; i < 120; i++) {
      await new Promise(window.requestAnimationFrame);
      samples.push({ frame: i, top: viewport.scrollTop, height: viewport.scrollHeight, client: viewport.clientHeight, width: viewport.clientWidth, visibility: getComputedStyle(viewport).visibility, last: content.lastElementChild?.getBoundingClientRect().top, children: content.childElementCount });
    }
    return samples;
  }); }
  for (const viewport of [{ width: 1920, height: 920, deviceScaleFactor: 1 }, { width: 1536, height: 736, deviceScaleFactor: 1.25 }, { width: 390, height: 844, deviceScaleFactor: 1 }]) {
    await page.setViewport(viewport);
    await page.goto("http://127.0.0.1:8794/#/runs/c726b444-4e09-47b2-98d3-2927fb2990b5", { waitUntil: "networkidle2" });
    await page.waitForSelector('[data-slot="message-scroller-viewport"]');
    const atRest = await sample();
    const rect = await page.$eval('[data-slot="message-scroller-viewport"]', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(rect.x, rect.y); await page.mouse.wheel({ deltaY: -340 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const afterScroll = await sample();
    const variants = values => [...new Set(values.map(s => `${s.top}:${s.height}:${s.width}:${s.visibility}:${s.last}`))];
    cases.push({ viewport, atRest, afterScroll, restVariants: variants(atRest), scrolledVariants: variants(afterScroll) });
    await page.screenshot({ path: `data/v7-ui/scroll-after-${viewport.width}.png` });
    assert.equal(variants(atRest).length, 1, `Resting replay should remain stable at ${viewport.width}px`);
    assert.equal(variants(afterScroll).length, 1, `Replay should remain stable after scrolling at ${viewport.width}px`);
    assert.equal(afterScroll.every(s => s.visibility === "visible"), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  }
  writeFileSync("data/v7-ui/scroll-after.json", JSON.stringify({ errors, requests, cases }, null, 2));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ errors, requests: requests.length, cases: cases.map(c => ({ viewport: c.viewport, restVariants: c.restVariants.length, scrolledVariants: c.scrolledVariants.length, first: c.atRest[0], last: c.afterScroll.at(-1) })) }));
} finally { await browser.close(); }
