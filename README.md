# Double Bill

Independent cinema showtimes for Vancouver, Toronto and Montreal. A mobile-first static site that lists what each city's independent and repertory screens are playing; ticket purchases stay on each venue's own site.

Live at [rsingla.ca/doublebill](https://rsingla.ca/doublebill/). GitHub Pages serves the site under the repository's name, so the repository is named `doublebill`; the build reads the path from the Pages configuration, and nothing in the code names it.

## Project status

The pipeline is complete: source extraction, deterministic title normalization, guarded TMDB matching, idempotent PostgreSQL persistence with per-run reconciliation, JSON data files, and an installable mobile-first site. It has no LLM or generative-AI runtime dependency. The site covers three cities (see [Cities](#cities)).

## Stack

- Next.js App Router as a static export, React, TypeScript, Tailwind CSS
- Neon PostgreSQL (free tier)
- Node.js ingestion worker on GitHub Actions
- GitHub Pages for hosting
- TMDB for canonical movie metadata
- `@ctrl/video-filename-parser` as a guarded final pass for release-style suffixes
- `fast-fuzzy` for deterministic title similarity
- Web App Manifest and service worker for installability and offline schedule access

## Key artifacts

- [`docs/architecture.md`](docs/architecture.md): boundaries, data flow, folder structure, and design decisions
- [`docs/hidden-api-hunt.md`](docs/hidden-api-hunt.md): source investigation and Network-tab capture protocol
- [`db/migrations/001_initial_schema.sql`](db/migrations/001_initial_schema.sql): relational schema
- [`db/migrations/002_normalization_pipeline.sql`](db/migrations/002_normalization_pipeline.sql): match-review state and read policies
- [`db/migrations/003_seed_theatres.sql`](db/migrations/003_seed_theatres.sql) and [`004_seed_park_theatre.sql`](db/migrations/004_seed_park_theatre.sql): the venues the worker ingests

## Local setup

```bash
cp .env.example .env.local
npm install
npm run dev
```

Set `DATABASE_URL` and `TMDB_API_TOKEN`. Without `DATABASE_URL`, the UI uses labelled demo listings for visual development. `npm run build --workspace=@vic/web` writes the static site to `apps/web/out`.

`npm run migrate` applies the SQL migrations in `db/migrations/` that have not been applied yet, in order, and records them in `schema_migrations`. The ingest workflow runs it before every ingest, so a new migration on `main` reaches the database on the next run.

## Matching

A screening is linked to a TMDB film only when one candidate clearly wins; otherwise it is listed under the venue's own title. Three things settle ties:

- A year the venue prints beside the title, on the listing or on the film's own page.
- The venue's programme, set in `theatres.source_config` as `{"programme": "first_run"}` or `"festival"`: there, of two same-title films, the current release wins. Repertory and mixed venues get no preference.
- A pin in `title_overrides` for a title no rule will settle: `insert into title_overrides (theatre_slug, title, tmdb_id, note) values ('cinema-du-parc', 'Suspiria', 11906, '1977, Argento');`. Write the title as the venue prints it; `'*'` as the venue applies everywhere. The TMDB id is the number in the film's themoviedb.org URL.

When no database knows a film, the screening still shows the venue's own image and blurb, which the extractors take from the film's page. With an `OMDB_API_KEY` secret (free at omdbapi.com; a thousand lookups a day, answers cached for a week), OMDb is asked for a poster and a plot before falling back to the venue's, since festival films reach IMDb first.

Posters are served by the site itself. Before each build, `apps/web/scripts/fetch-posters.mjs` copies every image the page will show into `public/posters/`, scaled to 400 pixels wide, and the deploy workflow keeps that folder between builds so only new posters are fetched. An image that cannot be fetched is loaded from its source as before. The Kingsway prints no film pages, so its unmatched films stay text-only.

The review queue that shows what to pin: `select venue, normalized_title, match_reason from raw_source_items ...` (see `docs/architecture.md`).

## Cities

Every theatre carries a `city` and an IANA `timezone`, the JSON files include both, and the site shows a city picker in the dateline as soon as the data holds more than one city. Times are always shown in the theatre's own zone. Adding a city means seeding its theatres (a migration like `006_seed_toronto_montreal_theatres.sql`) and writing one extractor per venue under `apps/worker/src/extractors/`, then adding the venue slug to `venueSlugSchema`; nothing in the web app changes. Other cities are tracked in issue #5.

| City | Venues | Slugs |
|---|---|---|
| Vancouver | Rio Theatre, The Park Theatre, The Cinematheque, VIFF Centre, Hollywood Theatre | `rio-theatre`, `park-theatre`, `the-cinematheque`, `viff-centre`, `hollywood-theatre` |
| Toronto | Revue Cinema, Fox Theatre, Paradise Theatre, The Royal, Carlton Cinema, Kingsway Theatre, Hot Docs Ted Rogers Cinema | `revue-cinema`, `fox-theatre`, `paradise-theatre`, `the-royal`, `carlton-cinema`, `kingsway-theatre`, `hot-docs-cinema` |
| Montreal | Cinéma du Parc, Cinéma Beaubien, Cinéma du Musée, Cinéma Moderne, Cinéma Public, Cinémathèque québécoise | `cinema-du-parc`, `cinema-beaubien`, `cinema-du-musee`, `cinema-moderne`, `cinema-public`, `cinematheque-quebecoise` |

TIFF Lightbox is seeded but has no extractor: tiff.net refuses every request from GitHub's runners outright, and its Ticketmaster box office does the same. The Hot Docs Ted Rogers Cinema publishes its schedule only on an Agile Ticketing box office behind a bot challenge, so its extractor loads the feed in headless Chrome (`apps/worker/src/browser.ts`), which the GitHub runner has; a local run needs Google Chrome or a `BROWSER_EXECUTABLE`. [`docs/hidden-api-hunt.md`](docs/hidden-api-hunt.md) records what was found for every venue.

## Ingestion

```bash
npm run ingest                                    # every venue, 60-day horizon
npm run ingest -- --days=30 --venues=rio-theatre  # narrower run
```

For each venue the job records an `ingestion_runs` row, fetches the schedule, normalizes every title, links confident TMDB matches, and upserts `showtimes`. Future showtimes that a complete extraction no longer lists are marked inactive; history is never deleted. The venue slugs are listed under [Cities](#cities). Venues that share a platform share an adapter: the Rio and the Park (Barker events plugin), Cinéma du Parc, Beaubien and du Musée (the cinemacinema.ca schedule), the Cinémathèque québécoise and the Carlton (OmniWeb Ticketing), and the Revue and the Fox (Agile Ticketing links on their own sites). Hot Docs sells through Agile too, and is the one venue read through a browser rather than plain HTTP.

The normalizer strips known venue prefixes, series labels, and format/event suffixes, extracts a release year only when the listing sets one apart (for example `(1978)`), then ranks TMDB results by title similarity, year agreement, and popularity. A movie is linked only when the leading candidate clears both the confidence threshold and ambiguity margin. Uncertain screenings are still listed, under the title the venue printed and with the venue's own image and blurb when its page has them, and stay flagged in `raw_source_items` with `normalization_status = 'review'`; events the rules recognise as not a film are not listed.

## Hosting

The site is a static export served by GitHub Pages. It is rebuilt from the database after every ingest and on every push to `main` that touches the site. Past showtimes are hidden in the browser, so a page left open stays current between builds. The database is a free Neon Postgres project. Nothing costs money.

1. Create a Neon project and copy its pooled connection string (it ends in `?sslmode=require`). The first ingest creates the tables; to do it by hand, run `DATABASE_URL=... npm run migrate`.

2. Add the repository secrets `DATABASE_URL` and `TMDB_API_TOKEN`.
3. In Settings → Pages, set the source to "GitHub Actions".
4. Push to `main`, or run the "Deploy site to GitHub Pages" workflow by hand.

The deploy workflow refuses to build when `DATABASE_URL` is missing, so a forgotten secret cannot publish the sample listings, and the page build fails when the database holds no upcoming showtimes, so a broken ingest cannot publish an empty schedule. The ingest workflow checks both secrets before it starts. To preview the sample data on Pages anyway, run the workflow by hand with the "demo" option.

A project site is served under `/<repository>/`; the build reads that prefix from the Pages configuration, so moving to a custom domain needs no code change. Because the site is a snapshot, same-day changes such as a screening selling out appear after the next build.

## Automation

- `.github/workflows/ci.yml` runs typecheck, tests and the build on every push to `main` and every pull request.
- `.github/workflows/ingest.yml` runs the ingestion job three times a day, at 9 a.m., 1 p.m. and 5 p.m. Vancouver time, then redeploys the site. GitHub schedules in UTC, so each local time is scheduled at both possible offsets and the first job skips the one that does not land on a local hour. It can also be started by hand from the Actions tab with a custom horizon or venue list.
- `.github/workflows/deploy-pages.yml` builds and publishes the site. `pages.yml` calls it on pushes to `main` that change the site.

## Data files

The build also writes two JSON files next to the page:

- `/api/showtimes.json`: upcoming showtimes through the end of the 14th Vancouver calendar day (the page itself carries 60 days and narrows them with the When picker)
- `/api/today.json`: the rest of the build day in Vancouver time

Both hold `{ data, meta }` where `meta.generatedAt` is the build time and `meta.demo` flags preview data.

## Verification

```bash
npm test
npm run typecheck
npm run build
```

The worker also has a repository test that runs against a real database with the migrations applied. It is skipped unless `DATABASE_URL` is set:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/vic npm test --workspace=@vic/worker
```

## Delivery status

1. System architecture and database schema — complete
2. Hidden API hunt — complete
3. Data extraction scripts — complete
4. Deterministic normalization and TMDB merging — complete
5. API routes and PWA frontend — complete
6. Scheduled ingestion job with run history and reconciliation — complete
