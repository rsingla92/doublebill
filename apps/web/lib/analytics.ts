/**
 * Page-view counting with GoatCounter (goatcounter.com): no cookies, no personal
 * data, no advertising. It is off unless the build sets NEXT_PUBLIC_GOATCOUNTER_CODE
 * to the site code chosen at sign-up (the "doublebill" in doublebill.goatcounter.com).
 */
export const GOATCOUNTER_SCRIPT = "https://gc.zgo.at/count.js";

/** The endpoint that receives counts, or null when counting is off or the code is malformed. */
export function goatCounterEndpoint(code: string | undefined = process.env.NEXT_PUBLIC_GOATCOUNTER_CODE): string | null {
  const trimmed = code?.trim().toLowerCase();
  if (!trimmed || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(trimmed)) return null;
  return `https://${trimmed}.goatcounter.com/count`;
}
