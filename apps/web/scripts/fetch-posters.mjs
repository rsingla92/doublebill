// Copies every poster the site will show into public/posters/ before the build, so
// the page serves its own images instead of loading them from TMDB, Amazon and each
// venue's site. Files are named by a hash of the source address and kept between
// builds (the deploy workflow caches the folder), so a rebuild fetches only new ones.
// An image that cannot be fetched keeps its remote address and the page loads it
// as before. Without DATABASE_URL (the sample listings) nothing is fetched.
import { createHash } from "node:crypto";
import { access, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import sharp from "sharp";

const DIR = path.join(process.cwd(), "public", "posters");
const MANIFEST = path.join(DIR, "manifest.json");
/** Twice the widest the page shows a poster, for dense screens. */
const WIDTH = 400;
const QUALITY = 82;
const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;
/** A day past the page's own horizon, so a poster is never missing at the edge. */
const HORIZON_DAYS = 61;
const USER_AGENT = "Mozilla/5.0 (compatible; DoubleBill/1.0; +https://github.com/rsingla92/vancouver-indie-cinema)";

const fileName = (url) => `${createHash("sha1").update(url).digest("hex").slice(0, 20)}.jpg`;
const exists = (file) => access(file).then(() => true, () => false);

async function mapWithConcurrency(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

async function posterUrls(databaseUrl) {
  const sql = postgres(databaseUrl, { max: 2, prepare: false });
  try {
    const rows = await sql`
      select distinct coalesce(case when m.poster_path is null then null else 'https://image.tmdb.org/t/p/w500' || m.poster_path end, s.listing_image_url) as url
      from showtimes s
        left join movies m on m.id = s.movie_id
        join theatres t on t.id = s.theatre_id
      where s.is_active and t.is_active and s.status in ('scheduled', 'sold_out')
        and s.starts_at >= now() and s.starts_at < now() + make_interval(days => ${HORIZON_DAYS})`;
    return rows.map((row) => row.url).filter((url) => typeof url === "string" && /^https?:\/\//.test(url));
  } finally {
    await sql.end();
  }
}

async function fetchPoster(url, file) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "image/*" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const image = sharp(Buffer.from(await response.arrayBuffer()), { failOn: "error" }).rotate().resize({ width: WIDTH, withoutEnlargement: true }).jpeg({ quality: QUALITY, mozjpeg: true });
  await writeFile(file, await image.toBuffer());
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log("posters: no DATABASE_URL, the page keeps remote images");
  process.exit(0);
}

await mkdir(DIR, { recursive: true });
const wanted = new Map((await posterUrls(databaseUrl)).map((url) => [url, fileName(url)]));

// Drop files no listing needs any more, so the cached folder stays the size of the site.
const needed = new Set(wanted.values());
for (const name of await readdir(DIR)) {
  if (name.endsWith(".jpg") && !needed.has(name)) await unlink(path.join(DIR, name));
}

let kept = 0;
let fetched = 0;
const failed = [];
await mapWithConcurrency([...wanted], CONCURRENCY, async ([url, name]) => {
  const file = path.join(DIR, name);
  if (await exists(file)) {
    kept += 1;
    return;
  }
  try {
    await fetchPoster(url, file);
    fetched += 1;
  } catch (error) {
    wanted.delete(url);
    failed.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
});

await writeFile(MANIFEST, JSON.stringify(Object.fromEntries(wanted)));
for (const line of failed) console.warn(`posters: left remote, ${line}`);
console.log(`posters: ${wanted.size} served by the site (${kept} kept, ${fetched} fetched), ${failed.length} left remote`);
