import { GOATCOUNTER_SCRIPT, goatCounterEndpoint } from "@/lib/analytics";

/** Counts one page view per load when a GoatCounter code is configured; renders nothing otherwise. */
export function Analytics() {
  const endpoint = goatCounterEndpoint();
  if (!endpoint) return null;
  return <script async data-goatcounter={endpoint} src={GOATCOUNTER_SCRIPT} />;
}
