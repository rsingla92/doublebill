import { chromium, type Browser, type LaunchOptions, type Page } from "playwright-core";

/**
 * Some box offices answer a plain HTTP client with a bot challenge and only a
 * browser gets through. This module loads such a page in headless Chrome (the
 * one on the GitHub Actions runner, or the executable named by BROWSER_EXECUTABLE)
 * and returns the document once the challenge has run its course. It is used
 * for the Hot Docs feed, which sits behind Incapsula.
 */
const DEFAULT_TIMEOUT_MS = 90_000;
const ATTEMPTS = 2;
/** Incapsula's interstitials load their own script and iframe from this path. */
const CHALLENGE_MARKER = "_Incapsula_Resource";

export interface BrowserFetchOptions {
  /** How long to wait, per attempt, for the challenge to finish and the real document to appear. */
  timeoutMs?: number;
  /** Where to report what the browser does; BROWSER_DEBUG=1 sends it to stderr. */
  log?: (message: string) => void;
}

let shared: Promise<Browser> | null = null;

function launchOptions(): LaunchOptions {
  const executablePath = process.env.BROWSER_EXECUTABLE;
  return { headless: true, ...(executablePath ? { executablePath } : { channel: "chrome" }) };
}

/** One browser per process, started on first use and closed by `closeBrowser`. */
async function browser(log: (message: string) => void): Promise<Browser> {
  if (!shared) {
    shared = chromium.launch(launchOptions()).then((launched) => {
      launched.on("disconnected", () => {
        log("browser disconnected");
        shared = null;
      });
      return launched;
    }, (error: unknown) => {
      shared = null;
      throw new Error(`Chrome could not be started (install Google Chrome or set BROWSER_EXECUTABLE): ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return shared;
}

export async function closeBrowser(): Promise<void> {
  const open = shared;
  shared = null;
  if (open) await open.then((launched) => launched.close()).catch(() => undefined);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function watch(page: Page, log: (message: string) => void): void {
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) log(`navigated to ${frame.url()}`); });
  page.on("response", (response) => { if (response.request().resourceType() === "document") log(`document ${response.status()} ${response.url()}`); });
  page.on("crash", () => log("page crashed"));
  page.on("close", () => log("page closed"));
  page.on("pageerror", (error) => log(`page error: ${error.message}`));
}

async function load(url: URL, timeoutMs: number, log: (message: string) => void): Promise<string> {
  const context = await (await browser(log)).newContext({ locale: "en-CA", timezoneId: "America/Toronto" });
  try {
    const page = await context.newPage();
    watch(page, log);
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
    // The challenge reloads the page on its own; wait until a document without it has loaded.
    await page.waitForFunction(
      (marker) => document.readyState !== "loading" && !document.querySelector(`script[src*="${marker}"], iframe[src*="${marker}"]`),
      CHALLENGE_MARKER,
      { timeout: timeoutMs, polling: 500 },
    );
    // For a JSON or XML document this is the page Chrome wraps it in; the caller reads the <pre>.
    return await page.content();
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Load `url` in a fresh browser context and return the document as Chrome holds
 * it: the HTML of a page, or a JSON or XML body inside a <pre>. A bot challenge
 * that reloads the page is waited out; a page that closes under the challenge
 * gets one more attempt in a new context, then the failure is reported.
 */
export async function fetchWithBrowser(url: URL, options: BrowserFetchOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.log ?? (process.env.BROWSER_DEBUG ? (message: string) => console.error(`[browser] ${message}`) : () => undefined);
  let lastError: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await load(url, timeoutMs, log);
    } catch (error) {
      lastError = error;
      log(`attempt ${attempt} failed: ${describe(error)}`);
    }
  }
  throw new Error(`${url} could not be loaded in the browser: ${describe(lastError)}`);
}
