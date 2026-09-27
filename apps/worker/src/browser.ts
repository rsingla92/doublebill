import { chromium, type Browser, type LaunchOptions } from "playwright-core";

/**
 * Some box offices answer a plain HTTP client with a bot challenge and only a
 * browser gets through. This module loads such a page in headless Chrome (the
 * one on the GitHub Actions runner, or the executable named by BROWSER_EXECUTABLE)
 * and returns the document once the challenge has run its course. It is used
 * for the Hot Docs feed, which sits behind Incapsula.
 */
const DEFAULT_TIMEOUT_MS = 90_000;
/** Incapsula's interstitials load their own script and iframe from this path. */
const CHALLENGE_MARKER = "_Incapsula_Resource";

export interface BrowserFetchOptions {
  /** How long to wait for the challenge to finish and the real document to appear. */
  timeoutMs?: number;
}

let shared: Promise<Browser> | null = null;

function launchOptions(): LaunchOptions {
  const executablePath = process.env.BROWSER_EXECUTABLE;
  return { headless: true, ...(executablePath ? { executablePath } : { channel: "chrome" }) };
}

/** One browser per process, started on first use and closed by `closeBrowser`. */
async function browser(): Promise<Browser> {
  if (!shared) {
    shared = chromium.launch(launchOptions()).catch((error: unknown) => {
      shared = null;
      throw new Error(`Chrome could not be started (install Google Chrome or set BROWSER_EXECUTABLE): ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return shared;
}

export async function closeBrowser(): Promise<void> {
  const open = shared;
  shared = null;
  if (open) await (await open).close().catch(() => undefined);
}

/**
 * Load `url` in a fresh browser context and return the document's text: the HTML
 * of a page, or the body of a JSON or XML document as Chrome shows it. A bot
 * challenge that reloads the page is waited out; one that never resolves is an
 * error after the timeout.
 */
export async function fetchWithBrowser(url: URL, options: BrowserFetchOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const context = await (await browser()).newContext({ locale: "en-CA", timezoneId: "America/Toronto" });
  try {
    const page = await context.newPage();
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForFunction(
      (marker) => !document.querySelector(`script[src*="${marker}"], iframe[src*="${marker}"]`) && document.readyState !== "loading",
      CHALLENGE_MARKER,
      { timeout: timeoutMs, polling: 500 },
    );
    const type = (await page.evaluate(() => document.contentType)) ?? "";
    if (/json|xml|plain/i.test(type)) {
      // Chrome wraps a non-HTML document in a <pre>; its text is the document.
      return page.evaluate(() => document.querySelector("pre")?.textContent ?? document.body.innerText);
    }
    return page.content();
  } finally {
    await context.close().catch(() => undefined);
  }
}
