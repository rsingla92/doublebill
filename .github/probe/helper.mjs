// Temporary: run the worker's own browser helper against a URL on the runner.
import { fetchWithBrowser, closeBrowser } from "../../apps/worker/dist/browser.js";
const [target] = process.argv.slice(2);
const started = Date.now();
try {
  const text = await fetchWithBrowser(new URL(target), { log: (message) => console.log(`[browser +${Date.now() - started}ms] ${message}`) });
  console.log(`ok after ${Date.now() - started}ms, ${text.length} chars`);
  console.log(text.slice(0, 1500));
} catch (error) {
  console.log(`failed after ${Date.now() - started}ms: ${error.stack ?? error}`);
} finally {
  await closeBrowser();
}
