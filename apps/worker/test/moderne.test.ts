import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractModerne, monthsInRange, parseModerneCalendar } from "../src/extractors/moderne.js";

const fixture = readFileSync(new URL("./fixtures/moderne-horaire.html", import.meta.url), "utf8");

describe("Cinéma Moderne", () => {
  it("reads each calendar card with its Montreal time, version, year and ticket link", () => {
    const { showtimes, warnings } = parseModerneCalendar(fixture);
    expect(warnings).toEqual([]);
    expect(showtimes).toHaveLength(6);
    expect(showtimes[0]).toMatchObject({
      venueSlug: "cinema-moderne",
      sourceUid: "the-good-the-bad-and-the-ugly-60e-anniversaire:2026-10-06T20:00",
      rawTitle: "The Good, The Bad and The Ugly: 60e anniversaire",
      startsAt: "2026-10-06T20:00:00-04:00",
      detailUrl: "https://www.cinemamoderne.com/films/details/the-good-the-bad-and-the-ugly-60e-anniversaire/",
      ticketUrl: "https://cinemamoderne.ticketacces.net/fr/organisation/representations/index.cfm?EvenementID=21189",
      releaseYear: 1966,
      tags: ["VASTF", "Restauration 4K"],
    });
    const qa = showtimes.find((showtime) => showtime.startsAt === "2026-10-07T20:15:00-04:00");
    expect(qa).toMatchObject({ rawTitle: "La meilleure façon, c’est par accident", tags: ["VOSTA", "Q&A"], releaseYear: 2026 });
    expect(showtimes.find((showtime) => showtime.rawTitle.startsWith("Cinema Paradiso"))).toMatchObject({ tags: ["VOSTA"], releaseYear: 1988 });
  });

  it("reads a single-digit morning hour and can drop days before the crawl", () => {
    const html = `<div class="cm-Cal"><div class="cm-Cal__day" data-day="2026-10-04"><div class="cm-Cal__day__event"><div class="cm-Cal__day__event__title"><a href="https://www.cinemamoderne.com/films/details/le-petit-prince-petits-modernes/"><span class="cm-Fat">9:30</span></a></div><div class="cm-Card__title">Le petit prince – Petits Modernes <span class="cm-Card__subtitles">(VOF)</span></div></div></div></div>`;
    expect(parseModerneCalendar(html).showtimes[0]).toMatchObject({ startsAt: "2026-10-04T09:30:00-04:00", tags: ["VOF"] });
    expect(parseModerneCalendar(html).showtimes[0]?.ticketUrl).toBeUndefined();
    expect(parseModerneCalendar(html, undefined, "2026-10-05").showtimes).toEqual([]);
  });

  it("lists the months a range touches", () => {
    expect(monthsInRange({ start: new Date("2026-09-25T12:00:00Z"), end: new Date("2026-11-24T12:00:00Z") })).toEqual([[2026, 9], [2026, 10], [2026, 11]]);
    // 23:30 Toronto time on December 31 is already January in UTC; the venue's own calendar decides.
    expect(monthsInRange({ start: new Date("2027-01-01T04:30:00Z"), end: new Date("2027-01-01T04:30:00Z") })).toEqual([[2026, 12]]);
  });

  describe("extractModerne", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("fetches one page per month, drops duplicates from overlapping edges and warns about a month it cannot read", async () => {
      const requested: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
        const url = String(input);
        requested.push(url);
        return url.includes("/2026/11/") ? new Response("gone", { status: 404 }) : new Response(fixture);
      }));
      const filmPages: string[] = [];
      const batch = await extractModerne({ start: new Date("2026-09-25T12:00:00Z"), end: new Date("2026-11-24T12:00:00Z") }, {
        fetchPage: async (url) => {
          filmPages.push(url.toString());
          return `<html><head><meta property="og:image" content="/img/${url.pathname.split("/").filter(Boolean).at(-1)}.jpg"><meta property="og:description" content="The film's own page describes it in a sentence long enough to keep."></head><body></body></html>`;
        },
      });
      expect(requested).toEqual(["https://www.cinemamoderne.com/horaire/2026/09/", "https://www.cinemamoderne.com/horaire/2026/10/", "https://www.cinemamoderne.com/horaire/2026/11/"]);
      expect(batch.showtimes).toHaveLength(6);
      expect(batch.warnings).toEqual([expect.stringMatching(/2026\/11\/: GET .* failed with 404/)]);
      // Each film's page is read once, for its still and blurb; the card already had the year.
      expect(filmPages.length).toBe(new Set(batch.showtimes.map((showtime) => showtime.detailUrl)).size);
      expect(batch.showtimes.every((showtime) => showtime.imageUrl?.startsWith("https://www.cinemamoderne.com/img/") && showtime.synopsis?.startsWith("The film's own page"))).toBe(true);
    });
  });
});
