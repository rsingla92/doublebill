import postgres from "postgres";
import type { ExtractedShowtime } from "../contracts.js";
import type { NormalizedTitle, RankedCandidate, TmdbMovie } from "./contracts.js";
import { canonicalTitle } from "./text.js";

export interface MergeInput {
  item: ExtractedShowtime;
  normalized: NormalizedTitle;
  candidate: RankedCandidate | null;
  /** Why there is no candidate, for the review queue. */
  refusal?: string;
  /** What a second database said about an unmatched film. */
  details?: { imageUrl?: string; synopsis?: string };
  payloadHash: string;
  rulesVersion: string;
  ingestionRunId?: string;
}

export type MergeResult =
  | { status: "matched"; movieId: string; showtimeId: string }
  /** No confident film. The screening is still listed under its own title unless it is not a film or has no link. */
  | { status: "review"; showtimeId: string | null };

export type IngestionRunStatus = "succeeded" | "partial" | "failed";

export interface IngestionRunSummary {
  status: IngestionRunStatus;
  fetchedCount: number;
  upsertedCount: number;
  errorCount: number;
  errorSummary?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Limits on how much one run may hide. An extraction that silently lost part of
 * a schedule would otherwise deactivate everything it failed to see.
 */
export interface ReconciliationGuard {
  /** Refuse when more than this fraction of the venue's active future showtimes is unseen. */
  maxFraction: number;
  /** ...but only once at least this many rows would be hidden, so small venues can still cancel. */
  minCount: number;
}

export const DEFAULT_RECONCILIATION_GUARD: ReconciliationGuard = { maxFraction: 0.5, minCount: 5 };

export interface DeactivationResult {
  deactivated: number;
  unseen: number;
  active: number;
  skipped: boolean;
}

type Sql = postgres.Sql;
// The merge helpers below run inside CinemaRepository.merge, so they take the transaction handle.
type Tx = postgres.TransactionSql<{}>;

const NO_CANDIDATE_REASON = "No candidate cleared the confidence and ambiguity thresholds";
const ERROR_SUMMARY_LIMIT = 4000;

export function tagSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function tagCategory(label: string): "format" | "accessibility" | "experience" {
  if (/\b(?:\d{2}mm|restoration|restored|remaster(?:ed)?|[24]k|imax|dcp|digital|print)\b/i.test(label)) return "format";
  if (/caption|subtitle|described|accessib|relaxed|sensory/i.test(label)) return "accessibility";
  return "experience";
}

const httpsOrNull = (url: string | undefined): string | null => (url?.startsWith("https://") ? url : null);
/** A venue whose site has no working https at all (the Kingsway) still gets its schedule page as the link; migration 007 allows it. */
const webUrlOrNull = (url: string | undefined): string | null => (url && /^https?:\/\//.test(url) ? url : null);

async function requireTheatreId(sql: Tx, slug: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`select id from theatres where slug = ${slug}`;
  const theatre = rows[0];
  if (!theatre) throw new Error(`Unknown theatre: ${slug}`);
  return theatre.id;
}

/** Record what the extractor saw and how it was normalized. A changed payload makes a new revision. */
async function upsertRawItem(sql: Tx, theatreId: string, input: MergeInput): Promise<string> {
  const { item, normalized, candidate } = input;
  const payload = JSON.parse(JSON.stringify(item.sourcePayload)) as postgres.JSONValue;
  const rows = await sql<{ id: string }[]>`
    insert into raw_source_items (theatre_id, ingestion_run_id, source_uid, raw_title, source_url, payload, payload_hash,
      normalized_title, normalized_year, normalization_confidence, normalization_method,
      normalization_rules_version, normalization_output, normalization_status, tmdb_candidate_id,
      match_confidence, match_reason, resolved_at)
    values (${theatreId}, ${input.ingestionRunId ?? null}, ${item.sourceUid}, ${item.rawTitle}, ${webUrlOrNull(item.detailUrl)},
      ${sql.json(payload)}, ${input.payloadHash}, ${normalized.coreTitle},
      ${normalized.releaseYear}, ${normalized.confidence}, 'deterministic', ${input.rulesVersion},
      ${sql.json(normalized)}, ${candidate ? "matched" : "review"}, ${candidate?.movie.id ?? null},
      ${candidate?.score ?? null}, ${candidate?.reason ?? input.refusal ?? NO_CANDIDATE_REASON},
      ${candidate ? sql`now()` : null})
    on conflict (theatre_id, source_uid, payload_hash) do update set
      fetched_at = now(),
      ingestion_run_id = coalesce(excluded.ingestion_run_id, raw_source_items.ingestion_run_id),
      normalized_title = excluded.normalized_title, normalized_year = excluded.normalized_year,
      normalization_confidence = excluded.normalization_confidence,
      normalization_method = excluded.normalization_method,
      normalization_rules_version = excluded.normalization_rules_version,
      normalization_output = excluded.normalization_output, normalization_status = excluded.normalization_status,
      tmdb_candidate_id = excluded.tmdb_candidate_id, match_confidence = excluded.match_confidence,
      match_reason = excluded.match_reason, resolved_at = excluded.resolved_at
    returning id`;
  return rows[0]!.id;
}

async function upsertMovie(sql: Tx, movie: TmdbMovie, fallbackYear: number | null): Promise<string> {
  const releaseYear = movie.release_date ? Number(movie.release_date.slice(0, 4)) : fallbackYear;
  const rows = await sql<{ id: string }[]>`
    insert into movies (tmdb_id, title, original_title, release_year, synopsis, poster_path, backdrop_path, metadata, tmdb_last_synced_at)
    values (${movie.id}, ${movie.title}, ${movie.original_title}, ${releaseYear}, ${movie.overview},
      ${movie.poster_path}, ${movie.backdrop_path}, ${sql.json({ genreIds: movie.genre_ids, popularity: movie.popularity })}, now())
    on conflict (tmdb_id) where tmdb_id is not null do update set
      title = excluded.title, original_title = excluded.original_title, release_year = excluded.release_year,
      synopsis = excluded.synopsis, poster_path = excluded.poster_path, backdrop_path = excluded.backdrop_path,
      metadata = excluded.metadata, tmdb_last_synced_at = now()
    returning id`;
  return rows[0]!.id;
}

/**
 * Insert or refresh the screening. A film linked on an earlier run is kept when this
 * run could not match, so a flaky TMDB search never strips a listing of its poster.
 */
interface ListingDetails {
  imageUrl: string | null;
  synopsis: string | null;
  year: number | null;
}

async function upsertShowtime(sql: Tx, ids: { theatreId: string; movieId: string | null; rawId: string }, item: ExtractedShowtime, displayTitle: string, ticketUrl: string, listing: ListingDetails): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into showtimes (theatre_id, movie_id, raw_source_item_id, source_uid, display_title, starts_at, ends_at,
      ticket_url, status, listing_image_url, listing_synopsis, listing_year, last_seen_at)
    values (${ids.theatreId}, ${ids.movieId}, ${ids.rawId}, ${item.sourceUid}, ${displayTitle},
      ${item.startsAt}, ${item.endsAt ?? null}, ${ticketUrl}, ${item.status}, ${listing.imageUrl}, ${listing.synopsis}, ${listing.year}, now())
    on conflict (theatre_id, source_uid) do update set movie_id = coalesce(excluded.movie_id, showtimes.movie_id),
      raw_source_item_id = excluded.raw_source_item_id, display_title = excluded.display_title,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, ticket_url = excluded.ticket_url,
      status = excluded.status,
      listing_image_url = coalesce(excluded.listing_image_url, showtimes.listing_image_url),
      listing_synopsis = coalesce(excluded.listing_synopsis, showtimes.listing_synopsis),
      listing_year = coalesce(excluded.listing_year, showtimes.listing_year),
      is_active = true, last_seen_at = now()
    returning id`;
  return rows[0]!.id;
}

/** Attach the current labels and drop any the source no longer mentions. */
async function syncTags(sql: Tx, showtimeId: string, rawLabels: string[]): Promise<void> {
  const labels = new Map<string, string>();
  for (const label of rawLabels) {
    const slug = tagSlug(label);
    if (slug && !labels.has(slug)) labels.set(slug, label.trim());
  }
  for (const [slug, label] of labels) {
    await sql`insert into tags (slug, label, category) values (${slug}, ${label}, ${tagCategory(label)}) on conflict (slug) do nothing`;
    await sql`insert into showtime_tags (showtime_id, tag_id, source_text)
      select ${showtimeId}::uuid, id, ${label} from tags where slug = ${slug}
      on conflict do nothing`;
  }
  await sql`delete from showtime_tags where showtime_id = ${showtimeId}
    and tag_id not in (select id from tags where slug = any(${[...labels.keys()]}::text[]))`;
}

export class CinemaRepository {
  private readonly sql: Sql;

  constructor(databaseUrl = process.env.DATABASE_URL) {
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    // prepare: false keeps the worker compatible with transaction-mode connection poolers.
    this.sql = postgres(databaseUrl, { max: 4, prepare: false });
  }

  async findTheatre(slug: string): Promise<{ id: string; region: string; programme: string | null } | null> {
    const rows = await this.sql<{ id: string; region: string; programme: string | null }[]>`
      select id, region, source_config->>'programme' as programme from theatres where slug = ${slug}`;
    return rows[0] ?? null;
  }

  /** Pinned films for a venue, keyed by the title as the matcher compares it. Venue pins win over '*' pins. */
  async loadOverrides(slug: string): Promise<Map<string, number>> {
    const rows = await this.sql<{ theatre_slug: string; title: string; tmdb_id: string }[]>`
      select theatre_slug, title, tmdb_id::text from title_overrides where theatre_slug in ('*', ${slug})`;
    const pins = new Map<string, number>();
    for (const row of rows.sort((a, b) => (a.theatre_slug === "*" ? -1 : 0) - (b.theatre_slug === "*" ? -1 : 0))) {
      pins.set(canonicalTitle(row.title), Number(row.tmdb_id));
    }
    return pins;
  }

  async findTheatreId(slug: string): Promise<string | null> {
    return (await this.findTheatre(slug))?.id ?? null;
  }

  async startRun(theatreId: string): Promise<string> {
    const rows = await this.sql<{ id: string }[]>`insert into ingestion_runs (theatre_id) values (${theatreId}) returning id`;
    return rows[0]!.id;
  }

  async finishRun(runId: string, summary: IngestionRunSummary): Promise<void> {
    await this.sql`
      update ingestion_runs set status = ${summary.status}, finished_at = now(),
        fetched_count = ${summary.fetchedCount}, upserted_count = ${summary.upsertedCount},
        error_count = ${summary.errorCount}, error_summary = ${summary.errorSummary?.slice(0, ERROR_SUMMARY_LIMIT) ?? null},
        metadata = ${this.sql.json((summary.metadata ?? {}) as postgres.JSONValue)}
      where id = ${runId}`;
  }

  /**
   * How many of the theatre's latest finished runs in a row, newest first and at most
   * `limit`, the source blocked (`metadata.blocked`), not counting `exceptRunId`.
   */
  async countRecentBlocks(theatreId: string, exceptRunId: string, limit: number): Promise<number> {
    const rows = await this.sql<{ blocked: boolean }[]>`
      select coalesce((metadata->>'blocked')::boolean, false) as blocked from ingestion_runs
      where theatre_id = ${theatreId} and id <> ${exceptRunId} and finished_at is not null
      order by started_at desc limit ${limit}`;
    const streak = rows.findIndex((row) => !row.blocked);
    return streak === -1 ? rows.length : streak;
  }

  /**
   * Hide future showtimes the source no longer publishes. History is kept; the row
   * simply stops being active. Only rows starting before `until` are considered so a
   * date-bounded fetch never hides sessions it was not asked about, and the guard
   * refuses to hide most of a venue's schedule in one go.
   */
  async deactivateUnseenShowtimes(
    theatreId: string,
    seenSourceUids: string[],
    until: Date,
    guard: ReconciliationGuard = DEFAULT_RECONCILIATION_GUARD,
  ): Promise<DeactivationResult> {
    return this.sql.begin(async (sql) => {
      const counts = await sql<{ active: number; unseen: number }[]>`
        select count(*)::int as active,
          count(*) filter (where source_uid <> all(${seenSourceUids}::text[]))::int as unseen
        from showtimes
        where theatre_id = ${theatreId} and is_active and starts_at > now() and starts_at <= ${until}`;
      const { active, unseen } = counts[0]!;
      if (unseen >= guard.minCount && unseen > active * guard.maxFraction) {
        return { deactivated: 0, unseen, active, skipped: true };
      }
      const result = await sql`
        update showtimes set is_active = false
        where theatre_id = ${theatreId} and is_active and starts_at > now() and starts_at <= ${until}
          and source_uid <> all(${seenSourceUids}::text[])`;
      return { deactivated: result.count, unseen, active, skipped: false };
    });
  }

  /** Persist one extracted showtime and its normalization in a single transaction. */
  async merge(input: MergeInput): Promise<MergeResult> {
    return this.sql.begin(async (sql) => {
      const theatreId = await requireTheatreId(sql, input.item.venueSlug);
      // The purchase CTA must be an https link; fall back to the venue's own detail page, over http only
      // when the venue offers nothing else.
      const ticketUrl = httpsOrNull(input.item.ticketUrl) ?? httpsOrNull(input.item.detailUrl) ?? webUrlOrNull(input.item.detailUrl);
      const rawId = await upsertRawItem(sql, theatreId, input);

      if (!ticketUrl) {
        if (input.candidate) throw new Error(`No https ticket or detail URL for ${input.item.venueSlug}/${input.item.sourceUid}`);
        return { status: "review", showtimeId: null };
      }
      // An unmatched screening is listed under the venue's own title; a non-film event is not listed at all.
      if (!input.candidate && input.normalized.contentKind === "non_film") return { status: "review", showtimeId: null };

      const movieId = input.candidate ? await upsertMovie(sql, input.candidate.movie, input.normalized.releaseYear) : null;
      // A real poster beats the venue's still; the venue's own blurb beats a database plot.
      const listing: ListingDetails = {
        imageUrl: input.details?.imageUrl ?? input.item.imageUrl ?? null,
        synopsis: input.item.synopsis ?? input.details?.synopsis ?? null,
        year: input.normalized.releaseYear,
      };
      const showtimeId = await upsertShowtime(sql, { theatreId, movieId, rawId }, input.item, input.normalized.coreTitle, ticketUrl, listing);
      await syncTags(sql, showtimeId, [...input.item.tags, ...input.normalized.tags]);
      return movieId ? { status: "matched", movieId, showtimeId } : { status: "review", showtimeId };
    });
  }

  /** Cached answer from a rate-limited lookup, or undefined when none is fresh enough. */
  async get(provider: string, key: string, maxAgeMs: number): Promise<unknown | undefined> {
    const rows = await this.sql<{ response: unknown }[]>`
      select response from lookup_cache where provider = ${provider} and key = ${key} and fetched_at > now() - make_interval(secs => ${maxAgeMs / 1000})`;
    return rows.length > 0 ? rows[0]!.response : undefined;
  }

  async set(provider: string, key: string, value: unknown): Promise<void> {
    await this.sql`insert into lookup_cache (provider, key, response, fetched_at) values (${provider}, ${key}, ${this.sql.json(value as postgres.JSONValue)}, now())
      on conflict (provider, key) do update set response = excluded.response, fetched_at = now()`;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
