import { load } from "cheerio";
import { DateTime } from "luxon";
import { z } from "zod";
import { fetchWithBrowser } from "../browser.js";
import { extractedShowtimeSchema, type DateRange, type ExtractionBatch, type ExtractedShowtime } from "../contracts.js";
import { agileEventId, cleanAgileUrl } from "./agile.js";
import { cleanText, iso, TORONTO_TZ, usableDescription, usableImage } from "./utils.js";

/**
 * Hot Docs publishes the Ted Rogers Cinema schedule only on its Agile Ticketing
 * box office, boxoffice.hotdocs.ca, whose pages and feeds sit behind Incapsula
 * and answer a plain HTTP client with a challenge page. Loaded in a browser, the
 * WebSales JSON feed for the "Cinema A-Z" entry group lists every film on sale
 * with its showings: the showing id, the local start time, the purchase link,
 * the venue, the still, the blurb and the film's year. One request covers the
 * whole published schedule, months ahead for the Doc Soup series.
 */
const BASE = "https://boxoffice.hotdocs.ca";
/** The "Cinema A-Z" entry group, the one the box office's own scripts read. */
const CINEMA_FEED_GUID = "64170f3e-6ca4-4dbc-9cb5-e359273e95dd";
export const HOT_DOCS_FEED_URL = new URL(`/websales/feed.ashx?guid=${CINEMA_FEED_GUID}&showslist=true&format=json&withmedia=true&v=latest`, BASE);
/** Where a person reads the programme. */
const PROGRAMME_URL = "https://hotdocs.ca/whats-on/cinema";
/** During the festival the same box office sells for other venues; only the cinema belongs here. */
const OWN_VENUE = /ted rogers|hot docs cinema/i;
const QA = /\bq\s*(?:&|&amp;|\+|and)\s*a\b/i;

const propertySchema = z.object({ Name: z.string(), Value: z.string().optional().default("") });

const showingSchema = z.object({
  ID: z.union([z.number().int(), z.string()]).transform(String),
  DateTBD: z.boolean().optional(),
  StartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/),
  EndDate: z.string().optional(),
  SalesState: z.string().optional(),
  SalesMessage: z.string().optional(),
  LegacyPurchaseLink: z.string().optional(),
  Venue: z.object({ VenueID: z.union([z.number(), z.string()]).optional(), Name: z.string().optional() }).optional(),
});

const showSchema = z.object({
  ID: z.union([z.number().int(), z.string()]).transform(String),
  Name: z.string().min(1),
  Folder: z.string().optional(),
  Type: z.string().optional(),
  ShortDescription: z.string().optional(),
  ShortDescriptive1: z.string().optional(),
  ExtraHTML: z.string().optional(),
  EventImage: z.string().optional(),
  InfoLink: z.string().optional(),
  CustomProperties: z.array(z.unknown()).optional().default([]),
  CurrentShowings: z.array(z.unknown()).optional().default([]),
});

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`).join("; ");
}

/** The feed as JSON, whether it arrived bare or wrapped in the page Chrome shows for a JSON document. */
export function readFeed(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const pre = load(text)("pre").first().text().trim();
  if (!pre) throw new Error("the feed is not JSON");
  return JSON.parse(pre);
}

function properties(entries: unknown[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const entry of entries) {
    const property = propertySchema.safeParse(entry);
    if (!property.success) continue;
    const value = cleanText(property.data.Value);
    if (!value) continue;
    found.set(property.data.Name, [...(found.get(property.data.Name) ?? []), value]);
  }
  return found;
}

function status(showing: z.infer<typeof showingSchema>): ExtractedShowtime["status"] {
  const text = `${showing.SalesState ?? ""} ${showing.SalesMessage ?? ""}`;
  if (/cancel/i.test(text)) return "cancelled";
  if (/sold\s*out|soldout/i.test(text)) return "sold_out";
  return "scheduled";
}

export interface ParsedHotDocsFeed {
  showtimes: ExtractedShowtime[];
  /** Showings the feed lists at another venue, left out. */
  otherVenues: number;
  warnings: string[];
}

export function parseHotDocsFeed(payload: unknown, options: { maxYear?: number } = {}): ParsedHotDocsFeed {
  const shows = (payload as { ArrayOfShows?: unknown })?.ArrayOfShows;
  if (!Array.isArray(shows)) throw new Error("the feed has no ArrayOfShows");
  const maxYear = options.maxYear ?? new Date().getFullYear() + 1;
  const showtimes: ExtractedShowtime[] = [];
  const warnings: string[] = [];
  let otherVenues = 0;

  shows.forEach((entry, index) => {
    const show = showSchema.safeParse(entry);
    if (!show.success) {
      warnings.push(`show ${index}: ${issues(show.error)}`);
      return;
    }
    const film = show.data;
    const rawTitle = cleanText(film.Name);
    const props = properties(film.CustomProperties);
    const year = Number(props.get("Copyright")?.[0] ?? NaN);
    const releaseYear = Number.isInteger(year) && year >= 1888 && year <= maxYear ? year : undefined;
    const imageUrl = usableImage(film.EventImage, BASE);
    const synopsis = usableDescription(film.ShortDescription);
    const detailUrl = film.InfoLink ? cleanAgileUrl(film.InfoLink, BASE) : PROGRAMME_URL;
    const guid = film.InfoLink?.match(/evtinfo=\d+~([0-9a-f-]+)/i)?.[1];
    // The series or strand the cinema files the film under, then the event kind.
    const series = cleanText(film.ShortDescriptive1 ?? "") || props.get("Filter by Type")?.[0] || "";
    const tags = [...new Set([series, QA.test(`${film.Name} ${film.ShortDescription ?? ""} ${film.ExtraHTML ?? ""}`) ? "Q&A" : ""].filter(Boolean))];

    for (const raw of film.CurrentShowings) {
      const parsed = showingSchema.safeParse(raw);
      if (!parsed.success) {
        warnings.push(`${rawTitle}: showing ${issues(parsed.error)}`);
        continue;
      }
      const showing = parsed.data;
      if (showing.DateTBD) continue;
      const venue = showing.Venue?.Name ?? "";
      if (venue && !OWN_VENUE.test(venue)) {
        otherVenues += 1;
        continue;
      }
      const startsAt = DateTime.fromISO(showing.StartDate, { zone: TORONTO_TZ });
      if (!startsAt.isValid) {
        warnings.push(`${rawTitle}: unreadable start "${showing.StartDate}"`);
        continue;
      }
      const endsAt = showing.EndDate ? DateTime.fromISO(showing.EndDate, { zone: TORONTO_TZ }) : null;
      const ticketUrl = showing.LegacyPurchaseLink
        ? cleanAgileUrl(showing.LegacyPurchaseLink, BASE)
        : guid ? `${BASE}/websales/pages/ticketsearchcriteria.aspx?evtinfo=${showing.ID}~${guid}` : undefined;
      const showtime = extractedShowtimeSchema.safeParse({
        venueSlug: "hot-docs-cinema",
        sourceUid: showing.ID,
        rawTitle,
        startsAt: iso(startsAt),
        ...(endsAt?.isValid && endsAt > startsAt ? { endsAt: iso(endsAt) } : {}),
        detailUrl,
        ...(ticketUrl ? { ticketUrl } : {}),
        ...(releaseYear ? { releaseYear } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(synopsis ? { synopsis } : {}),
        status: status(showing),
        tags,
        sourcePayload: {
          showId: film.ID,
          showingId: showing.ID,
          agileEventId: agileEventId(ticketUrl),
          folder: film.Folder,
          type: film.Type,
          salesState: showing.SalesState,
          salesMessage: showing.SalesMessage,
          venue,
          director: props.get("Director(s)")?.join(", "),
          countries: props.get("Country Listing"),
          runtime: props.get("Runtime")?.[0],
          filterType: props.get("Filter by Type")?.[0],
        },
      });
      if (!showtime.success) {
        warnings.push(`${rawTitle} showing ${showing.ID}: ${issues(showtime.error)}`);
        continue;
      }
      showtimes.push(showtime.data);
    }
  });

  return { showtimes, otherVenues, warnings };
}

export interface HotDocsOptions {
  /** How the feed is fetched; the default loads it in a browser because of the bot challenge. */
  fetchPage?: (url: URL) => Promise<string>;
}

export async function extractHotDocs(range: DateRange, options: HotDocsOptions = {}): Promise<ExtractionBatch> {
  const fetchPage = options.fetchPage ?? ((url: URL) => fetchWithBrowser(url));
  const parsed = parseHotDocsFeed(readFeed(await fetchPage(HOT_DOCS_FEED_URL)));
  const start = DateTime.fromJSDate(range.start).setZone(TORONTO_TZ).startOf("day").toMillis();
  const end = range.end.getTime();
  const seen = new Set<string>();
  const showtimes = parsed.showtimes.filter((showtime) => {
    const at = Date.parse(showtime.startsAt);
    if (at < start || at > end || seen.has(showtime.sourceUid)) return false;
    seen.add(showtime.sourceUid);
    return true;
  });
  return { venueSlug: "hot-docs-cinema", fetchedAt: new Date().toISOString(), showtimes, warnings: parsed.warnings };
}
