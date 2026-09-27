import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPublic, parsePublicSchedule } from "../src/extractors/public.js";

const fixture = readFileSync(new URL("./fixtures/public-horaire.html", import.meta.url), "utf8");

describe("Cinéma Public", () => {
  const { showtimes, warnings } = parsePublicSchedule(fixture);

  it("reads each card with its Montreal time, TicketAcces screening id, version and notes", () => {
    expect(warnings).toEqual([]);
    expect(showtimes.length).toBeGreaterThanOrEqual(8);
    expect(showtimes[0]).toMatchObject({
      venueSlug: "cinema-public",
      sourceUid: "94622",
      rawTitle: "Il Paese : le village",
      startsAt: "2026-09-25T13:30:00-04:00",
      detailUrl: "https://cinemapublic.ca/films/il-paese-le-village/",
      ticketUrl: "https://cinemapublic.ticketacces.net/fr/organisation/achat/index.cfm?RepresentationID=94622",
      status: "scheduled",
      tags: ["STF", "En présence de Shelley Tepperman"],
    });
  });

  it("skips the disabled cells the page keeps for past days", () => {
    const html = `<div class="cm-Cal"><div class="cm-Cal__day cm-Cal__day--disabled" data-day="2026-09-21"><div class="cm-Cal__day__event"><div class="cm-Cal__day__event__title"><span class="mb-2">13:45</span></div></div></div></div>`;
    expect(parsePublicSchedule(html)).toEqual({ showtimes: [], warnings: [] });
  });

  it("marks a screening printed as Complet sold out and keeps the version as a tag", () => {
    expect(showtimes.find((showtime) => showtime.rawTitle === "Mirror + III.")).toMatchObject({ sourceUid: "94610", status: "sold_out", tags: ["STA"], startsAt: "2026-09-25T20:00:00-04:00" });
  });

  it("keeps free screenings with the link the venue gives and a slug-based id", () => {
    const free = showtimes.find((showtime) => showtime.rawTitle === "Doppelgängers³");
    expect(free).toMatchObject({ sourceUid: "doppelgangers³:2026-09-30T18:00", ticketUrl: "https://cinemapublic.ca/entree-libre/", tags: ["Entrée libre"] });
    const reserved = showtimes.find((showtime) => showtime.rawTitle === "Il n’y a pas de faux métier");
    expect(reserved?.ticketUrl).toMatch(/^https:\/\/www\.eventbrite\.ca\//);
    expect(reserved?.tags).toEqual(["STA", "Gratuit (sur réservation)"]);
  });

  describe("extractPublic", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("fetches the schedule page once, then each film page for its year, still and blurb, and warns when nothing parses", async () => {
      const schedule = vi.fn(async () => new Response(fixture));
      vi.stubGlobal("fetch", schedule);
      const filmPages: string[] = [];
      const batch = await extractPublic({
        fetchPage: async (url) => {
          filmPages.push(url.toString());
          return `<html><head><meta property="og:image" content="https://cinemapublic.ca/still.jpg"></head><body><p>Réalisation : Someone, Canada, 2024, 96 min</p></body></html>`;
        },
      });
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(batch.showtimes.length).toBe(showtimes.length);
      expect(batch.warnings).toEqual([]);
      expect(filmPages.length).toBe(new Set(batch.showtimes.map((showtime) => showtime.detailUrl)).size);
      expect(batch.showtimes.every((showtime) => showtime.imageUrl === "https://cinemapublic.ca/still.jpg" && showtime.releaseYear === 2024)).toBe(true);
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><body>maintenance</body></html>")));
      expect((await extractPublic({ fetchPage: async () => "" })).warnings).toEqual([expect.stringMatching(/no screenings parsed/)]);
    });
  });
});
