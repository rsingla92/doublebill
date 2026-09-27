import { z } from "zod";

export const venueSlugSchema = z.enum([
  "rio-theatre",
  "park-theatre",
  "the-cinematheque",
  "viff-centre",
  "hollywood-theatre",
  "cinema-du-parc",
  "cinema-beaubien",
  "cinema-du-musee",
  "revue-cinema",
  "fox-theatre",
  "cinema-moderne",
  "cinema-public",
  "cinematheque-quebecoise",
  "carlton-cinema",
  "kingsway-theatre",
  "the-royal",
  "paradise-theatre",
  "hot-docs-cinema",
]);

export const extractedShowtimeSchema = z.object({
  venueSlug: venueSlugSchema,
  sourceUid: z.string().min(1),
  rawTitle: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  detailUrl: z.string().url(),
  ticketUrl: z.string().url().optional(),
  /** Release year when the venue prints one; it settles namesakes and remakes. */
  releaseYear: z.number().int().min(1888).max(2200).optional(),
  /** The venue's own image and blurb, shown when no database knows the film. */
  imageUrl: z.string().url().optional(),
  synopsis: z.string().max(2000).optional(),
  status: z.enum(["scheduled", "sold_out", "cancelled"]).default("scheduled"),
  tags: z.array(z.string()).default([]),
  sourcePayload: z.record(z.string(), z.unknown()),
});

export type VenueSlug = z.infer<typeof venueSlugSchema>;
export type ExtractedShowtime = z.infer<typeof extractedShowtimeSchema>;

export interface ExtractionBatch {
  venueSlug: VenueSlug;
  fetchedAt: string;
  showtimes: ExtractedShowtime[];
  warnings: string[];
}

export interface DateRange {
  start: Date;
  end: Date;
}
