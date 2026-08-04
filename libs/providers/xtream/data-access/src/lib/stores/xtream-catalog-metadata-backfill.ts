import {
  CatalogMetadataRecord,
  XtreamContentMetadata,
  XtreamMetadataEnrichmentState,
  hasCompleteXtreamSearchMetadata,
  normalizeXtreamContentMetadata,
} from "@arm-nator/shared/interfaces";

const RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
const REQUEST_INTERVAL_MS = 250;
const PROGRESS_REPORT_INTERVAL = 100;
const CATALOG_REFRESH_INTERVAL = 2000;

export type XtreamCatalogMetadataType = "movie" | "series";

export interface XtreamCatalogMetadataJob {
  item: CatalogMetadataRecord;
  type: XtreamCatalogMetadataType;
}

export interface XtreamCatalogMetadataProgress {
  total: number;
  completed: number;
  failed: number;
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
  onProgress?: (progress: XtreamCatalogMetadataProgress) => void;
  onCatalogBatch?: () => void;
  onFailure?: (job: XtreamCatalogMetadataJob, error: unknown) => void;
}

function shouldFetchMetadata(
  item: CatalogMetadataRecord,
  now: number,
): boolean {
  if (
    item["metadata_status"] === "complete" ||
    hasCompleteXtreamSearchMetadata(item)
  ) {
    return false;
  }

  const retryAfter = item["metadata_retry_after"];
  if (typeof retryAfter !== "string" || !retryAfter.trim()) {
    return true;
  }

  const retryAt = Date.parse(retryAfter);
  return !Number.isFinite(retryAt) || retryAt <= now;
}

function isDeferredFailure(
  item: CatalogMetadataRecord,
  now: number,
): boolean {
  if (item["metadata_status"] !== "failed") return false;

  const retryAfter = item["metadata_retry_after"];
  if (typeof retryAfter !== "string" || !retryAfter.trim()) return false;

  const retryAt = Date.parse(retryAfter);
  return Number.isFinite(retryAt) && retryAt > now;
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
  const total = options.movies.length + options.series.length;
  const initiallyDeferredFailures = [...options.movies, ...options.series].filter(
    (item) => isDeferredFailure(item, now),
  ).length;
  const initiallyComplete = total - jobs.length - initiallyDeferredFailures;

  let nextJob = 0;
  let completed = initiallyComplete;
  let failed = initiallyDeferredFailures;
  let lastReportedProcessed = initiallyComplete;
  let lastReportedCatalogProcessed = initiallyComplete;
  const reportProgress = (force = false): void => {
    const processed = completed + failed;
    if (
      !force &&
      processed !== total &&
      processed !== initiallyComplete + 1 &&
      processed - lastReportedProcessed < PROGRESS_REPORT_INTERVAL
    ) {
      return;
    }

    lastReportedProcessed = processed;
    options.onProgress?.({
      total,
      completed,
      failed,
    });
  };
  const refreshCatalog = (force = false): void => {
    const processed = completed + failed;
    if (
      !force &&
      processed !== total &&
      processed - lastReportedCatalogProcessed < CATALOG_REFRESH_INTERVAL
    ) {
      return;
    }

    lastReportedCatalogProcessed = processed;
    options.onCatalogBatch?.();
  };

  reportProgress(true);

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
        refreshCatalog();
        reportProgress();
      } catch (error) {
        if (!options.isActive()) return;

        await options.persist(job, {}, enrichmentState("failed", attemptedAt));
        failed += 1;
        refreshCatalog();
        reportProgress();
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
  refreshCatalog(true);
  reportProgress(true);
  return completed;
}
