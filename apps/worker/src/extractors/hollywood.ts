import { load, type CheerioAPI } from "cheerio";
import type { DateTime } from "luxon";
import { extractedShowtimeSchema, type ExtractionBatch, type ExtractedShowtime } from "../contracts.js";
import { fetchText } from "../http.js";
import { absoluteUrl, cleanText, iso, mapWithConcurrency, parseDateTime, printedYear, usableDescription, usableImage } from "./utils.js";

const BASE = "https://www.hollywoodtheatre.ca";

export interface HollywoodPageResult {
  showtimes: ExtractedShowtime[];
  /** Set when a film page could not be read, so the batch is not mistaken for complete. */
  warning?: string;
}

export function parseHollywoodEventLinks(html: string): string[] {
  const $ = load(html);
  return [...new Set(
    $(".event_item-2 a[href^='/events/'],.event_item-2 a[href^='https://www.hollywoodtheatre.ca/events/']")
      .map((_, element) => absoluteUrl($(element).attr("href")!, BASE))
      .get(),
  )];
}

const MONTHS: Record<string, string> = {
  jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June", jul: "July",
  aug: "August", sep: "September", sept: "September", oct: "October", nov: "November", dec: "December",
};
const WRITTEN_DATE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/;
/** "SHOW: 7:00pm", "Showtime 7pm", "Film starts at 7:00 PM". */
const SHOW_TIME = /\b(?:show(?:time)?s?|screening|film|movie|feature|starts?)\s*(?:at|@|:|-|–)?\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))/gi;
/** "from 7:00–10:00 PM": a running time in prose, where only the end carries am/pm. */
const TIME_RANGE = /\b(\d{1,2}(?::\d{2})?)\s*(?:[-–—]|to)\s*\d{1,2}(?::\d{2})?\s*([ap])\.?m\.?\b/gi;
const ANY_TIME = /.{0,30}\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b.{0,10}/gi;

interface EventDate {
  /** "2026-10-03", "October 3 2026" or "October 3". */
  text: string;
  format: string;
  /** 24-hour start time when the structured date carried one. */
  clock?: string;
}

/**
 * The site's templates move the date around: it has lived in the meta description
 * and can appear as structured data or plain prose. Structured dates win; prose is
 * searched from the most specific source to the whole page.
 */
function findEventDate($: CheerioAPI, description: string, bodyText: string): EventDate | null {
  const structured = [
    ...$("time[datetime]").map((_, element) => $(element).attr("datetime") ?? "").get(),
    ...$("script[type='application/ld+json']").map((_, element) => $(element).text()).get(),
  ];
  for (const text of structured) {
    const iso = text.match(ISO_DATE);
    if (iso) return { text: iso[1]!, format: "yyyy-MM-dd", ...(iso[2] ? { clock: iso[2] } : {}) };
  }
  for (const text of [description, $("meta[property='og:description']").attr("content") ?? "", bodyText]) {
    const match = text.match(WRITTEN_DATE);
    if (!match) continue;
    const month = MONTHS[match[1]!.toLowerCase().slice(0, 4).replace(/[^a-z]/g, "")] ?? MONTHS[match[1]!.toLowerCase().slice(0, 3)]!;
    return match[3] ? { text: `${month} ${match[2]} ${match[3]}`, format: "LLLL d yyyy" } : { text: `${month} ${match[2]}`, format: "LLLL d" };
  }
  return null;
}

export function parseHollywoodEventPage(html: string, pageUrl: string, reference?: DateTime): HollywoodPageResult {
  const $ = load(html);
  const categories = $("a[href^='/categories/']")
    .map((_, element) => cleanText($(element).text()).toLowerCase())
    .get();
  if (!categories.includes("film")) return { showtimes: [] };

  const rawTitle = cleanText($("h1.heading-events").first().text() || $("title").text().split(" at Hollywood")[0]);
  const description = $("meta[name='description']").attr("content") ?? "";
  const imageUrl = usableImage($("meta[property='og:image']").attr("content"), pageUrl);
  const synopsis = usableDescription(description);
  // Join text nodes with spaces so adjacent elements never fuse into one word.
  const bodyText = cleanText($("body *").contents().filter((_, node) => node.type === "text").map((_, node) => $(node).text()).get().join(" "));
  if (!rawTitle) return { showtimes: [], warning: `${pageUrl}: film page has no title` };
  const date = findEventDate($, description, bodyText);
  if (!date) return { showtimes: [], warning: `${pageUrl}: film page has no recognisable date (description: "${description.slice(0, 120)}")` };

  const showTimes = [...bodyText.matchAll(SHOW_TIME)].map((match) => match[1]!.replaceAll(".", "").replace(/\s*(am|pm)$/i, " $1"));
  // With no labelled show time, a structured start time is the next best evidence,
  // then the start of a running time written in prose ("from 7:00–10:00 PM").
  const rangeStarts = [...bodyText.matchAll(TIME_RANGE)].map((match) => `${match[1]} ${match[2]!.toLowerCase()}m`);
  const uniqueTimes = showTimes.length > 0 ? [...new Set(showTimes)] : date.clock ? [date.clock] : rangeStarts.length > 0 ? [rangeStarts[0]!] : [];
  if (uniqueTimes.length === 0) {
    const seen = [...bodyText.matchAll(ANY_TIME)].map((match) => `"${match[0].trim()}"`).slice(0, 4);
    return { showtimes: [], warning: `${pageUrl}: film page has no show time (times on page: ${seen.join(", ") || "none"})` };
  }

  const ticketAnchor = $("a").filter((_, element) => /(?:get|buy)\s*tickets/i.test(cleanText($(element).text()))).first();
  const ticketHref = ticketAnchor.attr("href");
  const slug = new URL(pageUrl).pathname.split("/").filter(Boolean).at(-1)!;
  const maxYear = (reference?.year ?? new Date().getFullYear()) + 1;
  const slugYear = Number(slug.match(/-((?:19|20)\d{2})$/)?.[1] ?? NaN);
  const releaseYear = slugYear >= 1888 && slugYear <= maxYear ? slugYear : printedYear(bodyText, maxYear);

  const showtimes = uniqueTimes.map((time, index) => {
    const formats = /[ap]m$/i.test(time) ? [`${date.format} h:mm a`, `${date.format} h a`] : [`${date.format} HH:mm`];
    const startsAt = parseDateTime(`${date.text} ${time}`, formats, reference ? { reference } : {});
    return extractedShowtimeSchema.parse({
      venueSlug: "hollywood-theatre",
      sourceUid: `${slug}:${index}:${startsAt.toISO()}`,
      rawTitle,
      startsAt: iso(startsAt),
      ...(releaseYear ? { releaseYear } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(synopsis ? { synopsis } : {}),
      detailUrl: pageUrl,
      ...(ticketHref ? { ticketUrl: absoluteUrl(ticketHref, pageUrl) } : {}),
      tags: categories.filter((category) => category !== "film"),
      sourcePayload: { description, categories, dateText: date.text, showTimeText: time },
    });
  });
  return { showtimes };
}

export async function extractHollywood(maxPages = 20): Promise<ExtractionBatch> {
  const eventLinks = new Set<string>();
  const warnings: string[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL("/events", BASE);
    if (page > 1) url.searchParams.set("8c848147_page", String(page));
    const html = await fetchText(url);
    const links = parseHollywoodEventLinks(html);
    links.forEach((link) => eventLinks.add(link));
    const hasNext = /aria-label=["']Next Page["']/.test(html) && links.length > 0;
    if (!hasNext) break;
    if (page === maxPages) warnings.push(`stopped at page cap (${maxPages}); listings may be incomplete`);
  }

  const pages = await mapWithConcurrency([...eventLinks], 4, async (url) => {
    try {
      const result = parseHollywoodEventPage(await fetchText(new URL(url)), url);
      if (result.warning) warnings.push(result.warning);
      return result.showtimes;
    } catch (error) {
      warnings.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });

  return {
    venueSlug: "hollywood-theatre",
    fetchedAt: new Date().toISOString(),
    showtimes: pages.flat(),
    warnings,
  };
}
