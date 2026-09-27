import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractParadise, parseParadiseCalendar, parseParadiseMoviePage } from "../src/extractors/paradise.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("Paradise Theatre", () => {
  it("keeps films and shorts programmes from the calendar and leaves live events out", () => {
    const { filmUrls, skipped } = parseParadiseCalendar(fixture("paradise-calendar.html"));
    expect(filmUrls).toEqual(["https://paradiseonbloor.com/movies/leave-her-to-heaven/"]);
    expect(skipped).toEqual(["https://paradiseonbloor.com/special_events/just-for-laughs-jerrod-carmichael/", "https://paradiseonbloor.com/special_events/just-for-laughs-ron-taylor/"]);
  });

  it("reads one screening per ScreeningEvent with the box-office id, Toronto time and release year", () => {
    const { showtimes, warnings } = parseParadiseMoviePage(fixture("paradise-movie.html"), "https://paradiseonbloor.com/movies/ha-chan-shake-your-booty/");
    expect(warnings).toEqual([]);
    expect(showtimes.map((showtime) => [showtime.sourceUid, showtime.startsAt])).toEqual([["669249", "2026-10-01T18:00:00-04:00"], ["669251", "2026-10-05T17:45:00-04:00"]]);
    expect(showtimes[0]).toMatchObject({ venueSlug: "paradise-theatre", rawTitle: "Ha-Chan, Shake Your Booty!", detailUrl: "https://paradiseonbloor.com/movies/ha-chan-shake-your-booty/", ticketUrl: "https://paradiseonbloor.com/purchase/669249/", status: "scheduled", releaseYear: 2026 });
  });

  it("takes the film's image and description from the structured data, else from the share tags", () => {
    const graph = (movie: Record<string, unknown>) => JSON.stringify({ "@graph": [{ "@type": "Movie", name: "X", ...movie }, { "@type": "ScreeningEvent", startDate: "2026-10-01T18:00:00-04:00", url: "https://paradiseonbloor.com/purchase/1/" }] });
    const blurb = "A shorts programme of animation from three continents, introduced by its curator.";
    const structured = `<head><meta property="og:image" content="https://paradiseonbloor.com/share.jpg"></head><h2 class="show-title">X</h2><script type="application/ld+json">${graph({ image: ["https://paradiseonbloor.com/poster.jpg"], description: blurb, dateCreated: "2025-01-01" })}</script>`;
    expect(parseParadiseMoviePage(structured, "https://paradiseonbloor.com/movies/x/").showtimes[0]).toMatchObject({ releaseYear: 2025, imageUrl: "https://paradiseonbloor.com/poster.jpg", synopsis: blurb });
    const bare = `<head><meta property="og:image" content="https://paradiseonbloor.com/share.jpg"><meta name="description" content="${blurb}"></head><h2 class="show-title">X</h2><script type="application/ld+json">${graph({})}</script><p>Canada, 2024, 80 min</p>`;
    expect(parseParadiseMoviePage(bare, "https://paradiseonbloor.com/movies/x/").showtimes[0]).toMatchObject({ releaseYear: 2024, imageUrl: "https://paradiseonbloor.com/share.jpg", synopsis: blurb });
    // The real page names the film's still and blurb in its structured data.
    expect(parseParadiseMoviePage(fixture("paradise-movie.html"), "https://paradiseonbloor.com/movies/x/").showtimes[0]).toMatchObject({ imageUrl: expect.stringMatching(/HA-CHAN-scaled\.jpg$/), synopsis: expect.stringMatching(/^Haru and Luis/) });
  });

  it("marks sold-out and cancelled screenings from the structured data", () => {
    const page = (status: string, availability: string) => `<h2 class="show-title">X</h2><script type="application/ld+json">${JSON.stringify({ "@graph": [{ "@type": "ScreeningEvent", startDate: "2026-10-01T18:00:00-04:00", url: "https://paradiseonbloor.com/purchase/1/", eventStatus: status, offers: [{ availability }] }] })}</script>`;
    expect(parseParadiseMoviePage(page("https://schema.org/EventScheduled", "https://schema.org/SoldOut"), "https://paradiseonbloor.com/movies/x/").showtimes[0]?.status).toBe("sold_out");
    expect(parseParadiseMoviePage(page("https://schema.org/EventCancelled", "https://schema.org/InStock"), "https://paradiseonbloor.com/movies/x/").showtimes[0]?.status).toBe("cancelled");
  });

  describe("extractParadise", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("fetches each month's calendar, then only the film pages, and keeps screenings inside the range", async () => {
      const requested: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("/calendar-view/")) return new Response(fixture("paradise-calendar.html"));
        return new Response(fixture("paradise-movie.html"));
      }));
      const batch = await extractParadise({ start: new Date("2026-09-25T12:00:00Z"), end: new Date("2026-10-03T12:00:00Z") });
      expect(requested).toEqual(["https://paradiseonbloor.com/calendar-view/2026-09", "https://paradiseonbloor.com/calendar-view/2026-10", "https://paradiseonbloor.com/movies/leave-her-to-heaven/"]);
      // The October 5 screening is past the range end.
      expect(batch.showtimes.map((showtime) => showtime.sourceUid)).toEqual(["669249"]);
      expect(batch.warnings).toEqual([]);
    });
  });
});
