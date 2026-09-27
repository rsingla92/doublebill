import { load } from "cheerio";
import { DateTime } from "luxon";
import { extractedShowtimeSchema, type ExtractionBatch, type ExtractedShowtime } from "../contracts.js";
import { fetchText } from "../http.js";
import { absoluteUrl, cleanText, detailFields, iso, mapWithConcurrency, parseDateTime, printedYear, readPageDetails, VANCOUVER_TZ } from "./utils.js";

const BASE = "https://thecinematheque.ca";

/**
 * Screening dates on a film page carry a month, day and weekday but no year. The
 * year is inferred relative to `reference` (the crawl time) and the weekday token
 * settles the December-to-January boundary; the programme year in the page URL
 * is deliberately not used because a page can list screenings in the next year.
 */
/** The year the film page prints; kept under its old name for the tests and the index. */
export const parseFilmYear = printedYear;

export function parseCinemathequeFilmPage(html: string, pageUrl: string, reference?: DateTime): ExtractedShowtime[] {
  const $ = load(html);
  const rawTitle = cleanText($(".filmTitle").first().text() || $("h1").first().text() || $("title").text().split("|")[0]);
  const now = reference ?? DateTime.now().setZone(VANCOUVER_TZ);
  const details = readPageDetails(html, pageUrl, now.year + 1);
  const output: ExtractedShowtime[] = [];

  $("#screeningDates a[href*='evtinfo=']").each((_, element) => {
    const anchor = $(element);
    const ticketUrl = absoluteUrl(anchor.attr("href")!, pageUrl);
    const evtInfo = new URL(ticketUrl).searchParams.get("evtinfo")?.split("~")[0];
    const weekday = cleanText(anchor.find(".dow").text()).replace(/[()]/g, "");
    const monthDay = cleanText(anchor.clone().find(".dow,.time").remove().end().text());
    const time = cleanText(anchor.find(".time").text());
    const period = anchor.find(".time").hasClass("pm") ? "pm" : "am";
    const startsAt = parseScreeningDate(weekday, monthDay, `${time} ${period}`, now);

    output.push(extractedShowtimeSchema.parse({
      venueSlug: "the-cinematheque",
      sourceUid: evtInfo ?? `${new URL(pageUrl).pathname}:${startsAt.toISO()}`,
      rawTitle,
      startsAt: iso(startsAt),
      ...detailFields(details),
      detailUrl: pageUrl,
      ticketUrl,
      tags: [],
      sourcePayload: { evtInfo, pageUrl, screeningText: cleanText(anchor.text()) },
    }));
  });

  return output;
}

/** The site writes the next two days as "Today" and "Tomorrow" instead of a date. */
const RELATIVE_DAYS: Record<string, number> = { today: 0, tonight: 0, tomorrow: 1 };

function parseScreeningDate(weekday: string, monthDay: string, clock: string, reference: DateTime): DateTime {
  const offset = RELATIVE_DAYS[monthDay.toLowerCase()];
  if (offset !== undefined) {
    const time = DateTime.fromFormat(clock, "h:mm a", { zone: VANCOUVER_TZ, locale: "en-CA" });
    if (!time.isValid) throw new Error(`Unable to parse Vancouver date/time: ${monthDay} ${clock}`);
    return reference.setZone(VANCOUVER_TZ).plus({ days: offset }).set({ hour: time.hour, minute: time.minute, second: 0, millisecond: 0 });
  }
  const value = `${monthDay} ${clock}`;
  if (weekday) {
    try {
      return parseDateTime(`${weekday} ${value}`, ["cccc LLLL d h:mm a", "cccc LLL d h:mm a"], { reference });
    } catch {
      // A weekday that matches no nearby year is a site typo; fall back to the date alone.
    }
  }
  return parseDateTime(value, ["LLLL d h:mm a", "LLL d h:mm a"], { reference });
}

export function parseCinemathequeFilmLinks(html: string): string[] {
  const $ = load(html);
  return [...new Set(
    $("a[href^='/films/'],a[href^='https://thecinematheque.ca/films/']")
      .map((_, element) => absoluteUrl($(element).attr("href")!, BASE))
      .get()
      .filter((url) => /\/films\/\d{4}\//.test(url)),
  )];
}

export async function extractCinematheque(): Promise<ExtractionBatch> {
  const indexUrl = new URL("/films", BASE);
  const links = parseCinemathequeFilmLinks(await fetchText(indexUrl));
  const warnings: string[] = [];
  const pages = await mapWithConcurrency(links, 4, async (url) => {
    try {
      return parseCinemathequeFilmPage(await fetchText(new URL(url)), url);
    } catch (error) {
      warnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });

  return {
    venueSlug: "the-cinematheque",
    fetchedAt: new Date().toISOString(),
    showtimes: pages.flat(),
    warnings,
  };
}
