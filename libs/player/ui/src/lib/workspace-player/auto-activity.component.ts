import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { VideoPlayer, type AutoPlaybackFormat } from '@arm-nator/shared/interfaces';
import type {
  AutomaticPlaybackActivity,
  AutomaticPlaybackAttempt,
} from '@arm-nator/player/core';

const FORMAT_LABELS: Readonly<Record<AutoPlaybackFormat, string>> = {
  hls: 'HLS',
  mpegts: 'MPEG-TS',
  progressive: 'Progressive',
  dash: 'DASH',
  unknown: 'Unknown format',
};

const PLAYER_LABELS: Readonly<Partial<Record<VideoPlayer, string>>> = {
  [VideoPlayer.Auto]: 'Automatic',
  [VideoPlayer.Html5Player]: 'HTML video',
  [VideoPlayer.EmbeddedMpv]: 'Embedded MPV',
  [VideoPlayer.KsPlayer]: 'KS Player',
  [VideoPlayer.MPV]: 'MPV',
  [VideoPlayer.VLC]: 'VLC',
  [VideoPlayer.ArtPlayer]: 'ArtPlayer',
  [VideoPlayer.ArtPlayer2]: 'ArtPlayer 2',
};

function displayHost(value: string): string {
  const host = value.trim();
  if (!host) {
    return 'Unknown host';
  }

  try {
    const url = new URL(host.includes('://') ? host : `https://${host}`);
    return url.host || 'Unknown host';
  } catch {
    return 'Unknown host';
  }
}

function displayReason(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  const safe = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? ' ' : character;
  })
    .join('')
    .replace(
      /\b(authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+[^\s,;]+/gi,
      '$1=[redacted]',
    )
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, 'credentials hidden')
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/gi, 'stream address hidden')
    .replace(
      /(^|[\s=:("'`])(?:[a-z]:[\\/]|\\\\)[^\s?#,;<>"'`)\]]*/gi,
      '$1stream path hidden',
    )
    .replace(/(^|[\s=:("'`])\/[^\s?#,;<>"'`)]*/g, '$1stream path hidden')
    .replace(/[?#][^\s,;<>"'`)\]]*/g, 'stream query hidden')
    .replace(
      /\b(password|passwd|token|authorization|cookie|secret|credential|api[_-]?key|username|user)\s*[:=]\s*[^\s&,;]+/gi,
      '$1=[redacted]',
    )
    .replace(/\s+/g, ' ')
    .trim();

  return safe || 'No safe explanation is available.';
}

@Component({
  selector: 'app-auto-activity',
  standalone: true,
  templateUrl: './auto-activity.component.html',
  styleUrl: './auto-activity.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AutoActivityComponent {
  readonly activity = input.required<AutomaticPlaybackActivity>();

  protected readonly attempts = computed(() =>
    [...this.activity().attempts].reverse(),
  );

  protected readonly hasActivity = computed(() => {
    const activity = this.activity();
    return activity.status !== 'idle' || activity.attempts.length > 0;
  });

  protected readonly statusLabel = computed(() => {
    const activity = this.activity();
    const latestAttempt = activity.attempts.at(-1);

    switch (activity.status) {
      case 'preparing':
        return 'Preparing';
      case 'recovering':
        return 'Recovering';
      case 'playing':
        return latestAttempt?.verified
          ? 'Playing · 30 sec verified'
          : 'Playing · verification pending';
      case 'verified':
        return '30 sec verified';
      case 'stopped':
        return 'Stopped';
      case 'cancelled':
        return 'Cancelled';
      case 'idle':
        return 'Idle';
    }
  });

  protected formatLabel(format: AutoPlaybackFormat): string {
    return FORMAT_LABELS[format] ?? 'Unknown format';
  }

  protected playerLabel(engine: VideoPlayer | null): string {
    return engine ? (PLAYER_LABELS[engine] ?? 'Unknown player') : 'Unknown player';
  }

  protected outcomeLabel(attempt: AutomaticPlaybackAttempt): string {
    switch (attempt.outcome) {
      case 'preparing':
        return 'Preparing';
      case 'playing':
        return 'Playback started';
      case 'verified':
        return 'Verified playback';
      case 'failed':
        return 'Failed';
      case 'cancelled':
        return 'Cancelled';
    }
  }

  protected verificationLabel(attempt: AutomaticPlaybackAttempt): string {
    if (attempt.verified) {
      return attempt.outcome === 'playing' || attempt.outcome === 'verified'
        ? '30 sec verified'
        : '30 sec verified earlier';
    }

    switch (attempt.outcome) {
      case 'preparing':
        return 'Not started';
      case 'playing':
        return 'Verification pending';
      case 'verified':
        return '30 sec verified';
      case 'failed':
        return 'Not verified';
      case 'cancelled':
        return 'Cancelled before verification';
    }
  }

  protected hostLabel(host: string): string {
    return displayHost(host);
  }

  protected reasonLabel(reason: string | undefined): string | null {
    return displayReason(reason);
  }
}
