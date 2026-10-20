export type PlaybackTeardown = () => void | Promise<void>;

export async function awaitPlaybackTeardowns(
  teardowns: readonly Promise<void>[],
): Promise<void> {
  const results = await Promise.allSettled(teardowns);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    const details = failures
      .map((failure) =>
        failure instanceof Error ? failure.message : String(failure),
      )
      .join("; ");
    throw new AggregateError(failures, `Playback teardown failed: ${details}`);
  }
}

interface RegisteredTeardown {
  readonly callback: PlaybackTeardown;
  readonly repeatable: boolean;
}

/** Tracks playback-owned resources and blocks transitions until cleanup settles. */
export class PlaybackTeardownRegistry {
  private readonly teardowns = new Map<number, RegisteredTeardown>();
  private nextId = 0;
  private generation = 0;
  private drainInFlight: Promise<void> | null = null;

  register(
    teardown: PlaybackTeardown,
    options: { repeatable?: boolean } = {},
  ): () => void {
    const id = ++this.nextId;
    const registration: RegisteredTeardown = {
      callback: teardown,
      repeatable: options.repeatable === true,
    };
    this.teardowns.set(id, registration);
    let registered = true;
    return () => {
      if (!registered) {
        return;
      }
      registered = false;
      this.teardowns.delete(id);
    };
  }

  async prepareForPlayback(): Promise<number | null> {
    const generation = ++this.generation;
    await this.releaseAll();
    return this.isCurrent(generation) ? generation : null;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  async releaseAll(): Promise<void> {
    if (!this.drainInFlight) {
      const drain = this.drain();
      const trackedDrain = drain.finally(() => {
        if (this.drainInFlight === trackedDrain) {
          this.drainInFlight = null;
        }
      });
      this.drainInFlight = trackedDrain;
    }
    return this.drainInFlight;
  }

  private async drain(): Promise<void> {
    const drained = new Set<number>();
    while (true) {
      const batch = [...this.teardowns.entries()].filter(
        ([id]) => !drained.has(id),
      );
      if (batch.length === 0) {
        return;
      }

      const results = await Promise.allSettled(
        batch.map(async ([id, registration]) => {
          await registration.callback();
          drained.add(id);
          if (
            !registration.repeatable &&
            this.teardowns.get(id) === registration
          ) {
            this.teardowns.delete(id);
          }
        }),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        const details = failures
          .map((failure) =>
            failure instanceof Error ? failure.message : String(failure),
          )
          .join("; ");
        throw new AggregateError(
          failures,
          `Playback teardown failed: ${details}`,
        );
      }
    }
  }
}
