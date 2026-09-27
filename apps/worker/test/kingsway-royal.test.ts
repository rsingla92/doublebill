import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { parseDaySpec, parseKingswaySchedule } from "../src/extractors/kingsway.js";
import { parseRoyalPosts } from "../src/extractors/royal.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const reference = DateTime.fromISO("2026-09-25", { zone: "America/Toronto" });

describe("Kingsway Theatre", () => {
  it("reads day patterns", () => {
    expect(parseDaySpec("daily")).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(parseDaySpec("Fri / Mon to Thurs")).toEqual([1, 2, 3, 4, 5]);
    expect(parseDaySpec("Fri Sun Tues Thurs")).toEqual([2, 4, 5, 7]);
    expect(parseDaySpec("Sat Sun")).toEqual([6, 7]);
    expect(parseDaySpec("Mon-Wed")).toEqual([1, 2, 3]);
  });

  it("expands the week's lines into one screening per day, in Toronto time, with the schedule page as the link", () => {
    const { showtimes, warnings } = parseKingswaySchedule(fixture("kingsway-new.html"), undefined, reference);
    expect(warnings).toEqual([]);
    const filipinana = showtimes.filter((showtime) => showtime.rawTitle === "Filipinana" && showtime.startsAt.includes("T13:00"));
    // The page says "Friday September 24", but September 24, 2026 is a Thursday: the week runs Friday the 25th to Thursday October 1.
    expect(filipinana.map((showtime) => showtime.startsAt.slice(0, 10))).toEqual(["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(filipinana[0]).toMatchObject({ venueSlug: "kingsway-theatre", sourceUid: "filipinana:2026-09-25T13:00", startsAt: "2026-09-25T13:00:00-04:00", detailUrl: "http://kingswaymovies.ca/new.html" });
    expect(filipinana[0]?.ticketUrl).toBeUndefined();
    expect(showtimes.filter((showtime) => showtime.rawTitle === "Finding Emily" && showtime.startsAt.includes("T13:00")).map((showtime) => showtime.startsAt.slice(0, 10))).toEqual(["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(showtimes.filter((showtime) => showtime.rawTitle === "Obsession" && showtime.startsAt.includes("T20:45")).map((showtime) => showtime.startsAt.slice(0, 10))).toEqual(["2026-09-25", "2026-09-29"]);
  });

  it("reports a page without the schedule heading", () => {
    expect(() => parseKingswaySchedule("<html><body>Closed for the week</body></html>", undefined, reference)).toThrow(/Schedule starting/);
    expect(parseKingswaySchedule("<html><body>Kingsway Theatre Schedule starting Friday September 25 to Thursday October 01<br>see you there</body></html>", undefined, reference).warnings).toEqual([expect.stringMatching(/no screenings parsed/)]);
    const agreed = parseKingswaySchedule("<html><body>Schedule starting Friday October 2 to Thursday October 08<br>7:00 pm Film (Sat)</body></html>", undefined, reference);
    expect(agreed.showtimes.map((showtime) => showtime.startsAt)).toEqual(["2026-10-03T19:00:00-04:00"]);
  });
});

describe("The Royal", () => {
  it("reads the date from the post title, the start time from the body and the promoter's ticket link", () => {
    const { showtimes, warnings } = parseRoyalPosts(JSON.parse(fixture("royal-posts.json")), reference);
    const persepolis = showtimes.find((showtime) => showtime.rawTitle === "Persépolis");
    expect(persepolis).toMatchObject({ venueSlug: "the-royal", sourceUid: "4157:2026-09-02T18:30", startsAt: "2026-09-02T18:30:00-04:00", detailUrl: "https://theroyal.to/persepolis-theroyaltheatre/" });
    expect(persepolis?.ticketUrl).toMatch(/^https:\/\/www\.eventbrite\.ca\/e\/persepolis/);
    expect(persepolis).toMatchObject({ imageUrl: "https://theroyal.to/wp-content/uploads/2026/08/PersepolisPoster_Aug5_FilmmakersInfo-760x1024.jpg", synopsis: expect.stringMatching(/.{80}/) });
    // Posts with a date but no time in the body (an exhibit, a comedy night) are not screenings
    // and are skipped without a warning, so the run still reconciles what disappeared.
    expect(showtimes).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("handles two dates in one title and falls back to the doors time", () => {
    const posts = [{ id: 1, link: "https://theroyal.to/x/", title: { rendered: "Double Bill &#8211; September 24 &amp; 25, 2026" }, content: { rendered: "<p>Doors 7pm</p><a href='https://www.showclix.com/event/x'>Get Tickets</a>" } }];
    const { showtimes, warnings } = parseRoyalPosts(posts, reference);
    expect(warnings).toEqual([]);
    expect(showtimes.map((showtime) => [showtime.sourceUid, showtime.startsAt])).toEqual([["1:2026-09-24T19:00", "2026-09-24T19:00:00-04:00"], ["1:2026-09-25T19:00", "2026-09-25T19:00:00-04:00"]]);
    expect(showtimes[0]).toMatchObject({ rawTitle: "Double Bill", ticketUrl: "https://www.showclix.com/event/x" });
  });
});
