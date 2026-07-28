import { ClipboardModule } from "@angular/cdk/clipboard";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";
import {
  PLAYER_ENGINES,
  PLAYER_FACADE,
  isManagedExternalPlayer,
} from "@arm-nator/player/core";
import {
  type PlaybackFallbackRequest,
  WebPlayerViewComponent,
} from "@arm-nator/player/ui";
import {
  type ResolvedPortalPlayback,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";

interface DirectPlaybackInfo {
  readonly protocol: string;
  readonly host: string;
  readonly streamType: string;
  readonly headerCount: number;
}

@Component({
  selector: "app-direct-play",
  imports: [
    ClipboardModule,
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    WebPlayerViewComponent,
  ],
  templateUrl: "./direct-play.component.html",
  styleUrl: "./direct-play.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DirectPlayComponent {
  private readonly player = inject(PLAYER_FACADE);

  readonly engines = PLAYER_ENGINES;
  readonly playback = signal<ResolvedPortalPlayback | null>(null);
  readonly selectedEngine = signal(VideoPlayer.ArtPlayer);
  readonly status = signal<
    "ready" | "opening" | "playing" | "external" | "error"
  >("ready");
  readonly errorMessage = signal("");

  url = "";
  title = "";
  headersText = "";
  isLive = true;

  readonly isExternalEngine = computed(() =>
    isManagedExternalPlayer(this.selectedEngine()),
  );
  readonly playbackInfo = computed<DirectPlaybackInfo | null>(() => {
    const playback = this.playback();
    if (!playback) {
      return null;
    }

    let protocol = "Unknown";
    let host = "Unknown";
    try {
      const parsed = new URL(playback.streamUrl);
      protocol = parsed.protocol.replace(":", "").toUpperCase();
      host = parsed.host;
    } catch {
      // Raw paths and custom protocols remain playable by native engines.
    }

    return {
      protocol,
      host,
      streamType: this.detectStreamType(playback.streamUrl),
      headerCount: Object.keys(playback.headers ?? {}).length,
    };
  });

  async play(): Promise<void> {
    const streamUrl = this.url.trim();
    if (!streamUrl) {
      this.errorMessage.set("Enter a playback URL.");
      this.status.set("error");
      return;
    }

    const playback: ResolvedPortalPlayback = {
      streamUrl,
      title: this.title.trim() || "Direct stream",
      headers: this.parseHeaders(this.headersText),
      isLive: this.isLive,
    };

    this.playback.set(playback);
    this.errorMessage.set("");
    this.status.set("opening");

    const engine = this.selectedEngine();
    if (engine === VideoPlayer.MPV || engine === VideoPlayer.VLC) {
      try {
        await this.player.openExternalPlayback(
          playback,
          engine === VideoPlayer.MPV ? "mpv" : "vlc",
        );
        this.status.set("external");
      } catch (error) {
        this.errorMessage.set(
          error instanceof Error ? error.message : "External player failed.",
        );
        this.status.set("error");
      }
      return;
    }

    this.status.set("playing");
  }

  async openFallback(request: PlaybackFallbackRequest): Promise<void> {
    try {
      await this.player.openExternalPlayback(request.playback, request.player);
      this.status.set("external");
    } catch (error) {
      this.errorMessage.set(
        error instanceof Error ? error.message : "External player failed.",
      );
      this.status.set("error");
    }
  }

  clear(): void {
    this.playback.set(null);
    this.status.set("ready");
    this.errorMessage.set("");
  }

  private parseHeaders(value: string): Record<string, string> | undefined {
    const headers: Record<string, string> = {};
    for (const line of value.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        continue;
      }
      const name = line.slice(0, separator).trim();
      const headerValue = line.slice(separator + 1).trim();
      if (name && headerValue) {
        headers[name] = headerValue;
      }
    }
    return Object.keys(headers).length ? headers : undefined;
  }

  private detectStreamType(url: string): string {
    const cleanUrl = url.toLowerCase().split("?")[0];
    if (cleanUrl.endsWith(".m3u8")) return "HLS";
    if (cleanUrl.endsWith(".mpd")) return "DASH";
    if (cleanUrl.endsWith(".ts") || cleanUrl.endsWith(".mpegts"))
      return "MPEG-TS";
    if (cleanUrl.endsWith(".mp4")) return "MP4";
    if (cleanUrl.endsWith(".mkv")) return "Matroska";
    return "Automatic";
  }
}
