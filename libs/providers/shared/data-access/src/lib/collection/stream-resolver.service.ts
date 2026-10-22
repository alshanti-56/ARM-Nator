import { inject, Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { PlaylistsService } from "@arm-nator/services";
import {
  deriveXtreamPlaybackServerUrl,
  Playlist,
  ResolvedPortalPlayback,
} from "@arm-nator/shared/interfaces";
import {
  XtreamApiService,
  XtreamCredentials,
  XtreamUrlService,
  buildXtreamSavedPlaybackHeaders,
} from "@arm-nator/providers/xtream/data-access";
import { UnifiedCollectionItem } from "@arm-nator/providers/shared/util";

export interface ResolvedLiveCollectionDetail {
  readonly playback: ResolvedPortalPlayback;
}

@Injectable({ providedIn: "root" })
export class StreamResolverService {
  private readonly playlistsService = inject(PlaylistsService);
  private readonly xtreamApi = inject(XtreamApiService);
  private readonly xtreamUrl = inject(XtreamUrlService);

  async resolvePlayback(
    item: UnifiedCollectionItem,
  ): Promise<ResolvedPortalPlayback> {
    return (await this.resolveLiveDetail(item)).playback;
  }

  async resolveLiveDetail(
    item: UnifiedCollectionItem,
  ): Promise<ResolvedLiveCollectionDetail> {
    const playlist = (await firstValueFrom(
      this.playlistsService.getPlaylistById(item.playlistId),
    )) as Playlist | undefined;
    if (!playlist?.serverUrl || !playlist.username || !playlist.password) {
      throw new Error("Missing Xtream credentials");
    }
    if (item.xtreamId == null) {
      throw new Error("Missing Xtream stream ID");
    }

    const credentials: XtreamCredentials = {
      serverUrl: playlist.serverUrl,
      username: playlist.username,
      password: playlist.password,
    };
    let playbackCredentials = credentials;
    try {
      const account = await this.xtreamApi.getAccountInfo(credentials);
      const auth: unknown = account?.user_info?.auth;
      const formats = account?.user_info?.allowed_output_formats;
      playbackCredentials = {
        ...credentials,
        playbackServerUrl: deriveXtreamPlaybackServerUrl(account),
        allowedOutputFormats:
          (auth === true || auth === 1 || auth === "1") &&
          Array.isArray(formats)
            ? formats.filter(
                (format) => typeof format === "string" && format.trim(),
              )
            : undefined,
      };
    } catch {
      // The media URL can still work while the account API is unavailable.
    }

    const streamUrl = this.xtreamUrl.constructLiveUrl(
      playbackCredentials,
      item.xtreamId,
    );
    return {
      playback: {
        streamUrl,
        recovery: this.xtreamUrl.buildPlaybackRecoveryMetadata(
          playbackCredentials,
          playlist._id,
          streamUrl,
          {
            liveStreamId: item.xtreamId,
            savedHeaders: buildXtreamSavedPlaybackHeaders(playlist),
          },
        ),
        requestPolicy: {
          accountRef: playlist._id,
          portalCredentials: true,
        },
        title: item.name,
        thumbnail: item.logo ?? null,
        isLive: true,
        itemIdentity: {
          sourceType: "xtream",
          playlistId: playlist._id,
          contentKind: "live",
          providerItemId: String(item.xtreamId),
        },
        userAgent: playlist.userAgent,
        referer: playlist.referrer,
        origin: playlist.origin,
      },
    };
  }
}
