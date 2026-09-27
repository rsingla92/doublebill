import { load, type Cheerio, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { DateTime } from "luxon";
import { extractedShowtimeSchema, type DateRange, type ExtractionBatch, type ExtractedShowtime } from "../contracts.js";
import { fetchText } from "../http.js";
import { addPageDetails, cleanText, iso, TORONTO_TZ } from "./utils.js";

const BASE = "https://www.cinemamoderne.com";

/**
 * Cinéma Moderne's schedule is a monthly calendar at /horaire/YYYY/MM/. Each day
 * carries `data-day`; each screening card prints the time, the title with its
 * version label, the film's details (director, country, year, running time,
 * languages, format) and a TicketAcces link for the film. One request per month
 * inside the horizon covers the schedule.
 */
export interface ParsedModerneCalendar {
  showtimes: ExtractedShowtime[];
  warnings: string[];
}

const VERSION_LABEL = /^\(([^)]*)\)$/;

function listItems($: CheerioAPI, card: Cheerio<AnyNode>): string[] {
  return card.find(".cm-List__item").map((_, element) => cleanText($(element).text())).get().filter(Boolean);
}

/**
 * Parse one month page. A month page also shows the tail of the previous month
 * and the head of the next, so `fromDay` (YYYY-MM-DD) lets the caller drop days
 * before the crawl.
 */
export function parseModerneCalendar(html: string, pageUrl = `${BASE}/horaire/`, fromDay = ""): ParsedModerneCalendar {
  const $ = load(html);
  const showtimes: ExtractedShowtime[] = [];
  const warnings: string[] = [];

  $(".cm-Cal__day[data-day]").each((_, dayElement) => {
    const day = $(dayElement).attr("data-day") ?? "";
    if (day < fromDay) return;
    $(dayElement).find(".cm-Cal__day__event").each((__, eventElement) => {
      const event = $(eventElement);
      const time = cleanText(event.find(".cm-Fat").first().text());
      const titleNode = event.find(".cm-Card__title").first();
      const version = cleanText(titleNode.find(".cm-Card__subtitles").text()).match(VERSION_LABEL)?.[1] ?? "";
      const rawTitle = cleanText(titleNode.clone().find(".cm-Card__subtitles").remove().end().text());
      const filmHref = event.find(".cm-Cal__day__event__title a[href]").first().attr("href");
      const ticketHref = event.find("a[href*='ticketacces.net']").first().attr("href");
      const details = listItems($, event);
      const year = details.map((item) => item.match(/^((?:18|19|20)\d{2})$/)?.[1]).find(Boolean);
      const format = details.find((item) => /^(DCP|35\s*mm|16\s*mm|70\s*mm|Blu-ray|Num[ée]rique|Vid[ée]o)/i.test(item)) ?? "";

      if (!rawTitle || !time || !filmHref) {
        if (rawTitle || time) warnings.push(`${day} ${time} "${rawTitle}": screening card is missing its title, time or film link`);
        return;
      }
      // Morning screenings print a single-digit hour ("9:30").
      const startsAt = DateTime.fromFormat(`${day} ${time}`, "yyyy-MM-dd H:mm", { zone: TORONTO_TZ });
      if (!startsAt.isValid) {
        warnings.push(`${day} ${time} "${rawTitle}": unreadable date or time`);
        return;
      }
      const detailUrl = new URL(filmHref, pageUrl).toString();
      const slug = new URL(detailUrl).pathname.split("/").filter(Boolean).at(-1) ?? detailUrl;
      const tags = [
        ...version.split(/\s*\+\s*/).map((label) => label.trim()).filter(Boolean),
        ...(format && !/^DCP$/i.test(format) ? [format.replace(/^DCP\s*-\s*/i, "")] : []),
      ];
      try {
        showtimes.push(extractedShowtimeSchema.parse({
          venueSlug: "cinema-moderne",
          // The site has no screening id; the film slug and start time are the stable pair.
          sourceUid: `${slug}:${startsAt.toFormat("yyyy-MM-dd'T'HH:mm")}`,
          rawTitle,
          startsAt: iso(startsAt),
          detailUrl,
          ...(ticketHref ? { ticketUrl: new URL(ticketHref, pageUrl).toString() } : {}),
          ...(year ? { releaseYear: Number(year) } : {}),
          tags,
          sourcePayload: { day, time, version, details, ticketacces: ticketHref?.match(/EvenementID=(\d+)/)?.[1] },
        }));
      } catch (error) {
        warnings.push(`${day} ${time} "${rawTitle}": ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });

  return { showtimes, warnings };
}

/** The months touched by the range, as [year, month] pairs. */
export function monthsInRange(range: DateRange): Array<[number, number]> {
  const start = DateTime.fromJSDate(range.start).setZone(TORONTO_TZ).startOf("month");
  const end = DateTime.fromJSDate(range.end).setZone(TORONTO_TZ).startOf("month");
  const months: Array<[number, number]> = [];
  for (let cursor = start; cursor <= end; cursor = cursor.plus({ months: 1 })) months.push([cursor.year, cursor.month]);
  return months;
}

export interface ModerneOptions {
  /** Page fetcher for the film pages, replaceable in tests. */
  fetchPage?: (url: URL) => Promise<string>;
}

export async function extractModerne(range: DateRange, options: ModerneOptions = {}): Promise<ExtractionBatch> {
  const showtimes: ExtractedShowtime[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const fromDay = DateTime.fromJSDate(range.start).setZone(TORONTO_TZ).toISODate() ?? "";

  for (const [year, month] of monthsInRange(range)) {
    const url = new URL(`/horaire/${year}/${String(month).padStart(2, "0")}/`, BASE);
    try {
      const parsed = parseModerneCalendar(await fetchText(url), url.toString(), fromDay);
      warnings.push(...parsed.warnings);
      // Month pages overlap at their edges, so the same screening can appear twice.
      for (const showtime of parsed.showtimes) {
        if (seen.has(showtime.sourceUid)) continue;
        seen.add(showtime.sourceUid);
        showtimes.push(showtime);
      }
    } catch (error) {
      warnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The calendar card has the year; the film's page has its still and blurb.
  await addPageDetails(showtimes, options.fetchPage ?? fetchText);
  return { venueSlug: "cinema-moderne", fetchedAt: new Date().toISOString(), showtimes, warnings };
}
