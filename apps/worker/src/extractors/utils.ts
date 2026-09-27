import { load, type CheerioAPI } from "cheerio";
import { DateTime } from "luxon";
import type { ExtractedShowtime } from "../contracts.js";

export const VANCOUVER_TZ = "America/Vancouver";
/** Toronto and Montreal share the Eastern zone. */
export const TORONTO_TZ = "America/Toronto";

/** A listing is never this far from the crawl date; a weekday that only fits a year away is a typo. */
const MAX_DISTANCE_DAYS = 200;

export function cleanText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function absoluteUrl(href: string, base: string): string {
  return new URL(href, base).toString();
}

/**
 * Venue listings rarely print a year. Assume the schedule looks forward: a month
 * more than six months behind the reference belongs to next year, and one more
 * than six months ahead belongs to last year.
 */
export function inferYear(month: number, reference: DateTime): number {
  let year = reference.year;
  const distance = month - reference.month;
  if (distance < -6) year += 1;
  if (distance > 6) year -= 1;
  return year;
}

function formatHasYear(format: string): boolean {
  return /y/.test(format.replace(/'[^']*'/g, ""));
}

/**
 * Parse a venue-local date/time string with one of the given Luxon formats. The
 * zone defaults to Vancouver; Toronto and Montreal venues pass `TORONTO_TZ`.
 *
 * - Formats that already contain a year token are parsed verbatim.
 * - Otherwise the year is inferred relative to `reference` (or fixed with `year`).
 *   Candidate years are validated by Luxon, so a weekday token such as "Sat"
 *   rejects years where the weekday does not line up, and a candidate that only
 *   fits far from the reference is rejected too so the caller can fall back.
 */
export function parseDateTime(
  value: string,
  formats: string[],
  options: { year?: number; reference?: DateTime; zone?: string; locale?: string } = {},
): DateTime {
  const zone = options.zone ?? VANCOUVER_TZ;
  const parseOptions = { zone, locale: options.locale ?? "en-CA" };
  const reference = (options.reference ?? DateTime.now()).setZone(zone);
  const candidateYears = options.year !== undefined
    ? [options.year]
    : [reference.year - 1, reference.year, reference.year + 1];

  for (const format of formats) {
    if (formatHasYear(format)) {
      const parsed = DateTime.fromFormat(value, format, parseOptions);
      if (parsed.isValid) return parsed;
      continue;
    }

    const valid = candidateYears
      .map((year) => DateTime.fromFormat(`${value} ${year}`, `${format} yyyy`, parseOptions))
      .filter((parsed) => parsed.isValid)
      .filter((parsed) => options.year !== undefined || Math.abs(parsed.diff(reference, "days").days) <= MAX_DISTANCE_DAYS)
      .sort((a, b) => Math.abs(a.diff(reference, "days").days) - Math.abs(b.diff(reference, "days").days));
    if (valid.length === 0) continue;

    return valid.find((parsed) => parsed.year === inferYear(parsed.month, reference)) ?? valid[0]!;
  }

  throw new Error(`Unable to parse ${zone} date/time: ${value}`);
}

export function iso(dateTime: DateTime): string {
  const value = dateTime.toISO({ suppressMilliseconds: true });
  if (!value) throw new Error("Invalid datetime");
  return value;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index]!);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

/** "Japan 1962. Dir: Masaki Kobayashi.": the year closest before a director credit. */
const YEAR_BEFORE_DIRECTOR = /\b((?:18|19|20)\d{2})\b(?:(?!\b(?:18|19|20)\d{2}\b)[\s\S]){0,60}?\bdir(?:\.|:|ector|ected|\.:)/i;
/** "Canada, 2026, 94 min", "USA | 1990 | 113 min": a year followed by a running time, with no other number between. */
const YEAR_BEFORE_RUNTIME = /\b((?:18|19|20)\d{2})\b[^\d]{0,40}?\b\d{1,3}\s*(?:min(?:ute)?s?|mins?)(?![a-z])/gi;
/** "October 3, 2026", "3 October 2026", "Fri Oct 3 2026": the year is part of a screening date, not a release year. */
const DATE_BEFORE_YEAR = /(?:\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s+\d{1,2}(?:st|nd|rd|th)?,?\s*|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?,?\s*|\b\d{1,2}[./-]\d{1,2}[./-])$/i;

/**
 * The release year a venue prints beside a film, or null. Only a year anchored to a
 * director credit or a running time counts, so a season label such as "VIFF 2026"
 * or a title such as "2001: A Space Odyssey" is never mistaken for one, and a year
 * that is part of a screening date ("October 3, 2026 · 113 min") is skipped.
 */
export function printedYear(text: string, maxYear: number): number | null {
  const credited = Number(text.match(YEAR_BEFORE_DIRECTOR)?.[1] ?? NaN);
  if (credited >= 1888 && credited <= maxYear) return credited;
  for (const match of text.matchAll(YEAR_BEFORE_RUNTIME)) {
    const year = Number(match[1]);
    if (year < 1888 || year > maxYear) continue;
    if (DATE_BEFORE_YEAR.test(text.slice(Math.max(0, match.index - 24), match.index))) continue;
    return year;
  }
  return null;
}

export interface PageDetails {
  year: number | null;
  imageUrl?: string;
  synopsis?: string;
}

export const SYNOPSIS_MAX = 1000;
/** A description shorter than this is a slogan or a ticket note, not a blurb. */
const DESCRIPTION_MIN = 40;
const PARAGRAPH_MIN = 80;

/** The longest of the texts that is long enough to be a blurb, cut to the synopsis limit. */
export function longestParagraph(texts: string[], minLength = PARAGRAPH_MIN): string | undefined {
  const longest = texts.map(cleanText).filter((text) => text.length >= minLength).sort((a, b) => b.length - a.length)[0];
  return longest?.slice(0, SYNOPSIS_MAX);
}

/** An image address a browser can load from anywhere: absolute, protocol-relative or root-relative, never data: or blank. */
export function usableImage(src: string | undefined, pageUrl: string): string | undefined {
  return src && /^(?:https?:\/\/|\/)/.test(src) ? absoluteUrl(src, pageUrl) : undefined;
}

/** A description worth showing: the page's own words, when it has enough of them. */
export function usableDescription(text: string | undefined): string | undefined {
  const cleaned = cleanText(text ?? "");
  return cleaned.length >= DESCRIPTION_MIN ? cleaned.slice(0, SYNOPSIS_MAX) : undefined;
}

/**
 * What a film's own page says about it: the year it prints, its share image, and
 * a blurb (the page's description, or its longest paragraph).
 */
/**
 * The page's visible text with a space between elements, so "92 min" and the
 * heading after it never fuse into one word that no rule can read.
 */
export function pageText($: CheerioAPI): string {
  const nodes = $("body").find("*").addBack().not("script, style, noscript, template").contents().filter((_, node) => node.type === "text");
  return cleanText(nodes.map((_, node) => $(node).text()).get().join(" "));
}

export function readPageDetails(html: string, pageUrl: string, maxYear: number): PageDetails {
  const $ = load(html);
  const year = printedYear(pageText($), maxYear);
  const imageUrl = usableImage($('meta[property="og:image"]').attr("content") ?? $('meta[name="twitter:image"]').attr("content"), pageUrl);
  const synopsis = usableDescription($('meta[property="og:description"]').attr("content") ?? $('meta[name="description"]').attr("content"))
    ?? longestParagraph($("p").map((_, element) => $(element).text()).get());
  return { year, ...(imageUrl ? { imageUrl } : {}), ...(synopsis ? { synopsis } : {}) };
}

/** The showtime fields a page's details fill, with nothing set for what the page lacked. */
export function detailFields(details: { year?: number | null | undefined; imageUrl?: string | undefined; synopsis?: string | undefined }): Pick<ExtractedShowtime, "releaseYear" | "imageUrl" | "synopsis"> {
  return {
    ...(details.year ? { releaseYear: details.year } : {}),
    ...(details.imageUrl ? { imageUrl: details.imageUrl } : {}),
    ...(details.synopsis ? { synopsis: details.synopsis } : {}),
  };
}

export interface PageDetailsOptions {
  concurrency?: number;
  maxYear?: number;
}

/**
 * Fetch each film's own page once and fill in what the listing lacked: the year it
 * prints, its image and a blurb. A page that cannot be read costs nothing but a
 * possible match and a poster, so failures are silent.
 */
export async function addPageDetails(
  showtimes: ExtractedShowtime[],
  fetchPage: (url: URL) => Promise<string>,
  options: PageDetailsOptions = {},
): Promise<void> {
  const maxYear = options.maxYear ?? new Date().getFullYear() + 1;
  const pages = [...new Set(showtimes.filter((showtime) => !showtime.releaseYear || !showtime.imageUrl || !showtime.synopsis).map((showtime) => showtime.detailUrl))];
  const details = new Map<string, PageDetails>();
  await mapWithConcurrency(pages, options.concurrency ?? 2, async (url) => {
    try {
      details.set(url, readPageDetails(await fetchPage(new URL(url)), url, maxYear));
    } catch {
      // Left without details.
    }
  });
  for (const showtime of showtimes) {
    const found = details.get(showtime.detailUrl);
    if (!found) continue;
    if (!showtime.releaseYear && found.year) showtime.releaseYear = found.year;
    if (!showtime.imageUrl && found.imageUrl) showtime.imageUrl = found.imageUrl;
    if (!showtime.synopsis && found.synopsis) showtime.synopsis = found.synopsis;
  }
}

