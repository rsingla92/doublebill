import { describe, expect, it, vi } from "vitest";
import type { ExtractedShowtime, ExtractionBatch } from "../src/contracts.js";
import { HttpError, NetworkError } from "../src/http.js";
import { BLOCKED_GRACE_RUNS, ingest, ingestVenue, isUnhealthy, type IngestDependencies } from "../src/jobs/ingest.js";
import type { MergeInput } from "../src/normalization/repository.js";

const showtime = (sourceUid: string, rawTitle = "Tony"): ExtractedShowtime => ({
  venueSlug: "rio-theatre", sourceUid, rawTitle, startsAt: "2026-09-22T18:30:00-07:00",
  detailUrl: "https://riotheatre.ca/movie/tony/", status: "scheduled", tags: [], sourcePayload: { sourceUid },
});
const batch = (showtimes: ExtractedShowtime[], warnings: string[] = []): ExtractionBatch => ({ venueSlug: "rio-theatre", fetchedAt: "2026-09-21T00:00:00Z", showtimes, warnings });

function harness(mergeImpl?: (input: MergeInput) => Promise<{ status: "matched"; movieId: string; showtimeId: string } | { status: "review", showtimeId: null }>) {
  const repository = {
    findTheatre: vi.fn(async (slug: string) => (slug === "rio-theatre" ? { id: "theatre-1", region: "BC", programme: null } : null)),
    loadOverrides: vi.fn(async () => new Map<string, number>()),
    startRun: vi.fn(async () => "run-1"),
    finishRun: vi.fn(async () => undefined),
    countRecentBlocks: vi.fn(async () => 0),
    deactivateUnseenShowtimes: vi.fn(async () => ({ deactivated: 2, unseen: 2, active: 6, skipped: false })),
    merge: vi.fn(mergeImpl ?? (async () => ({ status: "matched" as const, movieId: "m", showtimeId: "s" }))),
  };
  const dependencies: IngestDependencies = {
    normalizer: { normalize: (rawTitle) => ({ coreTitle: rawTitle, releaseYear: null, contentKind: "film", tags: [], confidence: 0.96, note: "" }) },
    tmdb: { search: vi.fn(async () => []) },
    repository,
    rulesVersion: "test",
  };
  return { dependencies, repository };
}

const now = new Date("2026-09-21T12:00:00Z");

describe("ingestVenue", () => {
  it("records a successful run and reconciles unseen showtimes", async () => {
    const { dependencies, repository } = harness();
    const report = await ingestVenue("rio-theatre", dependencies, { now, days: 10, extractors: { "rio-theatre": async () => batch([showtime("a"), showtime("b")]) } });

    expect(report).toMatchObject({ status: "succeeded", runId: "run-1", fetched: 2, matched: 2, review: 0, deactivated: 2, errors: [] });
    expect(repository.merge).toHaveBeenCalledWith(expect.objectContaining({ ingestionRunId: "run-1" }));
    expect(repository.deactivateUnseenShowtimes).toHaveBeenCalledWith("theatre-1", ["a", "b"], new Date("2026-10-01T12:00:00Z"));
    expect(repository.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "succeeded", fetchedCount: 2, upsertedCount: 2, errorCount: 0 }));
  });

  it("reports when the reconciliation guard refuses to hide the schedule", async () => {
    const { dependencies, repository } = harness();
    repository.deactivateUnseenShowtimes.mockResolvedValueOnce({ deactivated: 0, unseen: 40, active: 42, skipped: true });
    const report = await ingestVenue("rio-theatre", dependencies, { now, extractors: { "rio-theatre": async () => batch([showtime("a"), showtime("b")]) } });

    expect(report).toMatchObject({ status: "partial", deactivated: 0, reconciliationSkipped: true });
    expect(report.warnings[0]).toMatch(/reconciliation skipped: 40 of 42/);
    expect(repository.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "partial", metadata: expect.objectContaining({ reconciliationSkipped: true }) }));
  });

  it("skips reconciliation when extraction reported warnings", async () => {
    const { dependencies, repository } = harness();
    const report = await ingestVenue("rio-theatre", dependencies, { now, extractors: { "rio-theatre": async () => batch([showtime("a")], ["page 2 failed"]) } });

    expect(report).toMatchObject({ status: "partial", deactivated: 0, warnings: ["page 2 failed"] });
    expect(repository.deactivateUnseenShowtimes).not.toHaveBeenCalled();
  });

  it("isolates per-item merge failures", async () => {
    const { dependencies, repository } = harness(async (input) => {
      if (input.item.sourceUid === "bad") throw new Error("boom");
      return { status: "review", showtimeId: null };
    });
    const report = await ingestVenue("rio-theatre", dependencies, { now, extractors: { "rio-theatre": async () => batch([showtime("good"), showtime("bad")]) } });

    expect(report).toMatchObject({ status: "partial", review: 1, errors: ['bad "Tony": boom'] });
    expect(repository.deactivateUnseenShowtimes).toHaveBeenCalledWith("theatre-1", ["good", "bad"], expect.any(Date));
    expect(repository.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "partial", errorCount: 1, errorSummary: 'bad "Tony": boom' }));
  });

  it("marks the run failed when extraction throws", async () => {
    const { dependencies, repository } = harness();
    const report = await ingestVenue("rio-theatre", dependencies, { now, extractors: { "rio-theatre": async () => { throw new Error("offline"); } } });

    expect(report).toMatchObject({ status: "failed", errors: ["extraction failed: offline"] });
    expect(repository.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "failed", errorSummary: "extraction failed: offline" }));
    expect(repository.merge).not.toHaveBeenCalled();
  });

  it("marks a run the source blocked, and counts the blocked runs before it", async () => {
    const { dependencies, repository } = harness();
    repository.countRecentBlocks.mockResolvedValueOnce(1);
    const blocked = async () => { throw new HttpError("https://example.test/wp-json", 403); };
    const report = await ingestVenue("rio-theatre", dependencies, { now, extractors: { "rio-theatre": blocked } });

    expect(report).toMatchObject({ status: "failed", blocked: true, blockedStreak: 2 });
    expect(repository.countRecentBlocks).toHaveBeenCalledWith("theatre-1", "run-1", BLOCKED_GRACE_RUNS);
    expect(repository.finishRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "failed", metadata: expect.objectContaining({ blocked: true }) }));
  });

  it("counts a source it could not reach as blocked", async () => {
    const { dependencies } = harness();
    const unreachable = async () => { throw new NetworkError("https://example.test/day", new TypeError("fetch failed")); };
    const report = await ingestVenue("rio-theatre", dependencies, { now, extractors: { "rio-theatre": unreachable } });

    expect(report).toMatchObject({ status: "failed", blocked: true, blockedStreak: 1, errors: ["extraction failed: GET https://example.test/day failed: fetch failed"] });
  });

  it("does not count a failure that is not a block as one", async () => {
    const { dependencies, repository } = harness();
    const missing = async () => { throw new HttpError("https://example.test/wp-json", 404); };
    const report = await ingestVenue("rio-theatre", dependencies, { now, extractors: { "rio-theatre": missing } });

    expect(report).toMatchObject({ status: "failed", blocked: false, blockedStreak: 0 });
    expect(repository.countRecentBlocks).not.toHaveBeenCalled();
  });

  it("refuses to run for a theatre that has not been seeded", async () => {
    const { dependencies, repository } = harness();
    const report = await ingestVenue("viff-centre", dependencies, { now });
    expect(report.status).toBe("failed");
    expect(report.errors[0]).toMatch(/not seeded/);
    expect(repository.startRun).not.toHaveBeenCalled();
  });
});

describe("ingest", () => {
  it("runs the requested venues and never rejects", async () => {
    const { dependencies, repository } = harness();
    repository.startRun.mockRejectedValueOnce(new Error("db down"));
    const reports = await ingest(dependencies, { now, venues: ["rio-theatre", "rio-theatre"], extractors: { "rio-theatre": async () => batch([showtime("a")]) } });
    expect(reports.map((report) => report.status).sort()).toEqual(["failed", "succeeded"]);
  });
});

describe("isUnhealthy", () => {
  const failed = { venueSlug: "fox-theatre" as const, runId: "run-1", status: "failed" as const, fetched: 0, matched: 0, review: 0, deactivated: 0, reconciliationSkipped: false, blocked: false, blockedStreak: 0, warnings: [], errors: ["extraction failed: GET … failed with 403"] };

  it("tolerates a block until it has lasted the grace runs", () => {
    expect(isUnhealthy({ ...failed, blocked: true, blockedStreak: 1 })).toBe(false);
    expect(isUnhealthy({ ...failed, blocked: true, blockedStreak: BLOCKED_GRACE_RUNS - 1 })).toBe(false);
    expect(isUnhealthy({ ...failed, blocked: true, blockedStreak: BLOCKED_GRACE_RUNS })).toBe(true);
  });

  it("fails on any other failure, error or skipped reconciliation", () => {
    expect(isUnhealthy(failed)).toBe(true);
    expect(isUnhealthy({ ...failed, status: "partial", errors: [], reconciliationSkipped: true })).toBe(true);
    expect(isUnhealthy({ ...failed, status: "succeeded", errors: [] })).toBe(false);
  });
});
