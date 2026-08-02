import { eq } from "drizzle-orm";
import * as schema from "@arm-nator/database/schema";
import type {
  XtreamContentMetadata,
  XtreamMetadataEnrichmentState,
} from "@arm-nator/shared/interfaces";
import type { AppDatabase } from "../database.types";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export async function updateXtreamContentMetadata(
  db: AppDatabase,
  contentId: number,
  metadata: XtreamContentMetadata,
  enrichment?: XtreamMetadataEnrichmentState,
): Promise<{ success: boolean }> {
  const updates = {
    genre: nonEmpty(metadata.genre),
    releaseDate: nonEmpty(metadata.releaseDate),
    country: nonEmpty(metadata.country),
    director: nonEmpty(metadata.director),
    cast: nonEmpty(metadata.cast),
    description: nonEmpty(metadata.description),
    rating: nonEmpty(metadata.rating),
    posterUrl: nonEmpty(metadata.posterUrl),
    backdropUrl: nonEmpty(metadata.backdropUrl),
    metadataStatus: enrichment?.status,
    metadataAttemptedAt: enrichment?.attemptedAt,
    metadataRetryAfter: enrichment?.retryAfter,
  };

  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  ) as Partial<typeof updates>;

  if (Object.keys(definedUpdates).length > 0) {
    await db
      .update(schema.content)
      .set(definedUpdates)
      .where(eq(schema.content.id, contentId));
  }

  return { success: true };
}
