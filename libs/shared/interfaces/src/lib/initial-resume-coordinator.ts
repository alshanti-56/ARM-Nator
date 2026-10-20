import type { ConfirmedProgressSample } from "./confirmed-progress-writer";
import type { ViewingResume } from "./viewing-continuity";

interface ResumeConfig<T> {
  resolve(item: T, actualDuration: number): Promise<ViewingResume | null>;
  seek(positionSeconds: number): boolean;
  onError?(error: unknown): void;
  now?(): number;
}

/** Hold initial progress until a compatible resume is resolved and its seek is confirmed. */
export class InitialResumeCoordinator<T> {
  private generation = 0;
  private item: T | null = null;
  private phase: "metadata" | "lookup" | "seek" | "ready" = "ready";
  private startedAt = 0;
  private seekStartedAt = 0;
  private target = 0;
  private sawSeeking = false;
  private latestPosition = 0;
  constructor(private readonly config: ResumeConfig<T>) {}

  begin(item: T | null, policy: "auto" | "start-over" = "auto"): number {
    this.item = item;
    this.phase = item !== null && policy === "auto" ? "metadata" : "ready";
    this.startedAt = this.now();
    this.latestPosition = 0;
    this.sawSeeking = false;
    return ++this.generation;
  }

  accept(generation: number, sample: ConfirmedProgressSample): boolean {
    if (generation !== this.generation) return false;
    if (this.phase === "ready") return true;
    const now = this.now();
    if (this.phase === "seek") {
      if (sample.seeking) {
        this.sawSeeking = true;
        return false;
      }
      if (
        this.sawSeeking ||
        Math.abs(sample.positionSeconds - this.target) <= 0.75
      )
        this.phase = "ready";
      else if (now - this.seekStartedAt >= 5000) {
        this.phase = "ready";
        this.config.onError?.(
          new Error(
            "Resume seek was not confirmed; retaining current playback",
          ),
        );
      }
      return this.phase === "ready";
    }
    if (now - this.startedAt >= 10_000) {
      this.phase = "ready";
      this.config.onError?.(
        new Error("Resume lookup timed out; retaining current playback"),
      );
      return true;
    }
    if (
      !sample.seeking &&
      Number.isFinite(sample.positionSeconds) &&
      sample.positionSeconds >= 0
    )
      this.latestPosition = sample.positionSeconds;
    if (
      this.phase === "metadata" &&
      this.item !== null &&
      !sample.seeking &&
      ["playing", "paused"].includes(sample.status) &&
      Number.isFinite(sample.durationSeconds) &&
      (sample.durationSeconds ?? 0) > 0
    ) {
      this.phase = "lookup";
      const item = this.item,
        duration = sample.durationSeconds as number;
      void Promise.resolve()
        .then(() => this.config.resolve(item, duration))
        .then((resume) => {
          if (generation !== this.generation || this.phase !== "lookup") return;
          this.phase = "ready";
          if (
            !resume ||
            resume.finished ||
            Math.abs(resume.positionSeconds - this.latestPosition) <= 0.75
          )
            return;
          this.target = resume.positionSeconds;
          this.seekStartedAt = this.now();
          this.phase = "seek";
          if (!this.config.seek(this.target)) this.phase = "ready";
        })
        .catch((error) => {
          if (
            generation !== this.generation ||
            (this.phase !== "lookup" && this.phase !== "seek")
          )
            return;
          this.phase = "ready";
          this.config.onError?.(error);
        });
    }
    return false;
  }

  private now(): number {
    return this.config.now?.() ?? Date.now();
  }
}
