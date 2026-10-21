import { SOURCE_PLAYBACK_POLICY as P } from "./source-playback-evidence";
export interface SourceConfirmationInput {
  generation: string;
  atMs: number;
  positionSeconds: number;
  playing: boolean;
  stalled: boolean;
  seeking: boolean;
  presentedFrames?: number;
  frameReady?: boolean;
  audioOnly?: boolean;
  audioReady?: boolean;
}
/** Qualification is scoped to one uninterrupted generation, never metadata alone. */
export class SourcePlaybackConfirmation {
  private first: SourceConfirmationInput | null = null;
  private last: SourceConfirmationInput | null = null;
  private frameAdvanced = false;
  reset(): void {
    this.first = null;
    this.last = null;
    this.frameAdvanced = false;
  }
  observe(s: SourceConfirmationInput): boolean {
    if (
      !Number.isFinite(s.atMs) ||
      !Number.isFinite(s.positionSeconds) ||
      s.positionSeconds < 0 ||
      !s.playing ||
      s.stalled ||
      s.seeking
    ) {
      this.reset();
      return false;
    }
    const last = this.last;
    if (
      last &&
      (s.generation !== last.generation ||
        s.atMs < last.atMs ||
        s.atMs - last.atMs > P.progressGapMs ||
        s.positionSeconds < last.positionSeconds ||
        (s.presentedFrames !== undefined &&
          last.presentedFrames !== undefined &&
          s.presentedFrames < last.presentedFrames))
    )
      this.reset();
    if (
      this.last &&
      s.positionSeconds <= this.last.positionSeconds &&
      s.atMs - this.last.atMs > 0
    ) {
      this.reset();
    }
    this.first ??= s;
    if (
      this.last &&
      s.presentedFrames !== undefined &&
      this.last.presentedFrames !== undefined &&
      s.presentedFrames > this.last.presentedFrames
    )
      this.frameAdvanced = true;
    this.last = s;
    const mediaReady =
      s.audioOnly === true
        ? s.audioReady === true
        : this.frameAdvanced || s.frameReady === true;
    return (
      mediaReady &&
      s.atMs - this.first.atMs >= P.confirmationMs &&
      s.positionSeconds - this.first.positionSeconds >= P.confirmationSeconds
    );
  }
}
