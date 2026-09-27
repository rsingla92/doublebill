import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { closeBrowser } from "../browser.js";
import { venueSlugSchema, type DateRange, type ExtractionBatch, type VenueSlug } from "../contracts.js";
import { VENUE_EXTRACTORS, type VenueExtractor } from "../extractors/index.js";
import { createDefaultPipeline, processShowtime, type PipelineDependencies } from "../normalization/pipeline.js";
import type { CinemaRepository, IngestionRunStatus } from "../normalization/repository.js";

/** How far ahead the date-bounded Rio fetch and the reconciliation window reach. */
export const DEFAULT_HORIZON_DAYS = 60;
const MAX_HORIZON_DAYS = 120;
const DAY_MS = 86_400_000;

export type IngestRepository = Pick<CinemaRepository, "merge" | "findTheatre" | "loadOverrides" | "startRun" | "finishRun" | "deactivateUnseenShowtimes">;

/** Quebec venues print French titles, which TMDB only returns in French. */
export const searchLanguagesFor = (region: string): readonly string[] => (region === "QC" ? ["en-CA", "fr-CA"] : ["en-CA"]);
export type IngestDependencies = Omit<PipelineDependencies, "repository"> & { repository: IngestRepository };

export interface IngestOptions {
  days?: number;
  venues?: readonly VenueSlug[];
  extractors?: Partial<Record<VenueSlug, VenueExtractor>>;
  now?: Date;
  log?: (message: string) => void;
}

export interface VenueIngestReport {
  venueSlug: VenueSlug;
  runId: string | null;
  status: IngestionRunStatus;
  fetched: number;
  matched: number;
  review: number;
  deactivated: number;
  /** True when the reconciliation guard refused to hide most of the venue's schedule. */
  reconciliationSkipped: boolean;
  warnings: string[];
  errors: string[];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Ingest one venue: record an ingestion run, extract, normalize and merge every
 * showtime, then hide future showtimes that a complete extraction no longer lists.
 */
export async function ingestVenue(venueSlug: VenueSlug, dependencies: IngestDependencies, options: IngestOptions = {}): Promise<VenueIngestReport> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? new Date();
  const range: DateRange = { start: now, end: new Date(now.getTime() + (options.days ?? DEFAULT_HORIZON_DAYS) * DAY_MS) };
  const report: VenueIngestReport = { venueSlug, runId: null, status: "failed", fetched: 0, matched: 0, review: 0, deactivated: 0, reconciliationSkipped: false, warnings: [], errors: [] };

  const theatre = await dependencies.repository.findTheatre(venueSlug);
  if (!theatre) {
    report.errors.push(`theatre "${venueSlug}" is not seeded; apply the seed migrations in db/migrations`);
    return report;
  }
  const theatreId = theatre.id;
  const languages = searchLanguagesFor(theatre.region);
  const preferRecent = theatre.programme === "first_run" || theatre.programme === "festival";
  const overrides = await dependencies.repository.loadOverrides(venueSlug);

  const runId = await dependencies.repository.startRun(theatreId);
  report.runId = runId;
  let batch: ExtractionBatch | null = null;

  try {
    const extractor = options.extractors?.[venueSlug] ?? VENUE_EXTRACTORS[venueSlug];
    try {
      batch = await extractor(range);
    } catch (error) {
      report.errors.push(`extraction failed: ${describe(error)}`);
      return report;
    }
    report.fetched = batch.showtimes.length;
    report.warnings.push(...batch.warnings);
    log(`${venueSlug}: extracted ${batch.showtimes.length} showtimes (${batch.warnings.length} warnings)`);

    for (const item of batch.showtimes) {
      try {
        const result = await processShowtime(item, dependencies, { ingestionRunId: runId, languages, preferRecent, overrides });
        if (result.status === "matched") report.matched += 1;
        else report.review += 1;
      } catch (error) {
        report.errors.push(`${item.sourceUid} "${item.rawTitle}": ${describe(error)}`);
      }
    }

    // Every extracted item was seen, whether or not it merged cleanly. Only a complete
    // extraction (no warnings, at least one item) is trusted to say what disappeared.
    if (batch.warnings.length === 0 && batch.showtimes.length > 0) {
      const result = await dependencies.repository.deactivateUnseenShowtimes(theatreId, batch.showtimes.map((item) => item.sourceUid), range.end);
      report.deactivated = result.deactivated;
      if (result.skipped) {
        report.reconciliationSkipped = true;
        report.warnings.push(`reconciliation skipped: ${result.unseen} of ${result.active} active showtimes were missing from this run, which looks like an incomplete extraction`);
      }
    } else {
      log(`${venueSlug}: skipped reconciliation because the extraction was incomplete`);
    }

    report.status = report.errors.length > 0 || report.warnings.length > 0 ? "partial" : "succeeded";
    return report;
  } catch (error) {
    report.errors.push(describe(error));
    report.status = "failed";
    return report;
  } finally {
    await dependencies.repository.finishRun(runId, {
      status: report.status,
      fetchedCount: report.fetched,
      upsertedCount: report.matched + report.review,
      errorCount: report.errors.length,
      ...(report.errors.length > 0 ? { errorSummary: report.errors.join("\n") } : {}),
      metadata: {
        matched: report.matched,
        review: report.review,
        deactivated: report.deactivated,
        reconciliationSkipped: report.reconciliationSkipped,
        warnings: report.warnings,
        horizonDays: options.days ?? DEFAULT_HORIZON_DAYS,
      },
    });
    log(`${venueSlug}: ${report.status} (matched ${report.matched}, review ${report.review}, deactivated ${report.deactivated}, errors ${report.errors.length})`);
  }
}

/** Ingest every requested venue concurrently. A venue failure never aborts the others. */
export async function ingest(dependencies: IngestDependencies, options: IngestOptions = {}): Promise<VenueIngestReport[]> {
  const venues = options.venues ?? venueSlugSchema.options;
  return Promise.all(venues.map(async (venueSlug) => {
    try {
      return await ingestVenue(venueSlug, dependencies, options);
    } catch (error) {
      return { venueSlug, runId: null, status: "failed" as const, fetched: 0, matched: 0, review: 0, deactivated: 0, reconciliationSkipped: false, warnings: [], errors: [describe(error)] };
    }
  }));
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { days: { type: "string" }, venues: { type: "string" } },
  });

  const days = values.days === undefined ? undefined : Number(values.days);
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > MAX_HORIZON_DAYS)) {
    throw new Error(`--days must be an integer between 1 and ${MAX_HORIZON_DAYS}`);
  }
  const venues = values.venues?.split(",").map((value) => venueSlugSchema.parse(value.trim()));

  for (const name of ["DATABASE_URL", "TMDB_API_TOKEN"] as const) {
    if (!process.env[name]) throw new Error(`${name} is not set. Add it as a repository secret, or to .env.local for a local run.`);
  }

  const pipeline = createDefaultPipeline();
  try {
    const reports = await ingest(pipeline, {
      ...(days !== undefined ? { days } : {}),
      ...(venues ? { venues } : {}),
      log: (message) => console.log(message),
    });
    for (const report of reports) console.log(JSON.stringify(report));
    // A run that fetched listings but could not persist them, or that had to refuse
    // reconciliation, must fail loudly rather than leave a stale schedule behind.
    const unhealthy = reports.some((report) => report.status === "failed" || report.errors.length > 0 || report.reconciliationSkipped);
    if (unhealthy) process.exitCode = 1;
  } finally {
    await pipeline.repository.close();
    // The Hot Docs extractor keeps a browser open; the process cannot exit until it is closed.
    await closeBrowser();
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
