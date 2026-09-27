import { load } from "cheerio";
import { DateTime } from "luxon";
import { z } from "zod";
import { extractedShowtimeSchema, type DateRange, type ExtractionBatch, type ExtractedShowtime } from "../contracts.js";
import { fetchText } from "../http.js";
import { agileEventId, cleanAgileUrl, isAgileTicketLink } from "./agile.js";
import { cleanText, detailFields, iso, mapWithConcurrency, readPageDetails, TORONTO_TZ, type PageDetails } from "./utils.js";

const BASE = "https://revuecinema.ca";

/**
 * The Revue's calendar page embeds every upcoming screening as the FullCalendar
 * `events` array: title, local start and film page. The film page carries the
 * Agile "Buy Tickets" link, one per film, so pages are fetched only for films
 * with a screening inside the range.
 */
export interface RevueCalendarEvent {
  title: string;
  /** Local Toronto time, "2026-12-31 18:45:00". */
  start: string;
  url: string;
}

const CLOSURE = /^\s*closed\b/i;

const eventSchema = z.object({ title: z.string().min(1), start: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/), url: z.string().url() });

/** Find the `events: [...]` literal in the calendar script; the array is JSON but sits inside JavaScript. */
function eventsLiteral(html: string): string {
  const scripts = load(html)("script").map((_, element) => load(html)(element).text()).get();
  for (const script of scripts) {
    const at = script.search(/\bevents\s*:\s*\[/);
    if (at === -1) continue;
    const open = script.indexOf("[", at);
    let depth = 0;
    let inString: string | null = null;
    for (let i = open; i < script.length; i += 1) {
      const char = script[i]!;
      if (inString) {
        if (char === "\\") i += 1;
        else if (char === inString) inString = null;
        continue;
      }
      if (char === '"' || char === "'") inString = char;
      else if (char === "[") depth += 1;
      else if (char === "]") {
        depth -= 1;
        if (depth === 0) return script.slice(open, i + 1);
      }
    }
  }
  throw new Error("calendar page has no events array");
}

export interface ParsedRevueCalendar {
  events: RevueCalendarEvent[];
  warnings: string[];
}

export function parseRevueCalendar(html: string): ParsedRevueCalendar {
  const raw = JSON.parse(eventsLiteral(html)) as unknown;
  if (!Array.isArray(raw)) throw new Error("calendar events are not an array");
  const events: RevueCalendarEvent[] = [];
  const warnings: string[] = [];
  raw.forEach((entry, index) => {
    const parsed = eventSchema.safeParse(entry);
    if (parsed.success) events.push(parsed.data);
    else warnings.push(`calendar event ${index}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`).join("; ")}`);
  });
  return { events, warnings };
}

export interface RevueFilmPage {
  /** The Agile link, or undefined when the film has none (a free or off-sale event). */
  ticketUrl?: string;
  /** The year, still and blurb the page prints. */
  details: PageDetails;
}

/** What one film page gives every screening of that film. */
export function parseRevueFilmPage(html: string, pageUrl: string, reference?: DateTime): RevueFilmPage {
  const $ = load(html);
  const href = $("a[href*='agileticketing.net/websales/pages/info.aspx']").filter((_, element) => isAgileTicketLink($(element).attr("href"))).first().attr("href");
  const details = readPageDetails(html, pageUrl, (reference ?? DateTime.now().setZone(TORONTO_TZ)).year + 1);
  return { ...(href ? { ticketUrl: cleanAgileUrl(href, pageUrl) } : {}), details };
}

export function revueShowtime(event: RevueCalendarEvent, film: RevueFilmPage | undefined): ExtractedShowtime {
  const ticketUrl = film?.ticketUrl;
  const startsAt = DateTime.fromFormat(event.start, event.start.length === 16 ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd HH:mm:ss", { zone: TORONTO_TZ });
  if (!startsAt.isValid) throw new Error(`unreadable start "${event.start}"`);
  const slug = new URL(event.url).pathname.replace(/^\/films\//, "").replace(/\/$/, "");
  return extractedShowtimeSchema.parse({
    venueSlug: "revue-cinema",
    // The site has no screening id; the film's slug and start time are the stable pair.
    sourceUid: `${slug}:${startsAt.toFormat("yyyy-MM-dd'T'HH:mm")}`,
    rawTitle: cleanText(event.title),
    startsAt: iso(startsAt),
    detailUrl: event.url,
    ...(ticketUrl ? { ticketUrl } : {}),
    ...detailFields(film?.details ?? {}),
    tags: [],
    sourcePayload: { ...event, agileEventId: agileEventId(ticketUrl) },
  });
}

export async function extractRevue(range: DateRange): Promise<ExtractionBatch> {
  const calendar = parseRevueCalendar(await fetchText(new URL("/calendar/", BASE)));
  const warnings = [...calendar.warnings];
  const start = DateTime.fromJSDate(range.start).setZone(TORONTO_TZ).startOf("day");
  const end = DateTime.fromJSDate(range.end).setZone(TORONTO_TZ);
  const inRange = calendar.events.filter((event) => {
    // The calendar also carries closure notices ("CLOSED FOR PRIVATE RENTAL"), which are not screenings.
    if (CLOSURE.test(event.title)) return false;
    const when = DateTime.fromFormat(event.start.slice(0, 16), "yyyy-MM-dd HH:mm", { zone: TORONTO_TZ });
    return when.isValid && when >= start && when <= end;
  });

  const filmUrls = [...new Set(inRange.map((event) => event.url))];
  const pages = new Map<string, RevueFilmPage>();
  await mapWithConcurrency(filmUrls, 4, async (url) => {
    try {
      pages.set(url, parseRevueFilmPage(await fetchText(new URL(url)), url));
    } catch (error) {
      warnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const showtimes: ExtractedShowtime[] = [];
  const seen = new Set<string>();
  for (const event of inRange) {
    try {
      const showtime = revueShowtime(event, pages.get(event.url));
      if (seen.has(showtime.sourceUid)) continue;
      seen.add(showtime.sourceUid);
      showtimes.push(showtime);
    } catch (error) {
      warnings.push(`${event.url} ${event.start}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { venueSlug: "revue-cinema", fetchedAt: new Date().toISOString(), showtimes, warnings };
}
