import { load } from "cheerio";
import { DateTime } from "luxon";
import { z } from "zod";
import { extractedShowtimeSchema, type DateRange, type ExtractionBatch, type ExtractedShowtime } from "../contracts.js";
import { fetchJson, fetchText } from "../http.js";
import { agileEventId, cleanAgileUrl, isAgileTicketLink } from "./agile.js";
import { cleanText, detailFields, iso, mapWithConcurrency, parseDateTime, readPageDetails, TORONTO_TZ } from "./utils.js";

const BASE = "https://www.foxtheatre.ca";
const PAGE_SIZE = 100;
const MAX_PAGES = 5;

/**
 * The Fox's WordPress site keeps one `movies` post per film with an `event-date`
 * class per screening day. The REST route lists them; each film page prints a
 * showtimes list with the day, the time and an Agile ticket link per screening.
 */
const postSchema = z.object({
  id: z.number().int(),
  slug: z.string().min(1),
  link: z.string().url(),
  title: z.object({ rendered: z.string() }),
  class_list: z.array(z.string()).optional().default([]),
});

export interface FoxPost {
  id: number;
  slug: string;
  link: string;
  title: string;
  /** Screening days, YYYY-MM-DD, from the post's `event-date-*` classes. */
  dates: string[];
}

export function parseFoxPosts(payload: unknown): { posts: FoxPost[]; warnings: string[] } {
  if (!Array.isArray(payload)) throw new Error("movies response is not an array");
  const posts: FoxPost[] = [];
  const warnings: string[] = [];
  payload.forEach((entry, index) => {
    const post = postSchema.safeParse(entry);
    if (!post.success) {
      warnings.push(`post ${index}: ${post.error.issues.map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`).join("; ")}`);
      return;
    }
    posts.push({
      id: post.data.id,
      slug: post.data.slug,
      link: post.data.link,
      title: cleanText(load(`<x>${post.data.title.rendered}</x>`)("x").text()),
      dates: post.data.class_list.filter((name) => name.startsWith("event-date-")).map((name) => name.slice("event-date-".length)),
    });
  });
  return { posts, warnings };
}

export interface FoxPageResult {
  showtimes: ExtractedShowtime[];
  warnings: string[];
}

export function parseFoxMoviePage(html: string, post: Pick<FoxPost, "id" | "link" | "title">, reference?: DateTime): FoxPageResult {
  const $ = load(html);
  const rawTitle = cleanText($("h1").first().text()) || post.title;
  const status = /^sold[\s-]*out\b/i.test(rawTitle) ? "sold_out" : "scheduled";
  const details = readPageDetails(html, post.link, (reference ?? DateTime.now().setZone(TORONTO_TZ)).year + 1);
  const showtimes: ExtractedShowtime[] = [];
  const warnings: string[] = [];

  $(".showtimes-lists .item").each((_, element) => {
    const item = $(element);
    const date = cleanText(item.find(".date").text());
    const time = cleanText(item.find(".time").text());
    const href = item.find("a[href]").filter((__, anchor) => isAgileTicketLink($(anchor).attr("href"))).first().attr("href");
    if (!date || !time) return;
    // A placeholder post (a closure notice) lists midnight entries with no ticket link.
    if (!href && /^12:00\s*am$/i.test(time)) return;
    try {
      const startsAt = parseDateTime(`${date} ${time}`, ["cccc, LLLL d h:mm a", "LLLL d h:mm a", "cccc, LLLL d h a"], { zone: TORONTO_TZ, ...(reference ? { reference } : {}) });
      const eventId = agileEventId(href);
      showtimes.push(extractedShowtimeSchema.parse({
        venueSlug: "fox-theatre",
        sourceUid: eventId ?? `${post.id}:${startsAt.toFormat("yyyy-MM-dd'T'HH:mm")}`,
        rawTitle,
        startsAt: iso(startsAt),
        detailUrl: post.link,
        ...(href ? { ticketUrl: cleanAgileUrl(href, post.link) } : {}),
        ...detailFields(details),
        status,
        tags: [],
        sourcePayload: { postId: post.id, dateText: date, timeText: time, agileEventId: eventId },
      }));
    } catch (error) {
      warnings.push(`${post.link} "${date} ${time}": ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return { showtimes, warnings };
}

export async function extractFox(range: DateRange): Promise<ExtractionBatch> {
  const warnings: string[] = [];
  const posts: FoxPost[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL("/wp-json/wp/v2/movies", BASE);
    url.search = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page), _fields: "id,slug,link,title,class_list" }).toString();
    const parsed = parseFoxPosts(await fetchJson(url));
    warnings.push(...parsed.warnings.map((warning) => `page ${page} ${warning}`));
    posts.push(...parsed.posts);
    if (parsed.posts.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) warnings.push(`stopped at page cap (${MAX_PAGES}); listings may be incomplete`);
  }

  const start = DateTime.fromJSDate(range.start).setZone(TORONTO_TZ).toISODate()!;
  const end = DateTime.fromJSDate(range.end).setZone(TORONTO_TZ).toISODate()!;
  const current = posts.filter((post) => post.dates.some((date) => date >= start && date <= end));

  const pages = await mapWithConcurrency(current, 4, async (post) => {
    try {
      const result = parseFoxMoviePage(await fetchText(new URL(post.link)), post);
      warnings.push(...result.warnings);
      return result.showtimes;
    } catch (error) {
      warnings.push(`${post.link}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });

  const seen = new Set<string>();
  const showtimes = pages.flat().filter((showtime) => !seen.has(showtime.sourceUid) && seen.add(showtime.sourceUid));
  return { venueSlug: "fox-theatre", fetchedAt: new Date().toISOString(), showtimes, warnings };
}
