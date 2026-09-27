import { load } from "cheerio";
import { DateTime } from "luxon";
import { extractedShowtimeSchema, type ExtractionBatch, type ExtractedShowtime } from "../contracts.js";
import { fetchText } from "../http.js";
import { absoluteUrl, cleanText, iso, longestParagraph, parseDateTime, printedYear, usableImage, VANCOUVER_TZ } from "./utils.js";

const BASE = "https://viff.org";

export function parseViffPage(html: string, pageUrl = `${BASE}/whats-on/`, reference?: DateTime): ExtractedShowtime[] {
  const $ = load(html);
  const output: ExtractedShowtime[] = [];

  $(".c-event-card").each((_, cardElement) => {
    const card = $(cardElement);
    const rawTitle = cleanText(card.find(".c-event-card__title").first().text());
    const detailHref = card.find(".c-event-card__title a").first().attr("href");
    if (!rawTitle || !detailHref) return;
    const detailUrl = absoluteUrl(detailHref, pageUrl);
    const now = reference ?? DateTime.now().setZone(VANCOUVER_TZ);
    // Everything on the card but the title: country, year and running time live there.
    const releaseYear = printedYear(cleanText(card.clone().find(".c-event-card__title").remove().end().text()), now.year + 1);
    const image = card.find("img").first();
    const imageUrl = usableImage(image.attr("data-src") ?? image.attr("src"), pageUrl);
    const synopsis = longestParagraph(card.find("p").map((__, element) => $(element).text()).get(), 60);

    card.find(".c-event-instance").each((__, instanceElement) => {
      const instance = $(instanceElement);
      const instanceId = instance.find("[data-instanceid]").first().attr("data-instanceid");
      const date = cleanText(instance.find(".c-event-instance__date span").text());
      const time = cleanText(instance.find(".c-event-instance__time").text());
      if (!date || !time) return;

      const startsAt = parseDateTime(`${date} ${time}`, ["ccc LLL d h:mm a", "LLL d h:mm a"], { reference: now });
      const ticketHref = instance.find("a.c-event-instance__btn[href*='/book/']").attr("href");
      const statusText = cleanText(instance.find(".c-event-instance__booking-message,.c-event-instance__btn").text()).toLowerCase();
      const status = statusText.includes("sold out") || statusText.includes("standby") ? "sold_out" : "scheduled";
      const tags = instance.find(".c-event-instance__access .access span")
        .map((___, element) => cleanText($(element).text()))
        .get()
        .filter(Boolean);

      output.push(extractedShowtimeSchema.parse({
        venueSlug: "viff-centre",
        sourceUid: instanceId ?? ticketHref?.match(/\/book\/([^/?#]+)/)?.[1] ?? `${new URL(detailUrl).pathname}:${startsAt.toISO()}`,
        rawTitle,
        startsAt: iso(startsAt),
        ...(releaseYear ? { releaseYear } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(synopsis ? { synopsis } : {}),
        detailUrl,
        ...(ticketHref ? { ticketUrl: absoluteUrl(ticketHref, pageUrl) } : {}),
        status,
        tags,
        sourcePayload: {
          eventId: instance.find("[data-eventid]").first().attr("data-eventid"),
          instanceId,
          venue: cleanText(instance.find(".c-event-instance__venue").text()),
          statusText,
        },
      }));
    });
  });

  return output;
}

export async function extractViff(maxPages = 20): Promise<ExtractionBatch> {
  const showtimes: ExtractedShowtime[] = [];
  const warnings: string[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(page === 1 ? "/whats-on/" : `/whats-on/page/${page}/`, BASE);
    const html = await fetchText(url);
    const parsed = parseViffPage(html, url.toString());
    showtimes.push(...parsed);
    if (parsed.length === 0) warnings.push(`${url}: no showtimes parsed`);
    if (!html.includes(`/whats-on/page/${page + 1}/`)) break;
    if (page === maxPages) warnings.push(`stopped at page cap (${maxPages}); listings may be incomplete`);
  }

  return { venueSlug: "viff-centre", fetchedAt: new Date().toISOString(), showtimes, warnings };
}
