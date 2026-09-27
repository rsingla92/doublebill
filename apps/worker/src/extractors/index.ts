import type { DateRange, ExtractionBatch, VenueSlug } from "../contracts.js";
import { extractBeaubien } from "./beaubien.js";
import { extractCarlton } from "./carlton.js";
import { extractCinemathequeQuebecoise } from "./cinematheque-quebecoise.js";
import { extractCinematheque } from "./cinematheque.js";
import { extractDuMusee } from "./du-musee.js";
import { extractDuParc } from "./du-parc.js";
import { extractFox } from "./fox.js";
import { extractKingsway } from "./kingsway.js";
import { extractModerne } from "./moderne.js";
import { extractPublic } from "./public.js";
import { extractRevue } from "./revue.js";
import { extractRoyal } from "./royal.js";
import { extractHollywood } from "./hollywood.js";
import { extractHotDocs } from "./hot-docs.js";
import { extractParadise } from "./paradise.js";
import { extractPark } from "./park.js";
import { extractRio } from "./rio.js";
import { extractViff } from "./viff.js";

export { extractBarker, parseBarkerPayload, PARK_THEATRE, RIO_THEATRE, type BarkerOptions, type BarkerVenue, type ParsedBarkerPayload } from "./barker.js";
export { extractRio, parseRioPayload } from "./rio.js";
export { extractPark, parseParkPayload } from "./park.js";
export { extractCinematheque, parseCinemathequeFilmLinks, parseCinemathequeFilmPage, parseFilmYear } from "./cinematheque.js";
export { extractViff, parseViffPage } from "./viff.js";
export { extractHollywood, parseHollywoodEventLinks, parseHollywoodEventPage } from "./hollywood.js";
export { extractCinemaCinema, parseCinemaCinemaSchedule, decodeSvelteKitData, decodeDevalue, CINEMA_BEAUBIEN, CINEMA_DU_PARC, CINEMA_DU_MUSEE, type CinemaCinemaVenue } from "./cinemacinema.js";
export { extractBeaubien } from "./beaubien.js";
export { extractDuParc } from "./du-parc.js";
export { extractDuMusee } from "./du-musee.js";
export { agileEventId, cleanAgileUrl, isAgileTicketLink } from "./agile.js";
export { extractRevue, parseRevueCalendar, parseRevueFilmPage, revueShowtime } from "./revue.js";
export { extractFox, parseFoxMoviePage, parseFoxPosts } from "./fox.js";
export { extractModerne, parseModerneCalendar, monthsInRange } from "./moderne.js";
export { extractPublic, parsePublicSchedule } from "./public.js";
export { extractOmniWeb, parseOmniWebDay, readMovieData, omniWebTicketUrl, CINEMATHEQUE_QUEBECOISE, CARLTON_CINEMA, type OmniWebVenue } from "./omniweb.js";
export { extractCinemathequeQuebecoise } from "./cinematheque-quebecoise.js";
export { extractCarlton } from "./carlton.js";
export { extractKingsway, parseKingswaySchedule, parseDaySpec } from "./kingsway.js";
export { extractRoyal, parseRoyalPosts } from "./royal.js";
export { extractParadise, parseParadiseCalendar, parseParadiseMoviePage } from "./paradise.js";
export { extractHotDocs, parseHotDocsFeed, readFeed as readHotDocsFeed, HOT_DOCS_FEED_URL } from "./hot-docs.js";

export type VenueExtractor = (range: DateRange) => Promise<ExtractionBatch>;

/** One extractor per venue. The Barker and cinemacinema.ca venues accept a date range; the others publish their full schedule. */
export const VENUE_EXTRACTORS: Readonly<Record<VenueSlug, VenueExtractor>> = {
  "rio-theatre": (range) => extractRio(range),
  "park-theatre": (range) => extractPark(range),
  "the-cinematheque": () => extractCinematheque(),
  "viff-centre": () => extractViff(),
  "hollywood-theatre": () => extractHollywood(),
  "cinema-du-parc": (range) => extractDuParc(range),
  "cinema-beaubien": (range) => extractBeaubien(range),
  "cinema-du-musee": (range) => extractDuMusee(range),
  "revue-cinema": (range) => extractRevue(range),
  "fox-theatre": (range) => extractFox(range),
  "cinema-moderne": (range) => extractModerne(range),
  "cinema-public": () => extractPublic(),
  "cinematheque-quebecoise": (range) => extractCinemathequeQuebecoise(range),
  "carlton-cinema": (range) => extractCarlton(range),
  "kingsway-theatre": () => extractKingsway(),
  "the-royal": () => extractRoyal(),
  "paradise-theatre": (range) => extractParadise(range),
  "hot-docs-cinema": (range) => extractHotDocs(range),
};
