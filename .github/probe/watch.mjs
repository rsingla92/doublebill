// Temporary: load a venue page in headless Chrome and record what it fetches.
// Used by the probe-venue workflow while the TIFF and Hot Docs sources are being
// investigated; both sites answer bot challenges to plain HTTP clients.
import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";

const [target, outDir, waitMs = "20000", clicks = ""] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ locale: "en-CA", timezoneId: "America/Toronto", viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const log = [];
let n = 0;
page.on("response", async (response) => {
  const request = response.request();
  const type = response.headers()["content-type"] ?? "";
  const url = response.url();
  const entry = { status: response.status(), method: request.method(), url, type, resource: request.resourceType() };
  log.push(entry);
  if (/json|javascript|text\/html|text\/plain|xml/.test(type) && !/google|facebook|doubleclick|analytics|hotjar|gtm|cookielaw|onetrust|awswaf|incapsula/i.test(url)) {
    try {
      const body = await response.text();
      if (body.length > 100 && body.length < 8_000_000) {
        const name = `${String(n++).padStart(3, "0")}_${url.replace(/[^a-z0-9]+/gi, "_").slice(0, 100)}.txt`;
        writeFileSync(`${outDir}/${name}`, body);
        entry.saved = name;
        entry.size = body.length;
        if (request.method() === "POST") entry.post = request.postData()?.slice(0, 3000);
        const headers = request.headers();
        entry.requestHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => !/cookie|authorization/i.test(key)));
      }
    } catch {}
  }
});
await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch((error) => console.error("goto:", error.message));
await page.waitForTimeout(Number(waitMs));
for (const selector of clicks.split("|").filter(Boolean)) {
  try {
    await page.click(selector, { timeout: 5000 });
    await page.waitForTimeout(8000);
    console.log("clicked", selector);
  } catch (error) {
    console.log("click failed", selector, error.message);
  }
}
writeFileSync(`${outDir}/page.html`, await page.content());
await page.screenshot({ path: `${outDir}/page.png`, fullPage: true }).catch(() => undefined);
writeFileSync(`${outDir}/log.json`, JSON.stringify(log, null, 1));
console.log("title:", await page.title(), "| final url:", page.url());
for (const entry of log) if (entry.saved) console.log(entry.status, entry.method, entry.resource, entry.url.slice(0, 200), entry.size);
await browser.close();
