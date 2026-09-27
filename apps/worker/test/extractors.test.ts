import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { venueSlugSchema } from "../src/contracts.js";
import {
  parseCinemathequeFilmPage,
  parseFilmYear,
  parseHollywoodEventPage,
  parseParkPayload,
  parseRioPayload,
  parseViffPage,
  VENUE_EXTRACTORS,
} from "../src/extractors/index.js";

describe("venue registry", () => {
  it("has an extractor for every venue slug", () => {
    expect(Object.keys(VENUE_EXTRACTORS).sort()).toEqual([...venueSlugSchema.options].sort());
  });
});

describe("Rio Theatre", () => {
  const listing = { id: 350691, event: { id: 350552, title: "Tony", link: "https://riotheatre.ca/movie/tony/" }, start_time: "2026-09-22T18:30:00-07:00", extra: "", premiere: false, tickets_link: "https://riotheatretickets.ca/events/45357-tony" };

  it("maps the Barker REST payload without inventing an end time", () => {
    const { showtimes, warnings } = parseRioPayload([{ ...listing, end_time: "2026-09-22T18:30:00-07:00" }]);
    expect(showtimes[0]).toMatchObject({ sourceUid: "350691", rawTitle: "Tony", ticketUrl: "https://riotheatretickets.ca/events/45357-tony" });
    expect(showtimes[0]?.endsAt).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("keeps an end time only when it follows the start time", () => {
    expect(parseRioPayload([{ ...listing, end_time: "2026-09-22T20:30:00-07:00" }]).showtimes[0]?.endsAt).toBe("2026-09-22T20:30:00-07:00");
    expect(parseRioPayload([{ ...listing, end_time: "2026-09-22T17:30:00-07:00" }]).showtimes[0]?.endsAt).toBeUndefined();
  });

  it("turns the premiere flag and extra text into tags", () => {
    const { showtimes } = parseRioPayload([{ ...listing, premiere: true, extra: "  Q&A with director " }]);
    expect(showtimes[0]?.tags).toEqual(["premiere", "Q&A with director"]);
  });

  it("skips a malformed listing with a warning instead of failing the venue", () => {
    const { showtimes, warnings } = parseRioPayload([
      { ...listing, tickets_link: "/events/45357-tony" },
      { ...listing, id: 2, event: { ...listing.event, title: "" } },
      { ...listing, id: 3 },
    ]);
    expect(showtimes.map((item) => item.sourceUid)).toEqual(["3"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/ticketUrl/);
    expect(() => parseRioPayload({ not: "an array" })).toThrow(/not an array/);
  });
});

describe("The Park Theatre", () => {
  it("reads the same Barker payload as the Rio under its own venue slug", () => {
    const [showtime] = parseParkPayload([{ id: 9001, event: { id: 9000, title: "The Park Presents: Lawrence of Arabia", link: "https://www.theparktheatre.ca/movie/lawrence-of-arabia/" }, start_time: "2026-10-03T19:00:00-07:00", end_time: "", extra: "70mm", premiere: false, tickets_link: "" }]).showtimes;
    expect(showtime).toMatchObject({ venueSlug: "park-theatre", sourceUid: "9001", rawTitle: "The Park Presents: Lawrence of Arabia", tags: ["70mm"] });
    expect(showtime?.ticketUrl).toBeUndefined();
  });
});

describe("The Cinematheque", () => {
  const page = (date: string, weekday: string) => `<h1>The Samurai and the Prisoner</h1><section id="screeningDates"><a href="https://tickets.thecinematheque.ca/websales/pages/ticketsearchcriteria.aspx?evtinfo=571372~venue&">${date} <span class="dow">(${weekday})</span><span class="time pm">7:00</span></a></section>`;
  const reference = DateTime.fromISO("2026-09-21", { zone: "America/Vancouver" });

  it("extracts the Vista screening identifier and local time", () => {
    const [showtime] = parseCinemathequeFilmPage(page("September 22", "Tuesday"), "https://thecinematheque.ca/films/2026/samurai-prisoner", reference);
    expect(showtime).toMatchObject({ sourceUid: "571372", rawTitle: "The Samurai and the Prisoner", startsAt: "2026-09-22T19:00:00-07:00" });
  });

  it("dates a January screening in the next year even on a 2026 programme page", () => {
    const december = DateTime.fromISO("2026-12-20", { zone: "America/Vancouver" });
    const [showtime] = parseCinemathequeFilmPage(page("January 9", "Saturday"), "https://thecinematheque.ca/films/2026/samurai-prisoner", december);
    expect(showtime?.startsAt).toBe("2027-01-09T19:00:00-08:00");
  });

  it("reads Today and Tomorrow relative to the crawl date", () => {
    const [today] = parseCinemathequeFilmPage(page("Today", ""), "https://thecinematheque.ca/films/2026/downpour", reference);
    const [tomorrow] = parseCinemathequeFilmPage(page("Tomorrow", ""), "https://thecinematheque.ca/films/2026/downpour", reference);
    expect(today?.startsAt).toBe("2026-09-21T19:00:00-07:00");
    expect(tomorrow?.startsAt).toBe("2026-09-22T19:00:00-07:00");
  });

  it("carries the year printed beside the director credit", () => {
    const withMeta = page("September 22", "Tuesday").replace("<section", '<p class="meta">Japan 1962. Dir: Masaki Kobayashi. 133 min. 35mm</p><section');
    expect(parseCinemathequeFilmPage(withMeta, "https://thecinematheque.ca/films/2026/harakiri", reference)[0]?.releaseYear).toBe(1962);
    expect(parseCinemathequeFilmPage(page("September 22", "Tuesday"), "https://thecinematheque.ca/films/2026/harakiri", reference)[0]?.releaseYear).toBeUndefined();
    const withShare = `<head><meta property="og:image" content="https://thecinematheque.ca/stills/harakiri.jpg"><meta property="og:description" content="Kobayashi's samurai drama, a ronin's request to die in a lord's courtyard."></head>${withMeta}`;
    expect(parseCinemathequeFilmPage(withShare, "https://thecinematheque.ca/films/2026/harakiri", reference)[0]).toMatchObject({ releaseYear: 1962, imageUrl: "https://thecinematheque.ca/stills/harakiri.jpg", synopsis: expect.stringMatching(/^Kobayashi/) });
    expect(parseFilmYear("Programme 2026. Japan 1962. Dir: Masaki Kobayashi.", 2027)).toBe(1962);
    expect(parseFilmYear("Sept 2026 season. No credit here.", 2027)).toBeNull();
  });

  it("falls back to the date alone when the printed weekday is wrong", () => {
    const [showtime] = parseCinemathequeFilmPage(page("September 22", "Monday"), "https://thecinematheque.ca/films/2026/samurai-prisoner", reference);
    expect(showtime?.startsAt).toBe("2026-09-22T19:00:00-07:00");
  });
});

describe("VIFF", () => {
  const card = (date: string, time: string) => `<div class="c-event-card"><h3 class="c-event-card__title"><a href="/whats-on/example/">Example Film</a></h3><div class="c-event-instance"><div class="c-event-instance__time">${time}</div><div class="c-event-instance__date"><span>${date}</span></div><span class="c-event-instance__venue">VIFF Cinema</span><button data-eventid="50784" data-instanceid="55880"></button><a class="c-event-instance__btn" href="/whats-on/example/book/opaque">Book now</a></div></div>`;

  it("maps instances and availability independently", () => {
    const [showtime] = parseViffPage(card("Sat Sep 26", "6:10 pm"), "https://viff.org/whats-on/", DateTime.fromISO("2026-09-21", { zone: "America/Vancouver" }));
    expect(showtime).toMatchObject({ sourceUid: "55880", rawTitle: "Example Film", startsAt: "2026-09-26T18:10:00-07:00", ticketUrl: "https://viff.org/whats-on/example/book/opaque" });
  });

  it("rolls a January date over to the next year when the weekday only fits there", () => {
    const [showtime] = parseViffPage(card("Sat Jan 2", "7:00 pm"), "https://viff.org/whats-on/", DateTime.fromISO("2026-12-28", { zone: "America/Vancouver" }));
    expect(showtime?.startsAt).toBe("2027-01-02T19:00:00-08:00");
  });

  it("reads the year the card prints beside the running time, never the season label", () => {
    const withMeta = card("Sat Sep 26", "6:10 pm").replace("</h3>", '</h3><p class="c-event-card__meta">Canada, 2026, 94 min</p>');
    const reference = DateTime.fromISO("2026-09-21", { zone: "America/Vancouver" });
    expect(parseViffPage(withMeta, "https://viff.org/whats-on/", reference)[0]?.releaseYear).toBe(2026);
    const withLabel = card("Sat Sep 26", "6:10 pm").replace("</h3>", '</h3><p class="c-event-card__meta">VIFF 2026</p>');
    expect(parseViffPage(withLabel, "https://viff.org/whats-on/", reference)[0]?.releaseYear).toBeUndefined();
  });

  it("flags sold out and standby instances", () => {
    const html = card("Sat Sep 26", "6:10 pm").replace("Book now", "Standby only");
    expect(parseViffPage(html, "https://viff.org/whats-on/", DateTime.fromISO("2026-09-21", { zone: "America/Vancouver" }))[0]?.status).toBe("sold_out");
  });

  it("keeps the card's still and blurb, for films no database knows", () => {
    const blurb = "A first feature that follows three siblings back to the family orchard over one dry summer.";
    const html = card("Sat Sep 26", "6:10 pm").replace('<div class="c-event-instance">', `<img data-src="/media/example.jpg" src="data:image/gif;base64,R0lGOD"><p class="c-event-card__excerpt">${blurb}</p><p>Canada</p><div class="c-event-instance">`);
    const [showtime] = parseViffPage(html, "https://viff.org/whats-on/", DateTime.fromISO("2026-09-21", { zone: "America/Vancouver" }));
    expect(showtime).toMatchObject({ imageUrl: "https://viff.org/media/example.jpg", synopsis: blurb });
    expect(parseViffPage(card("Sat Sep 26", "6:10 pm"), "https://viff.org/whats-on/", DateTime.fromISO("2026-09-21", { zone: "America/Vancouver" }))[0]).not.toHaveProperty("imageUrl");
  });
});

describe("Hollywood Theatre", () => {
  it("keeps the page's share image and description, for films no database knows", () => {
    const blurb = "A documentary about the last projectionist in a small town, screening once with the director present.";
    const html = `<meta name="description" content="${blurb}"><meta property="og:image" content="https://www.hollywoodtheatre.ca/images/projectionist.jpg"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a><div>October 3, 2026</div><p>SHOW: 7:00pm</p>`;
    expect(parseHollywoodEventPage(html, "https://www.hollywoodtheatre.ca/events/x").showtimes[0]).toMatchObject({ imageUrl: "https://www.hollywoodtheatre.ca/images/projectionist.jpg", synopsis: blurb });
    const bare = `<meta name="description" content="Example Film at Hollywood Theatre"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a><div>October 3, 2026</div><p>SHOW: 7:00pm</p>`;
    const [showtime] = parseHollywoodEventPage(bare, "https://www.hollywoodtheatre.ca/events/x").showtimes;
    expect(showtime).not.toHaveProperty("imageUrl");
    expect(showtime).not.toHaveProperty("synopsis");
  });

  it("keeps film events and creates one record per advertised show time", () => {
    const html = `<title>Example Film at Hollywood Theatre</title><meta name="description" content="Example Film September 30, 2026 at Hollywood Theatre"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a><p>DOORS: 6:00pm // SHOW: 7:00pm</p><a href="https://tickets.example.com/example">Get Tickets</a>`;
    const { showtimes, warning } = parseHollywoodEventPage(html, "https://www.hollywoodtheatre.ca/events/example-film");
    expect(showtimes).toHaveLength(1);
    expect(warning).toBeUndefined();
    expect(showtimes[0]).toMatchObject({ rawTitle: "Example Film", startsAt: "2026-09-30T19:00:00-07:00", ticketUrl: "https://tickets.example.com/example", tags: [] });
  });

  it("keeps secondary categories as tags but not the film gate itself", () => {
    const html = `<meta name="description" content="Concert Film March 1, 2027 at Hollywood Theatre"><h1 class="heading-events">Concert Film</h1><a href="/categories/film">Film</a><a href="/categories/music">Music</a><p>SHOW: 7:00pm</p>`;
    const [showtime] = parseHollywoodEventPage(html, "https://www.hollywoodtheatre.ca/events/concert-film").showtimes;
    expect(showtime).toMatchObject({ tags: ["music"], startsAt: "2027-03-01T19:00:00-08:00" });
  });

  it("finds the date in the page when the description no longer carries it", () => {
    const prose = `<meta name="description" content="Example Film at Hollywood Theatre"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a><div>Friday, October 3rd, 2026</div><p>DOORS: 6:00pm // SHOW: 7:00pm</p>`;
    expect(parseHollywoodEventPage(prose, "https://www.hollywoodtheatre.ca/events/x").showtimes[0]?.startsAt).toBe("2026-10-03T19:00:00-07:00");

    const structured = `<meta name="description" content="Example Film at Hollywood Theatre"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a><time datetime="2026-10-03T19:00:00-07:00">Oct 3</time><p>SHOW: 7:00pm</p>`;
    expect(parseHollywoodEventPage(structured, "https://www.hollywoodtheatre.ca/events/x").showtimes[0]?.startsAt).toBe("2026-10-03T19:00:00-07:00");

    const noYear = `<meta name="description" content="Example Film at Hollywood Theatre"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a><div>Sat, Oct 3</div><p>SHOW: 9:30pm</p>`;
    const reference = DateTime.fromISO("2026-09-21", { zone: "America/Vancouver" });
    expect(parseHollywoodEventPage(noYear, "https://www.hollywoodtheatre.ca/events/x", reference).showtimes[0]?.startsAt).toBe("2026-10-03T21:30:00-07:00");
  });

  it("reads other show-time labels, falls back to a structured start time, and reports what it saw", () => {
    const film = (body: string) => `<meta name="description" content="Example Film at Hollywood Theatre"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a>${body}`;
    expect(parseHollywoodEventPage(film("<div>Friday, October 3, 2026</div><p>Doors 6:30 PM · Film starts 7:00 PM</p>"), "https://www.hollywoodtheatre.ca/events/x").showtimes[0]?.startsAt).toBe("2026-10-03T19:00:00-07:00");
    expect(parseHollywoodEventPage(film(`<time datetime="2026-10-03T21:30:00-07:00">Oct 3</time>`), "https://www.hollywoodtheatre.ca/events/x").showtimes[0]?.startsAt).toBe("2026-10-03T21:30:00-07:00");
    expect(parseHollywoodEventPage(film("<div>October 3, 2026</div><p>Doors open 6:30pm</p>"), "https://www.hollywoodtheatre.ca/events/x").warning).toMatch(/no show time \(times on page: "[^"]*Doors open 6:30pm"\)/);
  });

  it("takes the start of a running time when the show label is left blank", () => {
    // Seen on the site: "Doors 7pm • Show" with nothing after it, and the time only in the prose.
    const html = `<meta name="description" content="Example Film at Hollywood Theatre"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a><div>Thursday, October 8, 2026</div><div>Doors 7pm • Show</div><p>Join us on Thursday, October 8, from 7:00–10:00 PM for an evening of film.</p>`;
    const { showtimes, warning } = parseHollywoodEventPage(html, "https://www.hollywoodtheatre.ca/events/x");
    expect(warning).toBeUndefined();
    expect(showtimes.map((showtime) => showtime.startsAt)).toEqual(["2026-10-08T19:00:00-07:00"]);
  });

  it("takes the year from the page's slug, or from the page", () => {
    const film = (body: string) => `<meta name="description" content="Example Film at Hollywood Theatre"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a>${body}`;
    expect(parseHollywoodEventPage(film("<div>October 3, 2026</div><p>SHOW: 7:00pm</p>"), "https://www.hollywoodtheatre.ca/events/the-fly-1986").showtimes[0]?.releaseYear).toBe(1986);
    expect(parseHollywoodEventPage(film("<div>October 3, 2026</div><p>USA, 1986, 96 min</p><p>SHOW: 7:00pm</p>"), "https://www.hollywoodtheatre.ca/events/the-fly").showtimes[0]?.releaseYear).toBe(1986);
    expect(parseHollywoodEventPage(film("<div>October 3, 2026</div><p>SHOW: 7:00pm</p>"), "https://www.hollywoodtheatre.ca/events/the-fly").showtimes[0]?.releaseYear).toBeUndefined();
  });

  it("excludes non-film events", () => {
    const html = `<meta name="description" content="Concert September 30, 2026 at Hollywood Theatre"><h1 class="heading-events">Concert</h1><a href="/categories/music">Music</a><p>SHOW: 7:00pm</p>`;
    expect(parseHollywoodEventPage(html, "https://www.hollywoodtheatre.ca/events/concert")).toEqual({ showtimes: [] });
  });

  it("warns about a film page it cannot read instead of dropping it silently", () => {
    const noDate = `<meta name="description" content="Example Film at Hollywood Theatre"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a><p>SHOW: 7:00pm</p>`;
    expect(parseHollywoodEventPage(noDate, "https://www.hollywoodtheatre.ca/events/x").warning).toMatch(/no recognisable date/);
    const noTime = `<meta name="description" content="Example Film September 30, 2026"><h1 class="heading-events">Example Film</h1><a href="/categories/film">Film</a><p>Doors 6pm</p>`;
    expect(parseHollywoodEventPage(noTime, "https://www.hollywoodtheatre.ca/events/x").warning).toMatch(/no show time/);
  });
});
