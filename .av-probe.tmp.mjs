import puppeteer from "puppeteer-core";
const url = `http://127.0.0.1:8787/#/rooms/${process.env.ROOM_ID}`;
const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome", headless: "new",
  args: ["--no-sandbox","--disable-dev-shm-usage","--window-size=1440,900"]
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise(r => setTimeout(r, 6000));
  const info = await page.evaluate(() => {
    const body = document.body.innerText;
    const result = {
      hasResultTitle: body.includes("本局终章"),
      hasDeceptionWin: body.includes("欺骗阵营胜利"),
      hasRevealLabel: body.includes("身份揭晓"),
      hasPercival: body.includes("派西维尔"),
      hasMorgana: body.includes("莫甘娜"),
      hasAssassin: body.includes("刺客"),
      badgeCount: [...document.querySelectorAll("span")].filter(s => s.textContent === "派西维尔").length,
      viewportScroll: (() => { const v = document.querySelector('[data-slot="scroll-area-viewport"]'); return v ? { top: v.scrollTop, sh: v.scrollHeight, ch: v.clientHeight } : null; })()
    };
    return result;
  });
  console.log(JSON.stringify(info, null, 1));
} finally { await browser.close(); }
