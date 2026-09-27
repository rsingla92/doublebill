import { load } from "cheerio";
import { DateTime } from "luxon";
import { extractedShowtimeSchema, type ExtractionBatch, type ExtractedShowtime } from "../contracts.js";
import { fetchText } from "../http.js";
import { addPageDetails, cleanText, iso, TORONTO_TZ } from "./utils.js";

const BASE = "https://cinemapublic.ca";
const SCHEDULE_URL = `${BASE}/horaire/`;

/**
 * Cinéma Public publishes about two weeks of screenings on one page, /horaire/,
 * in the same calendar theme as Cinéma Moderne: a `data-day` per day and a card
 * per screening with the time, the title, a version label such as "(STF)", notes
 * ("Complet", "En présence de …", "Entrée libre") and a "Billetterie" link. Most
 * links go to TicketAcces with a RepresentationID; free screenings link to the
 * venue's own page or to Eventbrite.
 */
export interface ParsedPublicSchedule {
  showtimes: ExtractedShowtime[];
  warnings: string[];
}

const VERSION_LABEL = /^\(([A-Z][A-Z.\- ]*)\)$/;
/** Notes that describe availability rather than the screening. */
const STATUS_NOTES = /^(complet|derni[eè]re chance)$/i;

export function parsePublicSchedule(html: string, pageUrl = SCHEDULE_URL): ParsedPublicSchedule {
  const $ = load(html);
  const showtimes: ExtractedShowtime[] = [];
  const warnings: string[] = [];

  // Past days are kept on the page as disabled cells whose cards have no title or link.
  $(".cm-Cal__day[data-day]:not(.cm-Cal__day--disabled)").each((_, dayElement) => {
    const day = $(dayElement).attr("data-day") ?? "";
    $(dayElement).find(".cm-Cal__day__event").each((__, eventElement) => {
      const event = $(eventElement);
      const heading = event.find(".cm-Cal__day__event__title").first();
      const time = cleanText(heading.find("span").first().text());
      const titleLink = event.find(".cm-Card__title a[href], .cm-Cal__day__event__title a[href]").first();
      const rawTitle = cleanText(event.find(".cm-Card__title").first().text()) || cleanText(heading.find("a > span").first().text());
      const filmHref = titleLink.attr("href");
      const version = heading.find("a > span").map((___, element) => cleanText($(element).text())).get().map((text) => text.match(VERSION_LABEL)?.[1]).find(Boolean) ?? "";
      const notes = [...new Set(heading.find(".text-warning").map((___, element) => cleanText($(element).text())).get().filter(Boolean))];
      const ticketHref = event.find("a[title='Billetterie'][href], .cm-Actions a[href*='ticketacces.net']").first().attr("href");

      if (!rawTitle || !time || !filmHref) {
        if (rawTitle || time) warnings.push(`${day} ${time} "${rawTitle}": screening card is missing its title, time or film link`);
        return;
      }
      const startsAt = DateTime.fromFormat(`${day} ${time}`, "yyyy-MM-dd HH:mm", { zone: TORONTO_TZ });
      if (!startsAt.isValid) {
        warnings.push(`${day} ${time} "${rawTitle}": unreadable date or time`);
        return;
      }
      const detailUrl = new URL(filmHref, pageUrl).toString();
      const slug = decodeURIComponent(new URL(detailUrl).pathname.split("/").filter(Boolean).at(-1) ?? detailUrl);
      const representationId = ticketHref?.match(/RepresentationID=(\d+)/)?.[1];
      try {
        showtimes.push(extractedShowtimeSchema.parse({
          venueSlug: "cinema-public",
          sourceUid: representationId ?? `${slug}:${startsAt.toFormat("yyyy-MM-dd'T'HH:mm")}`,
          rawTitle,
          startsAt: iso(startsAt),
          detailUrl,
          ...(ticketHref ? { ticketUrl: new URL(ticketHref, pageUrl).toString() } : {}),
          status: notes.some((note) => /^complet$/i.test(note)) ? "sold_out" : "scheduled",
          tags: [version, ...notes.filter((note) => !STATUS_NOTES.test(note))].filter(Boolean),
          sourcePayload: { day, time, version, notes, representationId, location: event.attr("data-address") },
        }));
      } catch (error) {
        warnings.push(`${day} ${time} "${rawTitle}": ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });

  return { showtimes, warnings };
}

export interface PublicOptions {
  /** Page fetcher for the film pages, replaceable in tests. */
  fetchPage?: (url: URL) => Promise<string>;
}

export async function extractPublic(options: PublicOptions = {}): Promise<ExtractionBatch> {
  const parsed = parsePublicSchedule(await fetchText(new URL(SCHEDULE_URL)));
  const warnings = [...parsed.warnings];
  if (parsed.showtimes.length === 0) warnings.push(`${SCHEDULE_URL}: no screenings parsed`);
  // The schedule card has no year; the film's page prints it with the still and blurb.
  await addPageDetails(parsed.showtimes, options.fetchPage ?? fetchText);
  return { venueSlug: "cinema-public", fetchedAt: new Date().toISOString(), showtimes: parsed.showtimes, warnings };
}
