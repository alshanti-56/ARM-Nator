import { inject, Injectable } from "@angular/core";
import {
  PlaybackPositionData,
  ViewingStateUpdate,
  ViewingHistoryEntry,
} from "@arm-nator/shared/interfaces";
import { RuntimeCapabilitiesService } from "./runtime-capabilities.service";

type PlaybackPositionContentType = "vod" | "episode";

type PlaybackPositionElectronBridge = Partial<{
  dbGetViewingHistory: (playlistId?: string) => Promise<ViewingHistoryEntry[]>;
  dbSaveViewingState: (
    update: ViewingStateUpdate,
  ) => Promise<{ success: boolean }>;

  dbSavePlaybackPosition: (
    playlistId: string,
    data: PlaybackPositionData,
  ) => Promise<{ success: boolean }>;
  dbGetPlaybackPosition: (
    playlistId: string,
    contentXtreamId: number,
    contentType: PlaybackPositionContentType,
  ) => Promise<PlaybackPositionData | null>;
  dbGetSeriesPlaybackPositions: (
    playlistId: string,
    seriesXtreamId: number,
  ) => Promise<PlaybackPositionData[]>;
  dbGetRecentPlaybackPositions: (
    playlistId: string,
    limit?: number,
  ) => Promise<PlaybackPositionData[]>;
  dbGetAllPlaybackPositions: (
    playlistId: string,
  ) => Promise<PlaybackPositionData[]>;
  dbClearAllPlaybackPositions: (
    playlistId: string,
  ) => Promise<{ success: boolean }>;
  dbClearPlaybackPosition: (
    playlistId: string,
    contentXtreamId: number,
    contentType: PlaybackPositionContentType,
  ) => Promise<{ success: boolean }>;
  onPlaybackPositionUpdate: (
    callback: (data: PlaybackPositionData) => void,
  ) => () => void;
}>;

type PlaybackPositionRuntimeWindow = Window & {
  electron?: PlaybackPositionElectronBridge;
};

@Injectable({ providedIn: "root" })
export class PlaybackPositionRuntimeBridgeService {
  private readonly runtime = inject(RuntimeCapabilitiesService);

  get supportsStorage(): boolean {
    return this.runtime.supportsPlaybackPositionStorage;
  }

  get supportsUpdates(): boolean {
    return this.runtime.supportsPlaybackPositionUpdates;
  }

  getViewingHistory(playlistId?: string) {
    return (
      this.bridge?.dbGetViewingHistory?.(playlistId) ?? Promise.resolve([])
    );
  }

  get supportsViewingStorage(): boolean {
    return (
      this.supportsStorage &&
      typeof this.bridge?.dbSaveViewingState === "function"
    );
  }

  async saveViewingState(update: ViewingStateUpdate): Promise<void> {
    const save = this.bridge?.dbSaveViewingState;
    if (!this.supportsViewingStorage || !save)
      throw new Error("Viewing state storage is unavailable");
    const result = await save(update);
    if (result?.success !== true)
      throw new Error("Viewing state storage rejected the update");
  }

  async savePlaybackPosition(
    playlistId: string,
    data: PlaybackPositionData,
  ): Promise<void> {
    if (!this.supportsStorage) {
      return;
    }

    const save = this.bridge?.dbSavePlaybackPosition;
    if (!save) throw new Error("Playback position storage is unavailable");
    const result = await save(playlistId, data);
    if (result?.success !== true)
      throw new Error("Playback position storage rejected the update");
  }

  getPlaybackPosition(
    playlistId: string,
    contentXtreamId: number,
    contentType: PlaybackPositionContentType,
  ): Promise<PlaybackPositionData | null> {
    if (!this.supportsStorage) {
      return Promise.resolve(null);
    }

    return (
      this.bridge?.dbGetPlaybackPosition?.(
        playlistId,
        contentXtreamId,
        contentType,
      ) ?? Promise.resolve(null)
    );
  }

  getSeriesPlaybackPositions(
    playlistId: string,
    seriesXtreamId: number,
  ): Promise<PlaybackPositionData[]> {
    if (!this.supportsStorage) {
      return Promise.resolve([]);
    }

    return (
      this.bridge?.dbGetSeriesPlaybackPositions?.(playlistId, seriesXtreamId) ??
      Promise.resolve([])
    );
  }

  getRecentPlaybackPositions(
    playlistId: string,
    limit?: number,
  ): Promise<PlaybackPositionData[]> {
    if (!this.supportsStorage) {
      return Promise.resolve([]);
    }

    return (
      this.bridge?.dbGetRecentPlaybackPositions?.(playlistId, limit) ??
      Promise.resolve([])
    );
  }

  getAllPlaybackPositions(playlistId: string): Promise<PlaybackPositionData[]> {
    if (!this.supportsStorage) {
      return Promise.resolve([]);
    }

    return (
      this.bridge?.dbGetAllPlaybackPositions?.(playlistId) ??
      Promise.resolve([])
    );
  }

  async clearAllPlaybackPositions(playlistId: string): Promise<void> {
    if (!this.supportsStorage) {
      return;
    }

    await this.bridge?.dbClearAllPlaybackPositions?.(playlistId);
  }

  async clearPlaybackPosition(
    playlistId: string,
    contentXtreamId: number,
    contentType: PlaybackPositionContentType,
  ): Promise<void> {
    if (!this.supportsStorage) {
      return;
    }

    await this.bridge?.dbClearPlaybackPosition?.(
      playlistId,
      contentXtreamId,
      contentType,
    );
  }

  onPlaybackPositionUpdate(
    callback: (data: PlaybackPositionData) => void,
  ): (() => void) | undefined {
    if (!this.supportsUpdates) {
      return undefined;
    }

    return this.bridge?.onPlaybackPositionUpdate?.(callback);
  }

  private get bridge(): PlaybackPositionElectronBridge | undefined {
    if (typeof window === "undefined") {
      return undefined;
    }

    return (window as PlaybackPositionRuntimeWindow).electron;
  }
}
