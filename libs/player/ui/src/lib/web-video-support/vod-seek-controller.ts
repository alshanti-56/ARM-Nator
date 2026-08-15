export type VodSeekState = 'idle' | 'seeking' | 'completed' | 'failed' | 'destroyed';

const SEEK_DEADLINE_MS = 5_000;
const SEEK_MATCH_TOLERANCE_SECONDS = 2;

/** Owns one VOD seek generation and ignores callbacks from obsolete targets. */
export class VodSeekController {
  private stateValue: VodSeekState = 'idle';
  private generation = 0;
  private target: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attached = false;

  private readonly handleMetadata = (): void => {
    this.tryApply(this.generation);
  };

  private readonly handleSeekProgress = (): void => {
    if (this.target === null || this.stateValue !== 'seeking') {
      return;
    }
    if (
      Math.abs(this.config.video.currentTime - this.target) <=
      SEEK_MATCH_TOLERANCE_SECONDS
    ) {
      this.complete();
    }
  };

  constructor(
    private readonly config: {
      readonly video: HTMLVideoElement;
      readonly getStartTime: () => number;
      readonly getDuration: () => number;
      readonly seek: (seconds: number) => void;
      readonly isVod?: () => boolean;
    },
  ) {}

  attach(): void {
    if (this.attached || this.stateValue === 'destroyed') {
      return;
    }
    this.attached = true;
    this.config.video.addEventListener('loadedmetadata', this.handleMetadata);
    this.config.video.addEventListener('durationchange', this.handleMetadata);
    this.config.video.addEventListener('seeked', this.handleSeekProgress);
    this.config.video.addEventListener('timeupdate', this.handleSeekProgress);
  }

  requestStartTime(): void {
    if (this.stateValue === 'destroyed') {
      return;
    }
    if (this.config.isVod && !this.config.isVod()) {
      this.reset();
      return;
    }
    const requested = this.config.getStartTime();
    this.generation += 1;
    this.clearTimer();
    this.target = Number.isFinite(requested) && requested > 0 ? requested : null;
    this.stateValue = this.target === null ? 'idle' : 'seeking';
    if (this.target === null) {
      return;
    }
    const generation = this.generation;
    this.tryApply(generation);
    this.timer = setTimeout(() => {
      if (generation !== this.generation || this.stateValue !== 'seeking') {
        return;
      }
      this.stateValue = 'failed';
      this.target = null;
      this.timer = undefined;
    }, SEEK_DEADLINE_MS);
  }

  reset(): void {
    if (this.stateValue === 'destroyed') {
      return;
    }
    this.generation += 1;
    this.clearTimer();
    this.target = null;
    this.stateValue = 'idle';
  }

  destroy(): void {
    if (this.attached) {
      this.config.video.removeEventListener('loadedmetadata', this.handleMetadata);
      this.config.video.removeEventListener('durationchange', this.handleMetadata);
      this.config.video.removeEventListener('seeked', this.handleSeekProgress);
      this.config.video.removeEventListener('timeupdate', this.handleSeekProgress);
      this.attached = false;
    }
    this.clearTimer();
    this.generation += 1;
    this.target = null;
    this.stateValue = 'destroyed';
  }

  get state(): VodSeekState {
    return this.stateValue;
  }

  private tryApply(generation: number): void {
    if (
      generation !== this.generation ||
      this.target === null ||
      this.stateValue !== 'seeking'
    ) {
      return;
    }

    const target = this.clampTarget(this.target);
    try {
      this.config.seek(target);
    } catch {
      return;
    }
    this.target = target;
    this.handleSeekProgress();
  }

  private clampTarget(target: number): number {
    const duration = this.config.getDuration();
    if (Number.isFinite(duration) && duration > 0) {
      return Math.max(0, Math.min(target, duration));
    }

    try {
      const seekable = this.config.video.seekable;
      if (seekable.length > 0) {
        const start = seekable.start(0);
        const end = seekable.end(seekable.length - 1);
        return Math.max(start, Math.min(target, end));
      }
    } catch {
      // The media ranges may change while they are being read.
    }
    return Math.max(0, target);
  }

  private complete(): void {
    this.clearTimer();
    this.target = null;
    this.stateValue = 'completed';
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
