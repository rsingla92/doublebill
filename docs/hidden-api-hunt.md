# Step 2 — Hidden API Hunt

Investigation date: 2026-09-21. This document contains read-only findings and a capture protocol. It deliberately contains no extractor implementation.

## How to capture a candidate request

In Chrome or Edge:

1. Open DevTools → **Network** before loading the venue page.
2. Enable **Preserve log** and **Disable cache**.
3. Select **Fetch/XHR**, then reload the page.
4. Clear the log and perform one action at a time: next month, next page, open one film, or reveal additional dates.
5. For a promising request, save:
   - Request URL and method
   - Query string or POST payload
   - Response body and `Content-Type`
   - Relevant response headers (`ETag`, `Last-Modified`, cache controls)
   - Whether cookies, a nonce, or authorization headers are required
6. Right-click the request → **Copy → Copy as cURL** and **Copy response**. Redact cookies and analytics identifiers before sharing.

Reject analytics, ad, newsletter, CAPTCHA, and payment calls. A schedule source should return titles, dates/times, venue/session identifiers, detail URLs, or ticket URLs without requiring checkout state.

## Source matrix

| Venue | Observed architecture | Best first source | Confidence |
|---|---|---|---|
| Rio Theatre | WordPress + custom `barker-events` plugin | Plugin REST/AJAX request used by calendar navigation | High |
| The Park Theatre | Expected to match the Rio (same operator since December 2025) | Same Barker listings request on `theparktheatre.ca` | Medium, unverified |
| The Cinematheque | Server-rendered film/calendar pages + Vista Websales ticket links | Film/calendar HTML; Vista `evtinfo` as ticket session ID | High |
| VIFF Centre | WordPress listings + Elevent embedded booking widget | Server-rendered What's On pages; Elevent only for availability/detail gaps | High |
| Hollywood Theatre | Webflow CMS + Finsweet CMS pagination | Webflow listing HTML and pagination URLs | High |
| Cinéma du Parc, Cinéma Beaubien, Cinéma du Musée | One SvelteKit site, cinemacinema.ca | `/en/schedule/__data.json?date=YYYY-MM-DD` (JSON, one day per request) | High |
| Cinéma Moderne | WordPress calendar + TicketAcces | `/horaire/YYYY/MM/` (HTML, one month per request) | High |
| Cinéma Public | WordPress calendar + TicketAcces | `/horaire/` (HTML, the whole published fortnight) | High |
| Cinémathèque québécoise | Craft-style site behind Cloudflare + OmniWeb Ticketing | OmniWeb day page `omniwebticketing6.com/cinematheque/?schdate=YYYY-MM-DD` (`gMovieData` JSON in the page) | High |
| Carlton Cinema (Imagine Cinemas) | WordPress + OmniWeb Ticketing | OmniWeb day page `omniwebticketing6.com/imaginecinemas/carlton/?schdate=YYYY-MM-DD` | High |
| Kingsway Theatre | Hand-made static HTML, http only | `http://kingswaymovies.ca/new.html`, one week as text | High |
| The Royal | WordPress posts | `/wp-json/wp/v2/posts?categories=95` (the "screenings" category) | Medium |
| Paradise Theatre | WordPress (Marquee theme) with its own box office | `/calendar-view/YYYY-MM` for the films, each film page's ScreeningEvent JSON-LD for the screenings | High |
| TIFF Lightbox | tiff.net behind AWS WAF; tickets on Ticketmaster | Every path answers a JavaScript challenge from a server, and a hard 403 from GitHub's runners; Ticketmaster blocks the runners too | Blocked |
| Hot Docs Ted Rogers Cinema | Apostrophe CMS + Agile Ticketing behind Incapsula | The Agile WebSales JSON feed `boxoffice.hotdocs.ca/websales/feed.ashx?guid=64170f3e-…&showslist=true&format=json`, loaded in headless Chrome | High |
| Revue Cinema | WordPress (Bricks) + Agile Ticketing | FullCalendar events array on `/calendar/`; Agile link from each film page | High |
| Fox Theatre | WordPress (Elementor) + Agile Ticketing | `/wp-json/wp/v2/movies` for the films, each film page for times and Agile links | High |

## Rio Theatre

### Observed

- `https://riotheatre.ca/calendar/` renders a client-side monthly schedule.
- The page loads `wp-content/plugins/barker-events/assets/dist/js/frontend.min.js`.
- Inline configuration exposes:
  - `ajaxUrl`: `https://riotheatre.ca/wp-admin/admin-ajax.php`
  - `restBaseUrl`: `https://riotheatre.ca/wp-json/`
  - a WordPress REST nonce
  - the venue timezone offset
- Moving through the calendar updates event cards containing a title and local showtime.
- Event detail pages use `/movie/{slug}/` or `/event/{slug}/`; ticket CTAs often deep-link to `riotheatretickets.ca/events/{numeric-id}-{slug}`.

### Network-tab target

Filter with:

```text
wp-json OR admin-ajax OR barker OR event OR calendar
```

Then clear the log and click the calendar’s **next-month** arrow once. The desired request should contain a month/date range or pagination parameters and return event objects or rendered event fragments.

Capture these response fields if present:

- stable event/post ID
- title and slug
- start/end datetime and timezone
- event type (`movie` versus other event)
- detail URL
- ticket URL or ticket-platform event ID
- image/poster URL
- status/cancellation information

### Decision gate

Prefer a public GET REST route that works without a nonce. If the only source is `admin-ajax.php`, determine the `action` value and whether the nonce is actually validated. Do not persist or replay a short-lived browser nonce in production. If the JSON response omits ticket links, combine the schedule endpoint with the public detail page rather than scraping the visual calendar grid.

## The Park Theatre

### Observed

- Cineplex gave up the lease in October 2025; the theatre reopened in December 2025 under the Rio's management (Chris Ferguson, Oddfellows Pictures) with 4K laser and 70mm projection.
- The public site is `https://www.theparktheatre.ca/`.
- The site has not been inspected from this repository yet. Because it shares an operator with the Rio, the worker assumes the same WordPress + Barker stack and requests `/wp-json/barker/v1/listings` with the Rio's parameters.

### Network-tab target

Repeat the Rio procedure on the Park's calendar page and confirm the `barker` request exists, returns the same listing shape (`id`, `event.title`, `event.link`, `start_time`, `end_time`, `extra`, `premiere`, `tickets_link`), and needs no nonce.

### Decision gate

If the Park's site does not expose the Barker endpoint, the `park-theatre` ingestion run will record a failed run without affecting the other venues. Replace `extractPark` with an adapter for whatever the site actually serves before relying on it.

## The Cinematheque

### Observed

- `/films`, `/films/calendar`, and individual `/films/{year}/{slug}` pages are server-rendered.
- Individual film pages include screening-specific ticket links such as:

```text
https://tickets.thecinematheque.ca/websales/pages/ticketsearchcriteria.aspx
  ?evtinfo={numeric-event-id}~{venue-guid}&
```

- The observed venue GUID is stable within the inspected pages, while `evtinfo` changes by screening.
- No JSON-LD schedule payload or obvious first-party XHR schedule feed was observed on initial page load.

### Network-tab target

Start with the **Doc** and **Fetch/XHR** filters. Load `/films/calendar`, open one film, and click one screening only far enough to reach Vista Websales—do not add anything to a cart.

Filter with:

```text
websales OR evtinfo OR performance OR session OR event
```

Record the first read-only Vista request that resolves `evtinfo` into performance time, availability, and venue. Do not treat basket, customer, seat-hold, or payment endpoints as data sources.

### Decision gate

The first-party HTML is currently the safer source of truth for film metadata and showtime-to-ticket mapping. A Vista JSON endpoint is useful only if it is an unauthenticated read endpoint and materially improves status or schedule coverage. Keep the full existing Websales URL as the `ticket_url`; do not synthesize checkout URLs from guessed parameters.

## VIFF Centre

### Observed

- `/whats-on/` is paginated server-rendered WordPress HTML (`/whats-on/page/{n}/`).
- Cards already expose titles, series/tags, detail URLs, status text, and screening-specific booking links.
- Booking URLs follow `/whats-on/{film-slug}/book/{opaque-session-token}/`.
- The booking page is powered by `content.elevent.app/embedded-widget/elevent-widget.min.js` and initializes with an Elevent tenant key.
- A booking page renders the date, local time, venue, price, availability messaging, and add-to-cart UI.
- WordPress exposes a standard REST root at `https://viff.org/wp-json/`, but the public listings do not require it to render.

### Network-tab target

For listings, first test **Doc** requests for `/whats-on/page/2/` and `/whats-on-calendar/`. For booking detail, open one `/book/{token}/` page with **Fetch/XHR** selected and filter:

```text
elevent OR content.elevent.app OR api OR performance OR availability
```

Capture the first Elevent read request that uses the opaque session token. Expected useful fields are performance/session ID, start time, venue, price band, availability/status, and event title.

### Decision gate

Use VIFF’s own server-rendered listings as the default schedule source. Query Elevent only if it provides a stable unauthenticated read endpoint for availability or fields missing from the HTML. Never depend on cart, authentication, Stripe, or device-fingerprinting traffic.

## Hollywood Theatre

### Observed

- The site is Webflow CMS.
- Event cards are already present in rendered HTML and include date, title, event-detail link, CTA label, and a direct third-party ticket link.
- Ticket providers vary by event (for example Ticketmaster, Ticketweb, Eventbrite, Fever, Orange Tickets, or Gigpit).
- Pagination uses a Webflow/Finsweet query parameter such as `?8c848147_page=2`.
- Finsweet `cmsfilter`, `cmsload`, and `cmsnest` scripts are present; no dedicated theatre JSON API was observed.

### Network-tab target

Clear the log, click **See more Events**, and filter:

```text
8c848147_page OR cmsload OR webflow OR events
```

Determine whether Finsweet requests the next Webflow page as HTML or calls a JSON endpoint. Capture the request URL, response type, and whether the returned fragment includes direct ticket URLs.

### Decision gate

If the response is HTML, treat the stable paginated Webflow pages as the clean source; this is simpler and less brittle than selectors against the interactive homepage. Preserve each provider’s exact external ticket URL. Because Hollywood hosts concerts and comedy as well as film, ingest only the `film` category unless product scope explicitly expands.

## Toronto

Investigated 2026-09-25 from a sandbox that can reach the sites. Every Toronto venue is in `America/Toronto`.

### Agile Ticketing (Revue Cinema and Fox Theatre)

- Both venues sell through Agile Ticketing: the Revue on `prod3.agileticketing.net`, the Fox on its own `tickets.foxtheatre.ca` host. Agile's websales pages (`list.aspx`, `feed.ashx`) are behind Incapsula and return a block page to every server-side request, whatever the headers, so they cannot be a schedule source. The venues' own WordPress sites print the Agile links, and `extractors/agile.ts` holds the shared link handling: `evtinfo=<event id>~<guid>` carries Agile's event id.

### Revue Cinema

- `/calendar/` embeds every upcoming screening in the page as the FullCalendar `events` array: `{title, start, url}` with `start` in local time (`2026-12-31 18:45:00`) and `url` the film page. About 200 screenings, four months out, in one request. `/films/` lists only the first 20 films; the rest load through Bricks' `load_query_page` endpoint, which needs the site's cookie and nonce, so it is not used.
- Film pages print the showtimes and one Agile "Buy Tickets" link per film, `info.aspx?evtinfo=<event id>~<guid>`, not one per screening. The extractor fetches a film page only for films with a screening inside the horizon and uses that link as the ticket URL. The site has no screening id, so `sourceUid` is the film slug plus the start time.
- Fixtures: `revue-calendar.html` (the real script with seven events kept) and `revue-film.html`.

### Fox Theatre

- The `movies` post type is public on the WordPress REST route `/wp-json/wp/v2/movies?per_page=100&_fields=id,slug,link,title,class_list`. Each post's `class_list` names its screening days (`event-date-2026-10-17`), which bounds the film pages to fetch. About 35 posts are live at a time.
- Each film page prints `.showtimes-lists .item` rows with `.date` ("Saturday, October 17"), `.time` ("9:00 pm") and an Agile link `ticketsearchcriteria.aspx?evtinfo=<event id>~<guid>` per screening; the event id is the `sourceUid`. A film the venue has sold out carries "SOLD OUT" in its title. A closure notice is published as a movie with midnight rows and empty links; those rows are skipped.
- Fixtures: `fox-movies.json` (three posts from the REST route), `fox-movie.html` and `fox-movie-sold-out.html`.

### OmniWeb Ticketing (Cinémathèque québécoise and the Carlton)

- Both venues sell through OmniWeb Ticketing on `omniwebticketing6.com`, under `/cinematheque/` and `/imaginecinemas/carlton/`. The venue sites link a screening as `?schdate=<day>&perfix=<performance id>`; the extractor builds the same link.
- A day page (`?schdate=YYYY-MM-DD`) embeds `var gMovieData = {...}`: one entry per film (`code`, `title`, `runTimeStr`, `ratingReason`) with `schAuds` (auditoriums) holding `schPerfsGeneral` and `schPerfsReserved` performances (`perfIx`, `curtainTime` "2026-09-25 19:30" local, `seatsRemaining`). The page's `<select>` lists every day that has performances, about a month ahead for the Cinémathèque and five weeks for the Carlton. The crawl is the first day plus one request per further day inside the horizon; `perfIx` is the `sourceUid`, zero seats means sold out.
- Titles end with a version label the Cinémathèque uses (`(VOSTA)`, `(VOF)`), kept as a tag, or with a year for the Carlton's repertory titles (`A Clockwork Orange (1971)`), kept as the release year.
- The Cinémathèque's own site (`cinematheque.qc.ca`) answers every server-side request with a Cloudflare block page, so the box office is the only source and only ticketed screenings appear; free events are missed. The Carlton's page on imaginecinemas.com prints the same performances with links to OmniWeb. Fixtures: `omniweb-cinematheque.html` and `omniweb-carlton.html` (trimmed day pages).

### Kingsway Theatre

- `kingswaymovies.ca` is a hand-made static site whose TLS certificate does not cover the domain, so it is fetched over http. The week's schedule is plain text on `new.html`: a heading "Kingsway Theatre Schedule starting Friday September 24 to Thursday October 01" and one line per show, "1:00 pm Filipinana (daily)", "8:45 pm Obsession (Fri Tues)", "1:00 pm Finding Emily (Fri / Mon to Thurs)". The heading has printed a weekday that does not match its date; the weekday wins because the week always runs Friday to Thursday.
- There are no ids and no online sales: `sourceUid` is the title and start time, `detailUrl` is the schedule page, and `ticketUrl` is empty. Fixture: `kingsway-new.html`.

### The Royal

- Events are WordPress posts. Category 95 ("screenings", under "events") holds the film events; comedy has its own category. The REST route `/wp-json/wp/v2/posts?categories=95&per_page=100` returns them with the rendered title and body.
- The title ends with the date ("Persépolis – September 2, 2026", "… – September 24 & 25, 2026"); the body gives the start time ("Program Begins: 6:30 PM", "Show: 7:30pm", falling back to "Doors 7pm") and the promoter's ticket link (Eventbrite, AdmitOne, Ticketmaster). A post without a time in its body is skipped with a warning. `sourceUid` is the post id and start time. Fixture: `royal-posts.json`.

### Paradise Theatre

- `/calendar-view/YYYY-MM` lists every event of a month; each `li.calendar-show-item` holds the event card as HTML in `data-show-card`, whose link tells the kind: `/movies/` and `/programs/` are films and shorts programmes, `/special_events/` are music, comedy and quizzes and are skipped. Day pages (`/home/YYYY-MM-DD`) show the same with times but one day per request.
- Each film page embeds schema.org JSON-LD: a `Movie` (with `dateCreated`, the release date) and one `ScreeningEvent` per upcoming showtime with `startDate` (with offset), `eventStatus`, offers with `availability`, and `url` `https://paradiseonbloor.com/purchase/<showtime id>/`, the venue's own box office. The showtime id is the `sourceUid`. Past showtimes are not in the JSON-LD.
- The crawl is one calendar page per month in the horizon plus one request per film. Fixtures: `paradise-calendar.html` (two days) and `paradise-movie.html`.

### TIFF Lightbox (not ingested)

- Every path on `www.tiff.net`, including `robots.txt`, answers HTTP 202 with `x-amzn-waf-action: challenge` and an AWS WAF JavaScript challenge page, whatever the headers. The Internet Archive holds the same challenge page.
- Investigated again on 2026-09-27 with headless Chrome on a GitHub-hosted runner (the machine the ingest runs on): `www.tiff.net/calendar` answers HTTP 403 "Request blocked" from CloudFront before any challenge, so the runner's address range is refused outright and no browser helps. `www.ticketmaster.ca`, where TIFF sells, answers the runner's browser with its "browsing activity has been paused" block page, and its Discovery API needs a registered key. No public host of tiff.net outside the WAF serves the listings (`shop.tiff.net` is the merchandise store, `oauth.tiff.net` and `cinemetrics.tiff.net` are staff tools). Third-party listing sites carry only a couple of TIFF titles.
- What would work: a Ticketmaster Discovery API key as a repository secret (the API lists every TIFF Bell Lightbox event with its deep link, start time and images), or a runner whose egress address tiff.net does not block. The `tiff-lightbox` theatre row exists and simply has no showtimes.

### Hot Docs Ted Rogers Cinema

- hotdocs.ca (Apostrophe CMS) has no schedule of its own: `/whats-on/cinema` redirects to `boxoffice.hotdocs.ca`, an Agile Ticketing site behind Incapsula that returns a block page to every server-side request, whatever the headers; the Agile feed and widget are on the same host.
- Loaded in headless Chrome, the Incapsula interstitial (a short waiting room) resolves in about fifteen seconds and the box office answers normally, including on a GitHub-hosted runner. The box office's own scripts name the WebSales feed of the "Cinema A-Z" entry group: `/websales/feed.ashx?guid=64170f3e-6ca4-4dbc-9cb5-e359273e95dd&showslist=true&format=json&withmedia=true&v=latest` (`UpdateFrequencyMinutes: 10`). It is one document, about 200 KB, with `ArrayOfShows`: per film `ID`, `Name` as printed ("Frankenstein (1931)", "Unzipped - 4K Restoration"), `ShortDescription`, `ShortDescriptive1` (the strand: "New Release", "Nightmares on Bloor Street", "Stories We Told"), `EventImage`, `InfoLink` (the film's page on the box office) and `CustomProperties` (`Copyright` is the film's year, `Director(s)`, `Country Listing`, `Runtime`, `Filter by Type`). Each of `CurrentShowings` has `ID` (the `sourceUid`), `StartDate` in local time without offset, `EndDate`, `SalesState`, `SalesMessage`, `LegacyPurchaseLink` (`ticketsearchcriteria.aspx?evtinfo=<showing id>~<guid>`, the purchase page for that screening) and `Venue.Name`.
- On 2026-09-27 the feed held 35 films and 48 showings, every one at "Hot Docs Ted Rogers Cinema", through mid-November plus the monthly Doc Soup dates. The "Cinema by Date" list page (`list.aspx?epguid=a2104450-…`) shows the same showings plus the not-yet-titled Doc Soup subscription placeholders, which the feed leaves out. The festival has its own entry group and feed, so festival screenings at other venues are not expected here; the extractor still keeps only showings whose venue is the cinema.
- The extractor (`extractors/hot-docs.ts`) fetches the feed through `browser.ts` (playwright-core driving the runner's Chrome, or `BROWSER_EXECUTABLE`) and needs no other request. Fixture: `hot-docs-feed.json` (five films from the real feed).

## Montreal

Investigated 2026-09-25 from a sandbox that can reach the sites, so these are captured responses rather than assumptions. Every Montreal venue is in `America/Toronto`.

### Cinéma du Parc, Cinéma Beaubien and Cinéma du Musée (cinemacinema.ca)

- The three cinemas share one operator and one SvelteKit site. `/en/schedule` is server-rendered, and SvelteKit serves the same route data as JSON at `/en/schedule/__data.json`; `?date=YYYY-MM-DD` selects a day. No cookie or token is needed.
- The response is a devalue document (`{type:"data", nodes:[...]}`; each node's `data` is a flat array of values that reference each other by index). The schedule node holds `filmsRepresentations` (one entry per film and cinema, each with `representations`) and `datesRepresentations` (every day with screenings, about two months). The extractor decodes this itself; `apps/worker/test/fixtures/cinemacinema-schedule.json` is a trimmed real response.
- Each representation carries `representation_id`, `cinema_id` (1 Beaubien, 2 du Parc, 3 du Musée), `representation_date` (midnight UTC, a calendar date), `heure_debut` (`09:30 PM`, local), `version` (`VOF`, `VOSTA`, `VOSTF`, `VOASTF`…) and `format`. The film entry holds the title as printed; the representation title is sometimes truncated or carries a series prefix (`MINUIT: PERFECT BLUE`).
- Ticket links are `https://billetterie.<cinema>.com/US/movie-purchase.awp?P1=01&P2=<cinema_id, two digits>&P3=<representation_id>`, exactly as the page prints them; the billetterie page confirms date, time and room. When `url_bel` is false the screening is sold elsewhere and `url_autre_bel` holds that link (festival screenings).
- The crawl is one request for today plus one per further day inside the horizon (about 60 for the default 60 days, roughly 370 KB each). The three venues run concurrently in one ingest and share a single crawl.
- There is an `original_title` field on the film page's data (`/en/films/<slug>/__data.json`), but it was empty on the pages inspected and would cost one request per film, so it is not fetched.

### Cinéma Moderne

- `/horaire/` is a monthly calendar; `/horaire/YYYY/MM/` selects a month and a month page also shows the days of adjacent weeks, so month pages overlap. Each `.cm-Cal__day[data-day]` holds `.cm-Cal__day__event` cards with the time (`.cm-Fat`), the title and version label (`.cm-Card__title`, `.cm-Card__subtitles`: `(VOSTA)`, `(VOF + Q&A)`…), a details list (director, country, year, running time, languages, format such as `DCP - Restauration 4K`) and a TicketAcces link `representations/index.cfm?EvenementID=<film>`.
- Tickets are sold per film on TicketAcces (the screening is chosen there), so the ticket link carries the film's event id, not a screening id; `sourceUid` is the film slug plus the start time. The year in the details becomes `releaseYear`. Fixture: `moderne-horaire.html` (three days of the October page).

### Cinéma Public

- `/horaire/` lists the whole published schedule, about two weeks, in the same calendar theme as Cinéma Moderne (`.cm-Cal__day[data-day]`, `.cm-Cal__day__event`). Each card prints the time, the title, a version label (`(STF)`, `(STA)`), notes in `.text-warning` (`Complet`, `En présence de …`, `Entrée libre`, `Gratuit (sur réservation)`, `Dernière chance`) and a "Billetterie" link, usually TicketAcces `achat/index.cfm?RepresentationID=<screening>`; free screenings link to the venue's own page or Eventbrite instead.
- The page also carries a JSON-LD `ItemList` of `ScreeningEvent`s with the same screenings, but it marks every screening `InStock`, including ones the page prints as `Complet`, so the HTML cards are the source. `RepresentationID` is the `sourceUid`; a screening without one uses the film slug and start time. Fixture: `public-horaire.html` (three days).

## Payload acceptance checklist

A candidate source advances to Step 3 only if it passes all applicable checks:

- No login, cart, seat hold, payment, or customer data required
- Stable across a hard refresh and incognito session
- Has a stable event/performance identifier
- Carries an explicit timezone or can be safely interpreted as `America/Vancouver`
- Covers at least the currently published schedule horizon
- Supplies or can be deterministically joined to the exact external ticket URL
- Uses a request rate compatible with polite scheduled polling
- Has a documented HTML fallback and a last-known-good cache strategy

## Capture worksheet

For each venue, record one representative request:

```text
Venue:
Page/action that triggered it:
Request URL:
Method:
Query/body parameters:
Response Content-Type:
Authentication/nonce required:
Stable event ID field:
Title field:
Start/end field and timezone:
Ticket URL or ticket ID field:
Status/availability field:
Pagination/date-range mechanism:
Caching headers:
Redacted cURL saved:
Response sample saved:
```

These four captured responses—not assumptions about the sites—are the input contract for Step 3.
