import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agileEventId, cleanAgileUrl, isAgileTicketLink } from "../src/extractors/agile.js";
import { extractFox, parseFoxMoviePage, parseFoxPosts } from "../src/extractors/fox.js";
import { extractRevue, parseRevueCalendar, parseRevueFilmPage, revueShowtime } from "../src/extractors/revue.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const reference = DateTime.fromISO("2026-09-25", { zone: "America/Toronto" });

describe("Agile links", () => {
  it("reads the event id and cleans the WordPress-escaped link", () => {
    const href = "https://tickets.foxtheatre.ca/websales/pages/ticketsearchcriteria.aspx?evtinfo=657612~3cc021f8-1c84-4d3e-b58d-8be52cd73055&";
    expect(agileEventId(href)).toBe("657612");
    expect(isAgileTicketLink(href)).toBe(true);
    expect(isAgileTicketLink("https://prod3.agileticketing.net/websales/pages/list.aspx?epguid=291b")).toBe(false);
    expect(cleanAgileUrl(href, "https://www.foxtheatre.ca/")).toBe("https://tickets.foxtheatre.ca/websales/pages/ticketsearchcriteria.aspx?evtinfo=657612~3cc021f8-1c84-4d3e-b58d-8be52cd73055");
  });
});

describe("Revue Cinema", () => {
  it("reads every screening from the calendar's events array", () => {
    const { events, warnings } = parseRevueCalendar(fixture("revue-calendar.html"));
    expect(warnings).toEqual([]);
    expect(events).toHaveLength(8);
    expect(events[1]).toEqual({ title: "BUDDY (2026)", start: "2026-09-24 16:00:00", url: "https://revuecinema.ca/films/buddy-2026/" });
  });

  it("takes the film page's Agile link and builds a stable id from the film and its start", () => {
    const film = parseRevueFilmPage(fixture("revue-film.html"), "https://revuecinema.ca/films/2001/");
    const ticketUrl = "https://prod3.agileticketing.net/websales/pages/info.aspx?evtinfo=831933~fc639be0-110c-4035-a588-842aceff5ef6";
    expect(film.ticketUrl).toBe(ticketUrl);
    const showtime = revueShowtime({ title: "To 70 And Beyond: 2001: A SPACE ODYSSEY (1968) - Presented on 70mm!", start: "2027-01-08 18:15:00", url: "https://revuecinema.ca/films/2001/" }, film);
    expect(showtime).toMatchObject({ venueSlug: "revue-cinema", sourceUid: "2001:2027-01-08T18:15", startsAt: "2027-01-08T18:15:00-05:00", ticketUrl, detailUrl: "https://revuecinema.ca/films/2001/" });
    expect(showtime.sourcePayload).toMatchObject({ agileEventId: "831933" });
    expect(parseRevueFilmPage("<html><body><a href='https://prod3.agileticketing.net/websales/pages/list.aspx?epguid=x'>All films</a></body></html>", "https://revuecinema.ca/films/x/").ticketUrl).toBeUndefined();
  });

  it("keeps the film page's year, still and blurb for every screening of the film", () => {
    const html = `<html><head><meta property="og:image" content="https://revuecinema.ca/wp-content/uploads/2001.jpg"><meta property="og:description" content="Kubrick's voyage from the dawn of man to Jupiter and beyond, presented on 70mm."></head><body><p>USA, 1968, 149 min</p></body></html>`;
    const film = parseRevueFilmPage(html, "https://revuecinema.ca/films/2001/", DateTime.fromISO("2026-09-25", { zone: "America/Toronto" }));
    expect(film).toEqual({ details: { year: 1968, imageUrl: "https://revuecinema.ca/wp-content/uploads/2001.jpg", synopsis: "Kubrick's voyage from the dawn of man to Jupiter and beyond, presented on 70mm." } });
    const showtime = revueShowtime({ title: "2001: A SPACE ODYSSEY", start: "2027-01-08 18:15:00", url: "https://revuecinema.ca/films/2001/" }, film);
    expect(showtime).toMatchObject({ releaseYear: 1968, imageUrl: "https://revuecinema.ca/wp-content/uploads/2001.jpg", synopsis: expect.stringMatching(/^Kubrick/) });
    expect(showtime.ticketUrl).toBeUndefined();
    expect(revueShowtime({ title: "2001: A SPACE ODYSSEY", start: "2027-01-08 18:15:00", url: "https://revuecinema.ca/films/2001/" }, undefined)).not.toHaveProperty("imageUrl");
  });

  it("reports a calendar page without events", () => {
    expect(() => parseRevueCalendar("<html><script>var x = 1;</script></html>")).toThrow(/no events array/);
  });

  describe("extractRevue", () => {
    const requested: string[] = [];
    afterEach(() => { vi.unstubAllGlobals(); requested.length = 0; });

    it("fetches film pages only for films screening inside the range and warns about one it cannot read", async () => {
      vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/calendar/")) return new Response(fixture("revue-calendar.html"));
        if (url.endsWith("/films/2001/")) return new Response(fixture("revue-film.html"));
        return new Response("gone", { status: 404 });
      }));
      const batch = await extractRevue({ start: new Date("2026-12-30T12:00:00Z"), end: new Date("2027-01-09T12:00:00Z") });
      expect(requested.sort()).toEqual(["https://revuecinema.ca/calendar/", "https://revuecinema.ca/films/2001/", "https://revuecinema.ca/films/the-perfect-date-200-cigarettes-25th-anniversary-screening/"]);
      // The range ends at 07:00 Toronto time on January 9, so that day's 12:30 screening is out.
      expect(batch.showtimes.map((showtime) => showtime.sourceUid)).toEqual(["the-perfect-date-200-cigarettes-25th-anniversary-screening:2026-12-31T18:45", "2001:2027-01-08T18:15"]);
      expect(batch.showtimes[0]?.ticketUrl).toBeUndefined();
      expect(batch.showtimes[1]?.ticketUrl).toMatch(/evtinfo=831933/);
      expect(batch.warnings).toEqual([expect.stringMatching(/200-cigarettes.*failed with 404/)]);
    });
  });
});

describe("Fox Theatre", () => {
  it("lists movie posts with their screening days", () => {
    const { posts, warnings } = parseFoxPosts(JSON.parse(fixture("fox-movies.json")));
    expect(warnings).toEqual([]);
    expect(posts.find((post) => post.slug === "klassic-kidz-paranorman")).toEqual({ id: 1156262, slug: "klassic-kidz-paranorman", link: "https://www.foxtheatre.ca/movies/klassic-kidz-paranorman/", title: "Klassic Kidz: ParaNorman", dates: ["2026-10-10", "2026-10-12"] });
    expect(posts.find((post) => post.slug.startsWith("sold-out"))?.title).toBe("SOLD OUT – The Rocky Horror Picture Show w/Shadowcast!");
  });

  it("reads one screening per showtime row with the Agile event id and Toronto time", () => {
    const post = { id: 1156262, link: "https://www.foxtheatre.ca/movies/klassic-kidz-paranorman/", title: "Klassic Kidz: ParaNorman" };
    const { showtimes, warnings } = parseFoxMoviePage(fixture("fox-movie.html"), post, reference);
    expect(warnings).toEqual([]);
    expect(showtimes).toHaveLength(2);
    expect(showtimes[0]).toMatchObject({ venueSlug: "fox-theatre", sourceUid: "649643", rawTitle: "Klassic Kidz: ParaNorman", startsAt: "2026-10-10T13:00:00-04:00", ticketUrl: "https://tickets.foxtheatre.ca/websales/pages/ticketsearchcriteria.aspx?evtinfo=649643~3cc021f8-1c84-4d3e-b58d-8be52cd73055", status: "scheduled" });
    expect(showtimes[1]).toMatchObject({ sourceUid: "649644", startsAt: "2026-10-12T13:20:00-04:00" });
  });

  it("keeps the page's share image, description and printed year", () => {
    const post = { id: 1156262, link: "https://www.foxtheatre.ca/movies/klassic-kidz-paranorman/", title: "Klassic Kidz: ParaNorman" };
    const reference = DateTime.fromISO("2026-09-25", { zone: "America/Toronto" });
    const html = `<html><head><meta property="og:image" content="https://www.foxtheatre.ca/wp-content/uploads/paranorman.jpg"><meta name="description" content="A boy who can speak with the dead must save his town from a centuries-old curse."></head><body><h1>ParaNorman</h1><p>USA, 2012, 92 min</p><div class="showtimes-lists"><div class="item"><span class="date">Sunday, September 27</span><span class="time">11:00 am</span></div></div></body></html>`;
    const [showtime] = parseFoxMoviePage(html, post, reference).showtimes;
    expect(showtime).toMatchObject({ releaseYear: 2012, imageUrl: "https://www.foxtheatre.ca/wp-content/uploads/paranorman.jpg", synopsis: "A boy who can speak with the dead must save his town from a centuries-old curse." });
    expect(parseFoxMoviePage(fixture("fox-movie.html"), post, reference).showtimes[0]).not.toHaveProperty("imageUrl");
  });

  it("marks a film the venue titles SOLD OUT and keeps the title as printed", () => {
    const post = { id: 305581, link: "https://www.foxtheatre.ca/movies/sold-out-the-rocky-horror-picture-show-w-shadowcast/", title: "SOLD OUT – The Rocky Horror Picture Show w/Shadowcast!" };
    const [showtime] = parseFoxMoviePage(fixture("fox-movie-sold-out.html"), post, reference).showtimes;
    expect(showtime).toMatchObject({ sourceUid: "649622", status: "sold_out", rawTitle: "SOLD OUT – The Rocky Horror Picture Show w/Shadowcast!", startsAt: "2026-10-23T21:30:00-04:00" });
  });

  it("skips midnight placeholder rows without a ticket link but keeps a real screening without one", () => {
    const post = { id: 1, link: "https://www.foxtheatre.ca/movies/x/", title: "X" };
    const html = (time: string) => `<h1>X</h1><div class="showtimes-lists"><div class="item"><div class="col"><span class="date">Wednesday, September 30</span></div><div class="col"><span class="time">${time}</span><a href="" class="agile-ticket">Buy Tickets</a></div></div></div>`;
    expect(parseFoxMoviePage(html("12:00 am"), post, reference).showtimes).toEqual([]);
    const [free] = parseFoxMoviePage(html("7:00 pm"), post, reference).showtimes;
    expect(free).toMatchObject({ sourceUid: "1:2026-09-30T19:00", detailUrl: "https://www.foxtheatre.ca/movies/x/" });
    expect(free?.ticketUrl).toBeUndefined();
  });

  describe("extractFox", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("fetches only films with a screening day inside the range and reports pages it cannot read", async () => {
      const requested: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: URL | string) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("/wp-json/wp/v2/movies")) return Response.json(JSON.parse(fixture("fox-movies.json")));
        if (url.endsWith("/klassic-kidz-paranorman/")) return new Response(fixture("fox-movie.html"));
        return new Response("gone", { status: 404 });
      }));
      // The closure notice's last day is October 1, so a range from October 2 leaves it alone.
      const batch = await extractFox({ start: new Date("2026-10-02T12:00:00Z"), end: new Date("2026-10-31T12:00:00Z") });
      expect(requested.filter((url) => url.includes("/movies/")).length).toBe(2);
      expect(requested.some((url) => url.endsWith("/temporarily-closed/"))).toBe(false);
      expect(batch.showtimes.map((showtime) => showtime.sourceUid)).toEqual(["649643", "649644"]);
      expect(batch.warnings).toEqual([expect.stringMatching(/rocky-horror.*failed with 404/)]);
    });
  });
});
