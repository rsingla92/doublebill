import { load } from "cheerio";
import { DateTime } from "luxon";
import { z } from "zod";
import { extractedShowtimeSchema, type ExtractionBatch, type ExtractedShowtime } from "../contracts.js";
import { fetchJson } from "../http.js";
import { cleanText, iso, longestParagraph, parseDateTime, TORONTO_TZ, usableImage } from "./utils.js";

const BASE = "https://theroyal.to";
/** WordPress category ids on theroyal.to: "screenings" sits under "events"; comedy has its own category. */
export const SCREENINGS_CATEGORY = 95;
const PAGE_SIZE = 100;

/**
 * The Royal is a rental house: each screening is a WordPress post in the
 * "screenings" category whose title ends with the date ("Persépolis – September
 * 2, 2026", "… – September 24 & 25, 2026") and whose body gives the start time
 * ("Program Begins: 6:30 PM", "Show: 7:30pm") and the promoter's ticket link.
 */
const postSchema = z.object({
  id: z.number().int(),
  link: z.string().url(),
  title: z.object({ rendered: z.string() }),
  content: z.object({ rendered: z.string() }),
});

const TITLE_DATE = /^(.*?)\s*[-–—]\s*([A-Za-z]+\.?)\s+(\d{1,2}(?:\s*(?:&|and|,)\s*\d{1,2})*),?\s+(\d{4})\s*$/;
const START_TIME = /\b(?:program(?:me)?\s+begins|show(?:time)?|screening|film|feature|movie|starts?)\s*(?:at|begins|:|@|-|–)?\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i;
const DOORS_TIME = /\bdoors?(?:\s+open)?\s*(?:at|:|@|-|–)?\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i;
const SOCIAL_HOSTS = /(?:^|\.)(?:facebook|instagram|twitter|x|youtube|tiktok|whatsapp|linkedin|threads)\.com$/i;

export interface ParsedRoyalPosts {
  showtimes: ExtractedShowtime[];
  warnings: string[];
}

function ticketLink(html: string, pageUrl: string): string | undefined {
  const $ = load(html);
  const hrefs = $("a[href]").map((_, element) => $(element).attr("href") ?? "").get();
  for (const href of hrefs) {
    try {
      const url = new URL(href, pageUrl);
      if (url.protocol !== "https:" || url.hostname.endsWith("theroyal.to") || SOCIAL_HOSTS.test(url.hostname)) continue;
      if (/ticket|eventbrite|admitone|showclix|universe|tixr|dice\.fm|fever|shop|buy|rsvp|event/i.test(url.href) || /tickets?/i.test($(`a[href="${href}"]`).text())) return url.href;
    } catch {
      // Not a link we can use.
    }
  }
  return undefined;
}

export function parseRoyalPosts(payload: unknown, reference?: DateTime): ParsedRoyalPosts {
  if (!Array.isArray(payload)) throw new Error("posts response is not an array");
  const now = reference ?? DateTime.now().setZone(TORONTO_TZ);
  const showtimes: ExtractedShowtime[] = [];
  const warnings: string[] = [];

  payload.forEach((entry, index) => {
    const post = postSchema.safeParse(entry);
    if (!post.success) {
      warnings.push(`post ${index}: ${post.error.issues.map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`).join("; ")}`);
      return;
    }
    const title = cleanText(load(`<x>${post.data.title.rendered}</x>`)("x").text());
    // A post with no date in its title or no start time in its body (an announcement,
    // an exhibit, a rental notice) is not a screening to list. It is skipped without a
    // warning, since a warning would stop the run from hiding screenings that are gone.
    const dated = title.match(TITLE_DATE);
    if (!dated) return;
    const [, rawTitle, month, days, year] = dated;
    const content = load(post.data.content.rendered);
    const body = cleanText(content("body").text());
    const clock = body.match(START_TIME)?.[1] ?? body.match(DOORS_TIME)?.[1];
    if (!clock) return;
    const time = clock.replace(/\./g, "").replace(/\s*([ap]m)$/i, " $1");
    const ticketUrl = ticketLink(post.data.content.rendered, post.data.link);
    // The post's first image is the promoter's poster; its longest paragraph the blurb.
    const imageUrl = content("img").map((__, element) => content(element).attr("data-src") ?? content(element).attr("src") ?? "").get().map((src) => usableImage(src, post.data.link)).find(Boolean);
    const synopsis = longestParagraph(content("p").map((__, element) => content(element).text()).get());

    for (const day of days!.split(/\s*(?:&|and|,)\s*/)) {
      try {
        const startsAt = parseDateTime(`${month} ${day} ${year} ${time}`, ["LLLL d yyyy h:mm a", "LLLL d yyyy h a", "LLL d yyyy h:mm a", "LLL d yyyy h a"], { zone: TORONTO_TZ, reference: now });
        showtimes.push(extractedShowtimeSchema.parse({
          venueSlug: "the-royal",
          sourceUid: `${post.data.id}:${startsAt.toFormat("yyyy-MM-dd'T'HH:mm")}`,
          rawTitle: rawTitle!.trim(),
          startsAt: iso(startsAt),
          detailUrl: post.data.link,
          ...(ticketUrl ? { ticketUrl } : {}),
          ...(imageUrl ? { imageUrl } : {}),
          ...(synopsis ? { synopsis } : {}),
          tags: [],
          sourcePayload: { postId: post.data.id, postTitle: title, timeText: clock, usedDoors: !START_TIME.test(body) },
        }));
      } catch (error) {
        warnings.push(`${post.data.link}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  return { showtimes, warnings };
}

export async function extractRoyal(): Promise<ExtractionBatch> {
  const url = new URL("/wp-json/wp/v2/posts", BASE);
  url.search = new URLSearchParams({ categories: String(SCREENINGS_CATEGORY), per_page: String(PAGE_SIZE), _fields: "id,link,title,content" }).toString();
  const parsed = parseRoyalPosts(await fetchJson(url));
  return { venueSlug: "the-royal", fetchedAt: new Date().toISOString(), showtimes: parsed.showtimes, warnings: parsed.warnings };
}
