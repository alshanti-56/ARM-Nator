import type {
  PlaybackNetworkFailure,
  PlaybackRecoveryIdentity,
  ResolvedPortalPlayback,
} from "@arm-nator/shared/interfaces";

type Resolver = (request: {
  signal: AbortSignal;
  reason: "manual-retry" | "media-auth-failure";
}) => Promise<ResolvedPortalPlayback>;
/** Selection-scoped ownership survives engine replacement and prevents refresh loops. */
export class PlaybackRecoveryCoordinator {
  private selectionId = 0;
  private attemptId = 0;
  private controller?: AbortController;
  private operation?: Promise<boolean>;
  private used = false;
  private allowBudgetReset = true;
  private hasAdvanced = false;
  private lastPosition?: number;
  private stableSince?: number;
  private lastObservation?: number;
  constructor(private readonly timeoutMs = 15_000) {}
  get identity(): PlaybackRecoveryIdentity {
    return { selectionId: this.selectionId, attemptId: this.attemptId };
  }
  get busy(): boolean {
    return !!this.operation;
  }
  isCurrent(identity: PlaybackRecoveryIdentity): boolean {
    return (
      identity.selectionId === this.selectionId &&
      identity.attemptId === this.attemptId
    );
  }
  beginSelection(): void {
    this.cancel();
    this.selectionId++;
    this.used = false;
    this.allowBudgetReset = true;
    this.hasAdvanced = false;
    this.lastPosition = undefined;
    this.stableSince = undefined;
    this.lastObservation = undefined;
  }
  beginAttempt(): void {
    this.cancel();
    this.used = false;
    this.allowBudgetReset = true;
    this.stableSince = undefined;
  }
  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.operation = undefined;
    this.attemptId++;
    this.stableSince = undefined;
  }
  observe(
    position: number,
    status: string,
    seeking = false,
    now = Date.now(),
  ): void {
    const advancing =
      Number.isFinite(position) &&
      status === "playing" &&
      !seeking &&
      this.lastPosition !== undefined &&
      position > this.lastPosition;
    if (
      this.lastObservation !== undefined &&
      now - this.lastObservation > 3_000
    )
      this.stableSince = undefined;
    this.lastObservation = now;
    if (advancing) {
      this.hasAdvanced = true;
      this.stableSince ??= now;
      if (
        !this.busy &&
        this.allowBudgetReset &&
        now - this.stableSince >= 15_000
      )
        this.used = false;
    } else this.stableSince = undefined;
    if (this.busy || !this.allowBudgetReset) this.stableSince = undefined;
    this.lastPosition = position;
  }
  noteFailure(failure: PlaybackNetworkFailure): void {
    if (
      (failure.status === 401 || failure.status === 403) &&
      failure.resourceKind !== "license" &&
      (!failure.identity || this.isCurrent(failure.identity))
    ) {
      this.stableSince = undefined;
      if (this.used) this.allowBudgetReset = false;
    }
  }
  canRenew(failure: PlaybackNetworkFailure): boolean {
    return (
      this.hasAdvanced &&
      !this.used &&
      !this.busy &&
      (failure.status === 401 || failure.status === 403) &&
      ["manifest", "playlist", "segment", "encryption-key"].includes(
        failure.resourceKind,
      ) &&
      (!failure.identity || this.isCurrent(failure.identity))
    );
  }
  run(
    resolve: Resolver,
    commit: (
      playback: ResolvedPortalPlayback,
      identity: PlaybackRecoveryIdentity,
    ) => Promise<void>,
    automatic: boolean,
    timeoutMs = this.timeoutMs,
  ): Promise<boolean> {
    if (this.operation) return this.operation;
    if (automatic && this.used) return Promise.resolve(false);
    this.used ||= automatic;
    if (automatic) this.allowBudgetReset = false;
    this.stableSince = undefined;
    const identity = {
      selectionId: this.selectionId,
      attemptId: ++this.attemptId,
    };
    const controller = new AbortController();
    this.controller = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error("Recovery cancelled")),
        { once: true },
      );
      if (Number.isFinite(timeoutMs))
        timer = setTimeout(() => controller.abort(), timeoutMs);
    });
    const operation = (async () => {
      try {
        const source = await Promise.race([
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new Error("Cancelled");
            return resolve({
              signal: controller.signal,
              reason: automatic ? "media-auth-failure" : "manual-retry",
            });
          }),
          aborted,
        ]);
        if (controller.signal.aborted || !this.isCurrent(identity))
          return false;
        clearTimeout(timer);
        await commit(source, identity);
        if (this.isCurrent(identity)) this.allowBudgetReset = true;
        return this.isCurrent(identity);
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
        if (this.controller === controller) {
          this.controller = undefined;
          this.operation = undefined;
        }
      }
    })();
    this.operation = operation;
    return operation;
  }
}
