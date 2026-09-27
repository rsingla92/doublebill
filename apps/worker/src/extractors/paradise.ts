import { load } from "cheerio";
import { DateTime } from "luxon";
import { z } from "zod";
import { extractedShowtimeSchema, type DateRange, type ExtractionBatch, type ExtractedShowtime } from "../contracts.js";
import { fetchText } from "../http.js";
import { cleanText, detailFields, iso, mapWithConcurrency, readPageDetails, TORONTO_TZ, usableDescription, usableImage } from "./utils.js";

const BASE = "https://paradiseonbloor.com";

/**
 * Paradise mixes film with music and comedy. /calendar-view/YYYY-MM lists every
 * event of a month by day; films live under /movies/ and shorts programmes under
 * /programs/, live events under /special_events/ and are left out. Each film
 * page carries schema.org ScreeningEvent JSON-LD with the start time, status and
 * the venue's own purchase link, whose id is the screening id.
 */
const FILM_PATH = /^\/(movies|programs)\/[^/]+\/?$/;

export function parseParadiseCalendar(html: string, pageUrl = `${BASE}/calendar-view/`): { filmUrls: string[]; skipped: string[] } {
  const $ = load(html);
  const filmUrls = new Set<string>();
  const skipped = new Set<string>();
  $(".calendar-show-item[data-show-card]").each((_, element) => {
    // The card is HTML stored in an attribute; cheerio has already decoded it once.
    const card = load($(element).attr("data-show-card") ?? "");
    const href = card("a[href]").first().attr("href");
    if (!href) return;
    const url = new URL(href, pageUrl);
    (FILM_PATH.test(url.pathname) ? filmUrls : skipped).add(url.toString());
  });
  return { filmUrls: [...filmUrls], skipped: [...skipped] };
}

const screeningSchema = z.object({
  "@type": z.union([z.string(), z.array(z.string())]),
  startDate: z.string(),
  url: z.string().url().optional(),
  eventStatus: z.string().optional(),
  offers: z.array(z.object({ availability: z.string().optional() })).optional(),
});

function graphNodes(html: string): unknown[] {
  const $ = load(html);
  return $("script[type='application/ld+json']").map((_, element) => {
    try {
      const parsed = JSON.parse($(element).text()) as { "@graph"?: unknown[] } | unknown[];
      return Array.isArray(parsed) ? parsed : parsed["@graph"] ?? [parsed];
    } catch {
      return [];
    }
  }).get();
}

/** A schema.org value that may be a string, a list, or an object with a url. */
function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstString(value[0]);
  if (value && typeof value === "object" && "url" in value) return firstString((value as { url: unknown }).url);
  return undefined;
}

export interface ParadisePageResult {
  showtimes: ExtractedShowtime[];
  warnings: string[];
}

export function parseParadiseMoviePage(html: string, pageUrl: string): ParadisePageResult {
  const $ = load(html);
  const nodes = graphNodes(html) as Array<Record<string, unknown>>;
  const movie = nodes.find((node) => node["@type"] === "Movie");
  const rawTitle = cleanText($("h2.show-title").first().text() || $("h1").first().text()) || cleanText(String(movie?.name ?? ""));
  const year = typeof movie?.dateCreated === "string" ? Number(movie.dateCreated.slice(0, 4)) : NaN;
  const showtimes: ExtractedShowtime[] = [];
  const warnings: string[] = [];
  if (!rawTitle) return { showtimes, warnings: [`${pageUrl}: film page has no title`] };
  // The structured data names the film's image and description; the share tags are the fallback.
  const page = readPageDetails(html, pageUrl, DateTime.now().setZone(TORONTO_TZ).year + 1);
  const details = {
    year: Number.isInteger(year) && year >= 1888 ? year : page.year,
    imageUrl: usableImage(firstString(movie?.image), pageUrl) ?? page.imageUrl,
    synopsis: usableDescription(firstString(movie?.description)) ?? page.synopsis,
  };

  for (const node of nodes) {
    const types = ([] as unknown[]).concat(node["@type"] ?? []);
    if (!types.includes("ScreeningEvent")) continue;
    const event = screeningSchema.safeParse(node);
    if (!event.success) {
      warnings.push(`${pageUrl}: screening ${event.error.issues.map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`).join("; ")}`);
      continue;
    }
    const startsAt = DateTime.fromISO(event.data.startDate, { setZone: true });
    if (!startsAt.isValid) {
      warnings.push(`${pageUrl}: unreadable start "${event.data.startDate}"`);
      continue;
    }
    const showtimeId = event.data.url?.match(/\/purchase\/(\d+)/)?.[1];
    const cancelled = /EventCancelled|EventPostponed/i.test(event.data.eventStatus ?? "");
    const soldOut = event.data.offers?.length ? event.data.offers.every((offer) => /SoldOut/i.test(offer.availability ?? "")) : false;
    showtimes.push(extractedShowtimeSchema.parse({
      venueSlug: "paradise-theatre",
      sourceUid: showtimeId ?? `${new URL(pageUrl).pathname}:${startsAt.setZone(TORONTO_TZ).toFormat("yyyy-MM-dd'T'HH:mm")}`,
      rawTitle,
      startsAt: iso(startsAt.setZone(TORONTO_TZ)),
      detailUrl: pageUrl,
      ...(event.data.url ? { ticketUrl: event.data.url } : {}),
      ...detailFields(details),
      status: cancelled ? "cancelled" : soldOut ? "sold_out" : "scheduled",
      tags: [],
      sourcePayload: { showtimeId, eventStatus: event.data.eventStatus, movieName: movie?.name },
    }));
  }
  return { showtimes, warnings };
}

/** The months touched by the range, as "YYYY-MM". */
function monthsInRange(range: DateRange): string[] {
  const start = DateTime.fromJSDate(range.start).setZone(TORONTO_TZ).startOf("month");
  const end = DateTime.fromJSDate(range.end).setZone(TORONTO_TZ).startOf("month");
  const months: string[] = [];
  for (let cursor = start; cursor <= end; cursor = cursor.plus({ months: 1 })) months.push(cursor.toFormat("yyyy-MM"));
  return months;
}

export async function extractParadise(range: DateRange): Promise<ExtractionBatch> {
  const warnings: string[] = [];
  const filmUrls = new Set<string>();
  for (const month of monthsInRange(range)) {
    const url = new URL(`/calendar-view/${month}`, BASE);
    try {
      parseParadiseCalendar(await fetchText(url), url.toString()).filmUrls.forEach((film) => filmUrls.add(film));
    } catch (error) {
      warnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const pages = await mapWithConcurrency([...filmUrls], 4, async (url) => {
    try {
      const result = parseParadiseMoviePage(await fetchText(new URL(url)), url);
      warnings.push(...result.warnings);
      return result.showtimes;
    } catch (error) {
      warnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });

  const start = range.start.getTime();
  const end = range.end.getTime();
  const seen = new Set<string>();
  const showtimes = pages.flat().filter((showtime) => {
    const at = Date.parse(showtime.startsAt);
    if (at < start - 86_400_000 || at > end || seen.has(showtime.sourceUid)) return false;
    seen.add(showtime.sourceUid);
    return true;
  });
  return { venueSlug: "paradise-theatre", fetchedAt: new Date().toISOString(), showtimes, warnings };
}
