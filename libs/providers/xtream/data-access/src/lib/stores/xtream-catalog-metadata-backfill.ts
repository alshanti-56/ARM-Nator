import {
  CatalogMetadataRecord,
  XtreamContentMetadata,
  XtreamMetadataEnrichmentState,
  normalizeXtreamContentMetadata,
} from "@arm-nator/shared/interfaces";

const RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const REQUEST_INTERVAL_MS = 250;

export type XtreamCatalogMetadataType = "movie" | "series";

export interface XtreamCatalogMetadataJob {
  item: CatalogMetadataRecord;
  type: XtreamCatalogMetadataType;
}

interface XtreamCatalogMetadataBackfillOptions {
  movies: readonly CatalogMetadataRecord[];
  series: readonly CatalogMetadataRecord[];
  isActive: () => boolean;
  fetchDetails: (
    job: XtreamCatalogMetadataJob,
  ) => Promise<CatalogMetadataRecord>;
  persist: (
    job: XtreamCatalogMetadataJob,
    metadata: XtreamContentMetadata,
    enrichment: XtreamMetadataEnrichmentState,
  ) => Promise<void>;
  onFailure?: (job: XtreamCatalogMetadataJob, error: unknown) => void;
}

function shouldFetchMetadata(
  item: CatalogMetadataRecord,
  now: number,
): boolean {
  if (item["metadata_status"] === "complete") {
    return false;
  }

  const retryAfter = item["metadata_retry_after"];
  if (typeof retryAfter !== "string" || !retryAfter.trim()) {
    return true;
  }

  const retryAt = Date.parse(retryAfter);
  return !Number.isFinite(retryAt) || retryAt <= now;
}

function enrichmentState(
  status: XtreamMetadataEnrichmentState["status"],
  attemptedAt: Date,
): XtreamMetadataEnrichmentState {
  return {
    status,
    attemptedAt: attemptedAt.toISOString(),
    retryAfter:
      status === "failed"
        ? new Date(attemptedAt.getTime() + RETRY_DELAY_MS).toISOString()
        : null,
  };
}

export async function backfillXtreamCatalogMetadata(
  options: XtreamCatalogMetadataBackfillOptions,
): Promise<number> {
  const now = Date.now();
  const jobs: XtreamCatalogMetadataJob[] = [
    ...options.movies
      .filter((item) => shouldFetchMetadata(item, now))
      .map((item) => ({ item, type: "movie" as const })),
    ...options.series
      .filter((item) => shouldFetchMetadata(item, now))
      .map((item) => ({ item, type: "series" as const })),
  ];

  let nextJob = 0;
  let completed = 0;
  const worker = async (): Promise<void> => {
    while (options.isActive() && nextJob < jobs.length) {
      const job = jobs[nextJob++];
      const attemptedAt = new Date();

      try {
        const details = await options.fetchDetails(job);
        if (!options.isActive()) return;

        await options.persist(
          job,
          normalizeXtreamContentMetadata(details),
          enrichmentState("complete", attemptedAt),
        );
        completed += 1;
      } catch (error) {
        if (!options.isActive()) return;

        await options.persist(job, {}, enrichmentState("failed", attemptedAt));
        options.onFailure?.(job, error);
      }

      if (options.isActive() && nextJob < jobs.length) {
        await new Promise((resolve) =>
          setTimeout(resolve, REQUEST_INTERVAL_MS),
        );
      }
    }
  };

  await Promise.all([worker(), worker()]);
  return completed;
}
