import postgres from "postgres";
import { getDemoShowtimes } from "./demo-data";
import { VANCOUVER_TZ, vancouverDateKey } from "./format";
import { localPoster } from "./posters";
import { shortSynopsis } from "./showtimes";
import type { ShowtimeView } from "./types";

export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 14;
/** How far ahead the page lists, matching the worker's fetch horizon; the page narrows it client-side. */
export const HORIZON_DAYS = 60;

export interface ShowtimesResult {
  data: ShowtimeView[];
  demo: boolean;
  /** ISO timestamp of when this projection was produced; shown as "last updated". */
  generatedAt: string;
}

type ShowtimeRow = Omit<ShowtimeView, "startsAt"> & { startsAt: Date };

declare global {
  // eslint-disable-next-line no-var
  var __vicSql: ReturnType<typeof postgres> | undefined;
}

/** One connection pool per process, shared across routes and warm serverless invocations. */
function getSql(): ReturnType<typeof postgres> | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  globalThis.__vicSql ??= postgres(url, { max: 4, prepare: false, idle_timeout: 20 });
  return globalThis.__vicSql;
}

/**
 * Upcoming showtimes from now through the end of the Nth Vancouver calendar day,
 * so `days = 1` means "the rest of today" rather than the next 24 hours.
 */
export async function getShowtimes(days = DEFAULT_DAYS): Promise<ShowtimesResult> {
  const now = new Date();
  const generatedAt = now.toISOString();
  const sql = getSql();

  if (!sql) {
    const lastDay = vancouverDateKey(new Date(now.getTime() + (days - 1) * 86_400_000));
    const data = getDemoShowtimes(now).filter((item) => vancouverDateKey(item.startsAt) <= lastDay);
    return { data, demo: true, generatedAt };
  }

  const rows = await sql<ShowtimeRow[]>`
    select s.id::text,
      coalesce(m.id::text, 'listing:' || lower(s.display_title)) as "movieId",
      coalesce(m.title, s.display_title) as title, coalesce(m.release_year, s.listing_year) as year,
      coalesce(m.synopsis, s.listing_synopsis, '') as synopsis,
      coalesce(case when m.poster_path is null then null else 'https://image.tmdb.org/t/p/w500' || m.poster_path end, s.listing_image_url, '') as "posterUrl",
      case when m.backdrop_path is null then '' else 'https://image.tmdb.org/t/p/w1280' || m.backdrop_path end as "backdropUrl",
      json_build_object('slug', t.slug, 'name', t.name, 'city', t.city, 'timezone', t.timezone) as theatre,
      s.starts_at as "startsAt", s.ticket_url as "ticketUrl", s.status,
      coalesce(array_agg(tag.label order by tag.label) filter (where tag.id is not null), '{}') as tags
    from showtimes s
      left join movies m on m.id = s.movie_id
      join theatres t on t.id = s.theatre_id
      left join showtime_tags st on st.showtime_id = s.id
      left join tags tag on tag.id = st.tag_id
    where s.is_active and t.is_active and s.status in ('scheduled', 'sold_out')
      and s.starts_at >= now()
      and s.starts_at < (date_trunc('day', now() at time zone ${VANCOUVER_TZ}) + make_interval(days => ${days})) at time zone ${VANCOUVER_TZ}
    group by s.id, m.id, t.id
    order by s.starts_at asc, t.name asc`;

  // Only the featured pick shows a synopsis, and only its first sentences, so the page never carries more.
  // Posters come from the site's own copies where the build fetched them.
  return { data: rows.map((row) => ({ ...row, posterUrl: localPoster(row.posterUrl), synopsis: shortSynopsis(row.synopsis, 240), startsAt: row.startsAt.toISOString() })), demo: false, generatedAt };
}
