import { inject, Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { PlaylistsService } from "@arm-nator/services";
import {
  Channel,
  Playlist,
  ResolvedPortalPlayback,
} from "@arm-nator/shared/interfaces";
import { XtreamUrlService } from "@arm-nator/providers/xtream/data-access";
import { UnifiedCollectionItem } from "@arm-nator/providers/shared/util";

type PlaylistWithChannels = Playlist & {
  readonly playlist?: { readonly items?: Channel[] };
};

export interface ResolvedLiveCollectionDetail {
  readonly playback: ResolvedPortalPlayback;
  readonly channel?: Channel;
}

@Injectable({ providedIn: "root" })
export class StreamResolverService {
  private readonly playlistsService = inject(PlaylistsService);
  private readonly xtreamUrl = inject(XtreamUrlService);

  private async getElectronPlaylist(
    playlistId: string,
  ): Promise<Playlist | undefined> {
    if (typeof window === "undefined") {
      return undefined;
    }

    try {
      return (
        (await window.electron?.dbGetAppPlaylist?.(playlistId)) ?? undefined
      );
    } catch {
      return undefined;
    }
  }

  async resolvePlayback(
    item: UnifiedCollectionItem,
  ): Promise<ResolvedPortalPlayback> {
    return (await this.resolveLiveDetail(item)).playback;
  }

  async resolveLiveDetail(
    item: UnifiedCollectionItem,
  ): Promise<ResolvedLiveCollectionDetail> {
    switch (item.sourceType) {
      case "m3u":
        return this.resolveM3uDetail(item);
      case "xtream":
        return { playback: await this.resolveXtream(item) };
      case "stalker":
        throw new Error("Stalker playback is no longer supported");
    }
  }

  async resolveM3uPlaybackDetail(
    item: UnifiedCollectionItem,
  ): Promise<ResolvedLiveCollectionDetail> {
    return this.resolveM3uDetail(item);
  }

  private async resolveM3uDetail(
    item: UnifiedCollectionItem,
  ): Promise<ResolvedLiveCollectionDetail> {
    const playlist = (await firstValueFrom(
      this.playlistsService.getPlaylistById(item.playlistId),
    )) as PlaylistWithChannels | undefined;
    const channel =
      this.findM3uChannel(playlist?.playlist?.items ?? [], item) ??
      this.buildFallbackM3uChannel(item);

    return {
      playback: this.buildM3uPlayback(channel, playlist),
      channel,
    };
  }

  private buildM3uPlayback(
    channel: Channel,
    playlist?: Playlist,
  ): ResolvedPortalPlayback {
    const userAgent =
      channel.http?.["user-agent"]?.trim() || playlist?.userAgent;
    const referer = channel.http?.referrer?.trim() || playlist?.referrer;
    const origin = channel.http?.origin?.trim() || playlist?.origin;
    const headers: Record<string, string> = {};
    if (userAgent) headers["User-Agent"] = userAgent;
    if (referer) headers["Referer"] = referer;
    if (origin) headers["Origin"] = origin;

    return {
      streamUrl: channel.url ?? "",
      title: channel.name,
      thumbnail: channel.tvg?.logo ?? null,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      userAgent,
      referer,
      origin,
      isLive: true,
    };
  }

  private async resolveXtream(
    item: UnifiedCollectionItem,
  ): Promise<ResolvedPortalPlayback> {
    const creds = await this.getXtreamCredentials(item.playlistId);
    if (!creds || item.xtreamId == null) {
      throw new Error("Missing Xtream credentials");
    }

    return {
      streamUrl: this.xtreamUrl.constructLiveUrl(creds, item.xtreamId),
      title: item.name,
      thumbnail: item.logo ?? null,
      isLive: true,
    };
  }

  private async getXtreamCredentials(playlistId: string): Promise<{
    serverUrl: string;
    username: string;
    password: string;
    serverTimezone?: string;
  } | null> {
    const playlist =
      (await this.getElectronPlaylist(playlistId)) ??
      ((await firstValueFrom(
        this.playlistsService.getPlaylistById(playlistId),
      )) as Playlist | undefined);

    if (!playlist?.serverUrl || !playlist.username || !playlist.password) {
      return null;
    }

    return {
      serverUrl: playlist.serverUrl,
      username: playlist.username,
      password: playlist.password,
      serverTimezone: playlist.serverTimezone,
    };
  }

  private findM3uChannel(
    channels: Channel[],
    item: UnifiedCollectionItem,
  ): Channel | undefined {
    return channels.find(
      (channel) =>
        (item.streamUrl && channel.url === item.streamUrl) ||
        (item.channelId && channel.id === item.channelId),
    );
  }

  private buildFallbackM3uChannel(item: UnifiedCollectionItem): Channel {
    return {
      id: item.channelId ?? item.uid.split("::")[2] ?? "",
      name: item.name,
      url: item.streamUrl ?? "",
      tvg: {
        id: item.tvgId ?? "",
        name: item.name,
        url: "",
        logo: item.logo ?? "",
        rec: "",
      },
      group: { title: "" },
      http: {
        referrer: "",
        "user-agent": "",
        origin: "",
      },
      radio: item.radio ?? "false",
    };
  }
}
