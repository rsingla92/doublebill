import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtractedShowtime } from "../src/contracts.js";
import type { NormalizedTitle, RankedCandidate } from "../src/normalization/contracts.js";
import { CinemaRepository } from "../src/normalization/repository.js";

// Runs only against a database that has the migrations applied: DATABASE_URL=postgres://... npx vitest run
const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const DAY_MS = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
const TMDB_ID = 42_424_242;

const item = (overrides: Partial<ExtractedShowtime> = {}): ExtractedShowtime => ({
  venueSlug: "rio-theatre", sourceUid: "int-1", rawTitle: "Tony", startsAt: inDays(3),
  detailUrl: "https://riotheatre.ca/movie/tony/", ticketUrl: "https://riotheatretickets.ca/events/1-tony",
  status: "scheduled", tags: ["Q&A with director"], sourcePayload: { id: 1 }, ...overrides,
});
const normalized: NormalizedTitle = { coreTitle: "Tony", releaseYear: 2009, contentKind: "film", tags: ["Q&A"], confidence: 0.96, note: "" };
const candidate: RankedCandidate = {
  movie: { id: TMDB_ID, title: "Tony", original_title: "Tony", release_date: "2009-01-01", overview: "", poster_path: null, backdrop_path: null, genre_ids: [], popularity: 3 },
  score: 0.95, similarity: 1, reason: "test",
};

suite("CinemaRepository against Postgres", () => {
  // Constructed in beforeAll so collecting this file without DATABASE_URL stays a clean skip.
  let repository: CinemaRepository;
  let sql: postgres.Sql;
  let theatreId: string;

  const cleanup = async () => {
    await sql`delete from showtimes where source_uid like 'int-%'`;
    await sql`delete from raw_source_items where source_uid like 'int-%'`;
    await sql`delete from movies where tmdb_id = ${TMDB_ID}`;
    await sql`delete from lookup_cache where provider = 'int-test'`;
  };
  const tagsFor = async (sourceUid: string) => (await sql<{ slug: string }[]>`
    select t.slug from showtime_tags st join tags t on t.id = st.tag_id join showtimes s on s.id = st.showtime_id
    where s.source_uid = ${sourceUid} order by 1`).map((row) => row.slug);

  beforeAll(async () => {
    repository = new CinemaRepository(databaseUrl);
    sql = postgres(databaseUrl ?? "", { max: 1 });
    await cleanup();
    theatreId = (await repository.findTheatreId("rio-theatre"))!;
    expect(theatreId).toBeTruthy();
  });
  afterAll(async () => { await cleanup(); await repository.close(); await sql.end(); });

  it("links a film, then keeps it while refreshing the showtime when a later run cannot match", async () => {
    const first = await repository.merge({ item: item(), normalized, candidate, payloadHash: "h1", rulesVersion: "t" });
    expect(first.status).toBe("matched");
    expect(await tagsFor("int-1")).toEqual(["q-a", "q-a-with-director"]);

    const moved = inDays(4);
    const second = await repository.merge({
      item: item({ startsAt: moved, status: "sold_out", ticketUrl: "https://riotheatretickets.ca/events/1-tony-late" }),
      normalized: { ...normalized, confidence: 0.45 }, candidate: null, payloadHash: "h2", rulesVersion: "t",
    });
    expect(second.status).toBe("review");

    const [row] = await sql<{ movie_id: string; status: string; starts_at: Date; ticket_url: string; is_active: boolean }[]>`
      select movie_id, status, starts_at, ticket_url, is_active from showtimes where source_uid = 'int-1'`;
    expect(row).toMatchObject({ movie_id: first.status === "matched" ? first.movieId : "", status: "sold_out", ticket_url: "https://riotheatretickets.ca/events/1-tony-late", is_active: true });
    expect(row!.starts_at.toISOString()).toBe(new Date(moved).toISOString());
  });

  it("removes tags the source no longer mentions", async () => {
    await repository.merge({ item: item({ tags: [] }), normalized: { ...normalized, tags: [] }, candidate, payloadHash: "h3", rulesVersion: "t" });
    expect(await tagsFor("int-1")).toEqual([]);
  });

  it("keeps an http detail link as the source url and prefers the https ticket link", async () => {
    const result = await repository.merge({ item: item({ sourceUid: "int-http", detailUrl: "http://riotheatre.ca/movie/tony/" }), normalized, candidate, payloadHash: "h4", rulesVersion: "t" });
    expect(result.status).toBe("matched");
    const [raw] = await sql<{ source_url: string | null }[]>`select source_url from raw_source_items where source_uid = 'int-http'`;
    expect(raw?.source_url).toBe("http://riotheatre.ca/movie/tony/");
    expect((await sql<{ ticket_url: string }[]>`select ticket_url from showtimes where source_uid = 'int-http'`)[0]?.ticket_url).toBe("https://riotheatretickets.ca/events/1-tony");
  });

  it("hides a few unseen showtimes but refuses to hide most of a venue", async () => {
    const uids = Array.from({ length: 10 }, (_, index) => `int-r${index}`);
    for (const [index, uid] of uids.entries()) {
      await repository.merge({ item: item({ sourceUid: uid, startsAt: inDays(5 + index) }), normalized, candidate, payloadHash: `r${index}`, rulesVersion: "t" });
    }
    const until = new Date(Date.now() + 60 * DAY_MS);

    const small = await repository.deactivateUnseenShowtimes(theatreId, [...uids.slice(0, 8), "int-1", "int-http"], until);
    expect(small).toMatchObject({ skipped: false, unseen: 2, deactivated: 2 });

    const large = await repository.deactivateUnseenShowtimes(theatreId, uids.slice(0, 2), until);
    expect(large.skipped).toBe(true);
    expect(large.deactivated).toBe(0);
    expect(large.unseen).toBeGreaterThan(large.active * 0.5);

    const counts = await sql<{ active: number }[]>`select count(*)::int as active from showtimes where source_uid like 'int-r%' and is_active`;
    expect(counts[0]?.active).toBe(8);
  });

  it("lists an unmatched film under the venue's title and skips a non-film event", async () => {
    const listed = await repository.merge({
      item: item({ sourceUid: "int-2", rawTitle: "Total Recall (4K Restoration)" }),
      normalized: { coreTitle: "Total Recall", releaseYear: null, contentKind: "film", tags: ["restoration"], confidence: 0.9, note: "" },
      candidate: null, payloadHash: "h3", rulesVersion: "t",
    });
    expect(listed).toEqual({ status: "review", showtimeId: expect.any(String) });
    const [row] = await sql<{ movie_id: string | null; display_title: string }[]>`select movie_id, display_title from showtimes where source_uid = 'int-2'`;
    expect(row).toEqual({ movie_id: null, display_title: "Total Recall" });
    expect(await tagsFor("int-2")).toEqual(["q-a-with-director", "restoration"]);

    // The Kingsway's site has no working https; its http schedule page is still a usable link.
    const httpOnly = await repository.merge({
      item: item({ sourceUid: "int-4", rawTitle: "Uprising", detailUrl: "http://kingswaymovies.ca/new.html", ticketUrl: undefined }),
      normalized: { coreTitle: "Uprising", releaseYear: null, contentKind: "film", tags: [], confidence: 0.96, note: "" },
      candidate: null, payloadHash: "h5", rulesVersion: "t",
    });
    expect(httpOnly).toEqual({ status: "review", showtimeId: expect.any(String) });
    expect((await sql<{ ticket_url: string }[]>`select ticket_url from showtimes where source_uid = 'int-4'`)[0]?.ticket_url).toBe("http://kingswaymovies.ca/new.html");

    const skipped = await repository.merge({
      item: item({ sourceUid: "int-3", rawTitle: "Private Event" }),
      normalized: { coreTitle: "Private Event", releaseYear: null, contentKind: "non_film", tags: [], confidence: 0.9, note: "" },
      candidate: null, payloadHash: "h4", rulesVersion: "t",
    });
    expect(skipped).toEqual({ status: "review", showtimeId: null });
    expect((await sql`select 1 from showtimes where source_uid = 'int-3'`).length).toBe(0);
  });

  it("keeps the venue's image and blurb, or a second database's, for a film no database matched", async () => {
    const orchard = (overrides: Partial<NormalizedTitle> = {}): NormalizedTitle => ({ coreTitle: "Orchard", releaseYear: 2026, contentKind: "film", tags: [], confidence: 0.96, note: "", ...overrides });
    const listing = async () => (await sql<{ listing_image_url: string | null; listing_synopsis: string | null; listing_year: number | null }[]>`
      select listing_image_url, listing_synopsis, listing_year from showtimes where source_uid = 'int-5'`)[0];

    const listed = await repository.merge({
      item: item({ sourceUid: "int-5", rawTitle: "Orchard", imageUrl: "https://viff.org/media/orchard.jpg", synopsis: "Three siblings return to the family orchard." }),
      normalized: orchard(), candidate: null, refusal: "refused: TMDB returned no candidates; OMDb has \"Orchard\" (2026, tt1)",
      details: { imageUrl: "https://m.media-amazon.com/images/orchard.jpg", synopsis: "A database's plot." },
      payloadHash: "h6", rulesVersion: "t",
    });
    expect(listed.status).toBe("review");
    // A poster beats a still from the venue; the venue's own words beat a database plot.
    expect(await listing()).toEqual({ listing_image_url: "https://m.media-amazon.com/images/orchard.jpg", listing_synopsis: "Three siblings return to the family orchard.", listing_year: 2026 });

    // A later run that learns nothing keeps what an earlier one found.
    await repository.merge({ item: item({ sourceUid: "int-5", rawTitle: "Orchard" }), normalized: orchard({ releaseYear: null }), candidate: null, payloadHash: "h7", rulesVersion: "t" });
    expect(await listing()).toEqual({ listing_image_url: "https://m.media-amazon.com/images/orchard.jpg", listing_synopsis: "Three siblings return to the family orchard.", listing_year: 2026 });

    await repository.merge({ item: item({ sourceUid: "int-6", rawTitle: "Orchard" }), normalized: orchard({ releaseYear: null }), candidate: null, payloadHash: "h8", rulesVersion: "t" });
    expect((await sql<{ listing_image_url: string | null; listing_year: number | null }[]>`select listing_image_url, listing_year from showtimes where source_uid = 'int-6'`)[0]).toEqual({ listing_image_url: null, listing_year: null });
  });

  it("keeps lookup answers, empty ones included, until they age out", async () => {
    expect(await repository.get("int-test", "k", 60_000)).toBeUndefined();
    await repository.set("int-test", "k", { imdbId: "tt1", title: "K", year: null });
    await repository.set("int-test", "none", null);
    expect(await repository.get("int-test", "k", 60_000)).toEqual({ imdbId: "tt1", title: "K", year: null });
    expect(await repository.get("int-test", "none", 60_000)).toBeNull();

    await repository.set("int-test", "k", { imdbId: "tt2", title: "K", year: 2001 });
    expect(await repository.get("int-test", "k", 60_000)).toEqual({ imdbId: "tt2", title: "K", year: 2001 });

    await sql`update lookup_cache set fetched_at = now() - interval '2 minutes' where provider = 'int-test'`;
    expect(await repository.get("int-test", "k", 60_000)).toBeUndefined();
    expect(await repository.get("int-test", "k", 600_000)).toEqual({ imdbId: "tt2", title: "K", year: 2001 });
  });

  it("reads a venue's programme and its pinned titles", async () => {
    expect(await repository.findTheatre("rio-theatre")).toMatchObject({ id: theatreId, region: "BC", programme: null });
    await sql`insert into title_overrides (theatre_slug, title, tmdb_id, note) values ('*', 'Suspiria', 1, 'everywhere'), ('rio-theatre', 'SUSPIRIA', 2, 'the Rio')
      on conflict (theatre_slug, title) do update set tmdb_id = excluded.tmdb_id`;
    try {
      // Migrations pin other titles everywhere, so only the test's own entry is checked.
      expect((await repository.loadOverrides("rio-theatre")).get("suspiria")).toBe(2);
      expect((await repository.loadOverrides("park-theatre")).get("suspiria")).toBe(1);
    } finally {
      await sql`delete from title_overrides where title in ('Suspiria', 'SUSPIRIA')`;
    }
  });
});
