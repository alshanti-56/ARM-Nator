import { Subject } from "rxjs";
import { inject, Injectable } from "@angular/core";
import {
  PlaybackPositionData,
  ResolvedPortalPlayback,
  ConfirmedProgress,
  viewingItemFromPlayback,
} from "@arm-nator/shared/interfaces";
import { PlaybackPositionRuntimeBridgeService } from "./playback-position-runtime-bridge.service";

@Injectable({
  providedIn: "root",
})
export class PlaybackPositionService {
  readonly viewingStateChanged = new Subject<void>();
  private readonly playbackPositionBridge = inject(
    PlaybackPositionRuntimeBridgeService,
  );

  getViewingHistory(playlistId?: string) {
    return this.playbackPositionBridge.getViewingHistory(playlistId);
  }

  async saveViewingProgressOrThrow(
    playback: ResolvedPortalPlayback,
    progress: ConfirmedProgress & {
      action?: "progress" | "finished" | "reset";
    },
  ): Promise<void> {
    if (
      playback.itemIdentity &&
      this.playbackPositionBridge.supportsViewingStorage
    ) {
      await this.playbackPositionBridge.saveViewingState({
        item: viewingItemFromPlayback(playback),
        ...progress,
      });
      this.viewingStateChanged.next();
    } else if (playback.contentInfo) {
      await this.savePlaybackPositionOrThrow(playback.contentInfo.playlistId, {
        ...playback.contentInfo,
        ...progress,
      });
    }
  }

  async savePlaybackPositionOrThrow(
    playlistId: string,
    data: PlaybackPositionData,
  ): Promise<void> {
    await this.playbackPositionBridge.savePlaybackPosition(playlistId, data);
    this.viewingStateChanged.next();
  }

  async savePlaybackPosition(
    playlistId: string,
    data: PlaybackPositionData,
  ): Promise<void> {
    try {
      await this.playbackPositionBridge.savePlaybackPosition(playlistId, data);
    } catch (error) {
      console.error("Error saving playback position:", error);
    }
  }

  async getPlaybackPosition(
    playlistId: string,
    contentXtreamId: number,
    contentType: "vod" | "episode",
  ): Promise<PlaybackPositionData | null> {
    try {
      return await this.playbackPositionBridge.getPlaybackPosition(
        playlistId,
        contentXtreamId,
        contentType,
      );
    } catch (error) {
      console.error("Error getting playback position:", error);
      return null;
    }
  }

  async getSeriesPlaybackPositions(
    playlistId: string,
    seriesXtreamId: number,
  ): Promise<PlaybackPositionData[]> {
    try {
      return await this.playbackPositionBridge.getSeriesPlaybackPositions(
        playlistId,
        seriesXtreamId,
      );
    } catch (error) {
      console.error("Error getting series playback positions:", error);
      return [];
    }
  }

  async getRecentPlaybackPositions(
    playlistId: string,
    limit?: number,
  ): Promise<PlaybackPositionData[]> {
    try {
      return await this.playbackPositionBridge.getRecentPlaybackPositions(
        playlistId,
        limit,
      );
    } catch (error) {
      console.error("Error getting recent playback positions:", error);
      return [];
    }
  }

  async getAllPlaybackPositions(
    playlistId: string,
  ): Promise<PlaybackPositionData[]> {
    try {
      return await this.playbackPositionBridge.getAllPlaybackPositions(
        playlistId,
      );
    } catch (error) {
      console.error("Error getting all playback positions:", error);
      return [];
    }
  }

  async clearAllPlaybackPositions(playlistId: string): Promise<void> {
    try {
      await this.playbackPositionBridge.clearAllPlaybackPositions(playlistId);
      this.viewingStateChanged.next();
    } catch (error) {
      console.error("Error clearing all playback positions:", error);
    }
  }

  async clearPlaybackPosition(
    playlistId: string,
    contentXtreamId: number,
    contentType: "vod" | "episode",
  ): Promise<void> {
    try {
      await this.playbackPositionBridge.clearPlaybackPosition(
        playlistId,
        contentXtreamId,
        contentType,
      );
      this.viewingStateChanged.next();
    } catch (error) {
      console.error("Error clearing playback position:", error);
    }
  }
}
