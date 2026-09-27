import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { extractHotDocs, HOT_DOCS_FEED_URL, parseHotDocsFeed, readFeed } from "../src/extractors/hot-docs.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const feed = () => JSON.parse(fixture("hot-docs-feed.json")) as { ArrayOfShows: Array<Record<string, unknown>> };

describe("Hot Docs Ted Rogers Cinema", () => {
  it("reads one screening per showing with the showing id, Toronto time and the purchase link", () => {
    const { showtimes, warnings, otherVenues } = parseHotDocsFeed(feed(), { maxYear: 2027 });
    expect(warnings).toEqual([]);
    expect(otherVenues).toBe(0);
    expect(showtimes.map((showtime) => [showtime.sourceUid, showtime.startsAt])).toEqual([
      ["653547", "2026-10-25T15:30:00-04:00"],
      ["641951", "2026-10-07T19:00:00-04:00"],
      ["641952", "2026-10-08T10:30:00-04:00"],
      ["653546", "2026-10-25T13:00:00-04:00"],
      // Standard time from November 1.
      ["653554", "2026-11-07T13:00:00-05:00"],
      ["653540", "2026-10-17T16:00:00-04:00"],
    ]);
    expect(showtimes[0]).toMatchObject({
      venueSlug: "hot-docs-cinema",
      rawTitle: "Baby Doe",
      endsAt: "2026-10-25T17:10:00-04:00",
      detailUrl: "https://boxoffice.hotdocs.ca/websales/pages/info.aspx?evtinfo=651337~cf285ddd-dacb-4f18-89b8-1252c6dcffa6",
      ticketUrl: "https://boxoffice.hotdocs.ca/websales/pages/ticketsearchcriteria.aspx?evtinfo=653547~cf285ddd-dacb-4f18-89b8-1252c6dcffa6",
      status: "scheduled",
      releaseYear: 2025,
      imageUrl: "https://prod5.agileticketing.net/images/user/bc_2338/baby%20doe1.jpg",
      synopsis: "When new evidence emerges decades later, a churchgoing mom of three is arrested for the murder of a child she says was stillborn.",
      tags: ["New Release"],
    });
    expect(showtimes[0]?.sourcePayload).toMatchObject({ showId: "651337", showingId: "653547", agileEventId: "653547", director: "Jessica Earnshaw", countries: ["USA"], runtime: "100" });
  });

  it("tags the series the cinema files a film under and keeps the printed title", () => {
    const { showtimes } = parseHotDocsFeed(feed(), { maxYear: 2027 });
    const byTitle = (title: string) => showtimes.find((showtime) => showtime.rawTitle === title);
    expect(byTitle("Frankenstein (1931)")).toMatchObject({ releaseYear: 1931, tags: ["Nightmares on Bloor Street x Midtown Matinees"] });
    // Doc Soup entries carry no strand label; the type filter names the series instead.
    expect(byTitle("Doc Soup: Hanging by a Wire")).toMatchObject({ releaseYear: 2026, tags: ["Doc Soup"] });
    expect(byTitle("T.S. Eliot's Four Quartets - with Sophie Fiennes")?.tags).toEqual(["Must-See Docs"]);
  });

  it("reads status from the sales state and message, and Q&A from the blurb", () => {
    const base = feed();
    const show = base.ArrayOfShows[0]!;
    const showings = show.CurrentShowings as Array<Record<string, unknown>>;
    show.ShortDescription = "A screening followed by a Q&A with the director.";
    showings[0] = { ...showings[0], SalesState: "SoldOut", SalesMessage: "Sold Out" };
    showings.push({ ...showings[0], ID: 1, SalesState: "DuringSales", SalesMessage: "Cancelled" });
    const { showtimes } = parseHotDocsFeed({ ArrayOfShows: [show] }, { maxYear: 2027 });
    expect(showtimes.map((showtime) => showtime.status)).toEqual(["sold_out", "cancelled"]);
    expect(showtimes[0]?.tags).toEqual(["New Release", "Q&A"]);
  });

  it("leaves out showings at other venues and undated ones, and reports a malformed show", () => {
    const base = feed();
    const show = base.ArrayOfShows[0]!;
    const showings = show.CurrentShowings as Array<Record<string, unknown>>;
    showings.push({ ...showings[0], ID: 2, Venue: { VenueID: 300, Name: "TIFF Lightbox 1" } });
    showings.push({ ...showings[0], ID: 3, DateTBD: true });
    const { showtimes, otherVenues, warnings } = parseHotDocsFeed({ ArrayOfShows: [show, { ID: 9, Name: "" }] }, { maxYear: 2027 });
    expect(showtimes.map((showtime) => showtime.sourceUid)).toEqual(["653547"]);
    expect(otherVenues).toBe(1);
    expect(warnings).toEqual([expect.stringMatching(/show 1: Name/)]);
  });

  it("reads the feed bare or as the page Chrome shows for a JSON document", () => {
    expect(readFeed('{"ArrayOfShows":[]}')).toEqual({ ArrayOfShows: [] });
    expect(readFeed('<html><head></head><body><pre>{"ArrayOfShows":[]}</pre></body></html>')).toEqual({ ArrayOfShows: [] });
    expect(() => readFeed("<html><body>Request unsuccessful</body></html>")).toThrow(/not JSON/);
  });

  describe("extractHotDocs", () => {
    it("fetches the feed once and keeps screenings inside the range", async () => {
      const fetchPage = vi.fn(async (_url: URL) => fixture("hot-docs-feed.json"));
      const batch = await extractHotDocs({ start: new Date("2026-10-08T12:00:00Z"), end: new Date("2026-10-25T12:00:00Z") }, { fetchPage });
      expect(fetchPage).toHaveBeenCalledTimes(1);
      expect(String(fetchPage.mock.calls[0]?.[0])).toBe(HOT_DOCS_FEED_URL.toString());
      // The October 7 screening is before the range; October 25 afternoon and November are past its end.
      expect(batch.showtimes.map((showtime) => showtime.sourceUid)).toEqual(["641952", "653540"]);
      expect(batch.warnings).toEqual([]);
      expect(batch.venueSlug).toBe("hot-docs-cinema");
    });
  });
});
