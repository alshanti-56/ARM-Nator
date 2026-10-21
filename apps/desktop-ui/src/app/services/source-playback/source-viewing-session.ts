import {
  SourcePlaybackConfirmation,
  SOURCE_PLAYBACK_POLICY as P,
  type SourceConfirmationInput,
  type SourceEvidenceKey,
  type SourceEvidenceWrite,
  type SourcePlaybackCategory,
  type SourcePlaybackReason,
  type ResolvedPortalPlayback,
  type SourceSampleEvidence,
} from "@arm-nator/shared/interfaces";
export function sourceViewingIdentity(playback: ResolvedPortalPlayback): {
  sourceId: string;
  itemId: string;
  category: SourcePlaybackCategory;
} | null {
  const identity = playback.itemIdentity,
    info = playback.contentInfo;
  const sourceId =
    identity?.playlistId ?? info?.playlistId ?? playback.recovery?.accountRef;
  const itemId =
    identity?.providerItemId ??
    (info?.contentXtreamId != null ? String(info.contentXtreamId) : undefined);
  if (!sourceId || !itemId) return null;
  const kind = identity?.contentKind ?? info?.contentType;
  return {
    sourceId,
    itemId,
    category:
      playback.isLive || kind === "live"
        ? "live"
        : kind === "series" || kind === "episode"
          ? "series"
          : "movies",
  };
}
export class SourceViewingSession {
  private readonly confirmation = new SourcePlaybackConfirmation();
  private issued = false;
  private ended = false;
  private successfulAt: number | null = null;
  get finished(): boolean {
    return this.ended;
  }
  constructor(
    private readonly selection: {
      id: string;
      key: SourceEvidenceKey;
      itemId: string;
      title: string;
      startedAt: number;
    },
  ) {}
  observe(
    input: SourceConfirmationInput,
    currentGeneration: string,
    engine: string,
  ): SourceEvidenceWrite | null {
    if (input.generation !== currentGeneration || this.ended) return null;
    if (!this.confirmation.observe(input) || this.issued) return null;
    this.successfulAt = input.atMs;
    this.issued = true;
    return this.write(
      "played",
      null,
      engine,
      input.atMs,
      input.audioOnly === true,
    );
  }
  terminal(
    reason: SourcePlaybackReason,
    conclusive: boolean,
    engine: string,
    at: number,
  ): SourceEvidenceWrite | null {
    if (this.ended) return null;
    this.ended = true;
    return this.write(
      conclusive ? "failed" : "inconclusive",
      reason,
      engine,
      at,
      false,
    );
  }
  retryQualification(): void {
    if (!this.ended) this.issued = false;
  }
  resetWindow(): void {
    this.confirmation.reset();
  }
  private write(
    outcome: SourceSampleEvidence["outcome"],
    reason: SourcePlaybackReason | null,
    engine: string,
    at: number,
    audioOnly: boolean,
  ): SourceEvidenceWrite {
    const samples: SourceSampleEvidence[] = [
      {
        itemId: this.selection.itemId,
        title: this.selection.title,
        outcome,
        reason,
        engine,
        audioOnly,
        elapsedMs: Math.max(0, at - this.selection.startedAt),
      },
    ];
    const attempt = {
      checkId: this.selection.id,
      key: this.selection.key,
      origin: "viewing" as const,
      startedAt: this.selection.startedAt,
      completedAt: at,
      samples,
      reason,
    };
    return {
      attempt,
      ...(outcome === "played" || outcome === "failed"
        ? {
            observation: {
              checkId: attempt.checkId,
              key: attempt.key,
              origin: attempt.origin,
              startedAt: attempt.startedAt,
              completedAt: at,
              samples,
              successfulAt: this.successfulAt,
              result:
                outcome === "played"
                  ? ("verified" as const)
                  : ("failed" as const),
            },
            nextEligibleAt: at + P.freshMs,
            inconclusiveCount: 0,
          }
        : {}),
    };
  }
}
